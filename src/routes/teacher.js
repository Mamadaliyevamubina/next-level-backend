import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireTeacher, wrap } from '../auth.js';
import * as stats from '../stats.js';
import { visiblePapers } from '../scope.js';

const router = Router();
router.use(requireAuth, requireTeacher);

// Teachers see the students who chose them; an admin sees every student.
const scope = (req, alias = 's') => (req.role === 'admin'
  ? { sql: `${alias}.role = 'student'`, params: [] }
  : { sql: `${alias}.role = 'student' AND ${alias}.teacher_id = $1`, params: [req.userId] });

async function findStudent(req, id) {
  const { sql, params } = scope(req);
  const { rows } = await query(
    `SELECT s.id, s.username, s.name, s.email, s.status, s.class_name, s.created_at, s.approved_at, s.last_seen_at,
            sub.name AS subject_name, t.name AS teacher_name
       FROM users s
       LEFT JOIN subjects sub ON sub.id = s.subject_id
       LEFT JOIN users t ON t.id = s.teacher_id
      WHERE ${sql} AND s.id = $${params.length + 1}`,
    [...params, id],
  );
  return rows[0] || null;
}

// Every student with their headline numbers.
router.get('/students', wrap(async (req, res) => {
  const { sql, params } = scope(req);
  const { rows } = await query(
    `SELECT s.id, s.username, s.name, s.email, s.status, s.class_name, s.created_at, s.last_seen_at,
            sub.name AS subject_name, t.name AS teacher_name,
            coalesce(la.answered, 0) AS answered, coalesce(la.earned, 0) AS earned, coalesce(la.available, 0) AS available,
            coalesce(act.week, 0) AS week_attempts, act.last_attempt,
            coalesce(pp.papers, '[]') AS papers
       FROM users s
       LEFT JOIN subjects sub ON sub.id = s.subject_id
       LEFT JOIN users t ON t.id = s.teacher_id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS answered, sum(awarded)::int AS earned, sum(marks)::int AS available
           FROM latest_attempts WHERE user_id = s.id
       ) la ON true
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS week, max(created_at) AS last_attempt
           FROM attempts WHERE user_id = s.id
       ) act ON true
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object('paper', paper, 'label', label, 'earned', earned, 'available', available) ORDER BY paper) AS papers
           FROM (SELECT q.paper, p.label, sum(l.awarded)::int AS earned, sum(l.marks)::int AS available
                   FROM latest_attempts l JOIN questions q ON q.id = l.question_id JOIN papers p ON p.number = q.paper
                  WHERE l.user_id = s.id GROUP BY q.paper, p.label) x
       ) pp ON true
      WHERE ${sql}
      ORDER BY CASE s.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, s.class_name, s.name`,
    params,
  );
  const papers = await query(
    'SELECT number, label FROM papers WHERE number = ANY($1) ORDER BY number',
    [await visiblePapers(req.userId, req.role)],
  );
  res.json({ students: rows, papers: papers.rows });
}));

// Class summaries and the topics the teacher's approved students lose most marks on.
router.get('/overview', wrap(async (req, res) => {
  const { sql, params } = scope(req);
  const classes = await query(
    `SELECT s.class_name,
            count(*)::int AS students,
            count(*) FILTER (WHERE s.status = 'pending')::int AS pending,
            coalesce(sum(la.earned), 0)::int AS earned, coalesce(sum(la.available), 0)::int AS available,
            coalesce(sum(la.answered), 0)::int AS answered
       FROM users s
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS answered, sum(awarded)::int AS earned, sum(marks)::int AS available
           FROM latest_attempts WHERE user_id = s.id
       ) la ON s.status = 'approved'
      WHERE ${sql} AND s.status <> 'rejected'
      GROUP BY s.class_name ORDER BY s.class_name`,
    params,
  );
  const topics = await query(
    `SELECT q.paper, p.label AS paper_label, q.subtopic, count(DISTINCT l.user_id)::int AS students,
            sum(l.awarded)::int AS earned, sum(l.marks)::int AS available
       FROM latest_attempts l
       JOIN users s ON s.id = l.user_id
       JOIN questions q ON q.id = l.question_id
       JOIN papers p ON p.number = q.paper
      WHERE ${sql} AND s.status = 'approved'
      GROUP BY q.paper, p.label, q.subtopic
     HAVING sum(l.marks) >= 3 AND sum(l.awarded) < sum(l.marks)
      ORDER BY sum(l.awarded)::float / sum(l.marks), sum(l.marks) DESC
      LIMIT 8`,
    params,
  );
  res.json({ classes: classes.rows, topics: topics.rows });
}));

// One student in detail: progress by paper and chapter, weak topics, and their recent answers.
router.get('/students/:id', wrap(async (req, res) => {
  const student = await findStudent(req, Number(req.params.id));
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  const id = student.id;
  const course = await visiblePapers(id, 'student');
  const [totals, papers, chapters, weakest, recent, streak, activity] = await Promise.all([
    stats.totals(id, course), stats.byPaper(id, course), stats.byChapter(id, course), stats.weakest(id, 10),
    stats.recent(id, 25, true), stats.streak(id), stats.activity(id, 28),
  ]);
  res.json({ student, totals, papers, chapters, weakest, recent, streak, activity });
}));

// Approve, block or move a student back to pending.
router.post('/students/:id/status', wrap(async (req, res) => {
  const status = String(req.body.status || '');
  if (!['approved', 'rejected', 'pending'].includes(status)) return res.status(400).json({ error: 'Unknown status.' });
  const student = await findStudent(req, Number(req.params.id));
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  await query(
    `UPDATE users SET status = $2, approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE NULL END WHERE id = $1`,
    [student.id, status],
  );
  res.json({ id: student.id, status });
}));

export default router;
