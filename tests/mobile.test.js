'use strict';
/*
  The app on a phone.

  Every check here exists because the app was unusable on an iPhone 11:
  - the sidebar stayed in the layout at every width, covering half of a 414px
    screen and swallowing every tap meant for the page underneath
  - rows built as "title + a tail of buttons" gave the buttons the whole width,
    squeezing titles to one letter per line
  - the seven habit day-dots were crushed against the right edge
  - form controls under 16px made Safari zoom the whole page in on focus

  The viewport is an iPhone 11 (414 x 896 CSS px), with a desktop pass at the
  end to prove the phone layout did not leak upwards.
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

const PHONE = { width: 414, height: 896 };     // iPhone 11
const VIEWS = ['now', 'inbox', 'projects', 'reports', 'habits', 'review', 'binder', 'followups', 'recurring', 'settings'];

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

/* A real finger: pointer events carrying pointerType 'touch', which is what the
   reorder code sees on a phone. A mouse drag would prove nothing about it. */
async function touchDrag(page, rowSel, fromIdx, toIdx) {
  const rows = page.locator(rowSel);
  const handle = rows.nth(fromIdx).locator('[data-dnd-handle]').first();
  const hb = await handle.boundingBox();
  const tb = await rows.nth(toIdx).boundingBox();
  const x = hb.x + hb.width / 2;
  const y = hb.y + hb.height / 2;
  const ty = toIdx > fromIdx ? tb.y + tb.height - 4 : tb.y + 4;
  await handle.evaluate((el, [cx, cy, endY]) => {
    const fire = (type, atY) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
      clientX: cx, clientY: atY, button: 0,
    }));
    fire('pointerdown', cy);
    fire('pointermove', cy + 14);     // past the slop threshold
    fire('pointermove', endY);
    fire('pointerup', endY);
  }, [x, y, ty]);
  await page.waitForTimeout(400);
}

async function openApp(browser, viewport, isPhone) {
  const ctx = await browser.newContext({
    viewport, deviceScaleFactor: 2, isMobile: isPhone, hasTouch: isPhone,
    userAgent: isPhone
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : undefined,
  });
  const page = await ctx.newPage();
  // Same hard block as the other browser suites: nothing but the local server,
  // so a test run can never reach the owner's live Firestore.
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    return route.abort();
  });
  const errs = [];
  page.on('pageerror', e => { if (!/firebase|db is not defined/.test(e.message)) errs.push(e.message); });
  page.on('dialog', d => d.accept());
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.sidebar');
  return { page, errs };
}

/* The drawer covers the nav links, so a test cannot click them to move around.
   Drive the app's own nav action instead — the drawer itself is tested directly. */
const go = (page, v) => page.evaluate(x => handleAction('nav', { getAttribute: () => x }), v)
  .then(() => page.waitForTimeout(350));

(async () => {
  const server = spawn('node', ['serve.js'], { cwd: ROOT, stdio: 'ignore' });
  const stop = () => { try { server.kill(); } catch (e) {} };
  process.on('exit', stop);
  await waitForServer();
  const browser = await launch();

  const { page, errs } = await openApp(browser, PHONE, true);
  await go(page, 'settings');
  await page.fill('#import-input', FIXTURE);
  await page.click('[data-action="import-preview"]');
  await page.click('[data-action="import-apply"]');
  await page.waitForTimeout(600);

  console.log('\nNAV — on a phone the sidebar is a drawer, not a wall');
  await go(page, 'now');
  ok('the drawer starts closed', await page.locator('.sidebar.open').count() === 0);
  ok('  and is parked off screen', (await page.locator('.sidebar').boundingBox()).x < 0);
  ok('the menu button is there', await page.locator('.nav-btn').isVisible());
  await page.click('.nav-btn');
  await page.waitForTimeout(400);
  ok('it opens the drawer', await page.locator('.sidebar.open').count() === 1);
  ok('  over a scrim', await page.locator('.nav-scrim.on').isVisible());
  await page.click('[data-action="nav"][data-view="projects"]');
  await page.waitForTimeout(400);
  ok('choosing a destination navigates', (await page.locator('.view-title').innerText()) === 'Projects');
  ok('  and closes the drawer behind you', await page.locator('.sidebar.open').count() === 0);
  await page.click('.nav-btn');
  await page.waitForTimeout(300);
  // The scrim's own centre sits behind the drawer, so tap it where the drawer is not.
  await page.mouse.click(PHONE.width - 24, 420);
  await page.waitForTimeout(400);
  ok('tapping the page behind closes it too', await page.locator('.sidebar.open').count() === 0);

  console.log('\nWIDTH — nothing may push the page sideways');
  for (const v of VIEWS) {
    await go(page, v);
    const m = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      tiny: [...document.querySelectorAll('input,select,textarea')]
        .filter(el => el.offsetParent !== null && parseFloat(getComputedStyle(el).fontSize) < 16)
        .map(el => el.id || el.className || el.type),
    }));
    ok(`${v} fits the screen`, m.scrollW <= m.innerW + 1, m);
    // Safari zooms the whole page in when a focused field is under 16px.
    ok(`  and nothing on ${v} would make Safari zoom`, m.tiny.length === 0, m.tiny.slice(0, 3));
  }

  console.log('\nROWS — the title keeps the line, the buttons drop below it');
  await go(page, 'inbox');
  const titleW = await page.locator('.item-row .item-title').first().evaluate(el => el.getBoundingClientRect().width);
  ok('an inbox task title gets real width', titleW > 150, Math.round(titleW));
  await go(page, 'projects');
  const projTitleW = await page.locator('.project-title').first().evaluate(el => el.getBoundingClientRect().width);
  ok('a project title gets real width', projTitleW > 150, Math.round(projTitleW));
  await page.locator('.project-head').first().click();
  await page.waitForTimeout(400);
  const subW = await page.locator('.sub-title').first().evaluate(el => el.getBoundingClientRect().width);
  ok('a milestone title gets real width', subW > 120, Math.round(subW));

  console.log('\nHABITS — seven days you can actually hit');
  await go(page, 'habits');
  const dots = await page.locator('.habit-row').first().locator('.day-dot').evaluateAll(
    els => els.map(el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; }));
  ok('all seven days are shown', dots.length === 7, dots.length);
  ok('  each big enough for a thumb', dots.every(d => d.w >= 30 && d.h >= 30), dots[0]);
  ok('  and the last one is on screen', dots[6].right <= PHONE.width, dots[6]);

  console.log('\nREORDER — dragging works with a finger, not just a mouse');
  await go(page, 'inbox');
  const before = await page.locator('.item-row .item-title').allInnerTexts();
  if (before.length > 1) {
    await touchDrag(page, '.item-row', 0, 1);
    const after = await page.locator('.item-row .item-title').allInnerTexts();
    ok('a touch drag reorders the list', after[0] === before[1] && after[1] === before[0], { before, after });
  } else {
    ok('a touch drag reorders the list', false, 'fixture had nothing to drag');
  }

  console.log('\nMODALS');
  await go(page, 'habits');
  await page.locator('[data-action="edit-habit"]').first().click();
  await page.waitForSelector('.modal');
  const mb = await page.locator('.modal').boundingBox();
  ok('a modal fits inside the screen', mb.width <= PHONE.width - 8 && mb.x >= 0, mb);
  const fieldH = await page.locator('.modal .field input').first().evaluate(el => el.getBoundingClientRect().height);
  ok('  with fields big enough to tap', fieldH >= 38, Math.round(fieldH));
  await page.click('.modal-actions [data-action="close-modal"]').catch(() => {});

  console.log('\nDESKTOP — the phone layout stays on the phone');
  const desk = await openApp(browser, { width: 1280, height: 900 }, false);
  ok('the sidebar is back in the layout', (await desk.page.locator('.sidebar').boundingBox()).x >= 0);
  ok('  and the menu button is gone', !(await desk.page.locator('.nav-btn').isVisible()));
  ok('  with no scrim over the page', !(await desk.page.locator('.nav-scrim').isVisible()));
  const deskW = await desk.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok('  and nothing scrolls sideways', deskW);

  const allErrs = errs.concat(desk.errs);
  console.log('\nconsole errors: ' + (allErrs.length ? JSON.stringify(allErrs) : 'none'));
  allErrs.forEach(() => fails++);
  console.log(fails ? `\nmobile: ${fails} CHECK(S) FAILED` : '\nmobile: all checks passed');

  await browser.close();
  stop();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
