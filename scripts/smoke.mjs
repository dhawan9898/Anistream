// smoke.mjs - Walks the built web app in a headless browser and fails on any crash.
//
//   npm run build
//   npm i --no-save playwright-core
//   CHROME_PATH=/path/to/chrome node scripts/smoke.mjs
//
// Every network request is blocked, so this checks the hard case: the app must start, show a clear
// "can't reach the site" state with a way to retry, and every tab must still render. It exits
// non-zero when the page throws an uncaught error or a screen renders nothing. Screenshots land in
// ./smoke-shots.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

let chromium;
try { ({ chromium } = await import('playwright-core')); } catch {
  console.error('playwright-core is not installed: run `npm i --no-save playwright-core` first.');
  process.exit(2);
}
const executablePath = process.env.CHROME_PATH;
if (!executablePath) { console.error('Set CHROME_PATH to a Chrome/Chromium binary.'); process.exit(2); }

const DIST = join(process.cwd(), 'dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  try {
    const file = path === '/' || path === '\\' ? 'index.html' : path.slice(1);
    const body = await readFile(join(DIST, file));
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, r));
const origin = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', e => problems.push(`uncaught: ${e.message.split('\n')[0]}`));
await page.route(/^https?:\/\/(?!localhost)/, r => r.abort('internetdisconnected'));
await mkdir('smoke-shots', { recursive: true });

const results = [];
async function step(name, fn) {
  const before = problems.length;
  try { await fn(); await page.waitForTimeout(800); results.push(`ok    ${name}`); }
  catch (e) { problems.push(`${name}: ${e.message.split('\n')[0]}`); results.push(`FAIL  ${name}`); }
  if (problems.length > before) results[results.length - 1] += `  (+${problems.length - before} problems)`;
}
const visibleText = async () => (await page.evaluate(() => document.body.innerText)).trim().length;

await step('home shows a clear offline state with Try again', async () => {
  await page.goto(origin, { waitUntil: 'load' });
  await page.getByText(/try again/i).first().waitFor({ timeout: 15000 });
  await page.screenshot({ path: 'smoke-shots/home.png' });
});
for (const tab of ['Search', 'Library', 'Settings', 'Home']) {
  await step(`tab ${tab}`, async () => {
    await page.getByText(tab, { exact: true }).last().click();
    await page.waitForTimeout(1200);
    if ((await visibleText()) < 20) throw new Error('screen is blank');
    await page.screenshot({ path: `smoke-shots/${tab.toLowerCase()}.png` });
  });
}

console.log(results.join('\n'));
if (problems.length) console.log('\nProblems:\n' + [...new Set(problems)].map(p => `  - ${p}`).join('\n'));
await browser.close();
server.close();
process.exit(problems.length ? 1 : 0);
