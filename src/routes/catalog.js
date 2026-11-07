import { Router } from 'express';
import { query } from '../db.js';
import { wrap } from '../auth.js';

const router = Router();

// Public: the courses on the home page, with live counts from the database. No login needed.
router.get('/', wrap(async (req, res) => {
  const subjects = await query('SELECT id, code, name FROM subjects ORDER BY id');
  const papers = await query(
    `SELECT p.number, p.label, p.title, p.description, p.subject_id,
            (SELECT count(*)::int FROM questions q WHERE q.paper = p.number) AS questions,
            (SELECT count(*)::int FROM exam_papers e WHERE e.paper = p.number) AS sittings
       FROM papers p ORDER BY p.number`,
  );
  const chapters = await query(
    `SELECT c.paper, c.number, c.name, count(q.id)::int AS questions
       FROM chapters c LEFT JOIN questions q ON q.paper = c.paper AND q.chapter = c.number
      GROUP BY c.paper, c.number, c.name ORDER BY c.paper, c.number`,
  );
  const courses = subjects.rows.map((s) => {
    const list = papers.rows.filter((p) => p.subject_id === s.id).map((p) => ({
      number: p.number,
      label: p.label,
      title: p.title,
      description: p.description,
      questions: p.questions,
      sittings: p.sittings,
      chapters: chapters.rows.filter((c) => c.paper === p.number && c.questions > 0).map(({ number, name, questions }) => ({ number, name, questions })),
    }));
    return {
      code: s.code,
      name: s.name,
      papers: list,
      questions: list.reduce((t, p) => t + p.questions, 0),
      sittings: list.reduce((t, p) => t + p.sittings, 0),
    };
  }).filter((c) => c.papers.length);
  res.json({ courses });
}));

export default router;
