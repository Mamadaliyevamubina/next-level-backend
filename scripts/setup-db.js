// Creates the database (if missing), creates the tables, and loads every question from seed/:
// A Level 9618 from alevel-paper1-4.json, IGCSE 0478 from igcse-paper1-2.json.
// Run with: npm run db:setup
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import 'dotenv/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const seedDir = path.resolve(here, '../seed');

const SUBJECTS = {
  9618: 'Computer Science (9618)',
  '0478': 'Computer Science IGCSE (0478)',
};

// number: internal paper id (IGCSE papers are 11 and 12 so they never clash with 9618 Papers 1-4).
const PAPERS = [
  { number: 1, subject: '9618', label: 'Paper 1', title: 'Theory Fundamentals', description: 'AS Level theory: data representation, hardware, networks, security, databases.', source: 'alevel-paper1.json' },
  { number: 2, subject: '9618', label: 'Paper 2', title: 'Fundamental Problem-solving and Programming Skills', description: 'AS Level pseudocode, algorithms and program design.', source: 'alevel-paper2.json' },
  { number: 3, subject: '9618', label: 'Paper 3', title: 'Advanced Theory', description: 'A Level theory: floating point, protocols, AI, further programming.', source: 'alevel-paper3.json' },
  { number: 4, subject: '9618', label: 'Paper 4', title: 'Practical (Python)', description: 'A Level practical programming in Python.', source: 'alevel-paper4.json' },
  { number: 11, subject: '0478', label: 'IGCSE Paper 1', title: 'Computer Systems', description: 'IGCSE theory: data, transmission, hardware, software, the internet, emerging technologies.', source: 'igcse-paper1.json', examPrefix: 'ig-' },
  { number: 12, subject: '0478', label: 'IGCSE Paper 2', title: 'Algorithms, Programming and Logic', description: 'IGCSE algorithms, pseudocode programming, databases and Boolean logic.', source: 'igcse-paper2.json', examPrefix: 'ig-' },
];

// Every seed file has the shape { items, papers, skipped, chapters }.
function loadBank(source) {
  const bank = JSON.parse(fs.readFileSync(path.join(seedDir, source), 'utf8'));
  return { bank, chapters: bank.chapters };
}

async function ensureDatabase(url) {
  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.slice(1));
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!rowCount) {
    await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    console.log(`Created database ${dbName}`);
  }
  await client.end();
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');

  await ensureDatabase(url);
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  await client.query(fs.readFileSync(path.join(here, '../db/schema.sql'), 'utf8'));
  console.log('Tables ready');

  await client.query('BEGIN');
  const subjectIds = {};
  for (const [code, name] of Object.entries(SUBJECTS)) {
    const { rows } = await client.query(
      `INSERT INTO subjects (code, name) VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [code, name],
    );
    subjectIds[code] = rows[0].id;
  }
  let total = 0;
  for (const info of PAPERS) {
    const paper = info.number;
    const prefix = info.examPrefix || '';
    const { bank, chapters } = loadBank(info.source);

    await client.query(
      `INSERT INTO papers (number, title, description, subject_id, label) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (number) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description,
         subject_id = EXCLUDED.subject_id, label = EXCLUDED.label`,
      [paper, info.title, info.description, subjectIds[info.subject], info.label],
    );
    for (const [ch, name] of Object.entries(chapters)) {
      await client.query(
        `INSERT INTO chapters (paper, number, name) VALUES ($1, $2, $3)
         ON CONFLICT (paper, number) DO UPDATE SET name = EXCLUDED.name`,
        [paper, Number(ch), name],
      );
    }
    for (const [code, p] of Object.entries(bank.papers)) {
      await client.query(
        `INSERT INTO exam_papers (code, paper, label, qp_url, ms_url) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, qp_url = EXCLUDED.qp_url, ms_url = EXCLUDED.ms_url`,
        [prefix + code, paper, p.code, p.qp?.startsWith('http') ? p.qp : '', p.ms?.startsWith('http') ? p.ms : ''],
      );
    }
    for (const q of bank.items) {
      const examCode = `${q.session}-${q.variant}`;
      await client.query(
        `INSERT INTO questions (id, paper, exam_code, session, variant, label, marks, chapter, subtopic, prompt,
                                context_note, answer_type, criteria, max_note, rejects, final_answer, confidence,
                                figures, answer_figures)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (id) DO UPDATE SET
           paper = EXCLUDED.paper, exam_code = EXCLUDED.exam_code, session = EXCLUDED.session,
           variant = EXCLUDED.variant, label = EXCLUDED.label, marks = EXCLUDED.marks,
           chapter = EXCLUDED.chapter, subtopic = EXCLUDED.subtopic, prompt = EXCLUDED.prompt,
           context_note = EXCLUDED.context_note, answer_type = EXCLUDED.answer_type,
           criteria = EXCLUDED.criteria, max_note = EXCLUDED.max_note, rejects = EXCLUDED.rejects,
           final_answer = EXCLUDED.final_answer, confidence = EXCLUDED.confidence,
           figures = EXCLUDED.figures, answer_figures = EXCLUDED.answer_figures`,
        [
          q.id, paper, bank.papers[examCode] ? prefix + examCode : null, q.session, q.variant, q.q, q.marks,
          q.chapter, q.subtopic || '', q.prompt, q.context_note || '', q.answer_type || 'text',
          JSON.stringify(q.criteria || []), q.max_note || '', JSON.stringify(q.rejects || []),
          q.final_answer || '', q.confidence || '',
          JSON.stringify(q.figures || []), JSON.stringify(q.answer_figures || []),
        ],
      );
    }
    total += bank.items.length;
    console.log(`${info.subject} ${info.label}: ${bank.items.length} questions`);
  }
  await client.query('COMMIT');
  await client.end();
  console.log(`Done. ${total} questions loaded.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
