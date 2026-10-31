// One-off: copies the 9618 A Level question banks out of the old static pages into seed/.
// Each paperN.html embeds its bank in <script id="bank" type="application/json"> and its
// chapter names in `CHAPS = {...}`. The output has the same shape as the IGCSE files:
// { items, papers, skipped, chapters }.
//
//   node scripts/export-alevel.js /path/to/Next-Level        (folder that holds paper1.html–paper4.html)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const seedDir = path.resolve(here, '../seed');

function readEmbedded(html, id) {
  const m = html.match(new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`));
  if (!m) throw new Error(`<script id="${id}"> not found`);
  return JSON.parse(m[1]);
}

function readChapters(html) {
  const m = html.match(/CHAPS = (\{[^}]*\})/);
  if (!m) throw new Error('Chapter list not found');
  // Keys are unquoted numbers, so quote them to make it valid JSON.
  return JSON.parse(m[1].replace(/([{,])(\d+):/g, '$1"$2":'));
}

const source = process.argv[2];
if (!source) {
  console.error('Usage: node scripts/export-alevel.js /path/to/folder-with-paper1-4.html');
  process.exit(1);
}

for (const n of [1, 2, 3, 4]) {
  const html = fs.readFileSync(path.join(source, `paper${n}.html`), 'utf8');
  const bank = readEmbedded(html, 'bank');
  const out = {
    items: bank.items,
    papers: bank.papers,
    skipped: bank.skipped || [],
    chapters: readChapters(html),
  };
  const file = path.join(seedDir, `alevel-paper${n}.json`);
  fs.writeFileSync(file, `${JSON.stringify(out)}\n`);
  console.log(`paper${n}.html → seed/alevel-paper${n}.json: ${out.items.length} questions, ${Object.keys(out.chapters).length} chapters`);
}
