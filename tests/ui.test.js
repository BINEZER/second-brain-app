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

/* A real pointer drag: press the handle, move past the slop threshold, release
   over the target row. Mirrors what a hand does — nothing is dispatched directly. */
async function dragRow(page, rowSel, fromIdx, toIdx) {
  const rows = page.locator(rowSel);
  const handle = rows.nth(fromIdx).locator('[data-dnd-handle]').first();
  const hb = await handle.boundingBox();
  const tb = await rows.nth(toIdx).boundingBox();
  const x = hb.x + hb.width / 2;
  await page.mouse.move(x, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, hb.y + hb.height / 2 + 12, { steps: 3 });
  // Aim past the target's midpoint in the direction of travel.
  await page.mouse.move(x, toIdx > fromIdx ? tb.y + tb.height - 4 : tb.y + 4, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

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

  console.log('\nNOW — the app never puts anything here, and never replaces anything');
  await page.click('[data-action="nav"][data-view="now"]');
  await page.waitForTimeout(300);
  ok('Now starts empty — nothing is auto-filled', (await st()).settings.nowPins.length === 0,
    (await st()).settings.nowPins.length);
  await page.click('[data-action="nav"][data-view="inbox"]');
  for (const t of ['Charlie', 'Delta', 'Echo', 'Foxtrot']) {
    await page.fill('#capture-input', t);
    await page.click('[data-action="capture-add"]');
    await page.waitForTimeout(150);
  }
  for (let i = 0; i < 4; i++) {
    await page.locator('.item-row').nth(i).locator('[data-action="toggle-pin"]').click();
    await page.waitForTimeout(200);
  }
  // The old build refused a fourth pin with "Now is full (3/3)".
  ok('a fourth pin is allowed', (await st()).settings.nowPins.length === 4, (await st()).settings.nowPins.length);
  await page.click('[data-action="nav"][data-view="now"]');
  await page.waitForTimeout(300);
  const pinsBefore = await page.locator('.focus-card .focus-title').allInnerTexts();
  await page.locator('.focus-card').first().locator('[data-action="toggle-pin"]').click();
  await page.waitForTimeout(400);
  const pinsAfter = await page.locator('.focus-card .focus-title').allInnerTexts();
  ok('unpinning removes exactly one', pinsAfter.length === pinsBefore.length - 1, { pinsBefore, pinsAfter });
  ok('  and nothing is substituted in', pinsAfter.join('|') === pinsBefore.slice(1).join('|'),
    { pinsBefore, pinsAfter });
  await page.locator('.focus-card').first().locator('.check').click();
  await page.waitForTimeout(500);
  const pinsDone = await page.locator('.focus-card .focus-title').allInnerTexts();
  ok('completing a pin frees its slot', pinsDone.length === pinsAfter.length - 1, pinsDone);
  ok('  and still substitutes nothing', pinsDone.join('|') === pinsAfter.slice(1).join('|'),
    { pinsAfter, pinsDone });
  await dragRow(page, '.focus-card', 0, 1);
  const pinsDrag = await page.locator('.focus-card .focus-title').allInnerTexts();
  ok('Now pins reorder by drag', pinsDrag[1] === pinsDone[0] && pinsDrag[0] === pinsDone[1],
    { before: pinsDone, after: pinsDrag });

  console.log('\nNOW — a milestone is a first-class focus item');
  /* Pins were item ids and a milestone is not an item, while the pipeline filtered
     to type==='task'. A plan made only of projects and milestones — the normal
     shape — therefore left both surfaces permanently empty with no way to fill
     them. Star a project and its next milestone must reach Now. */
  await page.click('[data-action="nav"][data-view="projects"]');
  await page.waitForTimeout(300);
  const starTarget = page.locator('.project-card', { hasText: 'Site installation' });
  await page.click('[data-action="nav"][data-view="now"]');
  await page.waitForTimeout(400);
  const pipeRows = await page.locator('.pipeline-row').count();
  ok('a starred project puts its next milestone in the pipeline', pipeRows > 0, pipeRows);
  const pipeText = await page.locator('.pipeline').innerText();
  ok('  and the row names the project it came from', /📁/.test(pipeText));
  // One row per project: a nine-step project must not crowd out everything else.
  const projRefs = await page.evaluate(() =>
    [...document.querySelectorAll('.pipeline-row [data-action="toggle-pin"]')].map(b => b.getAttribute('data-id')));
  const msProjects = projRefs.filter(r => r.startsWith('ms:')).map(r => r.split(':')[1]);
  ok('  at most one milestone per project', new Set(msProjects).size === msProjects.length, msProjects);

  /* The fixture also has starred tasks, so the first pipeline row is not
     necessarily a milestone — pick the milestone row by its reference. */
  const msIdx = projRefs.findIndex(r => r.startsWith('ms:'));
  ok('the pipeline contains at least one milestone', msIdx >= 0, projRefs);
  const pipeTitle = await page.locator('.pipeline-row .item-title').nth(msIdx).innerText();
  await page.locator('.pipeline-row [data-action="toggle-pin"]').nth(msIdx).click();
  await page.waitForTimeout(500);
  const pinRefs = (await st()).settings.nowPins;
  ok('pinning stores a milestone reference', pinRefs.some(r => r.startsWith('ms:')), pinRefs);
  ok('  and it shows in Now',
    (await page.locator('.focus-card .focus-title').allInnerTexts()).includes(pipeTitle), pipeTitle);
  ok('  and leaves the pipeline', !(await page.locator('.pipeline').innerText()).includes(pipeTitle));

  // Ticking a pinned milestone must close the milestone on its project, not an item.
  const pinnedCard = page.locator('.focus-card').filter({ hasText: pipeTitle }).first();
  await pinnedCard.locator('.check').click();
  await page.waitForTimeout(600);
  const afterTick = await st();
  ok('ticking it in Now closes the milestone itself',
    afterTick.items.some(i => (i.subtasks || []).some(x => x.title === pipeTitle && x.done)), pipeTitle);
  ok('  and frees that slot without substituting anything',
    !afterTick.settings.nowPins.includes(pinRefs.find(r => r.startsWith('ms:'))),
    afterTick.settings.nowPins);

  // Pinning from inside a project is the other natural entry point.
  await page.click('[data-action="nav"][data-view="projects"]');
  await starTarget.locator('.project-head').click();
  await page.waitForSelector('.sub-row');
  ok('milestone rows carry a pin button', await page.locator('.sub-row .pin-btn').count() > 0);
  const msTitle = await page.locator('.sub-row span[style*="flex"]').first().innerText();
  await page.locator('.sub-row').first().locator('.pin-btn').click();
  await page.waitForTimeout(500);
  await page.click('[data-action="nav"][data-view="now"]');
  await page.waitForTimeout(400);
  ok('pinning from a project lands it in Now',
    (await page.locator('.focus-card .focus-title').allInnerTexts()).includes(msTitle), msTitle);
  const msCard = page.locator('.focus-card').filter({ hasText: msTitle }).first();
  const cardsBefore = await page.locator('.focus-card').count();
  await msCard.locator('[data-action="toggle-pin"]').click();
  await page.waitForTimeout(400);
  ok('and unpinning a milestone removes exactly it',
    !(await page.locator('.focus-card .focus-title').allInnerTexts()).includes(msTitle)
    && await page.locator('.focus-card').count() === cardsBefore - 1);
  // Collapse the project again: later blocks assume no card is expanded.
  await page.click('[data-action="nav"][data-view="projects"]');
  await starTarget.locator('.project-head').click();
  await page.waitForTimeout(300);

  console.log('\nPIN STATE — the same everywhere, so you can see what is already in Now');
  /* Three lists rendered three different pin buttons: the Inbox tinted the icon,
     milestones tinted it, and a task inside a project showed no pinned state at
     all — so one already in Now looked identical to one that was not. */
  await page.click('[data-action="nav"][data-view="inbox"]');
  await page.waitForTimeout(300);
  const pinRow = page.locator('.item-row').first();
  ok('a pin button starts un-pinned',
    !(await pinRow.locator('.pin-btn').getAttribute('class')).includes('pinned'));
  await pinRow.locator('.pin-btn').click();
  await page.waitForTimeout(400);
  const pinnedBtn = page.locator('.item-row').first().locator('.pin-btn');
  ok('  and shows as pinned once it is in Now',
    (await pinnedBtn.getAttribute('class')).includes('pinned'));
  ok('  with a title saying what a click does now',
    /already in now/i.test(await pinnedBtn.getAttribute('title')));
  ok('  and aria-pressed for anyone not seeing the styling',
    (await pinnedBtn.getAttribute('aria-pressed')) === 'true');
  // Pinned stays clickable: you must be able to take it out from where you are.
  await pinnedBtn.click();
  await page.waitForTimeout(400);
  ok('clicking a pinned button takes it out of Now',
    !(await page.locator('.item-row').first().locator('.pin-btn').getAttribute('class')).includes('pinned'));

  // Every entry point renders the one shared control.
  await page.click('[data-action="nav"][data-view="projects"]');
  await page.locator('.project-card', { hasText: 'Site installation' }).locator('.project-head').click();
  await page.waitForSelector('.sub-row');
  ok('milestones and project tasks use the same pin control',
    await page.locator('.sub-row .pin-btn').count() > 0
    && await page.locator('.project-body .item-row .pin-btn').count() > 0);
  ok('no list renders its own ad-hoc pin button',
    await page.evaluate(() => [...document.querySelectorAll('[data-action="toggle-pin"]')]
      .every(b => b.classList.contains('pin-btn') || b.classList.contains('btn-danger') || b.textContent.includes('Now'))));
  await page.locator('.project-card', { hasText: 'Site installation' }).locator('.project-head').first().click();
  await page.waitForTimeout(300);

  console.log('\nDRAG TO REORDER — every list, across more than one row');
  await page.click('[data-action="nav"][data-view="inbox"]');
  await page.waitForTimeout(300);
  const inb0 = await page.locator('.item-row .item-title').allInnerTexts();
  await dragRow(page, '.item-row', 0, 2);
  const inb1 = await page.locator('.item-row .item-title').allInnerTexts();
  ok('inbox: a row drags two places down', inb1[2] === inb0[0] && inb1[0] === inb0[1],
    { before: inb0.slice(0, 3), after: inb1.slice(0, 3) });
  await dragRow(page, '.item-row', 2, 0);
  ok('inbox: dragging it back restores the order',
    (await page.locator('.item-row .item-title').allInnerTexts()).join('|') === inb0.join('|'));
  // A drag must not swallow an ordinary click on the row.
  await page.locator('.item-row .clickable-title').first().click();
  await page.waitForTimeout(300);
  ok('clicking a row still opens it', await page.locator('.modal').count() === 1);
  await page.click('.modal-actions [data-action="close-modal"]');
  await page.waitForTimeout(200);
  // The arrows must still agree with the drag: both go through one reorder path.
  const arr0 = await page.locator('.item-row .item-title').allInnerTexts();
  await page.locator('.item-row').nth(1).locator('[data-action="move-inbox"][data-dir="-1"]').click();
  await page.waitForTimeout(400);
  const arr1 = await page.locator('.item-row .item-title').allInnerTexts();
  ok('the arrows still work alongside the handle', arr1[0] === arr0[1] && arr1[1] === arr0[0],
    { before: arr0.slice(0, 2), after: arr1.slice(0, 2) });

  await page.click('[data-action="nav"][data-view="projects"]');
  await page.waitForTimeout(300);
  const prj0 = await page.locator('.project-title').allInnerTexts();
  await dragRow(page, '.project-card[data-dnd-row]', 0, 2);
  const prj1 = await page.locator('.project-title').allInnerTexts();
  ok('projects reorder by drag', prj1[2] === prj0[0], { before: prj0, after: prj1 });

  await page.click('[data-action="nav"][data-view="habits"]');
  await page.waitForSelector('.habit-row');
  const hb0 = await page.evaluate(() => [...document.querySelectorAll('.habit-row')].map(r => r.innerText.split('\n')[0]));
  await dragRow(page, '.habit-row[data-dnd-row]', 0, 2);
  const hb1 = await page.evaluate(() => [...document.querySelectorAll('.habit-row')].map(r => r.innerText.split('\n')[0]));
  ok('habits reorder by drag', hb1[2] === hb0[0], { before: hb0, after: hb1 });

  console.log('\nINBOX SCOPES — one idea, one chip');
  await page.click('[data-action="nav"][data-view="inbox"]');
  await page.waitForTimeout(300);
  const scopeLabels = await page.locator('[data-action="inbox-scope"]').allInnerTexts();
  // "Unfiled" and "Standalone" were two chips for one idea; unfiled is now an
  // ordering and a row marker inside Standalone.
  ok('there is no separate Unfiled scope', !scopeLabels.some(t => /unfiled/i.test(t)), scopeLabels);
  ok('four scopes remain', scopeLabels.length === 4, scopeLabels);
  await page.click('[data-action="inbox-scope"][data-scope="standalone"]');
  await page.waitForTimeout(300);
  const topRow = await page.locator('.item-row').first().innerText();
  ok('a task with no domain is marked, not hidden, and sorts to the top',
    /needs a domain/.test(topRow), topRow.replace(/\n/g, ' '));
  /* The badge counted anything in the Inbox domain, projects included, so a
     project left there read as a number against an empty list. */
  const badgeN = (await st()).items.filter(i => i.type === 'task' && i.category === 'Inbox' && i.status === 'open').length;
  await page.click('[data-action="inbox-scope"][data-scope="all"]');
  await page.waitForTimeout(300);
  const processLabel = await page.locator('.view-head [data-action="process-inbox"]').innerText();
  ok('the Process Inbox count matches what the list can actually show',
    processLabel.includes('(' + badgeN + ')'), { label: processLabel, tasks: badgeN });

  console.log('\nINBOX — due-date and domain filters');
  await page.click('[data-action="nav"][data-view="inbox"]');
  await page.click('[data-action="inbox-scope"][data-scope="all"]');
  await page.waitForTimeout(300);
  const dateChips = await page.locator('[data-action="inbox-date"]').allInnerTexts();
  ok('the Inbox offers a date filter', dateChips.length === 5, dateChips);
  /* Chip counts come from the list before the date filter, so each chip promises
     what clicking it reveals rather than counting an already-narrowed list. */
  const anyCount = await page.locator('.item-row').count();
  ok('the "Any date" count matches the visible list',
    dateChips[0].includes('(' + anyCount + ')'), { chip: dateChips[0], rows: anyCount });

  const todayStr = new Date().toISOString().slice(0, 10);
  const weekEnd = new Date(); weekEnd.setDate(weekEnd.getDate() + 7);
  const weekStr = weekEnd.toISOString().slice(0, 10);
  const openNow = (await st()).items.filter(i => i.type === 'task' && i.status === 'open');
  for (const [key, pred] of [
    ['overdue', t => !!t.dueDate && t.dueDate < todayStr],
    ['today',   t => t.dueDate === todayStr],
    ['week',    t => !!t.dueDate && t.dueDate >= todayStr && t.dueDate <= weekStr],
    ['nodate',  t => !t.dueDate]
  ]) {
    await page.click(`[data-action="inbox-date"][data-date="${key}"]`);
    await page.waitForTimeout(350);
    const want = openNow.filter(pred).map(t => t.title).sort();
    const got = (await page.locator('.item-row .item-title').allInnerTexts()).sort();
    ok(`the ${key} filter shows exactly those tasks`, JSON.stringify(got) === JSON.stringify(want), { got, want });
  }
  await page.click('[data-action="inbox-date"][data-date="all"]');
  await page.waitForTimeout(300);

  const domSel = page.locator('[data-action-change="inbox-category"]');
  ok('the Inbox offers a domain filter', await domSel.count() === 1);
  const domOpts = await domSel.locator('option').allInnerTexts();
  // A picker offering a choice that yields nothing is just a longer list to read.
  ok('it only lists domains that hold something, with counts',
    domOpts.length > 1 && domOpts.slice(1).every(o => /\(\d+\)$/.test(o.trim())), domOpts);
  const pickDomain = domOpts[1].replace(/\s*\(\d+\)$/, '');
  await domSel.selectOption(pickDomain);
  await page.waitForTimeout(400);
  const domRows = await page.locator('.item-row .item-title').allInnerTexts();
  const domWant = openNow.filter(t => t.category === pickDomain).map(t => t.title).sort();
  ok('choosing a domain narrows to exactly that domain',
    JSON.stringify(domRows.sort()) === JSON.stringify(domWant), { got: domRows, want: domWant });
  ok('  and the date counts follow the domain',
    (await page.locator('[data-action="inbox-date"]').allInnerTexts())[0].includes('(' + domWant.length + ')'),
    (await page.locator('[data-action="inbox-date"]').allInnerTexts())[0]);

  // Filters combine, and an empty result must offer the way out.
  await page.click('[data-action="inbox-scope"][data-scope="recurring"]');
  await page.waitForTimeout(350);
  const filterEmpty = await page.locator('.empty').innerText();
  ok('an empty filtered view offers a way out', /clear filters/i.test(filterEmpty), filterEmpty);
  await page.locator('.empty [data-action="clear-inbox-filters"]').click();
  await page.waitForTimeout(350);
  ok('  and clearing resets the date filter',
    (await page.locator('[data-action="inbox-date"][data-date="all"]').getAttribute('class')).includes('on'));
  /* The domain picker is only rendered when the scope holds something, so check it
     back in a scope that does — its absence in an empty scope is correct. */
  await page.click('[data-action="inbox-scope"][data-scope="all"]');
  await page.waitForTimeout(350);
  ok('  and the domain picker too', (await domSel.inputValue()) === 'all', await domSel.inputValue());

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

  console.log('\nPROCESS INBOX — a button must do what its label says');
  await page.click('[data-action="nav"][data-view="inbox"]');
  await page.fill('#capture-input', 'Golf');
  await page.click('[data-action="capture-add"]');
  await page.waitForTimeout(200);
  await page.click('.view-head [data-action="process-inbox"]');
  await page.waitForSelector('.triage-card');
  /* It read "Keep as task" while silently filing under whatever domain the
     dropdown happened to be showing. The label now names that domain. */
  ok('the keep button stays short — the dropdown above already names the domain',
    (await page.locator('[data-action="triage-keep-task"]').innerText()).trim() === '✅ Keep',
    await page.locator('[data-action="triage-keep-task"]').innerText());
  ok('  and its tooltip names the domain it will file into',
    /file it in/i.test(await page.locator('[data-action="triage-keep-task"]').getAttribute('title')));
  ok('skip says it leaves the item standalone',
    /leave it standalone/i.test(await page.locator('[data-action="triage-skip"]').innerText()));

  /* Skip advanced an index modulo the list length, so with one item left it
     landed back on the same card and looked broken, and with several it cycled
     forever. It now sets the item aside for this pass. */
  const skipped = [];
  const queueLen = (await st()).items.filter(i => i.type === 'task' && i.status === 'open' && i.category === 'Inbox').length;
  for (let k = 0; k < queueLen; k++) {
    skipped.push(await page.locator('.triage-title').innerText());
    await page.click('[data-action="triage-skip"]');
    await page.waitForTimeout(350);
  }
  ok('every skip shows a card not seen before', new Set(skipped).size === skipped.length, skipped);
  ok('skipping everything finishes the pass',
    /Done for now/.test(await page.locator('.triage-card').innerText()),
    (await page.locator('.triage-card').innerText()).replace(/\n/g, ' '));
  const afterSkip = await st();
  ok('  and skipped items stay unfiled in the Inbox, with no project',
    skipped.every(t => {
      const it = afterSkip.items.find(x => x.title === t);
      return it && it.category === 'Inbox' && !it.projectId;
    }), skipped);
  await page.click('[data-action="exit-triage"]');
  await page.waitForTimeout(300);

  // Keep still files into whatever the dropdown is showing.
  await page.click('.view-head [data-action="process-inbox"]');
  await page.waitForSelector('.triage-card');
  const triageOpts = await page.locator('#triage-cat option').allInnerTexts();
  await page.selectOption('#triage-cat', triageOpts[1]);
  await page.waitForTimeout(300);
  const triaged = await page.locator('.triage-title').innerText();
  await page.click('[data-action="triage-keep-task"]');
  await page.waitForTimeout(500);
  const triagedItem = (await st()).items.find(i => i.title === triaged);
  ok('keep files into the chosen domain', triagedItem.category === triageOpts[1],
    { got: triagedItem.category, want: triageOpts[1] });
  ok('  and never puts the task into a project', !triagedItem.projectId, triagedItem.projectId);
  await page.click('[data-action="exit-triage"]');
  await page.waitForTimeout(300);

  console.log('\nFOLLOW-UPS — a person, their work, and a way to create it');
  await page.click('[data-action="nav"][data-view="followups"]');
  await page.waitForTimeout(400);
  // Follow-ups was an island: no link to the same person as a task or project owner.
  const untrackedCount = await page.locator('[data-action="track-person"]').count();
  ok('people holding work but untracked are surfaced', untrackedCount > 0, untrackedCount);
  const personLabel = await page.locator('[data-action="track-person"]').first().innerText();
  const person = personLabel.replace(/^＋\s*/, '').replace(/\s*\(\d+\)$/, '');
  await page.locator('[data-action="track-person"]').first().click();
  await page.waitForSelector('#fu-name');
  ok('tracking pre-fills their name', (await page.locator('#fu-name').inputValue()) === person, person);
  // The domain used to be hardcoded to a life area that might not exist.
  ok('the follow-up has a real domain picker', await page.locator('#fu-cat option').count() > 1);
  ok('  and says how much they already hold', /already assigned/i.test(await page.locator('.modal').innerText()));
  await page.click('[data-action="confirm-new-followup"]');
  await page.waitForTimeout(600);
  const fuRow = await page.locator('.item-row').first().innerText();
  ok('the row shows the work that person holds', /open task|project/i.test(fuRow), fuRow.replace(/\n/g, ' '));
  ok('and they leave the untracked list',
    await page.locator('[data-action="track-person"]').count() === untrackedCount - 1);

  // A follow-up can create the task it exists for, pre-assigned and linked back.
  await page.locator('[data-action="add-followup-task"]').first().click();
  await page.waitForSelector('#ft-title');
  await page.fill('#ft-title', 'Chase the signed contract');
  await page.click('[data-action="confirm-followup-task"]');
  await page.waitForTimeout(600);
  const chased = (await st()).items.find(i => i.title === 'Chase the signed contract');
  ok('a follow-up creates a real Inbox task', !!chased);
  ok('  assigned to that person', chased && chased.assignee === person, chased && chased.assignee);
  ok('  and linked back to the follow-up', !!(chased && chased.followupId));

  await page.click('[data-action="nav"][data-view="inbox"]');
  await page.click('[data-action="filter-assignee"][data-assignee="all"]');
  await page.waitForTimeout(400);
  ok('the owner chip on a task is clickable', await page.locator('[data-action="goto-followup"]').count() > 0);
  await page.locator('[data-action="goto-followup"]').first().click();
  await page.waitForTimeout(500);
  ok('  and jumps to Follow-ups',
    await page.evaluate(() => document.querySelector('.view-title').textContent) === 'Follow-ups');

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

  console.log('\nRECURRING — missed cycles stack, and each is a real task');
  await page.click('[data-action="nav"][data-view="recurring"]');
  await page.waitForTimeout(300);
  await page.click('[data-action="new-recurrence"]');
  await page.waitForSelector('#rc-title');
  await page.fill('#rc-title', 'File VAT return');
  await page.selectOption('#rc-type', 'monthly');
  await page.waitForTimeout(200);
  ok('monthly shows a day-of-month and hides the weekday chips',
    await page.locator('#rc-dom-wrap').isVisible() && !(await page.locator('#rc-days-wrap').isVisible()));
  await page.fill('#rc-dom', '15');
  const backdate = new Date();
  backdate.setMonth(backdate.getMonth() - 4);
  await page.fill('#rc-anchor', backdate.toISOString().slice(0, 10));
  await page.selectOption('#rc-pri', 'high');
  await page.click('[data-action="save-recurrence"]');
  await page.waitForTimeout(700);
  const vat = (await st()).items.filter(i => i.title === 'File VAT return');
  /* The owner chose stacking: missed filings are separate debts, not one.
     Assert the properties, not a fixed count — a back-date of four months spans
     four or five 15ths depending on whether today is past the 15th, so a
     hardcoded number fails once a month. Exact counts are pinned against frozen
     dates in tests/recurring.test.js. */
  const todayISO = new Date().toISOString().slice(0, 10);
  ok('every missed month produced its own task', vat.length >= 4, vat.map(i => i.dueDate));
  ok('each carries its own due date', new Set(vat.map(i => i.dueDate)).size === vat.length);
  ok('every one falls on the 15th', vat.every(i => i.dueDate.endsWith('-15')), vat.map(i => i.dueDate));
  ok('none is dated in the future', vat.every(i => i.dueDate <= todayISO));
  ok('the template\'s priority carries to every instance', vat.every(i => i.priority === 'high'));

  await page.click('[data-action="nav"][data-view="inbox"]');
  await page.click('[data-action="inbox-scope"][data-scope="recurring"]');
  await page.waitForTimeout(300);
  ok('the Recurring scope lists them', await page.locator('.item-row').count() === vat.length,
    { shown: await page.locator('.item-row').count(), created: vat.length });
  ok('a row names its cadence', /Monthly on the 15th/.test(await page.locator('.item-row').first().innerText()));
  // Closing one instance must not disturb the others.
  await page.locator('.item-row .check').first().click();
  await page.waitForTimeout(500);
  ok('completing one leaves the rest standing',
    (await st()).items.filter(i => i.title === 'File VAT return' && i.status === 'open').length === vat.length - 1);

  await page.click('[data-action="nav"][data-view="recurring"]');
  await page.waitForTimeout(300);
  await page.locator('.item-row').first().locator('[data-action="toggle-recurrence-pause"]').click();
  await page.waitForTimeout(400);
  ok('a series can be paused', (await st()).recurring[0].paused === true);
  await page.locator('.item-row').first().locator('[data-action="toggle-recurrence-pause"]').click();
  await page.waitForTimeout(400);
  ok('  and resumed', (await st()).recurring[0].paused === false);
  // Deleting the cadence must not delete the work it already created.
  await page.locator('.item-row').first().locator('[data-action="delete-recurrence"]').click();
  await page.waitForTimeout(500);
  ok('deleting the cadence keeps its existing tasks',
    (await st()).recurring.length === 0 && (await st()).items.filter(i => i.title === 'File VAT return').length === vat.length);

  // Reloading must not re-create what already exists.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  ok('a reload never duplicates instances',
    (await st()).items.filter(i => i.title === 'File VAT return').length === vat.length);

  console.log('\nHABITS — a monthly cadence');
  await page.click('[data-action="nav"][data-view="habits"]');
  await page.waitForTimeout(300);
  await page.click('[data-action="add-habit"]');
  await page.waitForSelector('#habit-name');
  await page.fill('#habit-name', 'Net worth snapshot');
  await page.selectOption('#hb-freq-type', 'monthly');
  await page.waitForTimeout(250);
  ok('the target field relabels for months', /per month/i.test(await page.locator('#hb-freq-target-label').innerText()));
  await page.fill('#hb-freq-target', '2');
  await page.click('[data-action="confirm-add-habit"]');
  await page.waitForTimeout(500);
  const mh = (await st()).habits.find(h => h.name === 'Net worth snapshot');
  ok('a monthly habit saves its target', mh && mh.frequency.type === 'monthly' && mh.frequency.target === 2,
    mh && mh.frequency);
  const mhRow = page.locator('.habit-row').filter({ hasText: 'Net worth' });
  ok('the row shows month-to-date progress', /x\/mo/.test(await mhRow.innerText()));
  await mhRow.locator('.day-dot').nth(0).click();
  await page.waitForTimeout(400);
  ok('  and counts a tick toward the month', /1 this month/.test(await mhRow.innerText()));

  console.log('\nREVIEW — checklists must never award XP');
  await page.click('[data-action="nav"][data-view="review"]');
  await page.waitForSelector('.rv-step');
  const tabCount = await page.locator('[data-action="review-tab"]').count();
  ok('three cadences', tabCount === 3, tabCount);
  const daySecs = await page.locator('.rv-sec').allInnerTexts();
  ok('daily covers all four fronts', daySecs.length === 4
    && /second brain/i.test(daySecs[0]) && /intelmotion/i.test(daySecs[1])
    && /comms/i.test(daySecs[2]) && /finance/i.test(daySecs[3]),
    daySecs.map(t => t.split('\n')[0]));
  const dayText = await page.locator('.view').innerText();
  ok('daily names the brain dump', /brain dump/i.test(dayText));
  ok('daily reviews the IntelMotion app', /job board in the IntelMotion app/i.test(dayText));
  ok('daily clears email', /decided inbox/i.test(dayText));
  const xpBefore = (await st()).gamification.xp;
  await page.locator('.rv-step .box').first().click();
  await page.waitForTimeout(400);
  ok('a tick persists', Object.keys((await st()).reviews.daily.done || {}).length === 1);
  ok('a tick awards no XP', (await st()).gamification.xp === xpBefore, { before: xpBefore, after: (await st()).gamification.xp });
  /* Ticks are keyed by the step's text, not its position. A positional key silently
     re-points every tick below an inserted step, so assert the key tracks content. */
  const tickKey = Object.keys((await st()).reviews.daily.done)[0];
  ok('the tick key is content-derived, not positional', /^k[0-9a-z]+$/.test(tickKey) && !/^s\d+i\d+$/.test(tickKey), tickKey);

  await page.click('[data-action="review-tab"][data-tab="weekly"]');
  await page.waitForTimeout(300);
  const wkText = await page.locator('.view').innerText();
  for (const [label, re] of [
    ['social media', /business social accounts/i],
    ['weekly wins', /three wins from this week/i],
    ['what did not happen', /did not happen, and why/i],
    ['the deep brain dump', /deep brain dump/i],
    ['repeat breakdowns', /repeat breakdowns, and anything still open/i],
    ['Zipana and IntelTech', /Zipana and IntelTech/i]
  ]) ok('weekly covers ' + label, re.test(wkText));

  await page.click('[data-action="review-tab"][data-tab="monthly"]');
  await page.waitForTimeout(300);
  const moText = await page.locator('.view').innerText();
  ok('monthly records the biggest wins', /three biggest wins/i.test(moText));
  ok('monthly records a family highlight', /family highlight/i.test(moText));
  ok('monthly reviews IntelMotion contracts', /contract renewals/i.test(moText));
  // Each cadence keeps its own ticks.
  await page.locator('.rv-step .box').first().click();
  await page.waitForTimeout(400);
  ok('monthly ticks are separate from daily', Object.keys((await st()).reviews.monthly.done || {}).length === 1
    && Object.keys((await st()).reviews.daily.done || {}).length === 1);
  await page.click('[data-action="review-tab"][data-tab="daily"]');
  await page.waitForTimeout(300);

  console.log('\nREVIEW — the owner can edit the list');
  const baseSteps = await page.locator('.rv-step').count();
  await page.click('[data-action="add-review-step"][data-kind="daily"]');
  await page.waitForSelector('#rv-what');
  await page.fill('#rv-what', 'Call the Nigist bookkeeper');
  await page.fill('#rv-why', 'Records go stale in a week.');
  await page.fill('#rv-where', 'Phone');
  await page.click('[data-action="save-review-step"]');
  await page.waitForTimeout(500);
  ok('a custom step is added', await page.locator('.rv-step').count() === baseSteps + 1);
  ok('  in its own section', /your own steps/i.test(await page.locator('.view').innerText()));
  const xpPre = (await st()).gamification.xp;
  await page.locator('.rv-step').last().locator('.box').click();
  await page.waitForTimeout(400);
  ok('a custom step awards no XP either', (await st()).gamification.xp === xpPre,
    { before: xpPre, after: (await st()).gamification.xp });
  // Hiding a built-in must be reversible — its wording lives in code, not in saved state.
  await page.locator('.rv-step').first().locator('[data-action="hide-review-step"]').click();
  await page.waitForTimeout(500);
  ok('a built-in step can be hidden', await page.locator('.rv-step').count() === baseSteps);
  await page.click('[data-action="restore-review-steps"]');
  await page.waitForSelector('.modal');
  await page.click('.modal [data-action="restore-review-step"]');
  await page.waitForTimeout(500);
  ok('  and restored', await page.locator('.rv-step').count() === baseSteps + 1);
  await page.locator('.rv-step').last().locator('[data-action="edit-review-step"]').click();
  await page.waitForSelector('#rv-what');
  await page.fill('#rv-what', 'Call the Nigist accountant');
  await page.click('[data-action="save-review-step"]');
  await page.waitForTimeout(500);
  ok('a custom step can be edited', /Nigist accountant/.test(await page.locator('.view').innerText()));
  await page.locator('.rv-step').last().locator('[data-action="delete-review-step"]').click();
  await page.waitForTimeout(500);
  ok('  and deleted', await page.locator('.rv-step').count() === baseSteps);

  console.log('\nPERSISTENCE');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.click('[data-action="nav"][data-view="review"]');
  await page.waitForTimeout(400);
  const persisted = Object.keys((await st()).reviews.daily.done || {}).length;
  ok('review ticks survive a reload', persisted === 1, persisted);
  ok('recurring series survive a reload', (await st()).recurring.length === 0 && (await st()).items.some(i => i.seriesId));
  ok('a monthly habit survives a reload', ((await st()).habits.find(h => h.name === 'Net worth snapshot') || {}).frequency.type === 'monthly');

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
