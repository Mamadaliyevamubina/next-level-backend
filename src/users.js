import { query } from './db.js';

// Grades 9–10 take Cambridge IGCSE, grades 11–12 take AS & A Level.
export const GRADES = [9, 10, 11, 12];
export const LEVEL_NAMES = { igcse: 'IGCSE', alevel: 'A Level' };
export const levelForGrade = (grade) => (grade === 9 || grade === 10 ? 'igcse' : grade === 11 || grade === 12 ? 'alevel' : null);

// A student's subjects as one row: a JSON list plus comma-separated subject and teacher names.
// Used as a LATERAL subquery; alias is the users table alias of the student.
export const STUDENT_SUBJECTS_SQL = (alias) => `
  SELECT json_agg(json_build_object('subject_id', sub.id, 'code', sub.code, 'name', sub.name, 'level', sub.level,
                                    'teacher_id', ss.teacher_id, 'teacher_name', t.name) ORDER BY ss.position, sub.name) AS subjects,
         string_agg(sub.name, ', ' ORDER BY ss.position, sub.name) AS subject_name,
         string_agg(DISTINCT t.name, ', ') AS teacher_name
    FROM student_subjects ss
    JOIN subjects sub ON sub.id = ss.subject_id
    LEFT JOIN users t ON t.id = ss.teacher_id
   WHERE ss.student_id = ${alias}.id`;

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
// subject_name and teacher_name list every subject and teacher of a student, e.g. "Chemistry (9701), Biology (9700)".
export async function loadProfile(id) {
  const { rows } = await query(
    `SELECT u.id, u.username, u.name, u.email, u.role, u.status, u.grade, u.class_name, u.subject_id, u.teacher_id,
            u.settings, u.created_at,
            coalesce(ss.subjects, '[]') AS subjects, ss.subject_name, ss.teacher_name,
            coalesce((SELECT json_agg(json_build_object('id', ts.subject_id, 'name', sx.name) ORDER BY sx.name)
                        FROM teacher_subjects ts JOIN subjects sx ON sx.id = ts.subject_id
                       WHERE ts.teacher_id = u.id), '[]') AS teaches
       FROM users u
       LEFT JOIN LATERAL (${STUDENT_SUBJECTS_SQL('u')}) ss ON true
      WHERE u.id = $1`,
    [id],
  );
  const user = rows[0];
  if (user) {
    user.settings = { ...DEFAULT_SETTINGS, ...user.settings };
    user.level = levelForGrade(user.grade);
  }
  return user || null;
}

// Checks a student's grade and subject choices: [{ subject_id, teacher_id }, ...].
// Every subject must be at the level of the grade, and every teacher must teach their subject.
// Returns { grade, pairs } or { error }.
export async function checkStudentChoices(gradeValue, list) {
  const grade = Number(gradeValue);
  const level = levelForGrade(grade);
  if (!level) return { error: 'Choose your grade (9, 10, 11 or 12).' };
  const items = Array.isArray(list) ? list : [];
  const pairs = items.map((x) => ({ subject_id: Number(x?.subject_id), teacher_id: Number(x?.teacher_id) }));
  if (!pairs.length) return { error: 'Choose at least one subject.' };
  if (pairs.length > 10) return { error: 'Choose at most 10 subjects.' };
  if (new Set(pairs.map((p) => p.subject_id)).size !== pairs.length) return { error: 'Each subject can only be chosen once.' };

  const { rows } = await query(
    `SELECT s.id, s.name, s.level, coalesce(array_agg(ts.teacher_id) FILTER (WHERE t.id IS NOT NULL), '{}') AS teachers
       FROM subjects s
       LEFT JOIN teacher_subjects ts ON ts.subject_id = s.id
       LEFT JOIN users t ON t.id = ts.teacher_id AND t.role IN ('teacher', 'admin', 'super_admin') AND t.status = 'approved'
      WHERE s.id = ANY($1) GROUP BY s.id`,
    [pairs.map((p) => p.subject_id).filter(Number.isInteger)],
  );
  for (const p of pairs) {
    const subject = rows.find((r) => r.id === p.subject_id);
    if (!subject) return { error: 'One of the chosen subjects does not exist.' };
    if (subject.level !== level) {
      return { error: `${subject.name} is ${LEVEL_NAMES[subject.level]}. Grade ${grade} students take ${LEVEL_NAMES[level]} subjects.` };
    }
    if (!subject.teachers.includes(p.teacher_id)) return { error: `Choose your teacher for ${subject.name}.` };
  }
  return { grade, pairs };
}

// Replaces a student's subjects (inside a transaction: pass the client).
// The first subject is also kept in users.subject_id / users.teacher_id.
export async function setStudentSubjects(client, studentId, pairs) {
  await client.query('DELETE FROM student_subjects WHERE student_id = $1', [studentId]);
  for (const [i, p] of pairs.entries()) {
    await client.query(
      'INSERT INTO student_subjects (student_id, subject_id, teacher_id, position) VALUES ($1, $2, $3, $4)',
      [studentId, p.subject_id, p.teacher_id, i],
    );
  }
  await client.query('UPDATE users SET subject_id = $2, teacher_id = $3 WHERE id = $1',
    [studentId, pairs[0]?.subject_id ?? null, pairs[0]?.teacher_id ?? null]);
}

// Subject choices from a request body: { subjects: [{ subject_id, teacher_id }] },
// or the older single { subject_id, teacher_id }. undefined when the body has neither.
export function choicesFromBody(body) {
  if (body.subjects !== undefined) return body.subjects;
  if (body.subject_id !== undefined) return [{ subject_id: body.subject_id, teacher_id: body.teacher_id }];
  return undefined;
}

// The student's current choices, in the same shape checkStudentChoices returns.
export function currentPairs(profile) {
  return (profile.subjects || []).map((s) => ({ subject_id: s.subject_id, teacher_id: s.teacher_id }));
}

// True when the new choices add a subject/teacher pair the student did not have before
// (that teacher has not approved them yet). Dropping a subject needs no approval.
export function addsNewTeacher(before, after) {
  const key = (p) => `${p.subject_id}:${p.teacher_id}`;
  const had = new Set(before.map(key));
  return after.some((p) => !had.has(key(p)));
}

export async function inTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
