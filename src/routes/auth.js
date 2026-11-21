import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool, query } from '../db.js';
import { requireAuth, signToken, wrap } from '../auth.js';
import { EMAIL_RE, GRADES, USERNAME_RE, checkStudentChoices, choicesFromBody, inTransaction, loadProfile, setStudentSubjects } from '../users.js';

const router = Router();

// True while the site has no admin or super admin yet: the login page then offers to create the first super admin.
async function needsSetup() {
  const { rowCount } = await query("SELECT 1 FROM users WHERE role IN ('admin', 'super_admin') LIMIT 1");
  return rowCount === 0;
}

router.get('/setup', wrap(async (req, res) => {
  res.json({ needsSetup: await needsSetup() });
}));

// Creates the first super admin. Refused as soon as any admin or super admin exists.
router.post('/setup', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const username = String(req.body.username || '').trim().toLowerCase();
  const email = String(req.body.email || '').trim().toLowerCase() || null;
  const password = String(req.body.password || '');
  if (!name) return res.status(400).json({ error: 'Enter your full name.' });
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Login name must be 3–30 characters: letters, numbers, dots, dashes or underscores.' });
  }
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address, or leave it empty.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  // One transaction with a lock, so two people pressing "Create" at once cannot both become super admin.
  const client = await pool.connect();
  let id;
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const staff = await client.query("SELECT 1 FROM users WHERE role IN ('admin', 'super_admin') LIMIT 1");
    if (staff.rowCount) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This site is already set up. Log in, or ask an admin for an account.' });
    }
    const taken = await client.query(
      'SELECT 1 FROM users WHERE lower(username) = $1 OR ($2::text IS NOT NULL AND lower(email) = $2)',
      [username, email],
    );
    if (taken.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'That login name or email is already used.' });
    }
    const { rows } = await client.query(
      `INSERT INTO users (name, username, email, password_hash, role, status, approved_at)
       VALUES ($1, $2, $3, $4, 'super_admin', 'approved', now()) RETURNING id`,
      [name, username, email, await bcrypt.hash(password, 10)],
    );
    id = rows[0].id;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.status(201).json({ token: signToken({ id }), user: await loadProfile(id) });
}));

// Grades, subjects (with their level: igcse or alevel) and teachers for the sign-up form.
router.get('/options', wrap(async (req, res) => {
  const subjects = await query('SELECT id, code, name, level FROM subjects ORDER BY name');
  const teachers = await query(
    `SELECT t.id, t.name, array_agg(ts.subject_id ORDER BY ts.subject_id) AS subject_ids
       FROM users t JOIN teacher_subjects ts ON ts.teacher_id = t.id
      WHERE t.role IN ('teacher', 'admin', 'super_admin') AND t.status = 'approved'
      GROUP BY t.id, t.name ORDER BY t.name`,
  );
  res.json({ grades: GRADES, levels: { 9: 'igcse', 10: 'igcse', 11: 'alevel', 12: 'alevel' }, subjects: subjects.rows, teachers: teachers.rows });
}));

// Student sign-up. The account starts as "pending" until a teacher approves it.
// { name, username, email?, password, grade, class_name, subjects: [{ subject_id, teacher_id }, ...] }
router.post('/register', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const username = String(req.body.username || '').trim().toLowerCase();
  const email = String(req.body.email || '').trim().toLowerCase() || null;
  const password = String(req.body.password || '');
  const className = String(req.body.class_name || '').trim();

  if (!name) return res.status(400).json({ error: 'Enter your full name.' });
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Login name must be 3–30 characters: letters, numbers, dots, dashes or underscores.' });
  }
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address, or leave it empty.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!className) return res.status(400).json({ error: 'Enter your class.' });
  const choices = await checkStudentChoices(req.body.grade, choicesFromBody(req.body));
  if (choices.error) return res.status(400).json({ error: choices.error });

  const taken = await query(
    'SELECT lower(username) = $1 AS same_username FROM users WHERE lower(username) = $1 OR ($2::text IS NOT NULL AND lower(email) = $2)',
    [username, email],
  );
  if (taken.rowCount) {
    return res.status(409).json({ error: taken.rows[0].same_username ? 'That login name is already taken.' : 'An account with that email already exists.' });
  }

  const hash = await bcrypt.hash(password, 10);
  const id = await inTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO users (name, username, email, password_hash, role, status, grade, class_name)
       VALUES ($1, $2, $3, $4, 'student', 'pending', $5, $6) RETURNING id`,
      [name, username, email, hash, choices.grade, className],
    );
    await setStudentSubjects(client, rows[0].id, choices.pairs);
    return rows[0].id;
  });
  res.status(201).json({ token: signToken({ id }), user: await loadProfile(id) });
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
