import { Router } from 'express';
import { query } from '../db.js';
import { requireApproved, requireAuth, requireStudent, wrap } from '../auth.js';

// Students: the quizzes their teacher assigned to them. A student only ever sees their own assignments.
const router = Router();
router.use(requireAuth, requireStudent, requireApproved);

// The student's copy of an assignment, or null if it was not given to them.
async function findMine(req, id) {
  const { rows } = await query(
    `SELECT a.id, a.title, a.instructions, a.due_at, a.created_at, t.name AS teacher_name,
            ast.assigned_at, ast.submitted_at
       FROM assignment_students ast
       JOIN assignments a ON a.id = ast.assignment_id
       JOIN users t ON t.id = a.teacher_id
      WHERE ast.assignment_id = $1 AND ast.student_id = $2`,
    [id, req.userId],
  );
  return rows[0] || null;
}

// All my assignments, newest first, with how far I have got.
router.get('/', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT a.id, a.title, a.instructions, a.due_at, a.created_at, t.name AS teacher_name,
            ast.assigned_at, ast.submitted_at,
            (SELECT count(*)::int FROM assignment_questions WHERE assignment_id = a.id) AS questions,
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
  const { rows } = await query(
    `SELECT q.*, p.label AS paper_label, c.name AS chapter_name, e.label AS exam_label, aq.position,
            CASE WHEN l.id IS NULL THEN NULL ELSE json_build_object(
              'id', l.id, 'answer', l.answer, 'ticked', l.ticked, 'awarded', l.awarded, 'marks', l.marks, 'created_at', l.created_at
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
  res.json({ assignment, questions: rows });
}));

// Save a self-marked answer to one question of the assignment: { answer, ticked, awarded }
router.post('/:id/questions/:questionId/attempts', wrap(async (req, res) => {
  const assignment = await findMine(req, Number(req.params.id));
  if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });
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
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, answer, ticked, awarded, marks, created_at`,
    [req.userId, req.params.questionId, answer, ticked, awarded, question.marks, assignment.id],
  );
  res.status(201).json({ attempt: saved.rows[0] });
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
  res.json({ submitted_at: rows[0].submitted_at, late });
}));

export default router;
