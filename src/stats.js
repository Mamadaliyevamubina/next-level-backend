import { query } from './db.js';

// Progress figures for one student, shared by the student dashboard and the teacher pages.

// `papers` limits the question count to the student's course.
export async function totals(userId, papers) {
  const { rows } = await query(
    `SELECT count(*)::int AS answered,
            coalesce(sum(awarded), 0)::int AS earned,
            coalesce(sum(marks), 0)::int AS available,
            count(*) FILTER (WHERE awarded >= marks)::int AS full_marks,
            (SELECT count(*)::int FROM attempts WHERE user_id = $1) AS attempts,
            (SELECT count(*)::int FROM attempts WHERE user_id = $1 AND created_at >= date_trunc('day', now())) AS today,
            (SELECT count(*)::int FROM questions WHERE paper = ANY($2)) AS questions
       FROM latest_attempts WHERE user_id = $1`,
    [userId, papers],
  );
  return rows[0];
}

export async function byPaper(userId, papers) {
  const { rows } = await query(
    `SELECT p.number AS paper, p.label, p.title, count(la.id)::int AS answered, count(q.id)::int AS questions,
            coalesce(sum(la.awarded), 0)::int AS earned, coalesce(sum(la.marks), 0)::int AS available
       FROM papers p
       JOIN questions q ON q.paper = p.number
       LEFT JOIN latest_attempts la ON la.question_id = q.id AND la.user_id = $1
      WHERE p.number = ANY($2)
      GROUP BY p.number, p.label, p.title ORDER BY p.number`,
    [userId, papers],
  );
  return rows;
}

export async function byChapter(userId, papers) {
  const { rows } = await query(
    `SELECT c.paper, p.label AS paper_label, c.number, c.name, count(la.id)::int AS answered, count(q.id)::int AS questions,
            coalesce(sum(la.awarded), 0)::int AS earned, coalesce(sum(la.marks), 0)::int AS available
       FROM chapters c
       JOIN papers p ON p.number = c.paper
       JOIN questions q ON q.paper = c.paper AND q.chapter = c.number
       LEFT JOIN latest_attempts la ON la.question_id = q.id AND la.user_id = $1
      WHERE c.paper = ANY($2)
      GROUP BY c.paper, p.label, c.number, c.name ORDER BY c.paper, c.number`,
    [userId, papers],
  );
  return rows;
}

export async function weakest(userId, limit = 6) {
  const { rows } = await query(
    `SELECT q.paper, p.label AS paper_label, q.chapter, q.subtopic,
            sum(la.awarded)::int AS earned, sum(la.marks)::int AS available, count(*)::int AS answered
       FROM latest_attempts la JOIN questions q ON q.id = la.question_id JOIN papers p ON p.number = q.paper
      WHERE la.user_id = $1
      GROUP BY q.paper, p.label, q.chapter, q.subtopic
     HAVING sum(la.marks) > 0 AND sum(la.awarded) < sum(la.marks)
      ORDER BY sum(la.awarded)::float / sum(la.marks), sum(la.marks) DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

export async function recent(userId, limit = 8, withAnswers = false) {
  const { rows } = await query(
    `SELECT a.id, a.question_id, a.awarded, a.marks, a.created_at, q.paper, p.label AS paper_label, q.label, q.subtopic,
            e.label AS exam_label ${withAnswers ? ', a.answer' : ''}
       FROM attempts a
       JOIN questions q ON q.id = a.question_id
       JOIN papers p ON p.number = q.paper
       LEFT JOIN exam_papers e ON e.code = q.exam_code
      WHERE a.user_id = $1
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

// Attempts per day for the last `days` days (oldest first), for activity charts.
export async function activity(userId, days = 14) {
  const { rows } = await query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day, count(a.id)::int AS attempts
       FROM generate_series(date_trunc('day', now()) - ($2::int - 1) * interval '1 day', date_trunc('day', now()), interval '1 day') d
       LEFT JOIN attempts a ON a.user_id = $1 AND date_trunc('day', a.created_at) = d
      GROUP BY d ORDER BY d`,
    [userId, days],
  );
  return rows;
}

// Number of consecutive days, ending today or yesterday, with at least one attempt.
export async function streak(userId) {
  // Days come back as 'YYYY-MM-DD' text in the database's time zone, so no time zone shifting happens in JS.
  const { rows } = await query(
    `SELECT DISTINCT to_char(created_at, 'YYYY-MM-DD') AS day, to_char(now(), 'YYYY-MM-DD') AS today
       FROM attempts WHERE user_id = $1 ORDER BY day DESC LIMIT 400`,
    [userId],
  );
  if (!rows.length) return 0;
  const key = (d) => d.toISOString().slice(0, 10);
  const have = new Set(rows.map((r) => r.day));
  const day = new Date(`${rows[0].today}T00:00:00Z`);
  if (!have.has(key(day))) day.setUTCDate(day.getUTCDate() - 1);
  let count = 0;
  while (have.has(key(day))) {
    count += 1;
    day.setUTCDate(day.getUTCDate() - 1);
  }
  return count;
}
