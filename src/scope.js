import { query } from './db.js';

// Which papers an account can see:
// students → the papers of their subjects, and IGCSE students (grade 9–10, or taking an IGCSE subject)
// also every IGCSE paper; teachers → the subjects they teach; admin → everything.
// Accounts without a subject (e.g. made before courses existed) see everything.
export async function visiblePapers(userId, role) {
  let sql = 'SELECT number FROM papers ORDER BY number';
  let params = [];
  if (role === 'student') {
    sql = `SELECT p.number FROM papers p
            WHERE NOT EXISTS (SELECT 1 FROM student_subjects WHERE student_id = $1)
               OR p.subject_id IN (SELECT subject_id FROM student_subjects WHERE student_id = $1)
               OR (p.subject_id IN (SELECT id FROM subjects WHERE level = 'igcse')
                   AND (EXISTS (SELECT 1 FROM users WHERE id = $1 AND grade IN (9, 10))
                        OR EXISTS (SELECT 1 FROM student_subjects ss JOIN subjects s ON s.id = ss.subject_id
                                    WHERE ss.student_id = $1 AND s.level = 'igcse')))
            ORDER BY p.number`;
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
