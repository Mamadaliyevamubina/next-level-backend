import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool, query } from '../db.js';
import { requireAuth, wrap } from '../auth.js';
import {
  EMAIL_RE, USERNAME_RE, addsNewTeacher, checkStudentChoices, choicesFromBody, cleanSettings, currentPairs, inTransaction,
  loadProfile, setStudentSubjects,
} from '../users.js';

const router = Router();
router.use(requireAuth);

// Update name, login name, email, and (for students) grade, class and subjects:
// { name?, username?, email?, grade?, class_name?, subjects?: [{ subject_id, teacher_id }] }
// Adding a subject with a teacher who has not approved the student yet sends the account back for approval.
router.patch('/profile', wrap(async (req, res) => {
  const current = await loadProfile(req.userId);
  const name = req.body.name === undefined ? current.name : String(req.body.name).trim();
  const username = req.body.username === undefined ? current.username : String(req.body.username).trim().toLowerCase();
  const email = req.body.email === undefined ? current.email : (String(req.body.email).trim().toLowerCase() || null);

  if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Login name must be 3–30 characters: letters, numbers, dots, dashes or underscores.' });
  }
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address, or leave it empty.' });

  const clash = await query(
    'SELECT lower(username) = $1 AS same_username FROM users WHERE id <> $3 AND (lower(username) = $1 OR ($2::text IS NOT NULL AND lower(email) = $2))',
    [username, email, req.userId],
  );
  if (clash.rowCount) {
    return res.status(409).json({ error: clash.rows[0].same_username ? 'That login name is already taken.' : 'Another account already uses that email.' });
  }

  let { class_name: className, grade, status } = current;
  let pairs = null;
  let needsApproval = false;
  if (current.role === 'student') {
    if (req.body.class_name !== undefined) {
      className = String(req.body.class_name).trim();
      if (!className) return res.status(400).json({ error: 'Class cannot be empty.' });
    }
    const wanted = choicesFromBody(req.body);
    if (wanted !== undefined || req.body.grade !== undefined) {
      const choices = await checkStudentChoices(req.body.grade ?? grade, wanted ?? currentPairs(current));
      if (choices.error) return res.status(400).json({ error: choices.error });
      grade = choices.grade;
      pairs = choices.pairs;
      if (addsNewTeacher(currentPairs(current), pairs)) {
        status = 'pending';
        needsApproval = true;
      }
    }
  }

  await inTransaction(pool, async (client) => {
    await client.query(
      `UPDATE users SET name = $2, username = $3, email = $4, class_name = $5, grade = $6,
              status = $7, approved_at = CASE WHEN $7 = 'pending' THEN NULL ELSE approved_at END
        WHERE id = $1`,
      [req.userId, name, username, email, className, grade, status],
    );
    if (pairs) await setStudentSubjects(client, req.userId, pairs);
  });
  res.json({ user: await loadProfile(req.userId), needsApproval });
}));

router.patch('/settings', wrap(async (req, res) => {
  const settings = cleanSettings(req.body.settings);
  await query('UPDATE users SET settings = settings || $2::jsonb WHERE id = $1', [req.userId, JSON.stringify(settings)]);
  res.json({ user: await loadProfile(req.userId) });
}));

router.post('/password', wrap(async (req, res) => {
  const current = String(req.body.current || '');
  const next = String(req.body.next || '');
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
  if (!(await bcrypt.compare(current, rows[0].password_hash))) {
    return res.status(400).json({ error: 'Your current password is not right.' });
  }
  if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.userId, await bcrypt.hash(next, 10)]);
  res.json({ ok: true });
}));

// Deletes the account and all its answers. Needs the password as confirmation.
router.delete('/', wrap(async (req, res) => {
  const { rows } = await query('SELECT password_hash, role FROM users WHERE id = $1', [req.userId]);
  if (!(await bcrypt.compare(String(req.body.password || ''), rows[0].password_hash))) {
    return res.status(400).json({ error: 'Password is not right.' });
  }
  if (rows[0].role !== 'student') {
    return res.status(400).json({ error: 'Teacher accounts can only be removed by the administrator.' });
  }
  await query('DELETE FROM users WHERE id = $1', [req.userId]);
  res.json({ deleted: true });
}));

export default router;
