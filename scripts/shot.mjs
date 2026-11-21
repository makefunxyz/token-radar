// Screenshots of the built dashboard with Playwright Chromium (installed in the shot dir).
// Usage: node scripts/shot.mjs <output-dir> <screenshots-dir>
//   1-board.png    default view (pre-token board)
//   2-detail.png   detail view of the top pre-token protocol, scrolled into view
//   3-filtered.png pre-token board filtered to the Ethereum chain
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const outDir = resolve(process.argv[2] ?? '');
const shotDir = process.argv[3];
if (!outDir || !shotDir) {
  process.stderr.write('usage: node scripts/shot.mjs <output-dir> <screenshots-dir>\n');
  process.exit(2);
}
const require = createRequire('/home/hatch/workspace/makefun/token-radar-01/shot/package.json');
const { chromium } = require('playwright');

const board = JSON.parse(readFileSync(join(outDir, 'board.json'), 'utf8')).rows;
const topPre = board.find((r) => r.token_status === 'pre-token');
if (!topPre) throw new Error('no pre-token row on the board');

const base = `file://${outDir}/dashboard/index.html`;
const browser = await chromium.launch();
async function shot(url, file, scrollDetail) {
  // A fresh page per shot: navigating only the hash would not reload, and the scroll
  // position and open detail panel would otherwise leak from the previous shot.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => process.stderr.write(`page error: ${e.message}\n`));
  page.on('console', (m) => { if (m.type() === 'error') process.stderr.write(`console error: ${m.text()}\n`); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#rows tr').length > 0, { timeout: 10000 });
  await page.waitForTimeout(400);
  if (scrollDetail) {
    await page.evaluate(() => document.querySelector('#detail').scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: join(shotDir, file) });
  process.stdout.write(`shot ${file} from ${url}\n`);
  await page.close();
}

await shot(base, '1-board.png', false);
await shot(`${base}#detail=${topPre.slug}`, '2-detail.png', true);
await shot(`${base}#status=pre-token&chain=Ethereum`, '3-filtered.png', false);
await browser.close();
process.stdout.write(`detail protocol: ${topPre.slug} (${topPre.name})\n`);
