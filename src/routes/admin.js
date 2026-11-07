import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool, query } from '../db.js';
import { ROLES, requireAdmin, requireAuth, requireSuperAdmin, wrap } from '../auth.js';
import { EMAIL_RE, USERNAME_RE, loadProfile, validTeacherChoice } from '../users.js';

// Account management for admins and super admins.
//
//   super_admin  can do everything, and is the only role that can create, promote, change or delete admins
//                (and other super admins).
//   admin        can see every account and all activity, and manage teachers and students:
//                create them, approve or block them, edit them, reset passwords, move students between teachers.
//                Admins cannot touch admin or super admin accounts, cannot give anyone admin rights,
//                and cannot delete accounts (they can block them instead).
const router = Router();
router.use(requireAuth, requireAdmin);

const manageableRoles = (role) => (role === 'super_admin' ? ROLES : ['student', 'teacher']);
const canManage = (req, target) => manageableRoles(req.role).includes(target.role);

async function loadTarget(req, res) {
  const id = Number(req.params.id);
  const { rows } = await query('SELECT id, role, status FROM users WHERE id = $1', [id]);
  const target = rows[0];
  if (!target) {
    res.status(404).json({ error: 'Account not found.' });
    return null;
  }
  if (target.id === req.userId) {
    res.status(400).json({ error: 'Use the Account page to change your own account.' });
    return null;
  }
  if (!canManage(req, target)) {
    res.status(403).json({ error: 'Only a super admin can change admin accounts.' });
    return null;
  }
  return target;
}

// Subject ids from ids or codes, e.g. [1, "9618"].
async function subjectIds(values) {
  const list = (Array.isArray(values) ? values : [values]).filter((v) => v !== undefined && v !== null && v !== '').map(String);
  if (!list.length) return { ids: [] };
  const { rows } = await query('SELECT id, code FROM subjects WHERE id::text = ANY($1) OR code = ANY($1)', [list]);
  const known = new Set(rows.flatMap((r) => [String(r.id), r.code]));
  const unknown = list.filter((v) => !known.has(v));
  if (unknown.length) return { error: `Unknown subject: ${unknown.join(', ')}` };
  return { ids: [...new Set(rows.map((r) => r.id))] };
}

async function setTeacherSubjects(client, userId, ids) {
  await client.query('DELETE FROM teacher_subjects WHERE teacher_id = $1', [userId]);
  if (ids.length) {
    await client.query(
      'INSERT INTO teacher_subjects (teacher_id, subject_id) SELECT $1, unnest($2::int[])',
      [userId, ids],
    );
  }
}

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Headline numbers for the whole school.
router.get('/overview', wrap(async (req, res) => {
  const [roles, activity, assignments] = await Promise.all([
    query(`SELECT role, status, count(*)::int AS count FROM users GROUP BY role, status ORDER BY role, status`),
    query(`SELECT count(*)::int AS attempts_week, count(DISTINCT user_id)::int AS active_students_week
             FROM attempts WHERE created_at > now() - interval '7 days'`),
    query(`SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE due_at IS NULL OR due_at > now())::int AS open
             FROM assignments`),
  ]);
  res.json({ users: roles.rows, activity: activity.rows[0], assignments: assignments.rows[0] });
}));

// Every account. Filters: role, status, search (name, login name, email or class).
router.get('/users', wrap(async (req, res) => {
  const params = [];
  const where = ['true'];
  const add = (sql, value) => { params.push(value); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (req.query.role) add('u.role = ?', String(req.query.role));
  if (req.query.status) add('u.status = ?', String(req.query.status));
  if (req.query.search) {
    add('(u.name ILIKE ? OR u.username ILIKE ? OR u.email ILIKE ? OR u.class_name ILIKE ?)', `%${String(req.query.search).trim()}%`);
  }
  const { rows } = await query(
    `SELECT u.id, u.username, u.name, u.email, u.role, u.status, u.class_name, u.subject_id, u.teacher_id,
            u.created_at, u.approved_at, u.last_seen_at, s.name AS subject_name, t.name AS teacher_name,
            cb.name AS created_by_name,
            coalesce((SELECT json_agg(json_build_object('id', ts.subject_id, 'name', ss.name) ORDER BY ss.name)
                        FROM teacher_subjects ts JOIN subjects ss ON ss.id = ts.subject_id
                       WHERE ts.teacher_id = u.id), '[]') AS teaches,
            (SELECT count(*)::int FROM users st WHERE st.teacher_id = u.id AND st.role = 'student') AS student_count
       FROM users u
       LEFT JOIN subjects s ON s.id = u.subject_id
       LEFT JOIN users t ON t.id = u.teacher_id
       LEFT JOIN users cb ON cb.id = u.created_by
      WHERE ${where.join(' AND ')}
      ORDER BY array_position($${params.length + 1}::text[], u.role) DESC, u.name`,
    [...params, ROLES],
  );
  const roles = manageableRoles(req.role);
  res.json({
    users: rows.map((u) => ({ ...u, can_manage: u.id !== req.userId && roles.includes(u.role) })),
    manageable_roles: roles,
  });
}));

// Create an account.
// { role, name, username, email?, password, subjects?: [...] (teachers), subject_id, teacher_id, class_name (students) }
router.post('/users', wrap(async (req, res) => {
  const role = String(req.body.role || '');
  if (!ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}.` });
  if (!manageableRoles(req.role).includes(role)) return res.status(403).json({ error: 'Only a super admin can create admin accounts.' });

  const name = String(req.body.name || '').trim();
  const username = String(req.body.username || '').trim().toLowerCase();
  const email = String(req.body.email || '').trim().toLowerCase() || null;
  const password = String(req.body.password || '');
  if (!name) return res.status(400).json({ error: 'Enter a name.' });
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Login name must be 3–30 characters: letters, numbers, dots, dashes or underscores.' });
  }
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address, or leave it empty.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  let className = '';
  let subjectId = null;
  let teacherId = null;
  if (role === 'student') {
    className = String(req.body.class_name || '').trim();
    subjectId = Number(req.body.subject_id);
    teacherId = Number(req.body.teacher_id);
    if (!className) return res.status(400).json({ error: 'Enter the student\'s class.' });
    if (!(await validTeacherChoice(subjectId, teacherId))) {
      return res.status(400).json({ error: 'Choose a subject and a teacher who teaches it.' });
    }
  }
  const subjects = role === 'teacher' ? await subjectIds(req.body.subjects) : { ids: [] };
  if (subjects.error) return res.status(400).json({ error: subjects.error });

  const taken = await query(
    'SELECT 1 FROM users WHERE lower(username) = $1 OR ($2::text IS NOT NULL AND lower(email) = $2)',
    [username, email],
  );
  if (taken.rowCount) return res.status(409).json({ error: 'That login name or email is already used.' });

  const hash = await bcrypt.hash(password, 10);
  const id = await inTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO users (name, username, email, password_hash, role, status, approved_at, class_name, subject_id, teacher_id, created_by)
       VALUES ($1, $2, $3, $4, $5, 'approved', now(), $6, $7, $8, $9) RETURNING id`,
      [name, username, email, hash, role, className, subjectId, teacherId, req.userId],
    );
    if (role === 'teacher') await setTeacherSubjects(client, rows[0].id, subjects.ids);
    return rows[0].id;
  });
  res.status(201).json({ user: await loadProfile(id) });
}));

// Edit an account: { name?, email?, status?, class_name?, subject_id?, teacher_id? (students), subjects? (teachers) }
router.patch('/users/:id', wrap(async (req, res) => {
  const target = await loadTarget(req, res);
  if (!target) return;
  const current = await loadProfile(target.id);

  const name = req.body.name === undefined ? current.name : String(req.body.name).trim();
  const email = req.body.email === undefined ? current.email : (String(req.body.email).trim().toLowerCase() || null);
  const status = req.body.status === undefined ? current.status : String(req.body.status);
  if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address, or leave it empty.' });
  if (!['pending', 'approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Unknown status.' });
  if (email && email !== current.email) {
    const clash = await query('SELECT 1 FROM users WHERE id <> $1 AND lower(email) = $2', [target.id, email]);
    if (clash.rowCount) return res.status(409).json({ error: 'Another account already uses that email.' });
  }

  let { class_name: className, subject_id: subjectId, teacher_id: teacherId } = current;
  if (target.role === 'student') {
    if (req.body.class_name !== undefined) className = String(req.body.class_name).trim();
    const nextSubject = req.body.subject_id === undefined ? subjectId : Number(req.body.subject_id);
    const nextTeacher = req.body.teacher_id === undefined ? teacherId : Number(req.body.teacher_id);
    if (nextSubject !== subjectId || nextTeacher !== teacherId) {
      if (!(await validTeacherChoice(nextSubject, nextTeacher))) {
        return res.status(400).json({ error: 'Choose a teacher who teaches that subject.' });
      }
      subjectId = nextSubject;
      teacherId = nextTeacher;
    }
  }
  const subjects = target.role === 'teacher' && req.body.subjects !== undefined ? await subjectIds(req.body.subjects) : null;
  if (subjects?.error) return res.status(400).json({ error: subjects.error });

  await inTransaction(async (client) => {
    await client.query(
      `UPDATE users SET name = $2, email = $3, status = $4, class_name = $5, subject_id = $6, teacher_id = $7,
              approved_at = CASE WHEN $4 = 'approved' THEN coalesce(approved_at, now()) ELSE NULL END
        WHERE id = $1`,
      [target.id, name, email, status, className, subjectId, teacherId],
    );
    if (subjects) await setTeacherSubjects(client, target.id, subjects.ids);
  });
  res.json({ user: await loadProfile(target.id) });
}));

// Change someone's role: { role }. Admins can switch accounts between student and teacher;
// only a super admin can make or unmake admins and super admins.
router.post('/users/:id/role', wrap(async (req, res) => {
  const target = await loadTarget(req, res);
  if (!target) return;
  const role = String(req.body.role || '');
  if (!ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}.` });
  if (!manageableRoles(req.role).includes(role)) return res.status(403).json({ error: 'Only a super admin can give admin rights.' });

  await inTransaction(async (client) => {
    await client.query(
      `UPDATE users SET role = $2, created_by = $3,
              status = CASE WHEN $2 = 'student' THEN status ELSE 'approved' END,
              approved_at = CASE WHEN $2 = 'student' THEN approved_at ELSE coalesce(approved_at, now()) END
        WHERE id = $1`,
      [target.id, role, req.userId],
    );
    // Only teachers (and staff) teach subjects.
    if (role === 'student') await client.query('DELETE FROM teacher_subjects WHERE teacher_id = $1', [target.id]);
  });
  res.json({ user: await loadProfile(target.id) });
}));

// Set a new password for someone who forgot theirs: { password }
router.post('/users/:id/password', wrap(async (req, res) => {
  const target = await loadTarget(req, res);
  if (!target) return;
  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [target.id, await bcrypt.hash(password, 10)]);
  res.json({ ok: true });
}));

// Permanently delete an account and everything it owns. Super admins only; admins block accounts instead.
router.delete('/users/:id', requireSuperAdmin, wrap(async (req, res) => {
  const target = await loadTarget(req, res);
  if (!target) return;
  await query('DELETE FROM users WHERE id = $1', [target.id]);
  res.json({ deleted: true });
}));

export default router;
