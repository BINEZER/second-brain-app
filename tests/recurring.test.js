'use strict';
/*
  Recurring series: the date maths, and the rule the owner chose — missed cycles
  stack rather than collapsing into one. The cap is the only thing that stops a
  forgotten daily chore from creating a row for every day of the year.
*/
require('./harness');

let fails = 0, passes = 0;
const ok = (name, cond, extra) => {
  if (cond) passes++;
  else { fails++; console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra) : ''); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const dates = __in('recurrenceDates');
const materialise = () => __in('materialiseRecurring')();
const addSeries = p => __in('newRecurrence')(p);
const iso = d => __in('fmtISO')(d);
const daysAgo = n => iso(__in('addDays')(new Date(), -n));
const CAP = __in('RECUR_CAP');

/* ---- the calendar, including the cases that usually go wrong ---- */
eq('monthly on the 15th',
  dates({ type: 'monthly', interval: 1, dayOfMonth: 15, anchor: '2026-01-15' }, '2026-01-01', '2026-04-30'),
  ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15']);

// The 31st must land on the last day of a short month, never skip it entirely.
eq('monthly on the 31st clamps into short months',
  dates({ type: 'monthly', interval: 1, dayOfMonth: 31, anchor: '2026-01-31' }, '2026-01-01', '2026-04-30'),
  ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);

eq('every second month',
  dates({ type: 'monthly', interval: 2, dayOfMonth: 1, anchor: '2026-01-01' }, '2026-01-01', '2026-06-30'),
  ['2026-01-01', '2026-03-01', '2026-05-01']);

eq('weekly on two days',
  dates({ type: 'weekly', interval: 1, days: [0, 4], anchor: '2026-09-14' }, '2026-09-14', '2026-09-27'),
  ['2026-09-14', '2026-09-18', '2026-09-21', '2026-09-25']);

eq('fortnightly counts whole weeks from the anchor',
  dates({ type: 'weekly', interval: 2, days: [0], anchor: '2026-09-14' }, '2026-09-14', '2026-10-19'),
  ['2026-09-14', '2026-09-28', '2026-10-12']);

eq('every third day',
  dates({ type: 'daily', interval: 3, anchor: '2026-09-14' }, '2026-09-14', '2026-09-25'),
  ['2026-09-14', '2026-09-17', '2026-09-20', '2026-09-23']);

eq('yearly', dates({ type: 'yearly', interval: 1, month: 6, dayOfMonth: 4, anchor: '2026-07-04' }, '2026-01-01', '2029-12-31'),
  ['2026-07-04', '2027-07-04', '2028-07-04', '2029-07-04']);

// A 29 February series must still fire in non-leap years.
eq('29 February clamps to the 28th in common years',
  dates({ type: 'yearly', interval: 1, month: 1, dayOfMonth: 29, anchor: '2024-02-29' }, '2024-01-01', '2027-12-31'),
  ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28']);

eq('nothing is produced before the anchor',
  dates({ type: 'monthly', interval: 1, dayOfMonth: 5, anchor: '2026-06-05' }, '2026-01-01', '2026-08-31'),
  ['2026-06-05', '2026-07-05', '2026-08-05']);

/* ---- missed cycles stack ---- */
resetApp();
addSeries({ title: 'File VAT', type: 'monthly', interval: 1, dayOfMonth: 15, anchor: daysAgo(160) });
materialise();
const vat = items().filter(i => i.title === 'File VAT');
ok('five months missed produces one task per month', vat.length >= 5, vat.length);
eq('  each with a distinct due date', new Set(vat.map(i => i.dueDate)).size, vat.length);
ok('  all still open', vat.every(i => i.status === 'open'));
ok('  all linked to the series', vat.every(i => i.seriesId));

const n = items().length;
materialise();
eq('running again creates nothing', items().length, n);

/* ---- the cap is what keeps stacking survivable ---- */
resetApp();
const runaway = addSeries({ title: 'Bins', type: 'daily', interval: 1, anchor: daysAgo(300) });
materialise();
eq('a year-old daily series stops at the cap', items().filter(i => i.title === 'Bins').length, CAP);
ok('  and pauses itself rather than flooding on', runaway.paused === true);
ok('  and says why on its face', /outstanding/.test(runaway.pausedReason || ''), runaway.pausedReason);

// Clearing the backlog lets it pick up again.
items().filter(i => i.title === 'Bins').slice(0, 20).forEach(i => { i.status = 'done'; i.completedAt = new Date().toISOString(); });
runaway.paused = false; runaway.pausedReason = null;
ok('un-pausing catches up once there is room', materialise().created > 0);

/* ---- what must never happen ---- */
resetApp();
addSeries({ title: 'Future', type: 'monthly', interval: 1, dayOfMonth: 1, anchor: iso(__in('addDays')(new Date(), 40)) });
materialise();
eq('a future anchor creates nothing yet', items().filter(i => i.title === 'Future').length, 0);

resetApp();
const paused = addSeries({ title: 'Paused', type: 'daily', interval: 1, anchor: daysAgo(10) });
paused.paused = true;
materialise();
eq('a paused series is inert', items().filter(i => i.title === 'Paused').length, 0);

/* ---- the template's fields reach every instance ---- */
resetApp();
addSeries({ title: 'Payroll', type: 'monthly', dayOfMonth: 1, anchor: daysAgo(70), category: 'Operations',
  priority: 'high', effort: 'M', assignee: 'Finance lead' });
materialise();
const pay = items().find(i => i.title === 'Payroll');
eq('category carries', pay.category, 'Operations');
eq('priority carries', pay.priority, 'high');
eq('effort carries', pay.effort, 'M');
eq('owner carries', pay.assignee, 'Finance lead');
eq('the due date is the occurrence date', pay.dueDate, pay.occursOn);

/* ---- cadence reads as English ---- */
const label = __in('recurrenceLabel');
eq('label: monthly', label({ type: 'monthly', interval: 1, dayOfMonth: 15 }), 'Monthly on the 15th');
eq('label: every other month', label({ type: 'monthly', interval: 2, dayOfMonth: 3 }), 'Every 2 months on the 3rd');
eq('label: daily', label({ type: 'daily', interval: 1 }), 'Every day');
eq('label: weekly', label({ type: 'weekly', interval: 1, days: [0, 2] }), 'Every week on Mon, Wed');


/* ---- what a Reset must leave behind ----
   resetApp() assigns defaultRoot() straight to `state`, without going through
   loadRoot()'s migration. Anything the migration creates but defaultRoot() omits
   is therefore undefined after a reset, and the view that reads it throws. */
const fresh = __in('defaultRoot()');
ok('a fresh root carries reviewCustom for every cadence',
  ['daily','weekly','monthly'].every(k => Array.isArray(fresh.state.reviewCustom[k])), fresh.state.reviewCustom);
ok('a fresh root carries reviewHidden for every cadence',
  ['daily','weekly','monthly'].every(k => Array.isArray(fresh.state.reviewHidden[k])), fresh.state.reviewHidden);
ok('a fresh root carries recurring', Array.isArray(fresh.state.recurring));
// The real symptom: the Review tab renders off these, so it must survive a reset.
__setState(__in('defaultRoot()'));
let reviewThrew = null;
try { __in('reviewSections("daily")'); __in('reviewSteps("weekly")'); }
catch (e) { reviewThrew = e.message; }
ok('the review checklist renders on a freshly reset app', reviewThrew === null, reviewThrew);
eq('  and still has its built-in daily sections', __in('reviewSections("daily")').length, 4);

/* ---- the one-time area migration must not eat current categories ----
   It maps six legacy names; everything else is already current. The old
   `|| 'Inbox'` fallback swept every modern category into the Inbox. */
const MAP = __in('AREA_MIGRATION_MAP');
const remap = c => MAP[c] ? MAP[c] : c;
eq('a legacy name is still renamed', remap('Family'), 'Family & Marriage');
eq('a legacy name is still renamed (Home)', remap('Home'), 'Home & Living Space');
eq('a current name is left alone', remap('Family & Marriage'), 'Family & Marriage');
eq('a current name is left alone (work)', remap('Work — IntelMotion / Intel Group'), 'Work — IntelMotion / Intel Group');
eq('an unknown domain is left alone, not binned', remap('Nigist LLC'), 'Nigist LLC');

/* ---- the Inbox badge must count only what the Inbox can show ----
   It used to count any item in the Inbox domain, projects included, so 16
   unfiled projects read as "16" against a list that shows only tasks. */
resetApp();
newItem({ type:'project', title:'A project left unfiled', category:'Inbox' });
newItem({ type:'task', title:'A real unfiled task', category:'Inbox' });
newItem({ type:'task', title:'A filed task', category:'Home' });
eq('the badge counts unfiled tasks only, not projects', inboxItems().length, 1);
eq('  and it equals what the Inbox lists', inboxItems().length,
  items().filter(i => i.type === 'task' && i.status === 'open' && i.category === 'Inbox').length);

/* ---- brag file: what it counts, and what it must not double-count ---- */
resetApp();
(function(){
  const iso = n => { const d = new Date(); d.setDate(d.getDate()+n); return d.toISOString(); };
  const msOf = (t, off, eff) => ({ id: __in('uid()'), title: t, done: true, doneAt: iso(off), effort: eff, xpAwarded: true });
  const DOM = 'Work — IntelMotion / Intel Group';

  // A project delivered inside the window, with its own closed steps.
  newItem({ type:'project', title:'Sales Academy rollout', category:DOM, status:'done',
    completedAt: iso(-4), assignee:'Demitu',
    subtasks:[ msOf('Curriculum written',-12,'L'), msOf('First cohort run',-5,'XL') ] });
  // A project only advanced.
  newItem({ type:'project', title:'Operating System', category:DOM,
    subtasks:[ msOf('SOP suite drafted',-9,'L'), msOf('KPI dashboard live',-3,'M'),
               { id:__in('uid()'), title:'ISO gap analysis', done:false, doneAt:null, effort:'XL', xpAwarded:false } ] });
  newItem({ type:'task', title:'Renew the SNDF contract', category:DOM, status:'done', completedAt: iso(-2), effort:'L' });
  newItem({ type:'task', title:'Payroll run', category:DOM, status:'done', completedAt: iso(-20), effort:'S', seriesId:'s1' });
  newItem({ type:'task', title:'Payroll run', category:DOM, status:'done', completedAt: iso(-50), effort:'S', seriesId:'s1' });
  // Another domain, and something outside the window: both must be excluded.
  newItem({ type:'task', title:'Something at home', category:'Home', status:'done', completedAt: iso(-3) });
  newItem({ type:'task', title:'Ancient history', category:DOM, status:'done', completedAt: iso(-400), effort:'XL' });

  const d = __in('bragData')('quarter', DOM);
  eq('one project reported as delivered', d.projectsDone.length, 1);
  /* A delivered project must not also appear under "moved forward" — it is
     already the stronger claim and listing it twice reads as padding. */
  ok('the delivered project is not also listed as advanced',
    !d.advanced.some(x => x.project.title === 'Sales Academy rollout'),
    d.advanced.map(x => x.project.title));
  eq('one project reported as advanced', d.advanced.length, 1);
  // Its steps still count, they are just not listed separately.
  eq('milestones count steps from delivered and advanced projects alike', d.milestoneCount, 4);
  eq('recurring work is separated from one-off tasks', d.recurring.length, 2);
  eq('  and the one-off is standalone', d.standalone.length, 1);
  ok('another domain is excluded', !d.tasksDone.some(t => t.category === 'Home'));
  ok('work outside the window is excluded', !d.tasksDone.some(t => t.title === 'Ancient history'));
  // L+XL (delivered) + L+M (advanced) + L (task) + S + S (recurring) = 3+5+3+2+3+1+1
  eq('effort points total every closed unit in the window', d.points, 18);
  ok('people worked with are collected', d.people.indexOf('Demitu') >= 0, d.people);

  const wk = __in('bragData')('week', DOM);
  ok('a shorter window reports less', wk.milestoneCount <= d.milestoneCount, { week: wk.milestoneCount, quarter: d.milestoneCount });
  const allDom = __in('bragData')('quarter', 'all');
  ok('"all areas" includes the other domain', allDom.tasksDone.some(t => t.category === 'Home'));
})();

console.log(`recurring: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
