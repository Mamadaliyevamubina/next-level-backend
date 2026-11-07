// Creates a teacher, admin or super admin account, or promotes an existing account.
// Use this to make the first super admin; after that, super admins appoint admins from the app (/api/admin).
//
//   npm run create-user -- --role teacher --username ms.karimova --name "Dilnoza Karimova" --password "secret123" --subject 9618
//   npm run create-user -- --role admin --username principal --name "Head Teacher" --password "secret123"
//   npm run create-user -- --role super_admin --username owner --name "Site Owner" --password "secret123"
//   npm run create-user -- --role teacher --username existing.user --subject 9618     (promote, keeps password)
//
// --subject can be repeated, or given as a comma-separated list of subject codes.
import { parseArgs } from 'node:util';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import 'dotenv/config';

const { values } = parseArgs({
  options: {
    role: { type: 'string', default: 'teacher' },
    username: { type: 'string' },
    name: { type: 'string' },
    password: { type: 'string' },
    email: { type: 'string' },
    subject: { type: 'string', multiple: true, default: [] },
  },
});

async function main() {
  if (!['teacher', 'admin', 'super_admin', 'student'].includes(values.role)) throw new Error('--role must be student, teacher, admin or super_admin');
  const username = String(values.username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new Error('--username must be 3–30 letters, numbers, dots, dashes or underscores');

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM users WHERE lower(username) = $1', [username]);
    let id;
    if (existing.rowCount) {
      id = existing.rows[0].id;
      await client.query(
        `UPDATE users SET role = $2, status = 'approved', approved_at = coalesce(approved_at, now()),
                name = coalesce($3, name), email = coalesce($4, email) WHERE id = $1`,
        [id, values.role, values.name || null, values.email?.toLowerCase() || null],
      );
      if (values.password) {
        await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, await bcrypt.hash(values.password, 10)]);
      }
      console.log(`Updated ${username}: now an approved ${values.role}.`);
    } else {
      if (!values.name) throw new Error('--name is required for a new account');
      if (!values.password || values.password.length < 8) throw new Error('--password (at least 8 characters) is required for a new account');
      const { rows } = await client.query(
        `INSERT INTO users (name, username, email, password_hash, role, status, approved_at)
         VALUES ($1, $2, $3, $4, $5, 'approved', now()) RETURNING id`,
        [values.name, username, values.email?.toLowerCase() || null, await bcrypt.hash(values.password, 10), values.role],
      );
      id = rows[0].id;
      console.log(`Created ${values.role} ${username}.`);
    }

    const codes = values.subject.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
    for (const code of codes) {
      const subject = await client.query('SELECT id, name FROM subjects WHERE code = $1 OR lower(name) = lower($1)', [code]);
      if (!subject.rowCount) throw new Error(`No subject with code "${code}". Add it to the subjects table first.`);
      await client.query(
        'INSERT INTO teacher_subjects (teacher_id, subject_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, subject.rows[0].id],
      );
      console.log(`  teaches ${subject.rows[0].name}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
