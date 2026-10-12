'use strict';
/*
  Portfolio, programme and project — the tracker half of the app.

  These are the parts brought over from the standalone project tracker: levels
  that roll up, budgets with earned value, a RAID log that feeds health, custom
  details, an activity log, part-done milestones, and the doughnuts that report
  them. Every one is optional, so the first thing checked is that a project
  which uses none of them still looks exactly like it did.

  Chart.js comes from a CDN the test environment cannot reach, so a stub records
  what the app asks to be drawn. That is the right boundary anyway: what needs
  testing is the data and colours handed to the chart, not Chart.js itself.
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
  catch (e) { return await chromium.launch({ ...opts, executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }); }
}

async function openApp(browser, { charts }) {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
  const page = await ctx.newPage();
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    return route.abort();
  });
  if (charts) {
    // Stands in for the CDN's Chart.js and records every config the app builds.
    await page.addInitScript(() => {
      window.__charts = [];
      window.Chart = function (el, cfg) { window.__charts.push(cfg); this.destroy = function () {}; };
    });
  }
  const errs = [];
  page.on('pageerror', e => { if (!/firebase|db is not defined/.test(e.message)) errs.push(e.message); });
  page.on('dialog', d => d.accept());
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.sidebar');
  return { ctx, page, errs };
}

/* Worse-first, so a check can say "this did not improve the verdict". */
const ORDER = ['overdue', 'behind', 'risk', 'ontrack', 'ahead', 'nodate', 'notstarted', 'noplan', 'done'];
const HEALTH_RANK = h => ORDER.indexOf(h);

const go = (page, v) => page.evaluate(x => handleAction('nav', { getAttribute: () => x }), v)
  .then(() => page.waitForTimeout(350));

(async () => {
  const server = spawn('node', ['serve.js'], { cwd: ROOT, stdio: 'ignore' });
  const stop = () => { try { server.kill(); } catch (e) {} };
  process.on('exit', stop);
  await waitForServer();
  const browser = await launch();
  const { page, errs } = await openApp(browser, { charts: true });

  await go(page, 'settings');
  await page.fill('#import-input', FIXTURE);
  await page.click('[data-action="import-preview"]');
  await page.click('[data-action="import-apply"]');
  await page.waitForTimeout(700);

  const titleOf = id => page.evaluate(x => (byId(x) || {}).title, id);
  const statOf = id => page.evaluate(x => { const s = projectStats(byId(x)); return { pct: s.pct, health: s.health, container: s.container, total: s.total, risks: s.openRisks, cpi: s.cpi, earned: s.earned, budget: s.budget }; }, id);

  console.log('\nNOTHING CHANGES FOR A PROJECT THAT USES NONE OF IT');
  const plain = await page.evaluate(() => projects().find(p => p.subtasks.length > 1).id);
  const before = await statOf(plain);
  ok('an ordinary project still reports a percentage', before.pct !== null, before);
  ok('  and is not a container', before.container === false, before);
  ok('  with no money figures invented', before.budget === null && before.cpi === null, before);

  console.log('\nLEVELS — A PORTFOLIO IS WHAT SITS UNDER IT');
  await go(page, 'projects');
  await page.click('[data-action="new-project"][data-kind="portfolio"]');
  await page.waitForSelector('#np-title');
  await page.fill('#np-title', 'Intel Group');
  await page.click('[data-action="confirm-new-project"]');
  await page.waitForTimeout(500);
  const portId = await page.evaluate(() => (projects().find(p => p.title === 'Intel Group') || {}).id);
  ok('a portfolio can be created', !!portId);
  ok('  and it is a container with nothing under it', (await statOf(portId)).total === 0, await statOf(portId));

  // Put a real project under it through the editor, the way the owner would.
  await page.evaluate(x => handleAction('open-editor', { getAttribute: () => x }), plain);
  await page.waitForSelector('#ed-kind');
  ok('the editor offers a level', await page.locator('#ed-kind option').count() === 3);
  await page.selectOption('#ed-parent', portId);
  await page.fill('#ed-weight', '3');
  await page.fill('#ed-budget', '500000');
  await page.fill('#ed-spent', '400000');
  await page.click('[data-action="confirm-edit"]');
  await page.waitForTimeout(500);

  const port = await statOf(portId);
  ok('the portfolio now holds it', port.total === 1, port);
  ok('  and reports the child\'s completion as its own', port.pct === before.pct, { port: port.pct, child: before.pct });
  ok('  with the child\'s budget rolled up', port.budget === 500000, port);
  const child = await statOf(plain);
  ok('the child kept its own numbers', child.pct === before.pct, child);
  ok('  and gained earned value from the budget', child.earned !== null && child.cpi !== null, child);

  console.log('\nTHE TREE');
  await go(page, 'reports');
  await page.click('[data-tab="portfolio"]');
  await page.waitForTimeout(500);
  const tree = await page.locator('.tree-row').count();
  ok('the tree shows the portfolio and its child', tree >= 2, tree);
  const treeText = await page.locator('.card').filter({ has: page.locator('.tree-row') }).innerText();
  ok('  naming the share of the parent', /% of parent/.test(treeText), treeText.split('\n').slice(0, 6));
  ok('  and the money against it', /500,000/.test(treeText));

  console.log('\nRISK — A LIVE ONE CHANGES THE VERDICT');
  /* The fixture project is long overdue, and overdue is already the worst
     verdict there is. Give it a sane window first, so what is being tested is
     the risk's effect and not the calendar's. */
  await page.evaluate(x => {
    const p = byId(x), DAY = 86400000;
    const iso = t => new Date(t).toISOString().slice(0, 10);
    p.startDate = iso(Date.now() - 50 * DAY);
    p.dueDate = iso(Date.now() + 50 * DAY);
    p.subtasks.slice(0, 5).forEach(s => { s.done = true; s.doneAt = new Date().toISOString(); });
    // Bring the spend back in line too, so the only thing left to move the
    // verdict is the risk about to be added.
    p.actualCost = 300000;
    persist();
  }, plain);
  await page.waitForTimeout(400);
  const healthBefore = (await statOf(plain)).health;
  ok('with a sane window it is not in trouble', healthBefore !== 'overdue' && healthBefore !== 'behind', healthBefore);
  await page.evaluate(x => handleAction('open-project-report', { getAttribute: () => x }), plain);
  await page.waitForTimeout(400);
  await page.click('[data-action="add-risk"]');
  await page.waitForSelector('#rk-title');
  await page.fill('#rk-title', 'Crane slot may slip');
  await page.selectOption('#rk-prob', '4');
  await page.selectOption('#rk-impact', '5');
  await page.fill('#rk-owner', 'Site team');
  await page.click('[data-action="save-risk"]');
  await page.waitForTimeout(500);
  const withRisk = await statOf(plain);
  ok('the risk is logged', withRisk.risks === 1, withRisk);
  ok('  and a score of 20 drags the verdict to off track', withRisk.health === 'behind', { was: healthBefore, now: withRisk.health });
  ok('  which is a downgrade, never an upgrade',
    HEALTH_RANK(withRisk.health) <= HEALTH_RANK(healthBefore), { was: healthBefore, now: withRisk.health });
  const modal = await page.locator('.modal').innerText();
  ok('  the project panel lists it', /Crane slot may slip/.test(modal));
  ok('  with a heat map behind it', await page.locator('.modal .heat-cell').count() === 25, await page.locator('.modal .heat-cell').count());
  ok('  and the portfolio above it turns too', (await statOf(portId)).health === 'behind', await statOf(portId));

  // Closing it takes the pressure off again.
  await page.click('.modal [data-action="edit-risk"]');
  await page.waitForSelector('#rk-status');
  await page.selectOption('#rk-status', 'closed');
  await page.click('[data-action="save-risk"]');
  await page.waitForTimeout(500);
  ok('closing the risk gives the verdict back', (await statOf(plain)).health === healthBefore, await statOf(plain));
  await page.click('.modal [data-action="delete-risk"]');
  await page.waitForTimeout(500);
  ok('  and it can be deleted', (await page.evaluate(x => byId(x).risks.length, plain)) === 0);

  console.log('\nDETAILS AND WHAT HAPPENED');
  await page.click('.modal [data-action="add-field"]');
  await page.waitForSelector('#fd-label');
  await page.fill('#fd-label', 'Vendor');
  await page.fill('#fd-value', 'Shanghai Lift Co.');
  await page.click('[data-action="save-field"]');
  await page.waitForTimeout(500);
  ok('a custom detail is kept', await page.evaluate(x => byId(x).fields.length, plain) === 1);
  ok('  and shown', /Shanghai Lift Co\./.test(await page.locator('.modal').innerText()));
  await page.fill('.modal input[data-role="proj-log"]', 'Crane booked for the 20th');
  await page.click('.modal [data-action="add-log"]');
  await page.waitForTimeout(500);
  const log = await page.evaluate(x => byId(x).log.map(l => l.text), plain);
  ok('a note goes into the log', log.includes('Crane booked for the 20th'), log);
  ok('  dated', await page.evaluate(x => !!byId(x).log[0].at, plain));

  console.log('\nPART-DONE MILESTONES');
  await page.click('.modal-actions [data-action="close-modal"]');
  await page.waitForTimeout(300);
  await go(page, 'projects');
  await page.locator('.project-card').filter({ hasText: await titleOf(plain) }).locator('.project-head').click();
  await page.waitForTimeout(400);
  const pctBefore = (await statOf(plain)).pct;
  // The first few are closed by now; part-done only means anything on an open one.
  await page.locator('.sub-row [data-action="rename-subtask"]').last().click();
  await page.waitForSelector('#ms-pct');
  await page.fill('#ms-pct', '50');
  await page.click('[data-action="confirm-rename-subtask"]');
  await page.waitForTimeout(500);
  const pctAfter = (await statOf(plain)).pct;
  ok('half a milestone moves the project half a milestone', pctAfter > pctBefore, { pctBefore, pctAfter });
  ok('  and says so on the row', /50%/.test(await page.locator('.project-body').first().innerText()));

  console.log('\nDOUGHNUTS — DRAWN WITHOUT A LIBRARY, SO THEY ARE ALWAYS THERE');
  /* These were Chart.js canvases, and on a phone whose CDN request failed they
     silently became a list of numbers with no picture — which is how it was
     reported. They are inline SVG now: no library, no network, no canvas. */
  await go(page, 'reports');
  await page.click('[data-tab="areas"]');
  await page.waitForTimeout(500);
  const ring = page.locator('.donut-svg').first();
  ok('a doughnut is drawn', await ring.count() === 1);
  const arcs = await page.locator('.donut-svg .donut-arc').evaluateAll(els => els.map(el => ({
    len: parseFloat(el.getAttribute('stroke-dasharray').split(' ')[0]),
    color: el.getAttribute('stroke'),
    label: el.querySelector('title').textContent,
  })));
  ok('  one arc per slice, six at most', arcs.length > 0 && arcs.length <= 6, arcs.length);
  ok('  biggest first', arcs.every((a, i) => i === 0 || a.len <= arcs[i - 1].len), arcs.map(a => a.len));
  ok('  in the fixed series order', arcs[0].color.toLowerCase() === '#2a78d6', arcs.map(a => a.color));
  ok('  and the ring adds up to the whole', Math.abs(arcs.reduce((s2, a) => s2 + a.len, 0) - (100 - 0.8 * arcs.length)) < 1.5,
    arcs.reduce((s2, a) => s2 + a.len, 0));
  ok('  each arc says what it is, for a hover and for a screen reader',
    arcs.every(a => /: .+\(\d+%\)/.test(a.label)), arcs.map(a => a.label));
  ok('  with the total in the middle', /\d/.test(await page.locator('.donut-total').first().innerText()),
    await page.locator('.donut-total').first().innerText());
  // The legend is what carries the numbers when the colour cannot.
  const legend = await page.locator('.legend li').allInnerTexts();
  ok('  and a written legend repeats them', legend.length === arcs.length, legend);
  ok('    with a share each', legend.every(l => /%/.test(l)), legend);

  await page.click('[data-tab="projects"]');
  await page.waitForTimeout(500);
  const healthArcs = await page.locator('.donut-svg .donut-arc').evaluateAll(els => els.map(el => el.getAttribute('stroke')));
  ok('the health mix is a doughnut too', healthArcs.length > 0);
  ok('  coloured by verdict, not by series slot',
    healthArcs.every(c => ['#10B981', '#06B6D4', '#94A3B8', '#F59E0B', '#F43F5E', '#CBD5E1'].includes(c)), healthArcs);

  console.log('\nCURRENCY IS A LABEL, NOT A CONVERSION');
  await go(page, 'settings');
  await page.fill('#currency-input', 'ETB');
  await page.locator('#currency-input').blur();
  await page.waitForTimeout(500);
  ok('the label is kept', await page.evaluate(() => state.state.settings.currency) === 'ETB');
  await go(page, 'reports');
  await page.click('[data-tab="portfolio"]');
  await page.waitForTimeout(500);
  ok('  and shows beside the money', /ETB/.test(await page.locator('.view').innerText()));

  console.log('\nAGILE — A BACKLOG INSTEAD OF A PLAN');
  const agileId = await page.evaluate(() => {
    const p = newItem({ type:'project', title:'Zipana', category:'Operations', priority:'high', isStarred:true });
    p.method = 'agile';
    persist();
    return p.id;
  });
  await go(page, 'projects');
  await page.locator('.project-card').filter({ hasText: 'Zipana' }).locator('.project-head').click();
  await page.waitForTimeout(400);
  ok('an agile project shows a board instead of milestones', await page.locator('.board-col').count() === 3,
    await page.locator('.board-col').count());

  for (const t of ['Sign-up screen', 'Payment hook']) {
    await page.fill(`input[data-role="new-story"][data-id="${agileId}"]`, t);
    await page.click(`[data-action="add-story"][data-id="${agileId}"]`);
    await page.waitForTimeout(350);
  }
  ok('items go into the backlog', await page.evaluate(x => byId(x).backlog.length, agileId) === 2);
  ok('  starting in To do', await page.evaluate(x => byId(x).backlog.every(b => b.status === 'todo'), agileId));

  // Points step through the usual ladder.
  const firstPoints = () => page.evaluate(x => byId(x).backlog[0].points, agileId);
  const p0 = await firstPoints();
  await page.locator('.story [data-action="story-points"]').first().click();
  await page.waitForTimeout(350);
  ok('points step on a tap', (await firstPoints()) !== p0, { was: p0, now: await firstPoints() });

  // Moving an item right puts it in Doing, then Done. Take it from the column it
  // is actually in — after the first move it is no longer the first card on the board.
  const col = n => page.locator('.board-col').nth(n);
  await col(0).locator('.story [data-action="story-move"][data-dir="1"]').first().click();
  await page.waitForTimeout(350);
  ok('an item moves to Doing', await page.evaluate(x => byId(x).backlog[0].status, agileId) === 'doing');
  await col(1).locator('.story [data-action="story-move"][data-dir="1"]').first().click();
  await page.waitForTimeout(350);
  const done = await page.evaluate(x => byId(x).backlog.find(b => b.status === 'done'), agileId);
  ok('  and on to Done', !!done, done && done.title);
  ok('  stamped with when, which is what the burndown reads', !!(done && done.doneAt));
  const agStat = await statOf(agileId);
  ok('the project percentage now comes from the backlog', agStat.pct > 0 && agStat.pct < 100, agStat);

  console.log('\nSPRINTS');
  await page.click(`[data-action="add-sprint"][data-id="${agileId}"]`);
  await page.waitForSelector('#sp-name');
  await page.fill('#sp-name', 'Sprint 1');
  await page.fill('#sp-goal', 'Get sign-up working');
  await page.click('[data-action="save-sprint"]');
  await page.waitForTimeout(500);
  ok('a sprint is created', await page.evaluate(x => byId(x).sprints.length, agileId) === 1);
  // Items added before the sprint existed are not in it; put them in.
  await page.evaluate(x => { const p = byId(x); p.backlog.forEach(b => b.sprintId = p.sprints[0].id); persist(); }, agileId);
  await page.waitForTimeout(400);
  const body = await page.locator('.project-card').filter({ hasText: 'Zipana' }).locator('.project-body').innerText();
  ok('  and the board says which one you are in', /Sprint 1/.test(body) && /Get sign-up working/.test(body),
    body.split('\n').slice(0, 5));

  console.log('\nTHE PIPELINE OFFERS THE NEXT BACKLOG ITEM');
  await go(page, 'now');
  const pipeline = await page.locator('.pipeline-row').allInnerTexts();
  ok('a starred agile project reaches Now through its backlog',
    pipeline.some(t => /Payment hook|Sign-up screen/.test(t)), pipeline);
  await page.locator('.pipeline-row').filter({ hasText: /Payment hook|Sign-up screen/ }).first()
    .locator('[data-action="toggle-pin"]').click();
  await page.waitForTimeout(400);
  const pinned = await page.evaluate(() => nowPins().filter(r => r.indexOf('st:') === 0));
  ok('  and can be pinned', pinned.length === 1, pinned);
  // Finishing it from Now closes the backlog item and frees the slot.
  await page.locator('.focus-card').filter({ hasText: /Payment hook|Sign-up screen/ }).locator('.check').click();
  await page.waitForTimeout(500);
  ok('finishing it from Now closes the item',
    await page.evaluate(x => byId(x).backlog.filter(b => b.status === 'done').length, agileId) === 2);
  ok('  and frees the slot without replacing it',
    (await page.evaluate(() => nowPins().filter(r => r.indexOf('st:') === 0))).length === 0);

  console.log('\nBURNDOWN AND VELOCITY');
  await page.evaluate(x => handleAction('open-project-report', { getAttribute: () => x }), agileId);
  await page.waitForTimeout(600);
  const built = await page.evaluate(() => (window.__charts || []).slice(-3));
  ok('a burndown is drawn', built.some(c => c.type === 'line' && c.data.datasets.length === 2
    && c.data.datasets[1].label === 'Plan'), built.map(c => c.type));
  const burn = built.find(c => c.type === 'line' && c.data.datasets[1] && c.data.datasets[1].label === 'Plan');
  ok('  its plan line runs from the full total down to nothing',
    burn.data.datasets[1].data[0] > 0 && burn.data.datasets[1].data.slice(-1)[0] === 0, burn.data.datasets[1].data);
  ok('  and the actual line stops at today rather than guessing',
    burn.data.datasets[0].data.some(v => v === null), burn.data.datasets[0].data);
  await page.click('.modal-actions [data-action="close-modal"]');
  await page.waitForTimeout(300);

  console.log('\nWINS — FINISHED WORK IS REPORTED AS FINISHED');
  await page.evaluate(() => {
    const DAY = 86400000;
    const p = newItem({ type:'project', title:'Shipment cleared', category:'Operations' });
    p.startDate = new Date(Date.now() - 40 * DAY).toISOString().slice(0, 10);
    p.dueDate = new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10);
    p.budget = 100; p.actualCost = 80;
    p.subtasks = [{ id:'w1', title:'Clear customs', done:true, effort:'L', doneAt:new Date().toISOString(), xpAwarded:true, pct:null, source:'manual' }];
    p.status = 'done'; p.completedAt = new Date().toISOString();
    persist();
  });
  await go(page, 'reports');
  await page.click('[data-tab="wins"]');
  await page.waitForTimeout(600);
  const wins = await page.locator('.view').innerText();
  ok('the finished project is there', /Shipment cleared/.test(wins), wins.split('\n').slice(0, 8));
  ok('  counted in the headline', await page.locator('.win-hero-n').innerText() !== '0', await page.locator('.win-hero-n').innerText());
  ok('  and credited for beating its date and its budget',
    /on time/.test(wins) && /within budget/.test(wins), wins.split('\n').filter(l => /time|budget/.test(l)).slice(0, 3));
  ok('  with a month-by-month strip', await page.locator('.spark-col').count() === 12, await page.locator('.spark-col').count());
  ok('  and a doughnut of which domain finished them',
    await page.locator('.donut-svg .donut-arc').count() > 0, await page.locator('.donut-svg .donut-arc').count());
  // A narrower window is allowed to be empty, and says so rather than looking broken.
  await page.click('[data-action="wins-range"][data-range="week"]');
  await page.waitForTimeout(500);
  ok('narrowing the window still renders', await page.locator('.win-hero-n').count() === 1);

  console.log('\nWITHOUT CHART.JS THE PIES SURVIVE AND THE REST SAYS SO');
  const plainPage = await openApp(browser, { charts: false });
  // A fresh context has its own empty storage, so give it something to chart.
  await go(plainPage.page, 'settings');
  await plainPage.page.fill('#import-input', FIXTURE);
  await plainPage.page.click('[data-action="import-preview"]');
  await plainPage.page.click('[data-action="import-apply"]');
  await plainPage.page.waitForTimeout(700);
  await go(plainPage.page, 'reports');
  await plainPage.page.click('[data-tab="areas"]');
  await plainPage.page.waitForTimeout(400);
  ok('the doughnut is still drawn with no library at all',
    await plainPage.page.locator('.donut-svg .donut-arc').count() > 0,
    await plainPage.page.locator('.donut-svg .donut-arc').count());
  const text = await plainPage.page.locator('.view').innerText();
  ok('  and the line and bar charts explain their absence rather than vanishing',
    /graph library did not load/.test(text), text.split('\n').filter(l => /library/.test(l)));
  await plainPage.ctx.close();

  console.log('\nTHEME IS PER DEVICE');
  const other = await openApp(browser, { charts: false });
  const themeOf = p => p.evaluate(() => document.documentElement.dataset.theme);
  const first = await themeOf(page);
  await go(page, 'settings');
  await page.click('[data-action="toggle-theme"]');
  await page.waitForTimeout(400);
  ok('switching changes this device', (await themeOf(page)) !== first, { first, now: await themeOf(page) });
  await other.page.reload({ waitUntil: 'domcontentloaded' });
  await other.page.waitForSelector('.sidebar');
  await other.page.waitForTimeout(400);
  ok('  and leaves the other one alone', (await themeOf(other.page)) === first, { other: await themeOf(other.page), first });
  ok('  without writing it into the synced data',
    await page.evaluate(() => { const t = JSON.parse(localStorage.getItem('adhd-second-brain-v1')); return t.state.settings.themeMode; }) !== (await themeOf(page)),
    { stored: await page.evaluate(() => JSON.parse(localStorage.getItem('adhd-second-brain-v1')).state.settings.themeMode), shown: await themeOf(page) });
  await other.ctx.close();

  const allErrs = errs.concat(plainPage.errs, other.errs);
  console.log('\nconsole errors: ' + (allErrs.length ? JSON.stringify(allErrs) : 'none'));
  allErrs.forEach(() => fails++);
  console.log(fails ? `\nportfolio: ${fails} CHECK(S) FAILED` : '\nportfolio: all checks passed');

  await browser.close();
  stop();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
