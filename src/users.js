import { query } from './db.js';

export const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Appearance and study preferences a user can change on the Account page.
const SETTING_RULES = {
  theme: ['system', 'light', 'dark'],
  accent: ['purple', 'blue', 'teal', 'rose', 'amber'],
  fontSize: ['small', 'medium', 'large'],
  font: ['inter', 'readable'],
  reduceMotion: 'boolean',
  compact: 'boolean',
  showStreak: 'boolean',
  defaultPaper: [null, 1, 2, 3, 4, 11, 12],
  dailyGoal: 'goal',
};

export const DEFAULT_SETTINGS = {
  theme: 'system',
  accent: 'purple',
  fontSize: 'medium',
  font: 'inter',
  reduceMotion: false,
  compact: false,
  showStreak: true,
  defaultPaper: null,
  dailyGoal: 10,
};

export function cleanSettings(input) {
  const out = {};
  for (const [key, rule] of Object.entries(SETTING_RULES)) {
    if (!(key in (input || {}))) continue;
    const value = input[key];
    if (rule === 'boolean' && typeof value === 'boolean') out[key] = value;
    else if (rule === 'goal' && Number.isInteger(value) && value >= 1 && value <= 100) out[key] = value;
    else if (Array.isArray(rule) && rule.includes(value)) out[key] = value;
  }
  return out;
}

// Full profile of one user, as sent to the browser (never includes the password hash).
export async function loadProfile(id) {
  const { rows } = await query(
    `SELECT u.id, u.username, u.name, u.email, u.role, u.status, u.class_name, u.subject_id, u.teacher_id,
            u.settings, u.created_at, s.name AS subject_name, t.name AS teacher_name,
            coalesce((SELECT json_agg(json_build_object('id', ts.subject_id, 'name', ss.name) ORDER BY ss.name)
                        FROM teacher_subjects ts JOIN subjects ss ON ss.id = ts.subject_id
                       WHERE ts.teacher_id = u.id), '[]') AS teaches
       FROM users u
       LEFT JOIN subjects s ON s.id = u.subject_id
       LEFT JOIN users t ON t.id = u.teacher_id
      WHERE u.id = $1`,
    [id],
  );
  const user = rows[0];
  if (user) user.settings = { ...DEFAULT_SETTINGS, ...user.settings };
  return user || null;
}

// Checks that a student's chosen teacher really teaches the chosen subject.
export async function validTeacherChoice(subjectId, teacherId) {
  const { rowCount } = await query(
    `SELECT 1 FROM users t JOIN teacher_subjects ts ON ts.teacher_id = t.id
      WHERE t.id = $1 AND ts.subject_id = $2 AND t.role IN ('teacher', 'admin') AND t.status = 'approved'`,
    [teacherId, subjectId],
  );
  return rowCount > 0;
}
