import { Router } from 'express';
import { pool, query } from '../db.js';
import { isStaff, requireAuth, requireTeacher, wrap } from '../auth.js';
import { visiblePapers } from '../scope.js';
import { scope } from './teacher.js';

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
            (SELECT count(DISTINCT user_id)::int FROM attempts WHERE assignment_id = a.id) AS started
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

  const id = await inTransaction(async (client) => {
    const { rows } = await client.query(
      'INSERT INTO assignments (teacher_id, title, instructions, due_at) VALUES ($1, $2, $3, $4) RETURNING id',
      [req.userId, title, String(req.body.instructions || '').trim(), due.skip ? null : due.value],
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
    `SELECT s.id, s.name, s.username, s.class_name, ast.assigned_at, ast.submitted_at,
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
      'UPDATE assignments SET title = $2, instructions = $3, due_at = $4 WHERE id = $1',
      [assignment.id, title, instructions, due.skip ? assignment.due_at : due.value],
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
    'UPDATE assignment_students SET submitted_at = NULL WHERE assignment_id = $1 AND student_id = $2',
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

export default router;
