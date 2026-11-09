// Creates the database (if missing), creates the tables, and loads every question from seed/:
// A Level 9618 from alevel-paper1-4.json, IGCSE 0478 from igcse-paper1-2.json,
// IGCSE Chemistry 0620 from chemistry-paper2/4/6.json.
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
  '0620': 'Chemistry IGCSE (0620)',
  9701: 'Chemistry (9701)',
};

// number: internal paper id. IGCSE Computer Science papers are 11 and 12 and IGCSE Chemistry papers are 21–26 (the paper's own number + 20) and A Level Chemistry papers are 41–45,
// so they never clash with 9618 Papers 1-4.
const PAPERS = [
  { number: 1, subject: '9618', label: 'Paper 1', title: 'Theory Fundamentals', description: 'AS Level theory: data representation, hardware, networks, security, databases.', source: 'alevel-paper1.json' },
  { number: 2, subject: '9618', label: 'Paper 2', title: 'Fundamental Problem-solving and Programming Skills', description: 'AS Level pseudocode, algorithms and program design.', source: 'alevel-paper2.json' },
  { number: 3, subject: '9618', label: 'Paper 3', title: 'Advanced Theory', description: 'A Level theory: floating point, protocols, AI, further programming.', source: 'alevel-paper3.json' },
  { number: 4, subject: '9618', label: 'Paper 4', title: 'Practical (Python)', description: 'A Level practical programming in Python.', source: 'alevel-paper4.json' },
  { number: 11, subject: '0478', label: 'IGCSE Paper 1', title: 'Computer Systems', description: 'IGCSE theory: data, transmission, hardware, software, the internet, emerging technologies.', source: 'igcse-paper1.json', examPrefix: 'ig-' },
  { number: 12, subject: '0478', label: 'IGCSE Paper 2', title: 'Algorithms, Programming and Logic', description: 'IGCSE algorithms, pseudocode programming, databases and Boolean logic.', source: 'igcse-paper2.json', examPrefix: 'ig-' },
  { number: 21, subject: '0620', label: 'Chemistry Paper 1', title: 'Multiple Choice (Core)', description: 'IGCSE Chemistry Core: 40 multiple-choice questions per paper.', source: 'chemistry-paper1.json', examPrefix: 'ch-' },
  { number: 22, subject: '0620', label: 'Chemistry Paper 2', title: 'Multiple Choice (Extended)', description: 'IGCSE Chemistry: 40 multiple-choice questions per paper across the whole syllabus.', source: 'chemistry-paper2.json', examPrefix: 'ch-' },
  { number: 23, subject: '0620', label: 'Chemistry Paper 3', title: 'Theory (Core)', description: 'IGCSE Chemistry Core structured questions across the whole syllabus.', source: 'chemistry-paper3.json', examPrefix: 'ch-' },
  { number: 24, subject: '0620', label: 'Chemistry Paper 4', title: 'Theory (Extended)', description: 'IGCSE Chemistry structured questions: bonding, moles, electrolysis, energetics, organic and more.', source: 'chemistry-paper4.json', examPrefix: 'ch-' },
  { number: 25, subject: '0620', label: 'Chemistry Paper 5', title: 'Practical Test', description: 'IGCSE Chemistry practical test: experiments, observations, tests for ions and gases.', source: 'chemistry-paper5.json', examPrefix: 'ch-' },
  { number: 26, subject: '0620', label: 'Chemistry Paper 6', title: 'Alternative to Practical', description: 'IGCSE Chemistry practical skills: apparatus, tests for ions and gases, titrations, planning.', source: 'chemistry-paper6.json', examPrefix: 'ch-' },
  { number: 41, subject: '9701', label: 'A Level Chemistry Paper 1', title: 'Multiple Choice (AS)', description: 'AS Level Chemistry: 40 multiple-choice questions on physical, inorganic and organic chemistry.', source: 'chemistry-alevel-paper1.json', examPrefix: 'ac-' },
  { number: 42, subject: '9701', label: 'A Level Chemistry Paper 2', title: 'AS Level Structured Questions', description: 'AS Level Chemistry structured questions: atomic structure, bonding, energetics, equilibria, organic.', source: 'chemistry-alevel-paper2.json', examPrefix: 'ac-' },
  { number: 43, subject: '9701', label: 'A Level Chemistry Paper 3', title: 'Advanced Practical Skills (AS)', description: 'AS Level Chemistry practical: titrations, enthalpy experiments, qualitative analysis.', source: 'chemistry-alevel-paper3.json', examPrefix: 'ac-' },
  { number: 44, subject: '9701', label: 'A Level Chemistry Paper 4', title: 'A Level Structured Questions', description: 'A Level Chemistry: lattice energy, electrochemistry, kinetics, transition elements, NMR and more.', source: 'chemistry-alevel-paper4.json', examPrefix: 'ac-' },
  { number: 45, subject: '9701', label: 'A Level Chemistry Paper 5', title: 'Planning, Analysis and Evaluation', description: 'A Level Chemistry: planning experiments, processing data and evaluating results.', source: 'chemistry-alevel-paper5.json', examPrefix: 'ac-' },
];

// Every IGCSE question must come from a Cambridge (CAIE) paper of its own syllabus, e.g. 0620/42 for Chemistry.
function checkCambridgeSource(info, bank) {
  if (!info.examPrefix) return;
  for (const [code, p] of Object.entries(bank.papers)) {
    const fromCaie = p.code.startsWith(`${info.subject}/`)
      && [p.qp, p.ms].every((u) => /\/CAIE\//.test(u) && u.includes(`/${info.subject}_`));
    if (!fromCaie) throw new Error(`${info.source}: ${code} (${p.code}) is not a Cambridge ${info.subject} paper.`);
  }
  const bad = bank.items.find((q) => !q.paper_code.startsWith(`${info.subject}/`) || !bank.papers[`${q.session}-${q.variant}`]);
  if (bad) throw new Error(`${info.source}: question ${bad.id} is not from a Cambridge ${info.subject} paper.`);
}

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

  // Read and check every question bank before touching the database.
  const banks = PAPERS.map((info) => {
    const loaded = loadBank(info.source);
    checkCambridgeSource(info, loaded.bank);
    return loaded;
  });
  console.log('Question banks checked: every IGCSE question is from a Cambridge (CAIE) paper of its syllabus');

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
  for (const [i, info] of PAPERS.entries()) {
    const paper = info.number;
    const prefix = info.examPrefix || '';
    const { bank, chapters } = banks[i];

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
  if (err.code === 'ECONNREFUSED' || err.errors?.some((e) => e.code === 'ECONNREFUSED')) {
    console.error('Could not connect to PostgreSQL: it is not running, or DATABASE_URL in .env points to the wrong host/port.');
  } else {
    console.error(err.message || err.code || err);
  }
  process.exit(1);
});
