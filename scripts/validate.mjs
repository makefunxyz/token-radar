// Gate validator: checks all 7 gate rows from a built /output directory.
// Usage: node scripts/validate.mjs <output-dir> <snapshot.json>
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildDossier } from '../vendor/makefun-board.ts';

const outDir = process.argv[2];
const snapPath = process.argv[3];
if (!outDir || !snapPath) {
  process.stderr.write('usage: node scripts/validate.mjs <output-dir> <snapshot.json>\n');
  process.exit(2);
}
const fails = [];
const notes = [];
function check(name, ok, detail) {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) fails.push(name);
}
function bytes(n) { return `${(n / 1024).toFixed(1)} KiB`; }

const snap = JSON.parse(readFileSync(snapPath, 'utf8'));
const snapSlugs = new Set(snap.protocols.map((p) => p.slug));

// 1. dashboard files
const dashDir = join(outDir, 'dashboard');
const dashFiles = [];
(function walk(dir, rel) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(join(dir, e.name), p);
    else dashFiles.push(p);
  }
})(dashDir, '');
const dashBytes = dashFiles.reduce((s, f) => s + statSync(join(dashDir, f)).size, 0);
const hasHtml = dashFiles.includes('index.html');
const hasCss = dashFiles.some((f) => f.endsWith('.css'));
const hasJs = dashFiles.some((f) => f.endsWith('.js'));
let httpHit = null;
for (const f of dashFiles) {
  const text = readFileSync(join(dashDir, f), 'utf8');
  const m = text.match(/https?:\/\//);
  if (m) { httpHit = `${f}: ${m[0]}`; break; }
}
check('dashboard_files', hasHtml && hasCss && hasJs && dashFiles.length <= 400 && dashBytes <= 4 * 1024 * 1024 && !httpHit,
  `${dashFiles.length} files, ${bytes(dashBytes)}, html=${hasHtml} css=${hasCss} js=${hasJs} http=${httpHit ?? 'none'}`);
check('dashboard_source_budget', dashBytes <= 55 * 1024, `${bytes(dashBytes)} of 55 KiB budget`);

// 2. board rows
const boardRaw = readFileSync(join(outDir, 'board.json'));
const board = JSON.parse(boardRaw.toString('utf8')).rows;
let boardOk = board.length >= 100 && board.length <= 4000 && boardRaw.length <= 8 * 1024 * 1024;
let boardDetail = `${board.length} rows, ${bytes(boardRaw.length)}`;
const seenSlugs = new Set();
const ranks = new Set();
for (const r of board) {
  if (!snapSlugs.has(r.slug)) { boardOk = false; boardDetail += `; unknown slug ${r.slug}`; break; }
  if (seenSlugs.has(r.slug)) { boardOk = false; boardDetail += `; duplicate slug ${r.slug}`; break; }
  seenSlugs.add(r.slug);
  if (typeof r.name !== 'string' || r.name.trim().length === 0) { boardOk = false; boardDetail += `; empty name ${r.slug}`; break; }
  if (!Number.isSafeInteger(r.rank) || r.rank < 1) { boardOk = false; boardDetail += `; bad rank ${r.slug}`; break; }
  ranks.add(r.rank);
  if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) {
    boardOk = false; boardDetail += `; bad implied ${r.slug}`; break;
  }
  if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) {
    boardOk = false; boardDetail += `; steps ${r.slug}`; break;
  }
  for (const s of r.farm_steps) {
    const t = s.trim();
    if (t.length < 20 || t.length > 600) { boardOk = false; boardDetail += `; step len ${t.length} ${r.slug}`; break; }
  }
  if (!boardOk) break;
}
for (let i = 1; i <= board.length; i++) if (!ranks.has(i)) { boardOk = false; boardDetail += '; ranks not 1..N'; break; }
for (let i = 1; i < board.length; i++) {
  if (board[i].implied_value_usd > board[i - 1].implied_value_usd) { boardOk = false; boardDetail += `; order at rank ${i + 1}`; break; }
}
if (board.length >= 2 && board[0].implied_value_usd === board[board.length - 1].implied_value_usd) {
  boardOk = false; boardDetail += '; all implied equal';
}
check('board_file', boardOk, boardDetail);

// 3. coverage
const missing = snap.watchlist.filter((s) => !seenSlugs.has(s));
check('coverage', missing.length === 0, `${snap.watchlist.length - missing.length}/${snap.watchlist.length} watchlist slugs`);

// 4. screenshots
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1];
    const len = buf.readUInt16BE(off + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
    }
    off += 2 + len;
  }
  return null;
}
const shotDir = join(outDir, 'screenshots');
const shots = readdirSync(shotDir).filter((f) => !f.startsWith('.')).sort();
let shotsOk = shots.length >= 3 && shots.length <= 4;
let shotDetail = shots.map((f) => {
  const buf = readFileSync(join(shotDir, f));
  const dim = pngSize(buf) ?? jpegSize(buf);
  const long = dim ? Math.max(dim.w, dim.h) : -1;
  const short = dim ? Math.min(dim.w, dim.h) : -1;
  const ok = buf.length <= 512 * 1024 && dim !== null && long <= 1440 && short >= 800;
  if (!ok) shotsOk = false;
  if (buf.length < 300 * 1024 || buf.length > 350 * 1024) notes.push(`${f} is ${bytes(buf.length)} (target 300–350 KiB)`);
  return `${f} ${dim ? `${dim.w}x${dim.h}` : 'unreadable'} ${bytes(buf.length)}`;
}).join('; ');
check('screenshots', shotsOk, shotDetail);

// 5. dossier byte-equality + size
const dossier = readFileSync(join(outDir, 'dossier.json'));
const rebuilt = Buffer.from(buildDossier(outDir, { text_max_bytes: 65536 }));
const dossierOk = dossier.equals(rebuilt) && dossier.length <= 1.5 * 1024 * 1024;
check('dossier_matches', dossierOk, `${bytes(dossier.length)}, byte-equal=${dossier.equals(rebuilt)}`);

// 6. model spot-checks (not a gate row, but the judge reads it)
const pre = board.filter((r) => r.token_status === 'pre-token');
const verdicts = {};
for (const r of pre) verdicts[r.verdict] = (verdicts[r.verdict] || 0) + 1;
process.stdout.write(`INFO model — pre-token ${pre.length}, live ${board.filter((r) => r.token_status === 'live').length}, live-unpriced ${board.filter((r) => r.token_status === 'live-unpriced').length}, not-a-launch ${board.filter((r) => r.token_status === 'not-a-launch').length}, verdicts ${JSON.stringify(verdicts)}\n`);
for (const n of notes) process.stdout.write(`NOTE ${n}\n`);
process.stdout.write(fails.length === 0 ? 'ALL GATE ROWS PASS\n' : `FAILURES: ${fails.join(', ')}\n`);
process.exit(fails.length === 0 ? 0 : 1);
