import { query } from './db.js';

// Which papers an account can see:
// students → the papers of their subject; teachers → the subjects they teach; admin → everything.
// Accounts without a subject (e.g. made before courses existed) see everything.
export async function visiblePapers(userId, role) {
  let sql = 'SELECT number FROM papers ORDER BY number';
  let params = [];
  if (role === 'student') {
    sql = `SELECT p.number FROM papers p, users u
            WHERE u.id = $1 AND (u.subject_id IS NULL OR p.subject_id = u.subject_id) ORDER BY p.number`;
    params = [userId];
  } else if (role === 'teacher') {
    sql = `SELECT p.number FROM papers p
            WHERE NOT EXISTS (SELECT 1 FROM teacher_subjects WHERE teacher_id = $1)
               OR p.subject_id IN (SELECT subject_id FROM teacher_subjects WHERE teacher_id = $1)
            ORDER BY p.number`;
    params = [userId];
  }
  const { rows } = await query(sql, params);
  return rows.map((r) => r.number);
}
