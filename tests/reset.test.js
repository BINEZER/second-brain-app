'use strict';
/*
  What a Reset must leave behind.

  This exists because a reset twice appeared to delete things it should not have:
  the Review checklists (defaultRoot() omitted the collections the view reads) and
  the Life Binder (cleared, then blank until some later boot happened to re-seed it).

  It drives the real resetApp() path in a browser, with a stub Firestore, because
  resetApp() returns early when `db` is undefined — so a test without one proves
  nothing about the code that actually runs on the owner's machine.
*/
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const ROOT = path.join(__dirname, '..');
const PORT = 8791;   // serve.js hardcodes this; the suites run sequentially, never at once
const BASE = `http://localhost:${PORT}/`;
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-import.json'), 'utf8');

let fails = 0;
const ok = (n, c, x) => {
  console.log((c ? '  ok   ' : '  FAIL ') + n + (x !== undefined ? '  ' + JSON.stringify(x) : ''));
  if (!c) fails++;
};

function waitForServer(tries = 40) {
  return new Promise((resolve, reject) => {
    const attempt = n => {
      http.get(BASE, res => { res.resume(); resolve(); })
        .on('error', () => n <= 0 ? reject(new Error('server never came up')) : setTimeout(() => attempt(n - 1), 250));
    };
    attempt(tries);
  });
}

async function launch() {
  const opts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PW_EXECUTABLE) opts.executablePath = process.env.PW_EXECUTABLE;
  try { return await chromium.launch(opts); }
  catch (e) { return await chromium.launch({ ...opts, executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }); }
}

(async () => {
  const server = spawn('node', ['serve.js'], { cwd: ROOT, stdio: 'ignore' });
  const stop = () => { try { server.kill(); } catch (e) {} };
  process.on('exit', stop);
  await waitForServer();

  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
  page.on('dialog', d => d.accept());

  // Same hard network block as the other browser suite: never touch the live database.
  const served = [];
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    return route.abort();
  });
  page.on('response', r => served.push(r.url()));

  // resetApp() bails out unless `db` exists, so stub just enough Firestore for the
  // calls it makes. Everything stays in memory; nothing leaves the page.
  await page.addInitScript(() => {
    const store = {};
    const fakeDb = { collection: () => ({ doc: id => ({
      get: () => Promise.resolve({ exists: !!store[id], data: () => store[id] }),
      set: v => { store[id] = v; return Promise.resolve(); },
      delete: () => { delete store[id]; return Promise.resolve(); }
    }) }) };
    // firestore() must hand back the same fake: the app's own init runs after this
    // and reassigns db from it, and a bare {} makes db.collection throw inside
    // resetApp's Promise.all, which skips its .finally and leaves the modal open.
    window.firebase = { initializeApp: () => ({}), firestore: Object.assign(() => fakeDb, { FieldValue: { serverTimestamp: () => null } }) };
    window.db = fakeDb;
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.sidebar');
  await page.waitForTimeout(500);

  const st = () => page.evaluate(() => {
    const t = localStorage.getItem('adhd-second-brain-v1');   // empty until the next persist()
    return t ? JSON.parse(t).state : { items: [], lifeAreas: [], habits: [] };
  });

  await page.click('[data-action="nav"][data-view="settings"]');
  await page.fill('#import-input', FIXTURE);
  await page.click('[data-action="import-preview"]');
  await page.waitForSelector('[data-action="import-apply"]');
  await page.click('[data-action="import-apply"]');
  await page.waitForTimeout(700);
  ok('app seeded before the reset', (await st()).items.filter(i => i.type === 'project').length === 4);

  console.log('\nTHE RESET ITSELF');
  await page.click('[data-action="nav"][data-view="settings"]');
  await page.click('[data-action="reset-app"]');
  await page.waitForTimeout(400);
  ok('reset asks before destroying anything', await page.locator('[data-action="confirm-reset"]').count() === 1);
  await page.click('[data-action="confirm-reset"]');
  await page.waitForTimeout(1200);

  console.log('\nIMMEDIATELY AFTER, WITH NO RELOAD');
  ok('the projects really were cleared', (await st()).items.length === 0, (await st()).items.length);
  await page.click('[data-action="nav"][data-view="review"]');
  await page.waitForTimeout(400);
  // defaultRoot() once omitted reviewCustom/reviewHidden, so this view threw and rendered nothing.
  ok('the Review checklist renders', await page.locator('.rv-step').count() > 0,
    await page.locator('.rv-step').count());
  ok('  with all three cadences', await page.locator('[data-action="review-tab"]').count() === 3);
  await page.click('[data-action="nav"][data-view="binder"]');
  await page.waitForTimeout(400);
  // The binder used to sit blank until a later boot happened to re-seed it, which
  // reads to the owner as "the reset deleted my Life Binder".
  ok('the Life Binder is already back', await page.locator('.area-card').count() > 0,
    await page.locator('.area-card').count());

  console.log('\nAFTER RE-IMPORTING AND RELOADING');
  await page.click('[data-action="nav"][data-view="settings"]');
  await page.fill('#import-input', FIXTURE);
  await page.click('[data-action="import-preview"]');
  await page.waitForSelector('[data-action="import-apply"]');
  await page.click('[data-action="import-apply"]');
  await page.waitForTimeout(700);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const after = await st();
  ok('binder areas kept their written content',
    after.lifeAreas.filter(a => a.purpose && a.purpose.length > 10).length > 0,
    after.lifeAreas.length);
  /* The area migration ran `AREA_MIGRATION_MAP[cat] || 'Inbox'`, so any current
     domain name fell through and every project lost its domain on the next load. */
  ok('no project was swept into the Inbox',
    after.items.filter(i => i.type === 'project' && i.category === 'Inbox').length === 0,
    after.items.filter(i => i.type === 'project' && i.category === 'Inbox').map(i => i.title));
  await page.click('[data-action="nav"][data-view="review"]');
  await page.waitForTimeout(400);
  ok('the Review checklist survived the reload', await page.locator('.rv-step').count() > 0);

  const external = served.filter(u => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:'));
  ok('the live database was never reached', external.length === 0, external.slice(0, 3));

  console.log(fails ? `\nreset: ${fails} CHECK(S) FAILED` : '\nreset: all checks passed');
  await browser.close();
  stop();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
