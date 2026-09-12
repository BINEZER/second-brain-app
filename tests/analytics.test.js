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

console.log(`analytics: ${passes} passed, ${fails} failed`);
process.exit(fails?1:0);
