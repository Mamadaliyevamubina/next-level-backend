import { Router } from 'express';
import { query } from '../db.js';
import { requireApproved, requireAuth, wrap } from '../auth.js';

// The competition: students ranked by how many questions they have solved (full marks on at least one attempt)
// this week, this month or ever, in one subject or all of them, and optionally inside one class.
const router = Router();
router.use(requireAuth, requireApproved);

const PERIODS = {
  week: "date_trunc('week', now())",
  month: "date_trunc('month', now())",
  all: null,
};

// Shown as "solving now" when the student's last answer was this recent.
const ACTIVE_MINUTES = 15;

router.get('/', wrap(async (req, res) => {
  const period = Object.hasOwn(PERIODS, req.query.period) ? req.query.period : 'week';
  const className = typeof req.query.class === 'string' ? req.query.class.trim().slice(0, 40) : '';

  const subjects = (await query(
    `SELECT DISTINCT s.id, s.code, s.name FROM subjects s JOIN papers p ON p.subject_id = s.id ORDER BY s.name`,
  )).rows;

  // Students start on their own (first) subject, so they compete with classmates doing the same papers.
  let subject = null;
  if (req.query.subject === 'all') subject = null;
  else if (req.query.subject && subjects.some((s) => String(s.id) === String(req.query.subject))) subject = Number(req.query.subject);
  else if (req.role === 'student') {
    const mine = await query('SELECT subject_id FROM student_subjects WHERE student_id = $1 ORDER BY subject_id LIMIT 1', [req.userId]);
    subject = mine.rows[0]?.subject_id ?? null;
  }

  const since = PERIODS[period];
  const { rows } = await query(
    `WITH best AS (
       SELECT a.user_id, a.question_id, max(a.awarded) AS awarded, max(a.marks) AS marks, max(a.created_at) AS last_at
         FROM attempts a
         JOIN questions q ON q.id = a.question_id
         JOIN papers p ON p.number = q.paper
        WHERE ($1::int IS NULL OR p.subject_id = $1)
          ${since ? `AND a.created_at >= ${since}` : ''}
        GROUP BY a.user_id, a.question_id
     )
     SELECT u.id, u.name, u.class_name,
            count(b.question_id)::int AS tried,
            (count(*) FILTER (WHERE b.awarded >= b.marks))::int AS solved,
            coalesce(sum(b.awarded), 0)::int AS earned,
            coalesce(sum(b.marks), 0)::int AS available,
            max(b.last_at) AS last_at,
            coalesce(max(b.last_at) > now() - make_interval(mins => $3), false) AS active
       FROM users u
       LEFT JOIN best b ON b.user_id = u.id
      WHERE u.role = 'student' AND u.status = 'approved'
        AND ($2 = '' OR u.class_name = $2)
        AND ($1::int IS NULL
             OR EXISTS (SELECT 1 FROM student_subjects ss WHERE ss.student_id = u.id AND ss.subject_id = $1)
             OR b.question_id IS NOT NULL)
      GROUP BY u.id
      ORDER BY solved DESC, earned DESC, tried DESC, u.name`,
    [subject, className, ACTIVE_MINUTES],
  );

  // Ties share a place: 1, 2, 2, 4.
  let place = 0;
  const ranked = rows.map((r, i) => {
    const prev = rows[i - 1];
    if (!prev || prev.solved !== r.solved || prev.earned !== r.earned) place = i + 1;
    return { ...r, place, me: r.id === req.userId };
  });
  const started = ranked.filter((r) => r.tried > 0 || r.me);
  const classes = (await query(
    `SELECT DISTINCT class_name FROM users
      WHERE role = 'student' AND status = 'approved' AND class_name <> '' ORDER BY class_name`,
  )).rows.map((r) => r.class_name);

  res.json({
    period,
    subject,
    class: className,
    subjects,
    classes,
    leaders: started.slice(0, 100),
    me: ranked.find((r) => r.me) || null,
    competitors: ranked.length,
    not_started: ranked.filter((r) => r.tried === 0 && !r.me).length,
    solved_total: ranked.reduce((t, r) => t + r.solved, 0),
    active_now: ranked.filter((r) => r.active).length,
  });
}));

export default router;
