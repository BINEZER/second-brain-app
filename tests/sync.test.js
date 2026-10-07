'use strict';
/*
  Two devices, one account.

  This exists because sync was broken in the worst possible way: the app pulled
  the cloud copy only on a device's very first visit, and on every visit after
  that pushed whatever was in that browser's storage. A phone opened once in
  August therefore showed August forever, and uploaded August over the laptop's
  September. Whichever device was opened last owned the data.

  So the checks below are about which copy wins, not about whether a write
  happened. Two separate browser contexts stand in for the phone and the laptop,
  talking to one in-memory "cloud" over HTTP — a stand-in for Firestore that
  supports get, set and onSnapshot, because the real client cannot be reached
  from a test and the logic under test is entirely about reconciliation.
*/
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const ROOT = path.join(__dirname, '..');
const PORT = 8791;          // serve.js hardcodes this; the suites run one at a time
const CLOUD_PORT = 8795;
const BASE = `http://localhost:${PORT}/`;
const CLOUD = `http://localhost:${CLOUD_PORT}/`;

let fails = 0;
const ok = (n, c, x) => {
  console.log((c ? '  ok   ' : '  FAIL ') + n + (x !== undefined ? '  ' + JSON.stringify(x) : ''));
  if (!c) fails++;
};

function waitForServer(url, tries = 40) {
  return new Promise((resolve, reject) => {
    const attempt = n => {
      http.get(url, res => { res.resume(); resolve(); })
        .on('error', () => n <= 0 ? reject(new Error('server never came up: ' + url)) : setTimeout(() => attempt(n - 1), 250));
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

/* The stand-in cloud: one versioned document per id, in memory. */
function startCloud() {
  const docs = {};          // id -> { doc, version }
  const server = http.createServer((req, res) => {
    const id = decodeURIComponent(req.url.replace(/^\//, '').split('?')[0]);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.method === 'GET') {
      const d = docs[id];
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ exists: !!d, doc: d ? d.doc : null, version: d ? d.version : 0 }));
    }
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const prev = docs[id] ? docs[id].version : 0;
        try { docs[id] = { doc: JSON.parse(body), version: prev + 1 }; } catch (e) {}
        res.writeHead(204, cors); res.end();
      });
      return;
    }
    if (req.method === 'DELETE') { delete docs[id]; res.writeHead(204, cors); return res.end(); }
    res.writeHead(405, cors); res.end();
  }).listen(CLOUD_PORT);
  return { server, docs };
}

/* One browser context per device, each with its own storage and its own fake
   Firestore client pointed at the shared cloud. */
async function openDevice(browser, { ua, seed }) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, userAgent: ua });
  const page = await ctx.newPage();
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(BASE) || url.startsWith(CLOUD) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    return route.abort();      // never the live Firestore, never the CDN
  });
  page.on('dialog', d => d.accept());
  await page.addInitScript(({ cloud, seeded }) => {
    if (seeded) { try { localStorage.setItem('adhd-second-brain-v1', seeded); } catch (e) {} }
    const docUrl = id => cloud + encodeURIComponent(id);
    const makeDoc = id => ({
      get: () => fetch(docUrl(id)).then(r => r.json())
        .then(j => ({ exists: !!j.exists, data: () => j.doc, metadata: { hasPendingWrites: false } })),
      set: v => fetch(docUrl(id), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) })
        .then(() => undefined),
      delete: () => fetch(docUrl(id), { method: 'DELETE' }).then(() => undefined),
      onSnapshot: (cb, onErr) => {
        let seen = -1;
        const tick = () => fetch(docUrl(id)).then(r => r.json()).then(j => {
          if (j.version === seen) return;
          seen = j.version;
          cb({ exists: !!j.exists, data: () => j.doc, metadata: { hasPendingWrites: false } });
        }).catch(() => {});
        const h = setInterval(tick, 250);
        tick();
        return () => clearInterval(h);
      },
    });
    const fakeDb = { collection: () => ({ doc: makeDoc }) };
    window.firebase = {
      initializeApp: () => ({}),
      firestore: Object.assign(() => fakeDb, { FieldValue: { serverTimestamp: () => null } }),
    };
    window.db = fakeDb;
  }, { cloud: CLOUD, seeded: seed || null });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.sidebar');
  await page.waitForTimeout(900);     // boot's reconcile, then the listener
  return { ctx, page };
}

/* A saved snapshot shaped like the real thing: one completed task carrying the
   date that decides how fresh this copy is, and an XP total to tell them apart. */
function snapshot({ xp, at, stamped, device, title }) {
  const root = {
    version: 1,
    state: {
      items: [{
        id: 'task-' + xp, title: title || ('Work from ' + at.slice(0, 10)), type: 'task',
        status: 'done', category: 'Operations', priority: 'medium', effort: 'M',
        createdAt: at, completedAt: at, subtasks: [], xpAwarded: true,
      }],
      settings: { nowPins: [], themeMode: 'light', numberLists: false },
      lifeAreas: [], habits: [], recurring: [],
      reviews: { daily: {}, weekly: {}, monthly: {} },
      reviewCustom: { daily: [], weekly: [], monthly: [] },
      reviewHidden: { daily: [], weekly: [], monthly: [] },
      gamification: { xp, habitBonusDates: [] },
    },
  };
  if (stamped) root.meta = { savedAt: at, device: device || 'other-device', name: device || 'Mac' };
  return JSON.stringify(root);
}


(async () => {
  const server = spawn('node', ['serve.js'], { cwd: ROOT, stdio: 'ignore' });
  const cloud = startCloud();
  const stop = () => { try { server.kill(); } catch (e) {} try { cloud.server.close(); } catch (e) {} };
  process.on('exit', stop);
  await waitForServer(BASE);
  await waitForServer(CLOUD);
  const browser = await launch();

  // What the page itself believes, read the way the app stores it.
  const localXp = page => page.evaluate(() => {
    const t = localStorage.getItem('adhd-second-brain-v1');
    return t ? JSON.parse(t).state.gamification.xp : null;
  });
  const cloudXp = () => (cloud.docs['primary'] && cloud.docs['primary'].doc.data.state.gamification.xp);
  const cloudTitles = () => (cloud.docs['primary'] ? cloud.docs['primary'].doc.data.state.items.map(i => i.title) : []);

  const OLD = '2026-08-02T09:00:00.000Z';
  const NEW = '2026-10-01T09:00:00.000Z';

  console.log('\nA STALE PHONE MUST NOT OVERWRITE A CURRENT LAPTOP');
  // The cloud already holds the laptop's recent work.
  cloud.docs['primary'] = { version: 1, doc: { data: JSON.parse(snapshot({ xp: 800, at: NEW, stamped: true, device: 'Mac' })), updatedAt: null } };
  const phone = await openDevice(browser, {
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    seed: snapshot({ xp: 10, at: OLD, stamped: true, device: 'iPhone' }),
  });
  ok('the phone takes the newer copy', await localXp(phone.page) === 800, await localXp(phone.page));
  ok('  and the cloud still holds it', cloudXp() === 800, cloudXp());
  // The complaint that started this: the phone sat on Level 1 while the laptop
  // was far past it. Compare against the level the app itself derives from 800 XP.
  const want = await phone.page.evaluate(() => levelInfo(800).level);
  const bar = await phone.page.locator('.topbar').innerText();
  ok('  the phone shows the level that XP implies', new RegExp('Level ' + want + '\\b').test(bar), { want, bar: bar.replace(/\n/g, ' ') });
  ok('  and is no longer stuck on Level 1', want > 1 && !/Level 1\b/.test(bar), bar.replace(/\n/g, ' '));

  // The copy that was replaced is kept, so a bad merge is recoverable. Read it
  // here: every later adoption replaces it with whatever it superseded.
  const backup = await phone.page.evaluate(() => {
    const t = localStorage.getItem('adhd-second-brain-v1-backup');
    return t ? JSON.parse(t).state.gamification.xp : null;
  });
  ok('  and the copy it replaced is kept', backup === 10, backup);

  console.log('\nA CURRENT DEVICE MUST PUSH OVER A STALE CLOUD');
  // Now the other direction: the cloud is stale, this device is ahead.
  cloud.docs['primary'] = { version: 5, doc: { data: JSON.parse(snapshot({ xp: 10, at: OLD, stamped: true, device: 'iPhone' })), updatedAt: null } };
  const laptop = await openDevice(browser, {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    seed: snapshot({ xp: 800, at: NEW, stamped: true, device: 'Mac' }),
  });
  await laptop.page.waitForTimeout(1600);     // the push is debounced
  ok('the laptop keeps its own copy', await localXp(laptop.page) === 800, await localXp(laptop.page));
  ok('  and sends it up', cloudXp() === 800, cloudXp());

  console.log('\nDATA SAVED BEFORE ANY OF THIS STILL SORTS ITSELF OUT');
  // Neither side carries a stamp, which is every device's first boot after the
  // update. The newest work inside the data decides, not whoever opened last.
  cloud.docs['primary'] = { version: 9, doc: { data: JSON.parse(snapshot({ xp: 10, at: OLD })), updatedAt: null } };
  const legacy = await openDevice(browser, {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    seed: snapshot({ xp: 800, at: NEW }),
  });
  await legacy.page.waitForTimeout(1600);
  ok('unstamped: the copy with the newer work wins', await localXp(legacy.page) === 800, await localXp(legacy.page));
  ok('  and it is what reaches the cloud', cloudXp() === 800, cloudXp());
  await legacy.ctx.close();

  console.log('\nA STALE DEVICE TOUCHED TODAY IS STILL A STALE DEVICE');
  /* The nastiest case: the phone has not synced since August, but it was opened
     today and something was ticked on it. That makes it the most recently
     touched copy while still being months behind, and a rule that only looked at
     timestamps would let it roll the laptop back. */
  cloud.docs['primary'] = { version: 20, doc: { data: JSON.parse(snapshot({ xp: 800, at: NEW, stamped: true, device: 'Mac' })), updatedAt: null } };
  const touched = JSON.parse(snapshot({ xp: 10, at: OLD, stamped: true, device: 'iPhone' }));
  touched.meta.savedAt = '2026-10-07T20:00:00.000Z';            // touched after the laptop's copy
  touched.state.items[0].completedAt = '2026-10-07T20:00:00.000Z';
  const stale = await openDevice(browser, {
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    seed: JSON.stringify(touched),
  });
  await stale.page.waitForTimeout(1600);
  ok('the copy that knows less does not win on recency', await localXp(stale.page) === 800, await localXp(stale.page));
  ok('  and the fuller copy survives in the cloud', cloudXp() === 800, cloudXp());
  await stale.ctx.close();

  console.log('\nLIVE — A CHANGE ON ONE DEVICE REACHES THE OTHER, NO RELOAD');
  // Both are now in sync at 800. Add a task on the laptop and watch the phone.
  await laptop.page.click('[data-action="nav"][data-view="inbox"]');
  await laptop.page.fill('#capture-input', 'Booked the crane');
  await laptop.page.click('[data-action="capture-add"]');
  await laptop.page.waitForTimeout(2500);        // debounced push + the phone's poll
  ok('the laptop sent it', cloudTitles().includes('Booked the crane'), cloudTitles());
  const onPhone = await phone.page.evaluate(() => {
    const t = localStorage.getItem('adhd-second-brain-v1');
    return t ? JSON.parse(t).state.items.map(i => i.title) : [];
  });
  ok('  and the phone has it without being reloaded', onPhone.includes('Booked the crane'), onPhone);
  await phone.page.click('[data-action="nav"][data-view="inbox"]');
  await phone.page.waitForTimeout(400);
  ok('  and shows it on screen', /Booked the crane/.test(await phone.page.locator('.view').innerText()));

  console.log('\nTHE SETTINGS PANEL SAYS WHAT IS GOING ON');
  await phone.page.click('[data-action="nav"][data-view="settings"]');
  await phone.page.waitForTimeout(400);
  const settings = await phone.page.locator('.view').innerText();
  ok('it names this device', /iPhone/.test(settings), settings.split('\n').filter(l => /iPhone|Saved here/.test(l)));
  ok('  and reports it is live', /live/.test(settings));
  await phone.page.click('[data-action="sync-now"]');
  await phone.page.waitForTimeout(800);
  ok('Sync now does not lose anything', (await localXp(phone.page)) === 800, await localXp(phone.page));

  await browser.close();
  stop();
  console.log(fails ? `\nsync: ${fails} CHECK(S) FAILED` : '\nsync: all checks passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
