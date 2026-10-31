import { Router } from 'express';
import { query } from '../db.js';
import { requireApproved, requireAuth, wrap } from '../auth.js';
import * as stats from '../stats.js';
import { visiblePapers } from '../scope.js';

const router = Router();
router.use(requireAuth, requireApproved);

// Papers this account may use, worked out once per request.
router.use(wrap(async (req, res, next) => {
  req.papers = await visiblePapers(req.userId, req.role);
  next();
}));

const ORDER = 'q.chapter, q.subtopic, q.exam_code, q.id';

const paperNumber = (req, value) => {
  const n = Number(value);
  return req.papers.includes(n) ? n : null;
};

// Papers with their chapters and how far this student has got in each.
router.get('/papers', wrap(async (req, res) => {
  const papers = await query(
    `SELECT p.*, s.code AS subject_code, s.name AS subject_name
       FROM papers p LEFT JOIN subjects s ON s.id = p.subject_id
      WHERE p.number = ANY($1) ORDER BY p.number`,
    [req.papers],
  );
  const chapters = await query(
    `SELECT c.paper, c.number, c.name,
            count(q.id)::int AS questions,
            count(la.id)::int AS attempted,
            coalesce(sum(la.awarded), 0)::int AS earned,
            coalesce(sum(la.marks), 0)::int AS available
       FROM chapters c
       LEFT JOIN questions q ON q.paper = c.paper AND q.chapter = c.number
       LEFT JOIN latest_attempts la ON la.question_id = q.id AND la.user_id = $1
      GROUP BY c.paper, c.number, c.name
      ORDER BY c.paper, c.number`,
    [req.userId],
  );
  const exams = await query('SELECT code, paper, label FROM exam_papers ORDER BY paper, code');
  res.json({
    papers: papers.rows.map((p) => {
      const chs = chapters.rows.filter((c) => c.paper === p.number);
      const sum = (k) => chs.reduce((t, c) => t + c[k], 0);
      return {
        ...p,
        questions: sum('questions'),
        attempted: sum('attempted'),
        earned: sum('earned'),
        available: sum('available'),
        chapters: chs,
        exams: exams.rows.filter((e) => e.paper === p.number),
      };
    }),
  });
}));

// Question list for one paper, with filters.
router.get('/papers/:paper/questions', wrap(async (req, res) => {
  const paper = paperNumber(req, req.params.paper);
  if (!paper) return res.status(404).json({ error: 'No such paper.' });

  const params = [req.userId, paper];
  const where = ['q.paper = $2'];
  const add = (sql, value) => { params.push(value); where.push(sql.replaceAll('?', `$${params.length}`)); };

  if (req.query.chapter) add('q.chapter = ?', Number(req.query.chapter));
  if (req.query.exam) add('q.exam_code = ?', String(req.query.exam));
  if (req.query.type) add('q.answer_type = ?', String(req.query.type));
  if (req.query.search) {
    add('(q.prompt ILIKE ? OR q.subtopic ILIKE ?)', `%${String(req.query.search).trim()}%`);
  }
  if (req.query.status === 'new') where.push('la.id IS NULL');
  if (req.query.status === 'review') where.push('la.awarded < la.marks');
  if (req.query.status === 'done') where.push('la.awarded >= la.marks');
  if (req.query.bookmarked === '1') where.push('b.user_id IS NOT NULL');

  const { rows } = await query(
    `SELECT q.id, q.label, q.marks, q.chapter, q.subtopic, q.answer_type, q.exam_code,
            e.label AS exam_label, left(q.prompt, 180) AS preview,
            la.awarded, (b.user_id IS NOT NULL) AS bookmarked
       FROM questions q
       LEFT JOIN exam_papers e ON e.code = q.exam_code
       LEFT JOIN latest_attempts la ON la.question_id = q.id AND la.user_id = $1
       LEFT JOIN bookmarks b ON b.question_id = q.id AND b.user_id = $1
      WHERE ${where.join(' AND ')}
      ORDER BY ${ORDER}`,
    params,
  );
  res.json({ questions: rows });
}));

// Picks a question to practise next: unanswered first, then ones that lost marks.
router.get('/papers/:paper/next', wrap(async (req, res) => {
  const paper = paperNumber(req, req.params.paper);
  if (!paper) return res.status(404).json({ error: 'No such paper.' });
  const params = [req.userId, paper];
  let chapterFilter = '';
  if (req.query.chapter) { params.push(Number(req.query.chapter)); chapterFilter = 'AND q.chapter = $3'; }
  const { rows } = await query(
    `SELECT q.id
       FROM questions q
       LEFT JOIN latest_attempts la ON la.question_id = q.id AND la.user_id = $1
      WHERE q.paper = $2 ${chapterFilter}
      ORDER BY CASE WHEN la.id IS NULL THEN 0 WHEN la.awarded < la.marks THEN 1 ELSE 2 END, random()
      LIMIT 1`,
    params,
  );
  res.json({ id: rows[0]?.id || null });
}));

router.get('/questions/:id', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT q.*, e.label AS exam_label, e.qp_url, e.ms_url, c.name AS chapter_name,
            p.label AS paper_label, (b.user_id IS NOT NULL) AS bookmarked
       FROM questions q
       LEFT JOIN exam_papers e ON e.code = q.exam_code
       LEFT JOIN chapters c ON c.paper = q.paper AND c.number = q.chapter
       LEFT JOIN papers p ON p.number = q.paper
       LEFT JOIN bookmarks b ON b.question_id = q.id AND b.user_id = $2
      WHERE q.id = $1 AND q.paper = ANY($3)`,
    [req.params.id, req.userId, req.papers],
  );
  const question = rows[0];
  if (!question) return res.status(404).json({ error: 'Question not found.' });

  const nav = await query(
    `SELECT prev_id, next_id FROM (
       SELECT q.id, lag(q.id) OVER w AS prev_id, lead(q.id) OVER w AS next_id
         FROM questions q WHERE q.paper = $2
       WINDOW w AS (ORDER BY ${ORDER})
     ) t WHERE id = $1`,
    [question.id, question.paper],
  );
  const attempts = await query(
    `SELECT id, answer, ticked, awarded, marks, created_at FROM attempts
      WHERE user_id = $1 AND question_id = $2 ORDER BY created_at DESC, id DESC`,
    [req.userId, question.id],
  );
  res.json({ question, ...nav.rows[0], attempts: attempts.rows });
}));

// Save a self-marked attempt. The mark is checked against the question's maximum.
router.post('/questions/:id/attempts', wrap(async (req, res) => {
  const { rows } = await query('SELECT marks, criteria FROM questions WHERE id = $1 AND paper = ANY($2)', [req.params.id, req.papers]);
  const question = rows[0];
  if (!question) return res.status(404).json({ error: 'Question not found.' });

  const points = question.criteria.length;
  const ticked = [...new Set((Array.isArray(req.body.ticked) ? req.body.ticked : [])
    .map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < points))].sort((a, b) => a - b);
  const requested = Number.isInteger(req.body.awarded) ? req.body.awarded : ticked.length;
  const awarded = Math.max(0, Math.min(question.marks, requested));
  const answer = String(req.body.answer || '').slice(0, 20000);

  const saved = await query(
    `INSERT INTO attempts (user_id, question_id, answer, ticked, awarded, marks)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, answer, ticked, awarded, marks, created_at`,
    [req.userId, req.params.id, answer, ticked, awarded, question.marks],
  );
  res.status(201).json({ attempt: saved.rows[0] });
}));

router.put('/questions/:id/bookmark', wrap(async (req, res) => {
  const found = await query('SELECT 1 FROM questions WHERE id = $1 AND paper = ANY($2)', [req.params.id, req.papers]);
  if (!found.rowCount) return res.status(404).json({ error: 'Question not found.' });
  await query(
    'INSERT INTO bookmarks (user_id, question_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [req.userId, req.params.id],
  );
  res.json({ bookmarked: true });
}));

router.delete('/questions/:id/bookmark', wrap(async (req, res) => {
  await query('DELETE FROM bookmarks WHERE user_id = $1 AND question_id = $2', [req.userId, req.params.id]);
  res.json({ bookmarked: false });
}));

router.get('/bookmarks', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT q.id, q.paper, p.label AS paper_label, q.label, q.marks, q.subtopic, e.label AS exam_label,
            left(q.prompt, 180) AS preview, la.awarded, b.created_at
       FROM bookmarks b
       JOIN questions q ON q.id = b.question_id
       JOIN papers p ON p.number = q.paper
       LEFT JOIN exam_papers e ON e.code = q.exam_code
       LEFT JOIN latest_attempts la ON la.question_id = q.id AND la.user_id = b.user_id
      WHERE b.user_id = $1
      ORDER BY b.created_at DESC`,
    [req.userId],
  );
  res.json({ bookmarks: rows });
}));

router.get('/stats', wrap(async (req, res) => {
  const [totals, weakest, recent, streak, activity] = await Promise.all([
    stats.totals(req.userId, req.papers), stats.weakest(req.userId), stats.recent(req.userId),
    stats.streak(req.userId), stats.activity(req.userId, 14),
  ]);
  res.json({ totals, weakest, recent, streak, activity });
}));

// Clear a student's attempts, for one paper or for everything.
router.delete('/progress', wrap(async (req, res) => {
  const paper = req.query.paper ? paperNumber(req, req.query.paper) : null;
  if (req.query.paper && !paper) return res.status(400).json({ error: 'No such paper.' });
  const result = paper
    ? await query(
      'DELETE FROM attempts a USING questions q WHERE a.question_id = q.id AND a.user_id = $1 AND q.paper = $2',
      [req.userId, paper],
    )
    : await query('DELETE FROM attempts WHERE user_id = $1', [req.userId]);
  res.json({ deleted: result.rowCount });
}));

export default router;
