// Adds teachers and students from a CSV file (save it from Excel or Google Sheets as "CSV").
// Each student is linked to their class, their subject and the teacher who teaches them.
//
//   npm run import-users -- path/to/students.csv            check the file, change nothing
//   npm run import-users -- path/to/students.csv --save     add / update the accounts
//
// Columns (header row required, order does not matter, extra columns are ignored):
//   role      student or teacher (empty = student)
//   name      full name (required)
//   username  login name; empty = made from the name, e.g. "Aziz Karimov" → aziz.karimov
//   email     optional
//   password  optional; empty = a random password is made for new accounts
//   class     students: their class, e.g. 12A (required)
//   subject   students: subject code 9618, 9701, 0478 or 0620 (required)
//             teachers: the subjects they teach, separated by ; e.g. 9618;0478
//   teacher   students: the teacher's login name or full name (required)
//
// Teachers are added first, so students in the same file can name them.
// Someone already in the database (same login name) is updated; their password is kept unless the file gives one.
// New accounts are approved straight away. Their passwords are written to <file>-passwords.csv to hand out.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import 'dotenv/config';

const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Small CSV reader: commas or semicolons, quoted fields, "" inside quotes, Windows line endings.
function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

// "Aziz Karimov" → "aziz.karimov" (letters only, accents and apostrophes dropped).
function usernameFrom(name) {
  return name.normalize('NFKD').replace(/[̀-ͯ'’ʻʼ`]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 30) || 'user';
}

// Easy to read aloud: no 0/O or 1/l.
function randomPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(10), (b) => chars[b % chars.length]).join('');
}

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const save = args.includes('--save');
  if (!file) throw new Error('Give the CSV file: npm run import-users -- students.csv [--save]');
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);

  const [header, ...lines] = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const cols = header.map((h) => h.trim().toLowerCase());
  for (const need of ['name']) if (!cols.includes(need)) throw new Error(`The file needs a "${need}" column. Columns found: ${cols.join(', ')}`);
  const records = lines.map((cells, i) => {
    const r = { line: i + 2 };
    cols.forEach((c, j) => { r[c] = (cells[j] || '').trim(); });
    r.role = (r.role || 'student').toLowerCase();
    return r;
  });

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const errors = [];
  const out = [];
  try {
    const subjects = (await client.query('SELECT id, code, name FROM subjects')).rows;
    const subjectByCode = (code) => subjects.find((s) => s.code === code.trim() || s.name.toLowerCase() === code.trim().toLowerCase());
    const existing = (await client.query('SELECT id, lower(username) AS username, lower(email) AS email, name, role FROM users')).rows;
    const usedNames = new Set(existing.map((u) => u.username));

    // Check every row first; nothing is saved if any row has a problem.
    const plan = [];
    const fileNames = new Set();
    for (const r of [...records].sort((a, b) => (a.role === 'teacher' ? 0 : 1) - (b.role === 'teacher' ? 0 : 1))) {
      const fail = (msg) => errors.push(`Line ${r.line} (${r.name || 'no name'}): ${msg}`);
      if (!['student', 'teacher'].includes(r.role)) { fail(`role must be student or teacher, not "${r.role}"`); continue; }
      if (!r.name) { fail('name is empty'); continue; }
      let username = (r.username || '').toLowerCase();
      // Without a login name, someone with exactly this name and role is the same person (so running the file twice is safe).
      // Accounts that another row names by login name are not candidates.
      const claimed = new Set(records.map((x) => (x.username || '').toLowerCase()).filter(Boolean));
      const sameName = username ? [] : existing.filter((u) => u.name.toLowerCase() === r.name.toLowerCase() && u.role === r.role && !claimed.has(u.username) && !fileNames.has(u.username));
      if (sameName.length > 1) { fail(`two ${r.role}s are already called "${r.name}"; add their login name to this row`); continue; }
      if (sameName.length === 1) username = sameName[0].username;
      const match = username ? existing.find((u) => u.username === username) : null;
      if (!username) {
        // Made-up login names never clash with someone else in the database or earlier in the file.
        const base = usernameFrom(r.name).slice(0, 27);
        username = base.length >= 3 ? base : `${base}.user`;
        for (let n = 2; usedNames.has(username) || fileNames.has(username); n += 1) username = `${base}${n}`;
      }
      if (!USERNAME_RE.test(username)) { fail(`login name "${username}" must be 3–30 letters, numbers, dots, dashes or underscores`); continue; }
      if (fileNames.has(username)) { fail(`login name "${username}" appears twice in the file`); continue; }
      fileNames.add(username);
      if (match && match.role !== r.role) { fail(`"${username}" already exists as ${match.role}; this file says ${r.role}`); continue; }
      const email = (r.email || '').toLowerCase() || null;
      if (email && !EMAIL_RE.test(email)) { fail(`email "${email}" is not valid`); continue; }
      if (email && existing.some((u) => u.email === email && u.username !== username)) { fail(`email ${email} is used by another account`); continue; }
      if (r.password && r.password.length < 8) { fail('password must be at least 8 characters'); continue; }

      const item = { ...r, username, email, existing: match };
      if (r.role === 'teacher') {
        const codes = (r.subject || r.subjects || '').split(/[;|/]/).map((s) => s.trim()).filter(Boolean);
        const found = codes.map(subjectByCode);
        if (found.some((s) => !s)) { fail(`unknown subject in "${r.subject}" (use ${subjects.map((s) => s.code).join(', ')})`); continue; }
        item.subjectIds = found.map((s) => s.id);
      } else {
        if (!r.class) { fail('class is empty'); continue; }
        const subject = r.subject && subjectByCode(r.subject);
        if (!subject) { fail(`unknown or empty subject "${r.subject || ''}" (use ${subjects.map((s) => s.code).join(', ')})`); continue; }
        if (!r.teacher) { fail('teacher is empty'); continue; }
        item.subjectId = subject.id;
      }
      plan.push(item);
    }

    // Students' teachers: someone in the database, or a teacher earlier in this file.
    const teachersInDb = (await client.query(
      `SELECT t.id, lower(t.username) AS username, lower(t.name) AS name, array_agg(ts.subject_id) AS subjects
         FROM users t LEFT JOIN teacher_subjects ts ON ts.teacher_id = t.id
        WHERE t.role IN ('teacher', 'admin', 'super_admin') GROUP BY t.id`,
    )).rows;
    const teacherKey = (s) => s.trim().toLowerCase();
    for (const item of plan.filter((p) => p.role === 'student')) {
      const key = teacherKey(item.teacher);
      const fromFile = plan.find((p) => p.role === 'teacher' && (p.username === key || p.name.toLowerCase() === key));
      const fromDb = teachersInDb.filter((t) => t.username === key || t.name === key);
      if (!fromFile && fromDb.length > 1) { errors.push(`Line ${item.line} (${item.name}): two teachers are called "${item.teacher}"; use the login name`); continue; }
      const teaches = fromFile ? fromFile.subjectIds : fromDb[0]?.subjects;
      if (!fromFile && !fromDb.length) { errors.push(`Line ${item.line} (${item.name}): no teacher "${item.teacher}" (add them as a teacher row, or check the spelling)`); continue; }
      if (!teaches.includes(item.subjectId)) {
        errors.push(`Line ${item.line} (${item.name}): ${item.teacher} does not teach ${subjects.find((s) => s.id === item.subjectId).code}`);
        continue;
      }
      item.teacherRef = fromFile ? { username: fromFile.username } : { id: fromDb[0].id };
    }

    const teachersCount = plan.filter((p) => p.role === 'teacher').length;
    const studentsCount = plan.filter((p) => p.role === 'student').length;
    const updates = plan.filter((p) => p.existing).length;
    console.log(`${records.length} rows: ${teachersCount} teachers, ${studentsCount} students (${plan.length - updates} new, ${updates} already in the database).`);
    const nameCount = {};
    for (const p of plan) nameCount[`${p.role}:${p.name.toLowerCase()}`] = (nameCount[`${p.role}:${p.name.toLowerCase()}`] || 0) + 1;
    for (const [key, n] of Object.entries(nameCount)) {
      if (n > 1) console.log(`Note: "${key.split(':')[1]}" appears ${n} times as ${key.split(':')[0]}. That is fine for different people with the same name; if it is one person typed twice, remove the extra row.`);
    }
    if (errors.length) {
      errors.sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
      console.log(`\n${errors.length} problem${errors.length === 1 ? '' : 's'} to fix in the file:`);
      errors.forEach((e) => console.log(`  ${e}`));
      console.log('\nNothing was saved. Fix these lines and run it again.');
      process.exitCode = 1;
      return;
    }
    if (!save) {
      for (const p of plan) {
        const what = p.role === 'teacher'
          ? `teacher, teaches ${p.subjectIds.map((id) => subjects.find((s) => s.id === id).code).join(', ') || 'nothing yet'}`
          : `student, class ${p.class}, ${subjects.find((s) => s.id === p.subjectId).code}, teacher ${p.teacher}`;
        console.log(`  ${p.existing ? 'update' : 'add   '} ${p.username.padEnd(24)} ${p.name} · ${what}`);
      }
      console.log('\nEverything looks right. Nothing was saved yet: run again with --save to add them.');
      return;
    }

    await client.query('BEGIN');
    const idByUsername = {};
    for (const p of plan) {
      const password = p.password || (p.existing ? null : randomPassword());
      const hash = password ? await bcrypt.hash(password, 10) : null;
      let id;
      if (p.existing) {
        id = p.existing.id;
        await client.query(
          `UPDATE users SET name = $2, email = coalesce($3, email), password_hash = coalesce($4, password_hash),
                  status = 'approved', approved_at = coalesce(approved_at, now()) WHERE id = $1`,
          [id, p.name, p.email, hash],
        );
      } else {
        const { rows } = await client.query(
          `INSERT INTO users (name, username, email, password_hash, role, status, approved_at)
           VALUES ($1, $2, $3, $4, $5, 'approved', now()) RETURNING id`,
          [p.name, p.username, p.email, hash, p.role],
        );
        id = rows[0].id;
      }
      idByUsername[p.username] = id;
      if (p.role === 'teacher') {
        await client.query('INSERT INTO teacher_subjects (teacher_id, subject_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING', [id, p.subjectIds]);
      } else {
        const teacherId = p.teacherRef.id ?? idByUsername[p.teacherRef.username];
        await client.query('UPDATE users SET class_name = $2, subject_id = $3, teacher_id = $4 WHERE id = $1', [id, p.class, p.subjectId, teacherId]);
      }
      out.push({ role: p.role, name: p.name, username: p.username, password: password || '(not changed: same as before)', class: p.class || '', subject: p.subject || '', teacher: p.teacher || '' });
    }
    await client.query('COMMIT');

    // A new file every time, so passwords from an earlier run are never overwritten.
    const base = path.join(path.dirname(file), path.basename(file, path.extname(file)));
    let target = `${base}-passwords.csv`;
    for (let n = 2; fs.existsSync(target); n += 1) target = `${base}-passwords-${n}.csv`;
    const header2 = ['role', 'name', 'username', 'password', 'class', 'subject', 'teacher'];
    fs.writeFileSync(target, `${[header2, ...out.map((o) => header2.map((h) => o[h]))].map((r) => r.map(csvCell).join(',')).join('\n')}\n`, { mode: 0o600 });
    console.log(`Saved: ${teachersCount} teachers and ${studentsCount} students.`);
    console.log(`Login names and passwords: ${target}`);
    console.log('Keep that file private and delete it once everyone has their password.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  if (err.code === 'ECONNREFUSED' || err.errors?.some((e) => e.code === 'ECONNREFUSED')) {
    console.error('Could not connect to PostgreSQL: it is not running, or DATABASE_URL in .env points to the wrong host/port.');
  } else {
    console.error(err.message || err.code || err);
  }
  process.exit(1);
});
