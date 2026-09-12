'use strict';
/* Bulk import: parsing, the preview plan, applying it, and refusing bad input. */
require('./harness');
const fs = require('fs');
const path = require('path');

let fails = 0, passes = 0;
const ok = (name, cond, extra) => {
  if (cond) { passes++; }
  else { fails++; console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra) : ''); }
};
const eq = (name, a, b) => ok(name, a === b, { got: a, want: b });

const payload = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-import.json'), 'utf8');
const W = { S: 1, M: 2, L: 3, XL: 5 };

/* ---- bad input is refused whole, never half-applied ---- */
resetApp();
ok('non-JSON refused', !!planImport('hello there').error);
ok('a bare array refused', !!planImport('[1,2,3]').error);
ok('an empty object refused', !!planImport('{}').error);
ok('a failed parse creates nothing', items().length === 0);

/* ---- the fixture imports as described ---- */
resetApp();
let plan = planImport(payload);
ok('fixture parses', !plan.error, plan.error);
eq('4 projects planned', plan.projects.length, 4);
eq('3 habits planned', plan.habits.length, 3);
eq('3 life areas planned', plan.areas.length, 3);
eq('nothing skipped on a clean slate', plan.skippedProjects.length, 0);
eq('no warnings', plan.warnings.length, 0);

const r = applyImport(plan);
eq('4 projects created', r.projects, 4);
eq('14 steps created', r.steps, 14);
eq('3 habits created', r.habits, 3);
eq('items grew by projects + child tasks', items().length, 4 + 2);
eq('habits landed', __getState().state.habits.length, 3);

/* ---- the imported data computes ---- */
eq('33 effort points across everything',
  projects().reduce((a, p) => a + projectStats(p).weightTotal, 0), 33);

const site = projects().find(p => p.title === 'Site installation');
eq('site: 7 milestones', site.subtasks.length, 7);
eq('site: 2 child tasks', tasksOf(site.id).length, 2);
eq('site: 21 effort points', projectStats(site).weightTotal, 21);
eq('site: starred', site.isStarred, true);
eq('site: priority', site.priority, 'high');
eq('site: start date', site.startDate, '2026-01-05');
eq('site: due date', site.dueDate, '2026-06-30');
eq('site: assignee', site.assignee, 'Site engineer');
eq('site: starts at 0%', projectStats(site).pct, 0);
ok('site: schedule is tracked', projectStats(site).timePct != null);

// The seven stage weights are the template the whole method rests on.
eq('site: stage weights are S M M XL L L M',
  site.subtasks.map(s => s.effort).join(' '), 'S M M XL L L M');
eq('site: milestone weights total 18',
  site.subtasks.reduce((a, s) => a + W[s.effort], 0), 18);

const refit = projects().find(p => p.title === 'Kitchen refit');
ok('archived project is flagged', __getInactive().indexOf(refit.id) >= 0);
eq('archived project priority', refit.priority, 'low');

const idea = projects().find(p => p.title === 'Unplanned idea');
eq('project with no steps is unmeasured, not 0%', projectStats(idea).pct, null);
eq('  and has no plan', projectStats(idea).hasPlan, false);

/* ---- the roll-up excludes archived and unmeasured ---- */
const port = portfolioStats(reportProjectList());
eq('roll-up covers the 3 non-archived projects', port.total, 3);
eq('one of them is unmeasured', port.noPlanCount, 1);
eq('weighted total excludes archived and unmeasured', port.weightTotal, 21 + 10);
eq('portfolio starts at 0%', port.weightedPct, 0);

/* ---- habits keep their frequencies ---- */
const hs = __getState().state.habits;
eq('daily habit', hs.find(h => h.name === 'Morning walk').frequency.type, 'daily');
eq('weekly target', hs.find(h => h.name === 'Strength session').frequency.target, 4);
eq('weekday habit days',
  JSON.stringify(hs.find(h => h.name === 'Desk tidy').frequency.days), '[0,1,2,3,4]');
ok('habit logs start empty', hs.every(h => Object.keys(h.log).length === 0));
ok('imported habits are active', hs.every(h => h.active !== false));

/* ---- re-importing the same block is a no-op ---- */
const plan2 = planImport(payload);
eq('second pass skips all 4 projects', plan2.skippedProjects.length, 4);
eq('second pass skips all 3 habits', plan2.skippedHabits.length, 3);
eq('second pass creates nothing', plan2.projects.length + plan2.habits.length, 0);
const n1 = items().length, h1 = __getState().state.habits.length;
applyImport(plan2);
eq('no duplicate items', items().length, n1);
eq('no duplicate habits', __getState().state.habits.length, h1);

/* ---- life areas are created when the binder lacks them ---- */
resetApp();
__getState().state.lifeAreas = [];
const p3 = planImport(payload);
eq('all three areas planned', p3.areas.length, 3);
applyImport(p3);
const names = __getState().state.lifeAreas.map(a => a.name);
['Operations', 'Trading', 'Home'].forEach(n => ok('area created: ' + n, names.indexOf(n) >= 0));
ok('no project left stranded in the Inbox', projects().every(p => p.category !== 'Inbox'));

/* ---- malformed entries degrade to documented defaults ---- */
resetApp();
const messy = planImport(JSON.stringify({
  projects: [
    { title: '  ', milestones: [] },
    { title: 'Bad dates', startDate: '2027-01-01', dueDate: '2026-01-01', milestones: [{ title: 'x', effort: 'S' }] },
    { title: 'Bad effort', milestones: [{ title: 'y', effort: 'HUGE' }, { title: '', effort: 'S' }] },
    { title: 'Bad priority', priority: 'urgent', milestones: [{ title: 'z' }] }
  ],
  habits: [{ name: 'Odd', frequency: { type: 'nonsense' } }]
}));
eq('a titleless project is dropped', messy.projects.length, 3);
ok('a start date after the due date is warned about',
  messy.warnings.some(w => /start date is after/.test(w)));
eq('  and both dates are dropped', messy.projects.find(p => p.title === 'Bad dates').startDate, null);
eq('an unknown effort falls back to S',
  messy.projects.find(p => p.title === 'Bad effort').milestones[0].effort, 'S');
eq('a titleless milestone is dropped',
  messy.projects.find(p => p.title === 'Bad effort').milestones.length, 1);
eq('an unknown priority falls back to medium',
  messy.projects.find(p => p.title === 'Bad priority').priority, 'medium');
eq('an unknown habit frequency falls back to daily', messy.habits[0].frequency.type, 'daily');

console.log(`import: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
