'use strict';
/* Project analytics: effort weighting, schedule health, history and roll-ups. */
require('./harness');
let fails=0, passes=0;
const ok=(name,cond,extra)=>{ if(cond){passes++;} else {fails++; console.log('FAIL:',name, extra!==undefined?JSON.stringify(extra):'');} };
const eq=(name,a,b)=>ok(name, a===b, {got:a, want:b});

const DAY = 86400000;
const iso = d => new Date(d).toISOString();
const isoDate = d => new Date(d).toISOString().slice(0,10);
const now = Date.now();
const sub2 = (t,done,effort,ago)=>({id:t, title:t, done, effort, doneAt: done&&ago!=null? iso(now-ago*DAY):null, xpAwarded:done});

// The harness exposes accessors for the app's top-level `let` bindings.
const reset = () => resetApp();
function mkProject(over){
  return newItem(Object.assign({type:'project', title:'P', category:'Operations', createdAt: iso(now-30*DAY)}, over));
}

/* ---------- 1. effort weighting ---------- */
reset();
let p = mkProject({});
p.subtasks = [
  {id:'a', title:'Site survey', done:true,  effort:'XL', doneAt: iso(now-20*DAY), xpAwarded:true}, // 5
  {id:'b', title:'Phone call',  done:false, effort:'S',  doneAt:null, xpAwarded:false},            // 1
];
let st = projectStats(p);
eq('weighted total', st.weightTotal, 6);
eq('weighted done', st.weightDone, 5);
eq('weighted pct', st.pct, 83);
eq('unweighted pct differs', st.countPct, 50);

// child tasks carry weight too
newItem({type:'task', title:'T1', projectId:p.id, effort:'M', status:'open'});
st = projectStats(p);
eq('weight total with child', st.weightTotal, 8);
eq('pct with child', st.pct, 63);

/* ---------- 2. schedule dimension ---------- */
reset();
p = mkProject({createdAt: iso(now-80*DAY), dueDate: isoDate(now+20*DAY)});  // 100d window, 80% spent
p.subtasks = [{id:'a',done:true,effort:'S',title:'x',doneAt:iso(now-10*DAY)},{id:'b',done:false,effort:'S',title:'y',doneAt:null},
              {id:'c',done:false,effort:'S',title:'z',doneAt:null},{id:'d',done:false,effort:'S',title:'w',doneAt:null}];
st = projectStats(p);
eq('completion 25%', st.pct, 25);
ok('time ~80%', Math.abs(st.timePct-80)<=1, st.timePct);
ok('variance ~ -55', Math.abs(st.variance+55)<=1, st.variance);
eq('health behind', st.health, 'behind');
ok('daysLeft ~20', Math.abs(st.daysLeft-20)<=1, st.daysLeft);

// on track
reset();
p = mkProject({createdAt: iso(now-50*DAY), dueDate: isoDate(now+50*DAY)});
p.subtasks = [{id:'a',done:true,effort:'S',title:'x',doneAt:iso(now-5*DAY)},{id:'b',done:false,effort:'S',title:'y',doneAt:null}];
st = projectStats(p);
eq('on track', st.health, 'ontrack');

// overdue
reset();
p = mkProject({createdAt: iso(now-50*DAY), dueDate: isoDate(now-2*DAY)});
p.subtasks = [{id:'a',done:true,effort:'S',title:'x',doneAt:iso(now-5*DAY)},{id:'b',done:false,effort:'S',title:'y',doneAt:null}];
st = projectStats(p);
eq('overdue', st.health, 'overdue');
ok('daysLeft negative', st.daysLeft < 0, st.daysLeft);

// no due date
reset();
p = mkProject({createdAt: iso(now-50*DAY)});
p.subtasks = [{id:'a',done:true,effort:'S',title:'x',doneAt:iso(now-1*DAY)}, {id:'b',done:false,effort:'S',title:'y',doneAt:null}];
st = projectStats(p);
eq('no date health', st.health, 'nodate');
eq('no date timePct', st.timePct, null);
eq('no date variance', st.variance, null);

/* ---------- 3. per-project history ---------- */
reset();
p = mkProject({createdAt: iso(now-40*DAY), dueDate: isoDate(now+10*DAY)});
p.subtasks = [
  {id:'a',done:true, effort:'S',title:'a',doneAt:iso(now-35*DAY)},
  {id:'b',done:true, effort:'S',title:'b',doneAt:iso(now-20*DAY)},
  {id:'c',done:true, effort:'S',title:'c',doneAt:iso(now-2*DAY)},
  {id:'d',done:false,effort:'S',title:'d',doneAt:null},
];
let h = projectHistory(p, 14);
eq('history points', h.points.length, 14);
eq('history undated', h.undated, 0);
eq('history ends at current pct', h.points[h.points.length-1].pct, projectStats(p).pct);
ok('history monotonic non-decreasing', h.points.every((pt,i)=> i===0 || pt.pct>=h.points[i-1].pct), h.points.map(x=>x.pct));
ok('history starts low', h.points[0].pct <= 25, h.points[0].pct);

// legacy done steps with no timestamp count from window start, and are reported
reset();
p = mkProject({createdAt: iso(now-40*DAY)});
p.subtasks = [{id:'a',done:true,effort:'S',title:'a',doneAt:null},{id:'b',done:false,effort:'S',title:'b',doneAt:null}];
h = projectHistory(p, 5);
eq('undated counted', h.undated, 1);
eq('undated present from start', h.points[0].pct, 50);

// stalled detection
reset();
p = mkProject({createdAt: iso(now-60*DAY)});
p.subtasks = [{id:'a',done:true,effort:'S',title:'a',doneAt:iso(now-30*DAY)},{id:'b',done:false,effort:'S',title:'b',doneAt:null}];
st = projectStats(p);
ok('stalled true', st.stalled===true, st);
eq('daysSinceActivity', st.daysSinceActivity, 30);

reset();
p = mkProject({createdAt: iso(now-60*DAY)});
p.subtasks = [{id:'a',done:true,effort:'S',title:'a',doneAt:iso(now-1*DAY)},{id:'b',done:false,effort:'S',title:'b',doneAt:null}];
ok('not stalled', projectStats(p).stalled===false);

/* ---------- 4. portfolio roll-up ---------- */
reset();
const big = mkProject({title:'Big project', category:'Operations', createdAt:iso(now-50*DAY), dueDate:isoDate(now+50*DAY)});
big.subtasks = [{id:'a',done:true,effort:'XL',title:'a',doneAt:iso(now-5*DAY)},{id:'b',done:false,effort:'XL',title:'b',doneAt:null}]; // 5/10
const small = mkProject({title:'Small project', category:'Trading', createdAt:iso(now-50*DAY), dueDate:isoDate(now+50*DAY)});
small.subtasks = [{id:'c',done:true,effort:'S',title:'c',doneAt:iso(now-5*DAY)},{id:'d',done:true,effort:'S',title:'d',doneAt:iso(now-4*DAY)},
                  {id:'e',done:true,effort:'S',title:'e',doneAt:iso(now-3*DAY)},{id:'f',done:false,effort:'S',title:'f',doneAt:null}]; // 3/4
const empty = mkProject({title:'Unplanned project', category:'Home', createdAt:iso(now-50*DAY)});

let port = portfolioStats(projects());
eq('portfolio total', port.total, 3);
eq('portfolio planned', port.plannedCount, 2);
eq('portfolio noPlan', port.noPlanCount, 1);
eq('weighted pct', port.weightedPct, Math.round((5+3)/(10+4)*100)); // 57
eq('simple avg pct', port.simplePct, Math.round((50+75)/2));        // 63
ok('weighted != simple (size matters)', port.weightedPct !== port.simplePct, {w:port.weightedPct, s:port.simplePct});
eq('areas count', port.byArea.length, 3);
const trading = port.byArea.find(a=>a.area==='Trading');
eq('trading area pct', trading.pct, 75);
const home = port.byArea.find(a=>a.area==='Home');
eq('unmeasured area has no pct', home.pct, null);
eq('unmeasured area counted', home.noPlan, 1);

/* ---------- 5. no-plan projects are unmeasured, not 0% ---------- */
reset();
p = mkProject({createdAt: iso(now-5*DAY)});
st = projectStats(p);
eq('no plan hasPlan', st.hasPlan, false);
eq('no plan pct is null not 0', st.pct, null);
eq('no plan health', st.health, 'noplan');
eq('no plan label', pctLabel(st), 'Not broken down');
port = portfolioStats([p]);
eq('excluded from weighted', port.weightedPct, null);
eq('excluded from average', port.simplePct, null);
eq('but still counted', port.total, 1);

// a genuinely 0% project with a plan IS measured
reset();
p = mkProject({createdAt: iso(now-5*DAY)});
p.subtasks=[{id:'a',done:false,effort:'S',title:'a',doneAt:null}];
st = projectStats(p);
eq('real 0% is 0 not null', st.pct, 0);
eq('real 0% hasPlan', st.hasPlan, true);
ok('real 0% not noplan', st.health!=='noplan', st.health);

/* ---------- misc: rendering does not throw ---------- */
reset();
__getState().state.lifeAreas=[{name:'Trading',purpose:'',framework:[],routines:[],guiding_principle:'',open_items:[]}];
const rp = mkProject({title:'X', category:'Trading', dueDate:isoDate(now+5*DAY)});
rp.subtasks=[{id:'a',done:true,effort:'M',title:'a',doneAt:iso(now-1*DAY)},{id:'b',done:false,effort:'L',title:'b',doneAt:null}];
newItem({type:'task', title:'child', projectId:rp.id, effort:'S', status:'open'});
try { renderProjectCard(rp); renderProjectsView(); renderReportsProjectsView(); renderProjectReportRow(rp); ok('renderers run',true); }
catch(e){ ok('renderers run',false,e.message); }
try { const html = renderReportsProjectsView(); ok('rollup html has weighted', html.includes('Weighted complete')); } catch(e){ ok('rollup html',false,e.message); }

// effort cycling
eq('cycle S->M', cycleEffort('S'), 'M');
eq('cycle XL->S', cycleEffort('XL'), 'S');
eq('cycle bad->M', cycleEffort('bogus'), 'M');


/* ---------- 6. explicit start date drives the schedule window ---------- */
// Same project, same due date: created long ago but work only started recently.
reset();
// Windows are chosen to sit well clear of the health-band boundaries. A
// scenario engineered to land exactly on one (say variance === -25) passes in
// the morning and fails in the evening, because hours of elapsed time move it.
p = mkProject({createdAt: iso(now-200*DAY), dueDate: isoDate(now+30*DAY)});
p.subtasks = [sub2('a',true,'S',5), sub2('b',false,'S'), sub2('c',false,'S'), sub2('d',false,'S')];
let withoutStart = projectStats(p);        // 25% done, ~87% of a 230-day window spent
p.startDate = isoDate(now-10*DAY);         // work began 10 days ago: ~25% of a 40-day window
let withStart = projectStats(p);
eq('completion unchanged by start date', withoutStart.pct, withStart.pct);
ok('createdAt window is nearly spent', withoutStart.timePct > 80, withoutStart.timePct);
ok('startDate window is about a quarter spent', Math.abs(withStart.timePct-25)<=5, withStart.timePct);
eq('was behind on createdAt window', withoutStart.health, 'behind');
eq('on track once the start date is honest', withStart.health, 'ontrack');
eq('startedFromDate flag', withStart.startedFromDate, true);
eq('fallback flag', withoutStart.startedFromDate, false);

// A start date in the future means the clock has not begun.
reset();
p = mkProject({createdAt: iso(now-30*DAY), startDate: isoDate(now+7*DAY), dueDate: isoDate(now+40*DAY)});
p.subtasks = [sub2('a',false,'S'), sub2('b',false,'S')];
st = projectStats(p);
eq('not started health', st.health, 'notstarted');
eq('not started flag', st.notStarted, true);
eq('time not yet spent', Math.round(st.timePct), 0);
eq('future start never stalls', st.stalled, false);

// A stale project that has not started should not be flagged stalled.
reset();
p = mkProject({createdAt: iso(now-90*DAY), startDate: isoDate(now+3*DAY), dueDate: isoDate(now+60*DAY)});
p.subtasks = [sub2('a',true,'S',60), sub2('b',false,'S')];
eq('future start suppresses stalled', projectStats(p).stalled, false);

// History window follows the start date too.
reset();
p = mkProject({createdAt: iso(now-300*DAY), startDate: isoDate(now-20*DAY), dueDate: isoDate(now+20*DAY)});
p.subtasks = [sub2('a',true,'S',10), sub2('b',false,'S')];
h = projectHistory(p, 10);
const firstMs = h.points[0].ms;
ok('history starts at the start date, not creation', Math.abs(firstMs-(now-20*DAY)) < 2*DAY, new Date(firstMs).toISOString());
eq('history ends at current pct', h.points[h.points.length-1].pct, projectStats(p).pct);

// A malformed start date falls back to createdAt rather than breaking.
reset();
p = mkProject({createdAt: iso(now-40*DAY), startDate:'not-a-date', dueDate: isoDate(now+40*DAY)});
p.subtasks = [sub2('a',true,'S',5), sub2('b',false,'S')];
st = projectStats(p);
ok('bad start date falls back', st.timePct>40 && st.timePct<60, st.timePct);
eq('bad start date reports as fallback, not explicit', st.startedFromDate, false);
ok('bad start date does not NaN', !isNaN(st.timePct));

// New items default to no start date.
reset();
eq('newItem startDate default', mkProject({}).startDate, null);

/* ---------- 7. today stamp ---------- */
ok('today stamp names today', renderTodayStamp().includes(new Date().toLocaleDateString(undefined,{weekday:'long'})));
ok('today stamp has the date', renderTodayStamp().includes(new Date().toLocaleDateString(undefined,{day:'numeric',month:'long',year:'numeric'})));
try { ok('Now view renders with the stamp', renderNowView().includes('today-stamp')); } catch(e){ ok('Now view renders',false,e.message); }

/* ---------- 8. periods: the windows, the numbers, the comparison ----------
   Reports > Compare puts two periods side by side, and the brag file reports one
   of them. Both go through periodStats, so these assertions cover both. */
reset();
const W0 = periodWindow('month', 0), W1 = periodWindow('month', -1);
eq('this month starts on the 1st', W0.from.slice(8), '01');
eq('last month ends the day before this one starts', fmtISO(addDays(new Date(W1.to+'T00:00:00'),1)), W0.from);
eq('this month is the one running now', W0.to >= todayISO() && W0.from <= todayISO(), true);
ok('a month window is 28 to 31 days', dayCount(W0.from,W0.to)>=28 && dayCount(W0.from,W0.to)<=31, dayCount(W0.from,W0.to));

const K0 = periodWindow('week', 0);
eq('a week window is 7 days', dayCount(K0.from,K0.to), 7);
eq('the week starts on a Monday', new Date(K0.from+'T00:00:00').getDay(), 1);
eq('last week ends the day before this one', fmtISO(addDays(new Date(periodWindow('week',-1).to+'T00:00:00'),1)), K0.from);

const Y1 = periodWindow('year', -1);
eq('last year runs Jan to Dec', Y1.from+'|'+Y1.to, (new Date().getFullYear()-1)+'-01-01|'+(new Date().getFullYear()-1)+'-12-31');
eq('this year is labelled by its number', periodWindow('year',0).label, String(new Date().getFullYear()));
eq('offset 0 reads as "this month"', periodRel('month',0), 'this month');
eq('offset -1 reads as "last month"', periodRel('month',-1), 'last month');

// Everything below lands inside last month, which is fully in the past.
const prev = periodWindow('month', -1);
const inPrev = h => prev.from + 'T' + h + ':00:00.000Z';
reset();
const pAdv = mkProject({title:'Advanced', category:'Operations'});
pAdv.subtasks = [{id:'s1', title:'step', done:true, effort:'L', doneAt: inPrev('09')},
                 {id:'s2', title:'open', done:false, effort:'S', doneAt:null}];
newItem({type:'task', title:'T', category:'Operations', effort:'M', status:'done', completedAt: inPrev('09')});
let ps = periodStats(prev.from, prev.to, 'all');
eq('a project with a closed step counts as advanced', ps.advanced.length, 1);
eq('its closed step counts as a milestone', ps.milestoneCount, 1);
eq('the closed task counts', ps.tasksDone.length, 1);
eq('effort points are L + M', ps.points, 5);
eq('the area breakdown carries the same points', ps.byArea[0].points, 5);
eq('a finished period is not still running', ps.running, false);
eq('a finished period has fully elapsed', ps.daysElapsed, ps.daysTotal);

// A delivered project is reported once, as delivered — never also as "advanced".
const pDone = mkProject({title:'Delivered', category:'Operations', status:'done', completedAt: inPrev('11')});
pDone.subtasks = [{id:'x', title:'s', done:true, effort:'S', doneAt: inPrev('10')}];
ps = periodStats(prev.from, prev.to, 'all');
eq('the delivered project is counted', ps.projectsDone.length, 1);
eq('and is not listed again as advanced', ps.advanced.length, 1);
eq('its steps still count as milestones', ps.milestoneCount, 2);
eq('and their effort still counts', ps.points, 6);

// Out-of-window work never leaks in, in either direction.
newItem({type:'task', title:'Today', category:'Operations', effort:'XL', status:'done', completedAt:new Date().toISOString()});
eq('work closed outside the window is ignored', periodStats(prev.from, prev.to, 'all').points, 6);
ok('and shows up in the window it belongs to', periodStats(W0.from, W0.to, 'all').points >= 5);
eq('the domain filter excludes other areas', periodStats(prev.from, prev.to, 'Health').points, 0);
eq('and keeps its own', periodStats(prev.from, prev.to, 'Operations').points, 6);

// The brag file is the same machinery, so the two can never disagree.
eq('brag file agrees with periodStats for this month',
   bragData('month','all').points, periodStats(W0.from, todayISO(), 'all').points);

/* Habit consistency over an explicit window, which is what makes one month
   comparable with another. */
(function(){
  const day = n => prev.from.slice(0,8) + String(n).padStart(2,'0');
  const log = {}; [1,8,15,22].forEach(n=>log[day(n)] = true);
  __getState().state.habits = [
    { id:'hw', name:'Weekly review', emoji:'x', category:'Operations', active:true,
      frequency:{type:'weekly', target:1}, log },
    { id:'hd', name:'Daily walk', emoji:'x', category:'Home', active:true,
      frequency:{type:'daily'}, log:{} },
    { id:'hr', name:'Retired', emoji:'x', category:'Home', active:false,
      frequency:{type:'daily'}, log:{} }
  ];
  const wk = habitConsistencyBetween(__getState().state.habits[0], prev.from, prev.to);
  ok('four weekly ticks in a month read as near-perfect', wk>=90 && wk<=100, wk);
  eq('an empty daily habit reads as 0%', habitConsistencyBetween(__getState().state.habits[1], prev.from, prev.to), 0);
  eq('a window that has not started yet has no score',
     habitConsistencyBetween(__getState().state.habits[0], periodWindow('month',1).from, periodWindow('month',1).to), null);
  eq('the 30-day figure is just the window ending today',
     habitConsistency(__getState().state.habits[0], 30),
     habitConsistencyBetween(__getState().state.habits[0], fmtISO(addDays(new Date(),-29)), todayISO()));

  const hs = periodHabits(prev.from, prev.to, 'all');
  eq('retired habits stay out of the comparison', hs.length, 2);
  eq('the domain filter narrows habits too', periodHabits(prev.from, prev.to, 'Home').length, 1);
  eq('the average is over the scored habits', periodHabitAvg(hs), Math.round((wk+0)/2));
  eq('a period with nothing to score averages to nothing', periodHabitAvg([{habit:null, pct:null}]), null);
})();

// The view and its export both render without throwing on real data.
__in('ui').reportsTab = 'compare';
try { ok('the Compare tab renders', renderReportsView().includes('Compare two periods')); }
catch(e){ ok('the Compare tab renders', false, e.message); }
ok('  and names both periods', renderReportsCompareView().includes(periodWindow('month',-1).label));
__in('ui').reportsTab = 'areas';

/* ---------- 9. what a save must survive ----------
   Now once had three slots, and loadRoot went on enforcing them long after the
   view stopped doing so: a fourth pin lived until the next load and then
   vanished. Across two devices that reads as "my phone's Now list is wrong" —
   the one that reloaded showed three, the one still open showed four. */
reset();
(function(){
  const root = JSON.parse(JSON.stringify(__in('defaultRoot')()));
  root.state.settings.nowPins = ['a','b','c','d','e'];
  root.state.settings.inactiveProjects = ['p1','p2'];
  localStorage.setItem('adhd-second-brain-v1', JSON.stringify(root));
  const back = __in('loadRoot')();
  // eq here is identity, so compare these lists by value.
  const same = (name,a,b)=>eq(name, JSON.stringify(a), JSON.stringify(b));
  same('every Now pin survives a load, not just the first three', back.state.settings.nowPins, ['a','b','c','d','e']);
  // Archived projects ride the one snapshot now, so they cannot drift from it.
  same('the archive list rides the snapshot', back.state.settings.inactiveProjects, ['p1','p2']);
  same('a fresh install starts with an empty archive list', __in('defaultRoot')().state.settings.inactiveProjects, []);
})();

console.log(`analytics: ${passes} passed, ${fails} failed`);
process.exit(fails?1:0);
