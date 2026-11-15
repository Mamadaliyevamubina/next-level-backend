import { query } from './db.js';

// "2(a)(i)" → ["2(a)(i)", "2(a)", "2"]: the part itself, then the parts it belongs to.
export function labelChain(label) {
  const parts = String(label).match(/^\d+|\([^)]*\)/g) || [String(label)];
  return parts.map((_, i) => parts.slice(0, parts.length - i).join(''));
}

// What the Cambridge examiner report says about this question part and its exam paper, or null if there is no report.
// comments: the most specific first, e.g. [{ label: "2(a)(i)", comment }, { label: "2", comment }].
// A database set up before examiner reports existed has no such tables: the question still loads, just without a report.
export async function examinerReport(examCode, label) {
  if (!examCode) return null;
  try {
    const report = await query('SELECT title, key_messages, general, url FROM examiner_reports WHERE exam_code = $1', [examCode]);
    if (!report.rowCount) return null;
    const chain = labelChain(label);
    const { rows } = await query('SELECT label, comment FROM examiner_comments WHERE exam_code = $1 AND label = ANY($2)', [examCode, chain]);
    const comments = chain.map((l) => rows.find((r) => r.label === l)).filter(Boolean);
    return { ...report.rows[0], comments };
  } catch (err) {
    if (err.code === '42P01') return null; // tables missing: run npm run db:setup
    throw err;
  }
}
