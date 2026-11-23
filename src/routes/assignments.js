import { Router } from 'express';
import { query } from '../db.js';
import { requireApproved, requireAuth, requireStudent, wrap } from '../auth.js';
import { MARKING_COLUMNS, MarkingError, aiEnabled, markAnswer, underLimit } from '../ai.js';
import { GRACE_MS, deadlineOf, fillBlankAnswers, queueSuggestions, settleExpired } from '../mock.js';

// Students: the quizzes their teacher assigned to them. A student only ever sees their own assignments.
const router = Router();
router.use(requireAuth, requireStudent, requireApproved);

// The student's copy of an assignment, or null if it was not given to them.
async function findMine(req, id) {
  const { rows } = await query(
    `SELECT a.id, a.title, a.instructions, a.due_at, a.created_at, t.name AS teacher_name,
            a.kind, a.time_limit_min, a.results_released_at,
            ast.assigned_at, ast.submitted_at, ast.started_at, ast.teacher_comment
       FROM assignment_students ast
       JOIN assignments a ON a.id = ast.assignment_id
       JOIN users t ON t.id = a.teacher_id
      WHERE ast.assignment_id = $1 AND ast.student_id = $2`,
    [id, req.userId],
  );
  const a = rows[0];
  if (!a) return null;
  if (a.kind === 'mock') {
    // Time ran out while the student was away: hand it in now, then read the row again.
    if (!a.submitted_at && a.started_at && Date.now() > deadlineOf(a).getTime() + GRACE_MS) {
      await settleExpired(a.id);
      return findMine(req, id);
    }
    a.deadline = deadlineOf(a);
  }
  return a;
}

const mockOnly = (res) => res.status(409).json({ error: 'This is a mock exam: there is no marking until your teacher has marked it.' });

// All my assignments, newest first, with how far I have got.
router.get('/', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT a.id, a.title, a.instructions, a.due_at, a.created_at, t.name AS teacher_name,
            a.kind, a.time_limit_min, a.results_released_at,
            ast.assigned_at, ast.submitted_at, ast.started_at,
            (SELECT count(*)::int FROM assignment_questions WHERE assignment_id = a.id) AS questions,
            (SELECT count(*)::int FROM mock_answers m
              WHERE m.assignment_id = a.id AND m.student_id = $1 AND m.answer <> '') AS mock_answered,
            CASE WHEN a.results_released_at IS NOT NULL THEN
              (SELECT coalesce(sum(m.mark), 0)::int FROM mock_answers m WHERE m.assignment_id = a.id AND m.student_id = $1)
            END AS mock_earned,
            (SELECT coalesce(sum(q.marks), 0)::int FROM assignment_questions aq JOIN questions q ON q.id = aq.question_id
              WHERE aq.assignment_id = a.id) AS marks,
            (SELECT count(*)::int FROM latest_assignment_attempts l
              WHERE l.assignment_id = a.id AND l.user_id = $1) AS answered,
            (SELECT coalesce(sum(l.awarded), 0)::int FROM latest_assignment_attempts l
              WHERE l.assignment_id = a.id AND l.user_id = $1) AS earned
       FROM assignment_students ast
       JOIN assignments a ON a.id = ast.assignment_id
       JOIN users t ON t.id = a.teacher_id
      WHERE ast.student_id = $1
      ORDER BY (ast.submitted_at IS NOT NULL), a.due_at NULLS LAST, a.created_at DESC`,
    [req.userId],
  );
  res.json({ assignments: rows });
}));

// One assignment with every question (and mark scheme, for self-marking) and my latest answer to each.
router.get('/:id', wrap(async (req, res) => {
  const assignment = await findMine(req, Number(req.params.id));
  if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });
  if (assignment.kind === 'mock') return res.json(await mockPaper(req, assignment));
  const { rows } = await query(
    `SELECT q.*, p.label AS paper_label, c.name AS chapter_name, e.label AS exam_label, aq.position,
            CASE WHEN l.id IS NULL THEN NULL ELSE json_build_object(
              'id', l.id, 'answer', l.answer, 'ticked', CASE WHEN l.marked_by = 'self' THEN l.ticked ELSE '{}' END,
              'awarded', l.awarded, 'marks', l.marks, 'marked_by', l.marked_by, 'ai_hint', l.ai_hint,
              'created_at', l.created_at
            ) END AS my_attempt
       FROM assignment_questions aq
       JOIN questions q ON q.id = aq.question_id
       JOIN papers p ON p.number = q.paper
       LEFT JOIN chapters c ON c.paper = q.paper AND c.number = q.chapter
       LEFT JOIN exam_papers e ON e.code = q.exam_code
       LEFT JOIN latest_assignment_attempts l ON l.assignment_id = aq.assignment_id AND l.question_id = q.id AND l.user_id = $2
      WHERE aq.assignment_id = $1
      ORDER BY aq.position`,
    [assignment.id, req.userId],
  );
  // With AI marking on, students do not see mark schemes (see practice.js).
  if (aiEnabled()) {
    for (const q of rows) Object.assign(q, { criteria: [], rejects: [], final_answer: '', answer_figures: [], max_note: '', scheme_hidden: true });
  }
  res.json({ assignment, questions: rows, ai_marking: aiEnabled() });
}));

// Save a self-marked answer to one question of the assignment: { answer, ticked, awarded }
router.post('/:id/questions/:questionId/attempts', wrap(async (req, res) => {
  const assignment = await findMine(req, Number(req.params.id));
  if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });
  if (assignment.kind === 'mock') return mockOnly(res);
  if (aiEnabled()) return res.status(403).json({ error: 'Use "Check my answer": the AI marks it and your teacher sees the feedback.' });
  if (assignment.submitted_at) {
    return res.status(409).json({ error: 'You have already handed this assignment in. Ask your teacher to reopen it.' });
  }
  const { rows } = await query(
    `SELECT q.marks, q.criteria FROM assignment_questions aq JOIN questions q ON q.id = aq.question_id
      WHERE aq.assignment_id = $1 AND q.id = $2`,
    [assignment.id, req.params.questionId],
  );
  const question = rows[0];
  if (!question) return res.status(404).json({ error: 'That question is not part of this assignment.' });

  const points = question.criteria.length;
  const ticked = [...new Set((Array.isArray(req.body.ticked) ? req.body.ticked : [])
    .map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < points))].sort((a, b) => a - b);
  const requested = Number.isInteger(req.body.awarded) ? req.body.awarded : ticked.length;
  const awarded = Math.max(0, Math.min(question.marks, requested));
  const answer = String(req.body.answer || '').slice(0, 20000);

  const saved = await query(
    `INSERT INTO attempts (user_id, question_id, answer, ticked, awarded, marks, assignment_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, answer, ticked, awarded, marks, marked_by, created_at`,
    [req.userId, req.params.questionId, answer, ticked, awarded, question.marks, assignment.id],
  );
  res.status(201).json({ attempt: saved.rows[0] });
}));

// Check an answer to one question of the assignment with the AI marker: { answer } → { correct, attempt }.
// Saved with the AI's feedback for the teacher; the student sees the mark and a hint only.
router.post('/:id/questions/:questionId/check', wrap(async (req, res) => {
  const assignment = await findMine(req, Number(req.params.id));
  if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });
  if (assignment.kind === 'mock') return mockOnly(res);
  if (assignment.submitted_at) {
    return res.status(409).json({ error: 'You have already handed this assignment in. Ask your teacher to reopen it.' });
  }
  const { rows } = await query(
    `SELECT ${MARKING_COLUMNS}
       FROM assignment_questions aq
       JOIN questions q ON q.id = aq.question_id
       JOIN papers p ON p.number = q.paper
       LEFT JOIN subjects sub ON sub.id = p.subject_id
       LEFT JOIN exam_papers e ON e.code = q.exam_code
      WHERE aq.assignment_id = $1 AND q.id = $2`,
    [assignment.id, req.params.questionId],
  );
  const question = rows[0];
  if (!question) return res.status(404).json({ error: 'That question is not part of this assignment.' });
  const answer = String(req.body.answer || '').slice(0, 20000);
  if (!answer.trim()) return res.status(400).json({ error: 'Write your answer first.' });
  if (!underLimit(req.userId)) return res.status(429).json({ error: 'You have checked a lot of answers in a short time. Wait a few minutes and try again.' });

  let result;
  try {
    result = await markAnswer(question, answer);
  } catch (err) {
    if (err instanceof MarkingError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
  const saved = await query(
    `INSERT INTO attempts (user_id, question_id, answer, ticked, awarded, marks, assignment_id, marked_by, ai_feedback, ai_hint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, answer, awarded, marks, marked_by, ai_hint, created_at`,
    [req.userId, question.id, answer, result.ticked, result.mark, question.marks, assignment.id, result.marked_by, result.feedback, result.hint],
  );
  res.status(201).json({ correct: result.correct, attempt: saved.rows[0] });
}));

// Hand the assignment in. After this the answers are locked until the teacher reopens it.
router.post('/:id/submit', wrap(async (req, res) => {
  const assignment = await findMine(req, Number(req.params.id));
  if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });
  if (assignment.submitted_at) return res.status(409).json({ error: 'This assignment is already handed in.' });
  const { rows } = await query(
    `UPDATE assignment_students SET submitted_at = now() WHERE assignment_id = $1 AND student_id = $2
     RETURNING submitted_at`,
    [assignment.id, req.userId],
  );
  const late = Boolean(assignment.due_at && new Date(rows[0].submitted_at) > new Date(assignment.due_at));
  if (assignment.kind === 'mock') {
    await fillBlankAnswers(assignment.id, req.userId);
    queueSuggestions(assignment.id, req.userId);
  }
  res.json({ submitted_at: rows[0].submitted_at, late });
}));

// Mock exam: start the clock. Pressing Start again later does not restart it.
router.post('/:id/start', wrap(async (req, res) => {
  const assignment = await findMine(req, Number(req.params.id));
  if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });
  if (assignment.kind !== 'mock') return res.status(400).json({ error: 'Only mock exams have a start.' });
  if (assignment.submitted_at) return res.status(409).json({ error: 'This mock exam is already handed in.' });
  const { rows } = await query(
    `UPDATE assignment_students SET started_at = coalesce(started_at, now())
      WHERE assignment_id = $1 AND student_id = $2 RETURNING started_at`,
    [assignment.id, req.userId],
  );
  res.json({ started_at: rows[0].started_at, deadline: deadlineOf({ ...assignment, started_at: rows[0].started_at }) });
}));

// Mock exam: save my answer to one question (autosaved while I type). { answer }
router.put('/:id/answers/:questionId', wrap(async (req, res) => {
  const assignment = await findMine(req, Number(req.params.id));
  if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });
  if (assignment.kind !== 'mock') return res.status(400).json({ error: 'Only mock exams save answers this way.' });
  if (!assignment.started_at) return res.status(409).json({ error: 'Press Start before you answer.' });
  if (assignment.submitted_at) return res.status(409).json({ error: 'Time is up: this mock exam has been handed in.' });
  const found = await query('SELECT 1 FROM assignment_questions WHERE assignment_id = $1 AND question_id = $2', [assignment.id, req.params.questionId]);
  if (!found.rowCount) return res.status(404).json({ error: 'That question is not part of this mock exam.' });
  const answer = String(req.body.answer || '').slice(0, 20000);
  await query(
    `INSERT INTO mock_answers (assignment_id, student_id, question_id, answer, saved_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (assignment_id, student_id, question_id) DO UPDATE SET answer = EXCLUDED.answer, saved_at = now()`,
    [assignment.id, req.userId, req.params.questionId, answer],
  );
  res.json({ saved: true });
}));

// The mock exam as the student sees it. Before results are released: the questions and my answers only
// (no mark scheme, no marks). After release: my marks, the points I made, the mark scheme and the comments.
async function mockPaper(req, assignment) {
  const released = Boolean(assignment.results_released_at);
  const showQuestions = Boolean(assignment.started_at);
  const { rows } = await query(
    `SELECT q.id, q.paper, q.label, q.marks, q.prompt, q.context_note, q.figures, q.answer_type,
            p.label AS paper_label, e.label AS exam_label, aq.position,
            ${released ? 'q.criteria, q.max_note, q.final_answer, q.answer_figures,' : ''}
            m.answer, m.saved_at
            ${released ? ', m.mark, m.ticked, m.comment' : ''}
       FROM assignment_questions aq
       JOIN questions q ON q.id = aq.question_id
       JOIN papers p ON p.number = q.paper
       LEFT JOIN exam_papers e ON e.code = q.exam_code
       LEFT JOIN mock_answers m ON m.assignment_id = aq.assignment_id AND m.question_id = q.id AND m.student_id = $2
      WHERE aq.assignment_id = $1
      ORDER BY aq.position`,
    [assignment.id, req.userId],
  );
  const marks = rows.reduce((t, q) => t + q.marks, 0);
  const questions = showQuestions || released ? rows : rows.map((q) => ({ id: q.id, marks: q.marks, position: q.position }));
  return {
    assignment: { ...assignment, marks, teacher_comment: released ? assignment.teacher_comment : '' },
    questions,
    earned: released ? rows.reduce((t, q) => t + (q.mark || 0), 0) : null,
    server_time: new Date(),
  };
}

export default router;
