import jwt from 'jsonwebtoken';
import { query } from './db.js';

const secret = () => {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set in .env');
  return process.env.JWT_SECRET;
};

export function signToken(user) {
  return jwt.sign({ sub: user.id }, secret(), { expiresIn: '7d' });
}

// Lets Express 4 pass errors from async route handlers to the error handler.
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Rejects the request unless it carries a valid "Authorization: Bearer <token>" header.
// The account is re-read every time, so approving or blocking someone in pgAdmin takes effect at once.
export const requireAuth = wrap(async (req, res, next) => {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please log in.' });
  let payload;
  try {
    payload = jwt.verify(token, secret());
  } catch {
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
  const { rows } = await query('SELECT id, role, status FROM users WHERE id = $1', [payload.sub]);
  if (!rows[0]) return res.status(401).json({ error: 'Account not found.' });
  if (rows[0].status === 'rejected') return res.status(401).json({ error: 'This account has been blocked. Speak to your teacher.' });
  req.userId = rows[0].id;
  req.role = rows[0].role;
  req.status = rows[0].status;
  next();
});

export function requireApproved(req, res, next) {
  if (req.status !== 'approved') {
    return res.status(403).json({ error: 'Your account is waiting for your teacher to approve it.', code: 'pending' });
  }
  next();
}

// Roles from least to most powerful.
export const ROLES = ['student', 'teacher', 'admin', 'super_admin'];
export const isStaff = (role) => role === 'admin' || role === 'super_admin';

// Allows the request only for the listed roles.
export const requireRole = (roles, message = 'You do not have permission to do that.') => (req, res, next) => {
  if (!roles.includes(req.role)) return res.status(403).json({ error: message });
  next();
};

// Teachers, plus admins and super admins (who can see every teacher's work).
export const requireTeacher = requireRole(['teacher', 'admin', 'super_admin'], 'Teachers only.');
export const requireAdmin = requireRole(['admin', 'super_admin'], 'Admins only.');
export const requireSuperAdmin = requireRole(['super_admin'], 'Super admins only.');

export function requireStudent(req, res, next) {
  if (req.role !== 'student') return res.status(403).json({ error: 'Students only.' });
  next();
}
