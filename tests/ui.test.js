'use strict';
/*
  Browser regression net. Starts the app's own static server, drives the real
  UI in Chromium, and asserts the flows that have broken before.

  Every check here exists because something went wrong once:
  - Process Inbox filing silently did nothing when a hardcoded life area was missing
  - milestones could not be renamed or removed
  - the review checklist must never touch XP
*/
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 8791;
const BASE = `http://localhost:${PORT}/`;
const FIXTURE = require('fs').readFileSync(path.join(__dirname, 'fixtures', 'sample-import.json'), 'utf8');

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
  catch (e) {
    // Local sandbox keeps its browser outside the default location.
    return await chromium.launch({ ...opts, executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  }
}

(async () => {
  const server = spawn('node', ['serve.js'], { cwd: ROOT, stdio: 'ignore' });
  const stop = () => { try { server.kill(); } catch (e) {} };
  process.on('exit', stop);

  await waitForServer();
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  const errs = [];
  // Firebase is CDN-loaded; without it `db` is undefined, which the app handles.
  page.on('pageerror', e => { if (!/firebase|db is not defined/.test(e.message)) errs.push(e.message); });
  page.on('dialog', d => d.accept());

  /*
    Hard-block every request that is not the local server.

    This is a safety rule, not a convenience. index.html loads the Firebase SDK
    from gstatic and connects to the live Firestore project; persist() then
    writes the whole state to snapshots/primary. A test run with real network
    access would overwrite the owner's real data with fixtures. Blocking here
    makes that impossible rather than unlikely.

    It also fixes a CI hang: the Firestore connection never goes idle, so
    waitUntil:'networkidle' waits forever on a runner that has internet.
  */
  const blocked = [];   // requests the guard aborted
  const served = [];    // responses the page actually received
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    blocked.push(url);
    return route.abort();
  });
  page.on('response', r => served.push(r.url()));

  const st = () => page.evaluate(() => JSON.parse(localStorage.getItem('adhd-second-brain-v1')).state);

  // domcontentloaded, not networkidle: nothing external is allowed to load anyway,
  // and the app renders from localStorage on first paint.
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.sidebar');
  ok('app boots', true);
  // Assert the guard is engaged, not merely that the page happened not to ask:
  // the Firebase SDK request must appear in the blocked list.
  ok('the Firebase SDK request was blocked', blocked.some(u => /gstatic\.com\/firebasejs/.test(u)), blocked.slice(0, 4));

  console.log('\nIMPORT');
  await page.click('[data-action="nav"][data-view="settings"]');
  await page.fill('#import-input', FIXTURE);
  await page.click('[data-action="import-preview"]');
  await page.waitForSelector('[data-action="import-apply"]');
  const preview = await page.locator('.import-plan').innerText();
  ok('preview describes what will be created', /4 projects/.test(preview) && /14/.test(preview), preview.replace(/\n/g, ' '));
  await page.click('[data-action="import-apply"]');
  await page.waitForSelector('.project-card');
  await page.waitForTimeout(400);
  // One project is archived, so three show by default.
  ok('projects rendered', await page.locator('.project-card').count() === 3, await page.locator('.project-card').count());

  console.log('\nPROCESS INBOX — filing must actually file');
  await page.click('[data-action="nav"][data-view="inbox"]');
  for (const t of ['Alpha', 'Bravo']) {
    await page.fill('#capture-input', t);
    await page.click('[data-action="capture-add"]');
    await page.waitForTimeout(150);
  }
  await page.click('.view-head [data-action="process-inbox"]');
  await page.waitForSelector('.triage-card');
  ok('triage offers a domain picker', await page.locator('#triage-cat').count() === 1);
  const card = await page.locator('.triage-title').innerText();
  const opts = await page.locator('#triage-cat option').allInnerTexts();
  await page.selectOption('#triage-cat', opts[0]);
  await page.click('[data-action="triage-keep-task"]');
  await page.waitForTimeout(400);
  const filed = (await st()).items.find(i => i.title === card);
  ok('keep-as-task files to the chosen domain', filed.category === opts[0], { title: card, got: filed.category });
  ok('the card advances', (await page.locator('.triage-title').innerText()) !== card);
  await page.click('[data-action="exit-triage"]');
  await page.waitForTimeout(300);

  console.log('\nMILESTONES — rename, delete, reorder');
  await page.click('[data-action="nav"][data-view="projects"]');
  await page.locator('.project-card', { hasText: 'Site installation' }).locator('.project-head').click();
  await page.waitForSelector('.sub-row');
  const before = await page.locator('.sub-row span[style*="flex"]').allInnerTexts();
  ok('milestones listed', before.length === 7, before.length);
  await page.locator('.sub-row').nth(1).locator('[data-action="move-subtask"][data-dir="-1"]').click();
  await page.waitForTimeout(400);
  const after = await page.locator('.sub-row span[style*="flex"]').allInnerTexts();
  ok('reorder swaps two rows', after[0] === before[1] && after[1] === before[0], { before: before.slice(0, 2), after: after.slice(0, 2) });
  await page.locator('.sub-row').first().locator('[data-action="rename-subtask"]').click();
  await page.waitForSelector('#ms-title');
  await page.fill('#ms-title', 'Renamed step');
  await page.click('[data-action="confirm-rename-subtask"]');
  await page.waitForTimeout(400);
  ok('rename applies', (await page.locator('.sub-row span[style*="flex"]').first().innerText()) === 'Renamed step');
  const n1 = await page.locator('.sub-row').count();
  await page.locator('.sub-row').first().locator('[data-action="delete-subtask"]').click();
  await page.waitForTimeout(500);
  ok('delete removes one', await page.locator('.sub-row').count() === n1 - 1);

  console.log('\nHABITS — retire and the week pager');
  await page.click('[data-action="nav"][data-view="habits"]');
  await page.waitForSelector('.habit-row');
  const hCount = await page.locator('.habit-row').count();
  ok('habits listed', hCount === 3, hCount);
  await page.locator('.habit-row').first().locator('[data-action="toggle-habit-active"]').click();
  await page.waitForTimeout(400);
  ok('retired habit leaves the list', await page.locator('.habit-row').count() === hCount - 1);
  await page.click('[data-action="toggle-inactive-habits"]');
  await page.waitForTimeout(300);
  ok('retired habit can be revealed', await page.locator('.habit-row').count() === hCount);
  await page.click('[data-action="habit-week"][data-dir="1"]');
  await page.waitForTimeout(300);
  ok('a past week has no unreachable days',
    await page.locator('.habit-row').first().locator('.day-dot.future').count() === 0);

  console.log('\nREPORTS — every tab exports');
  await page.click('[data-action="nav"][data-view="reports"]');
  for (const tab of ['areas', 'projects', 'habits', 'timeline']) {
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForTimeout(300);
    const dl = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
    await page.click('[data-action="export-report"]');
    const got = await dl;
    ok(`${tab} exports`, !!got, got ? got.suggestedFilename() : 'no download');
  }

  console.log('\nREPORTS — numeric headers sit over their numbers');
  await page.click('[data-tab="projects"]');
  await page.waitForSelector('.mini-table');
  /* A numeric column whose header is left-aligned while its cells are right-aligned
     reads as two columns that drifted apart. Assert the rendered right edges agree,
     not just that a class is present. */
  const cols = await page.evaluate(() => {
    const t = document.querySelector('.mini-table');
    const ths = [...t.querySelectorAll('th')];
    const tds = [...t.querySelector('tbody tr').querySelectorAll('td')];
    const rightEdge = el => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().right; };
    return ths.map((th, i) => ({
      col: th.textContent.trim(), num: th.classList.contains('num'),
      align: getComputedStyle(th).textAlign,
      drift: Math.abs(rightEdge(th) - rightEdge(tds[i]))
    }));
  });
  cols.filter(c => c.num).forEach(c =>
    ok(`"${c.col}" header is flush with its numbers`, c.align === 'right' && c.drift <= 1, c));
  ok('the text column stays left', cols[0].align === 'left' && !cols[0].num, cols[0]);

  console.log('\nROLL-UP — every number drills into the projects behind it');
  ok('all six tiles are buttons', await page.locator('button.rollup-tile[data-action="rollup-drill"]').count() === 6,
    await page.locator('button.rollup-tile[data-action="rollup-drill"]').count());
  await page.click('button.rollup-tile[data-key="offtrack"]');
  await page.waitForSelector('.modal');
  const drill = await page.locator('.modal').innerText();
  ok('the off-track tile lists the off-track project', /Off track \(1\)/.test(drill) && /Site installation/.test(drill),
    drill.split('\n').slice(0, 2).join(' | '));
  ok('  and only that one', await page.locator('.modal .project-card').count() === 1,
    await page.locator('.modal .project-card').count());
  await page.locator('.modal .project-card').first().click();
  await page.waitForTimeout(300);
  ok('a row opens that project\'s full report', /milestones/i.test(await page.locator('.modal').innerText()));
  await page.click('.modal-actions [data-action="close-modal"]');
  await page.waitForTimeout(200);
  // A slice with nothing in it must say so, not render a blank box.
  await page.locator('.mini-table tr.row-link').filter({ hasText: 'Home' }).first().locator('td.num').nth(3).click();
  await page.waitForSelector('.modal');
  ok('an empty slice explains itself', /Nothing is off track/.test(await page.locator('.modal').innerText()));
  await page.click('.modal-actions [data-action="close-modal"]');
  await page.waitForTimeout(200);
  // Keyboard reachability is why the tiles are <button>, not <div>.
  await page.locator('button.rollup-tile[data-key="noplan"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  ok('a tile opens from the keyboard', /Not broken down/.test(await page.locator('.modal').innerText()));
  await page.click('.modal-actions [data-action="close-modal"]');
  await page.waitForTimeout(200);

  console.log('\nREVIEW — checklists must never award XP');
  await page.click('[data-action="nav"][data-view="review"]');
  await page.waitForSelector('.rv-step');
  const tabCount = await page.locator('[data-action="review-tab"]').count();
  ok('three cadences', tabCount === 3, tabCount);
  ok('daily is sectioned', await page.locator('.rv-sec').count() === 2);
  const xpBefore = (await st()).gamification.xp;
  await page.locator('.rv-step .box').first().click();
  await page.waitForTimeout(400);
  ok('a tick persists', Object.keys((await st()).reviews.daily.done || {}).length === 1);
  ok('a tick awards no XP', (await st()).gamification.xp === xpBefore, { before: xpBefore, after: (await st()).gamification.xp });

  console.log('\nPERSISTENCE');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.click('[data-action="nav"][data-view="review"]');
  await page.waitForTimeout(400);
  ok('state survives a reload', Object.keys((await st()).reviews.daily.done || {}).length === 1);

  // The property that matters: nothing outside the local server was ever served,
  // so the owner's live Firestore cannot have been read or written.
  const external = served.filter(u => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:'));
  ok('no external response was ever received', external.length === 0, external.slice(0, 5));
  ok('the live database was never reached', !served.some(u => /firestore|googleapis\.com/.test(u)),
    served.filter(u => /firestore|googleapis\.com/.test(u)).slice(0, 3));
  console.log(`blocked ${blocked.length} external request(s) — expected: the Firebase SDK, Chart.js and web fonts`);
  console.log('\nconsole errors: ' + (errs.length ? JSON.stringify(errs) : 'none'));
  errs.forEach(() => fails++);
  console.log(fails ? `\nui: ${fails} CHECK(S) FAILED` : '\nui: all checks passed');

  await browser.close();
  stop();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
