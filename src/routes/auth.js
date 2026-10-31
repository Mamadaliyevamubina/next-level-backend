import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { requireAuth, signToken, wrap } from '../auth.js';
import { EMAIL_RE, USERNAME_RE, loadProfile, validTeacherChoice } from '../users.js';

const router = Router();

// Subjects and teachers for the sign-up form.
router.get('/options', wrap(async (req, res) => {
  const subjects = await query('SELECT id, code, name FROM subjects ORDER BY name');
  const teachers = await query(
    `SELECT t.id, t.name, array_agg(ts.subject_id ORDER BY ts.subject_id) AS subject_ids
       FROM users t JOIN teacher_subjects ts ON ts.teacher_id = t.id
      WHERE t.role IN ('teacher', 'admin') AND t.status = 'approved'
      GROUP BY t.id, t.name ORDER BY t.name`,
  );
  res.json({ subjects: subjects.rows, teachers: teachers.rows });
}));

// Student sign-up. The account starts as "pending" until the teacher approves it.
router.post('/register', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const username = String(req.body.username || '').trim().toLowerCase();
  const email = String(req.body.email || '').trim().toLowerCase() || null;
  const password = String(req.body.password || '');
  const className = String(req.body.class_name || '').trim();
  const subjectId = Number(req.body.subject_id);
  const teacherId = Number(req.body.teacher_id);

  if (!name) return res.status(400).json({ error: 'Enter your full name.' });
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Login name must be 3–30 characters: letters, numbers, dots, dashes or underscores.' });
  }
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address, or leave it empty.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!className) return res.status(400).json({ error: 'Enter your class.' });
  if (!(await validTeacherChoice(subjectId, teacherId))) {
    return res.status(400).json({ error: 'Choose your subject and then your teacher for that subject.' });
  }

  const taken = await query(
    'SELECT lower(username) = $1 AS same_username FROM users WHERE lower(username) = $1 OR ($2::text IS NOT NULL AND lower(email) = $2)',
    [username, email],
  );
  if (taken.rowCount) {
    return res.status(409).json({ error: taken.rows[0].same_username ? 'That login name is already taken.' : 'An account with that email already exists.' });
  }

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    `INSERT INTO users (name, username, email, password_hash, role, status, class_name, subject_id, teacher_id)
     VALUES ($1, $2, $3, $4, 'student', 'pending', $5, $6, $7) RETURNING id`,
    [name, username, email, hash, className, subjectId, teacherId],
  );
  res.status(201).json({ token: signToken(rows[0]), user: await loadProfile(rows[0].id) });
}));

// Log in with login name (or email) and password.
router.post('/login', wrap(async (req, res) => {
  const login = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const { rows } = await query(
    'SELECT id, password_hash, status FROM users WHERE lower(username) = $1 OR lower(email) = $1 LIMIT 1',
    [login],
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Wrong login name or password.' });
  }
  if (user.status === 'rejected') {
    return res.status(403).json({ error: 'This account has been blocked. Speak to your teacher.' });
  }
  await query('UPDATE users SET last_seen_at = now() WHERE id = $1', [user.id]);
  res.json({ token: signToken(user), user: await loadProfile(user.id) });
}));

router.get('/me', requireAuth, wrap(async (req, res) => {
  await query('UPDATE users SET last_seen_at = now() WHERE id = $1', [req.userId]);
  res.json({ user: await loadProfile(req.userId) });
}));

export default router;
