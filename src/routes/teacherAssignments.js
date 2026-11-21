import { Router } from 'express';
import { pool, query } from '../db.js';
import { isStaff, requireAuth, requireTeacher, wrap } from '../auth.js';
import { visiblePapers } from '../scope.js';
import { scope } from './teacher.js';
import { MARKING_COLUMNS } from '../ai.js';
import { deadlineOf, fillBlankAnswers, queueSuggestions, settleExpired, suggestMarks } from '../mock.js';

// Teachers create assignments (quizzes) for their own students and follow the results.
// Admins and super admins can see and manage every teacher's assignments.
const router = Router();
router.use(requireAuth, requireTeacher);

const MAX_QUESTIONS = 100;

// The assignment if this account may manage it, otherwise null.
async function findAssignment(req, id) {
  const { rows } = await query(
    `SELECT a.*, t.name AS teacher_name FROM assignments a JOIN users t ON t.id = a.teacher_id
      WHERE a.id = $1 AND ($2::boolean OR a.teacher_id = $3)`,
    [id, isStaff(req.role), req.userId],
  );
  return rows[0] || null;
}

// { kind: 'practice' | 'mock', time_limit_min } → checked values, or { error }.
function parseKind(body, current = {}) {
  const kind = body.kind === undefined ? (current.kind || 'practice') : String(body.kind);
  if (!['practice', 'mock'].includes(kind)) return { error: 'Choose practice or mock exam.' };
  if (kind === 'practice') return { kind, minutes: null };
  const raw = body.time_limit_min === undefined ? current.time_limit_min : body.time_limit_min;
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 300) return { error: 'A mock exam needs a time limit between 5 and 300 minutes.' };
  return { kind, minutes };
}

function parseDue(value) {
  if (value === undefined) return { ok: true, skip: true };
  if (value === null || value === '') return { ok: true, value: null };
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? { ok: false } : { ok: true, value: date };
}

// Keeps only the questions this account can see, in the order given.
async function checkQuestions(req, ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  if (!wanted.length) return { error: 'Pick at least one question.' };
  if (wanted.length > MAX_QUESTIONS) return { error: `An assignment can have at most ${MAX_QUESTIONS} questions.` };
  const papers = await visiblePapers(req.userId, req.role);
  const { rows } = await query('SELECT id FROM questions WHERE id = ANY($1) AND paper = ANY($2)', [wanted, papers]);
  const found = new Set(rows.map((r) => r.id));
  const missing = wanted.filter((id) => !found.has(id));
  if (missing.length) return { error: `These questions were not found or are not in your subjects: ${missing.slice(0, 5).join(', ')}` };
  return { ids: wanted };
}

// Student ids (given directly, or every approved student in the given classes) that this account teaches.
async function checkStudents(req, studentIds, classNames) {
  const ids = [...new Set((Array.isArray(studentIds) ? studentIds : []).map(Number).filter(Number.isInteger))];
  const classes = [...new Set((Array.isArray(classNames) ? classNames : []).map((c) => String(c).trim()).filter(Boolean))];
  if (!ids.length && !classes.length) return { ids: [] };
  const { sql, params } = scope(req);
  const n = params.length;
  const { rows } = await query(
    `SELECT s.id FROM users s
      WHERE ${sql} AND s.status = 'approved' AND (s.id = ANY($${n + 1}) OR s.class_name = ANY($${n + 2}))`,
    [...params, ids, classes],
  );
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) return { error: `You can only assign work to your own approved students (not found: ${missing.join(', ')}).` };
  return { ids: [...found] };
}

async function setQuestions(client, assignmentId, ids) {
  await client.query('DELETE FROM assignment_questions WHERE assignment_id = $1', [assignmentId]);
  await client.query(
    `INSERT INTO assignment_questions (assignment_id, question_id, position)
     SELECT $1, q, ord::int FROM unnest($2::text[]) WITH ORDINALITY AS t(q, ord)`,
    [assignmentId, ids],
  );
}

async function addStudents(client, assignmentId, ids) {
  if (!ids.length) return;
  await client.query(
    `INSERT INTO assignment_students (assignment_id, student_id)
     SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING`,
    [assignmentId, ids],
  );
}

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Every assignment with how many students have started and handed it in.
router.get('/', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT a.id, a.title, a.instructions, a.due_at, a.created_at, a.teacher_id, t.name AS teacher_name,
            (SELECT count(*)::int FROM assignment_questions WHERE assignment_id = a.id) AS questions,
            (SELECT coalesce(sum(q.marks), 0)::int FROM assignment_questions aq JOIN questions q ON q.id = aq.question_id
              WHERE aq.assignment_id = a.id) AS marks,
            (SELECT count(*)::int FROM assignment_students WHERE assignment_id = a.id) AS students,
            (SELECT count(*)::int FROM assignment_students WHERE assignment_id = a.id AND submitted_at IS NOT NULL) AS submitted,
            (SELECT count(DISTINCT user_id)::int FROM attempts WHERE assignment_id = a.id) AS started,
            a.kind, a.time_limit_min, a.results_released_at
       FROM assignments a JOIN users t ON t.id = a.teacher_id
      WHERE $1::boolean OR a.teacher_id = $2
      ORDER BY a.created_at DESC, a.id DESC`,
    [isStaff(req.role), req.userId],
  );
  res.json({ assignments: rows });
}));

// Create an assignment: { title, instructions?, due_at?, question_ids: [...], student_ids?: [...], class_names?: [...] }
router.post('/', wrap(async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Give the assignment a title.' });
  const due = parseDue(req.body.due_at);
  if (!due.ok) return res.status(400).json({ error: 'Due date is not a valid date.' });
  const questions = await checkQuestions(req, req.body.question_ids);
  if (questions.error) return res.status(400).json({ error: questions.error });
  const students = await checkStudents(req, req.body.student_ids, req.body.class_names);
  if (students.error) return res.status(400).json({ error: students.error });
  const kind = parseKind(req.body);
  if (kind.error) return res.status(400).json({ error: kind.error });

  const id = await inTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO assignments (teacher_id, title, instructions, due_at, kind, time_limit_min)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.userId, title, String(req.body.instructions || '').trim(), due.skip ? null : due.value, kind.kind, kind.minutes],
    );
    await setQuestions(client, rows[0].id, questions.ids);
    await addStudents(client, rows[0].id, students.ids);
    return rows[0].id;
  });
  res.status(201).json({ id, assigned: students.ids.length });
}));

// One assignment: its questions and every student's score on it.
router.get('/:id', wrap(async (req, res) => {
  const assignment = await findAssignment(req, Number(req.params.id));
  if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });
  if (assignment.kind === 'mock') await settleExpired(assignment.id);
  const questions = await query(
    `SELECT q.id, q.paper, p.label AS paper_label, q.label, q.marks, q.chapter, q.subtopic, e.label AS exam_label,
            left(q.prompt, 180) AS preview, aq.position
       FROM assignment_questions aq
       JOIN questions q ON q.id = aq.question_id
       JOIN papers p ON p.number = q.paper
       LEFT JOIN exam_papers e ON e.code = q.exam_code
      WHERE aq.assignment_id = $1 ORDER BY aq.position`,
    [assignment.id],
  );
  const students = await query(
    `SELECT s.id, s.name, s.username, s.class_name, ast.assigned_at, ast.submitted_at, ast.started_at,
            mk.mock_answered, mk.mock_marked, mk.mock_total, mk.mock_ai_pending,
            coalesce(r.answered, 0) AS answered, coalesce(r.earned, 0) AS earned, r.last_attempt,
            coalesce(r.results, '[]') AS results
       FROM assignment_students ast
       JOIN users s ON s.id = ast.student_id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS answered, sum(l.awarded)::int AS earned, max(l.created_at) AS last_attempt,
                json_agg(json_build_object('question_id', l.question_id, 'awarded', l.awarded, 'marks', l.marks)) AS results
           FROM latest_assignment_attempts l
          WHERE l.assignment_id = ast.assignment_id AND l.user_id = s.id
       ) r ON true
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE m.answer <> '')::int AS mock_answered,
                count(*) FILTER (WHERE m.mark IS NOT NULL)::int AS mock_marked,
                sum(coalesce(m.mark, m.ai_mark))::int AS mock_total,
                count(*) FILTER (WHERE m.ai_mark IS NULL AND m.ai_error IS NULL AND m.answer <> '')::int AS mock_ai_pending
           FROM mock_answers m WHERE m.assignment_id = ast.assignment_id AND m.student_id = s.id
       ) mk ON true
      WHERE ast.assignment_id = $1
      ORDER BY s.class_name, s.name`,
    [assignment.id],
  );
  const marks = questions.rows.reduce((t, q) => t + q.marks, 0);
  res.json({ assignment: { ...assignment, marks }, questions: questions.rows, students: students.rows });
}));

// Change details, replace the questions, or add/remove students.
// { title?, instructions?, due_at?, question_ids?, add_student_ids?, add_class_names?, remove_student_ids? }
router.patch('/:id', wrap(async (req, res) => {
  const assignment = await findAssignment(req, Number(req.params.id));
  if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });

  const title = req.body.title === undefined ? assignment.title : String(req.body.title).trim();
  if (!title) return res.status(400).json({ error: 'Title cannot be empty.' });
  const instructions = req.body.instructions === undefined ? assignment.instructions : String(req.body.instructions).trim();
  const kind = parseKind(req.body, assignment);
  if (kind.error) return res.status(400).json({ error: kind.error });
  const due = parseDue(req.body.due_at);
  if (!due.ok) return res.status(400).json({ error: 'Due date is not a valid date.' });

  let questions = null;
  if (req.body.question_ids !== undefined) {
    questions = await checkQuestions(req, req.body.question_ids);
    if (questions.error) return res.status(400).json({ error: questions.error });
  }
  const students = await checkStudents(req, req.body.add_student_ids, req.body.add_class_names);
  if (students.error) return res.status(400).json({ error: students.error });
  const remove = (Array.isArray(req.body.remove_student_ids) ? req.body.remove_student_ids : []).map(Number).filter(Number.isInteger);

  await inTransaction(async (client) => {
    await client.query(
      'UPDATE assignments SET title = $2, instructions = $3, due_at = $4, kind = $5, time_limit_min = $6 WHERE id = $1',
      [assignment.id, title, instructions, due.skip ? assignment.due_at : due.value, kind.kind, kind.minutes],
    );
    if (questions) await setQuestions(client, assignment.id, questions.ids);
    await addStudents(client, assignment.id, students.ids);
    if (remove.length) {
      await client.query('DELETE FROM assignment_students WHERE assignment_id = $1 AND student_id = ANY($2)', [assignment.id, remove]);
    }
  });
  res.json({ id: assignment.id });
}));

// Hand a submitted assignment back so the student can keep working on it.
router.post('/:id/students/:studentId/reopen', wrap(async (req, res) => {
  const assignment = await findAssignment(req, Number(req.params.id));
  if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });
  const { rowCount } = await query(
    // A reopened mock exam starts again with a fresh clock; the answers so far are kept.
    `UPDATE assignment_students SET submitted_at = NULL,
            started_at = CASE WHEN (SELECT kind FROM assignments WHERE id = $1) = 'mock' THEN NULL ELSE started_at END
      WHERE assignment_id = $1 AND student_id = $2`,
    [assignment.id, Number(req.params.studentId)],
  );
  if (!rowCount) return res.status(404).json({ error: 'That student does not have this assignment.' });
  res.json({ reopened: true });
}));

// Deletes the assignment. The students' answers stay in their practice history.
router.delete('/:id', wrap(async (req, res) => {
  const assignment = await findAssignment(req, Number(req.params.id));
  if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });
  await query('DELETE FROM assignments WHERE id = $1', [assignment.id]);
  res.json({ deleted: true });
}));

// ---- Mock exams: marking and releasing results ----

async function findMockStudent(req, res) {
  const assignment = await findAssignment(req, Number(req.params.id));
  if (!assignment) { res.status(404).json({ error: 'Assignment not found.' }); return null; }
  if (assignment.kind !== 'mock') { res.status(400).json({ error: 'This assignment is not a mock exam.' }); return null; }
  await settleExpired(assignment.id);
  const { rows } = await query(
    `SELECT s.id, s.name, s.username, s.class_name, ast.started_at, ast.submitted_at, ast.teacher_comment
       FROM assignment_students ast JOIN users s ON s.id = ast.student_id
      WHERE ast.assignment_id = $1 AND ast.student_id = $2`,
    [assignment.id, Number(req.params.studentId)],
  );
  if (!rows[0]) { res.status(404).json({ error: 'That student does not have this mock exam.' }); return null; }
  return { assignment, student: rows[0] };
}

// One student's mock exam for marking: every question with its mark scheme, the answer, the AI's suggestion
// and the teacher's mark so far.
router.get('/:id/students/:studentId/mock', wrap(async (req, res) => {
  const found = await findMockStudent(req, res);
  if (!found) return;
  const { assignment, student } = found;
  if (student.submitted_at) await fillBlankAnswers(assignment.id, student.id);
  const { rows } = await query(
    `SELECT ${MARKING_COLUMNS}, p.label AS paper_label, aq.position,
            m.answer, m.saved_at, m.ai_mark, m.ai_ticked, m.ai_error, m.mark, m.ticked, m.comment, m.marked_at
       FROM assignment_questions aq
       JOIN questions q ON q.id = aq.question_id
       JOIN papers p ON p.number = q.paper
       LEFT JOIN subjects sub ON sub.id = p.subject_id
       LEFT JOIN exam_papers e ON e.code = q.exam_code
       LEFT JOIN mock_answers m ON m.assignment_id = aq.assignment_id AND m.question_id = q.id AND m.student_id = $2
      WHERE aq.assignment_id = $1
      ORDER BY aq.position`,
    [assignment.id, student.id],
  );
  res.json({ assignment: { ...assignment, deadline: deadlineOf({ ...assignment, started_at: student.started_at }) }, student, questions: rows });
}));

// Ask the AI marker again for suggestions on every answer that has none (or failed). Waits for it to finish.
router.post('/:id/students/:studentId/suggest', wrap(async (req, res) => {
  const found = await findMockStudent(req, res);
  if (!found) return;
  if (!found.student.submitted_at) return res.status(409).json({ error: 'The student has not handed this mock exam in yet.' });
  await query(
    'UPDATE mock_answers SET ai_error = NULL WHERE assignment_id = $1 AND student_id = $2 AND ai_mark IS NULL',
    [found.assignment.id, found.student.id],
  );
  await suggestMarks(found.assignment.id, found.student.id);
  res.json({ done: true });
}));

// The teacher's mark for one answer: { mark, ticked?, comment? }
router.put('/:id/students/:studentId/mock/:questionId', wrap(async (req, res) => {
  const found = await findMockStudent(req, res);
  if (!found) return;
  if (!found.student.submitted_at) return res.status(409).json({ error: 'You can mark the answers once the student has handed the exam in.' });
  const q = await query(
    `SELECT q.marks, q.criteria FROM assignment_questions aq JOIN questions q ON q.id = aq.question_id
      WHERE aq.assignment_id = $1 AND q.id = $2`,
    [found.assignment.id, req.params.questionId],
  );
  if (!q.rows[0]) return res.status(404).json({ error: 'That question is not part of this mock exam.' });
  const { marks, criteria } = q.rows[0];
  const mark = Number(req.body.mark);
  if (!Number.isInteger(mark) || mark < 0 || mark > marks) return res.status(400).json({ error: `The mark must be a whole number from 0 to ${marks}.` });
  const ticked = [...new Set((Array.isArray(req.body.ticked) ? req.body.ticked : [])
    .map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < criteria.length))].sort((a, b) => a - b);
  const comment = String(req.body.comment || '').slice(0, 2000);
  await query(
    `INSERT INTO mock_answers (assignment_id, student_id, question_id, mark, ticked, comment, marked_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (assignment_id, student_id, question_id)
     DO UPDATE SET mark = EXCLUDED.mark, ticked = EXCLUDED.ticked, comment = EXCLUDED.comment, marked_at = now()`,
    [found.assignment.id, found.student.id, req.params.questionId, mark, ticked, comment],
  );
  res.json({ saved: true });
}));

// Accept every AI suggestion the teacher has not changed, for one student.
router.post('/:id/students/:studentId/accept-ai', wrap(async (req, res) => {
  const found = await findMockStudent(req, res);
  if (!found) return;
  const { rowCount } = await query(
    `UPDATE mock_answers SET mark = ai_mark, ticked = coalesce(ai_ticked, '{}'), marked_at = now()
      WHERE assignment_id = $1 AND student_id = $2 AND mark IS NULL AND ai_mark IS NOT NULL`,
    [found.assignment.id, found.student.id],
  );
  res.json({ accepted: rowCount });
}));

// The teacher's overall comment for one student: { comment }
router.put('/:id/students/:studentId/comment', wrap(async (req, res) => {
  const found = await findMockStudent(req, res);
  if (!found) return;
  await query(
    'UPDATE assignment_students SET teacher_comment = $3 WHERE assignment_id = $1 AND student_id = $2',
    [found.assignment.id, found.student.id, String(req.body.comment || '').slice(0, 4000)],
  );
  res.json({ saved: true });
}));

// Release the results: students who handed in see their marks. Every marked answer is also saved as an
// attempt (marked by the teacher), so the mock counts in the student's progress. Refused while any handed-in
// answer is still unmarked, unless { force: true }, which releases the marked answers only.
router.post('/:id/release', wrap(async (req, res) => {
  const assignment = await findAssignment(req, Number(req.params.id));
  if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });
  if (assignment.kind !== 'mock') return res.status(400).json({ error: 'This assignment is not a mock exam.' });
  if (assignment.results_released_at) return res.status(409).json({ error: 'The results are already released.' });
  await settleExpired(assignment.id);
  const unmarked = await query(
    `SELECT count(*)::int AS n FROM mock_answers m
       JOIN assignment_students ast ON ast.assignment_id = m.assignment_id AND ast.student_id = m.student_id
      WHERE m.assignment_id = $1 AND ast.submitted_at IS NOT NULL AND m.mark IS NULL`,
    [assignment.id],
  );
  if (unmarked.rows[0].n > 0 && !req.body.force) {
    return res.status(409).json({ error: `${unmarked.rows[0].n} answers are not marked yet.`, unmarked: unmarked.rows[0].n });
  }
  await inTransaction(async (client) => {
    await client.query(
      `INSERT INTO attempts (user_id, question_id, answer, ticked, awarded, marks, assignment_id, marked_by)
       SELECT m.student_id, m.question_id, m.answer, m.ticked, m.mark, q.marks, m.assignment_id, 'teacher'
         FROM mock_answers m
         JOIN questions q ON q.id = m.question_id
         JOIN assignment_students ast ON ast.assignment_id = m.assignment_id AND ast.student_id = m.student_id
        WHERE m.assignment_id = $1 AND ast.submitted_at IS NOT NULL AND m.mark IS NOT NULL`,
      [assignment.id],
    );
    await client.query('UPDATE assignments SET results_released_at = now() WHERE id = $1', [assignment.id]);
  });
  res.json({ released: true });
}));

// Start AI suggestions for every handed-in student who has none yet (e.g. after a server restart).
router.post('/:id/suggest-all', wrap(async (req, res) => {
  const assignment = await findAssignment(req, Number(req.params.id));
  if (!assignment || assignment.kind !== 'mock') return res.status(404).json({ error: 'Mock exam not found.' });
  const { rows } = await query('SELECT student_id FROM assignment_students WHERE assignment_id = $1 AND submitted_at IS NOT NULL', [assignment.id]);
  for (const r of rows) queueSuggestions(assignment.id, r.student_id);
  res.json({ queued: rows.length });
}));

export default router;
