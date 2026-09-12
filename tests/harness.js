'use strict';
/*
  The app is a single HTML file with all of its logic in one inline <script>.
  This harness pulls that script out of index.html and runs it under a minimal
  DOM stub, so the real functions are exercised in Node without a browser.

  Two things to know if you edit this:

  1. The app declares `state` and `inactiveProjects` with `let` at the top level
     of that script. Under indirect eval those become lexical bindings private
     to the eval scope — they are NOT properties of globalThis — so tests reach
     them through the accessors appended below, not through `global.state`.
  2. The leading 'use strict' must be stripped before evaluating, or function
     declarations stay trapped in the eval scope and nothing is callable.
*/
const fs = require('fs');
const path = require('path');

const APP_HTML = path.join(__dirname, '..', 'second-brain-website', 'index.html');

function extractAppScript() {
  const html = fs.readFileSync(APP_HTML, 'utf8');
  const marker = "<script>\n'use strict';";
  const open = html.indexOf(marker);
  if (open < 0) throw new Error('Could not find the app script in ' + APP_HTML);
  const close = html.indexOf('</script>', open);
  if (close < 0) throw new Error('Unterminated app script in ' + APP_HTML);
  return html.slice(open + '<script>'.length, close);
}

const noop = () => {};
const fakeEl = {
  innerHTML: '', value: '', dataset: {}, style: {},
  setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
  classList: { contains: () => false, add: noop, remove: noop, toggle: noop },
  appendChild: noop, remove: noop, click: noop, focus: noop,
  addEventListener: noop, scrollIntoView: noop,
};

/* Some globals (crypto, URL) are getter-only in modern Node; plain assignment
   throws under strict mode. Define them only where they are actually missing. */
function def(name, value) {
  if (name in global && global[name]) return;
  try { global[name] = value; }
  catch (e) { Object.defineProperty(global, name, { value, configurable: true, writable: true }); }
}

global.window = global;
global.document = {
  documentElement: { dataset: {} },
  activeElement: null,
  addEventListener: noop,
  querySelector: () => fakeEl,
  querySelectorAll: () => [],
  getElementById: () => null,
  createElement: () => fakeEl,
  body: { appendChild: noop, onkeydown: null },
};
global.localStorage = {
  _d: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
global.matchMedia = () => ({ matches: false });
global.getComputedStyle = () => ({ getPropertyValue: () => '' });
global.requestAnimationFrame = noop;
global.confirm = () => true;
global.prompt = () => null;
global.alert = noop;
def('Blob', function () {});
def('crypto', require('crypto').webcrypto);
if (!global.URL || !global.URL.createObjectURL) {
  global.URL = Object.assign(global.URL || {}, { createObjectURL: () => '', revokeObjectURL: noop });
}

const src = extractAppScript().replace(/'use strict';/, '');

(0, eval)(
  src +
  '\n;globalThis.__setState = v => { state = v; };' +
  '\n;globalThis.__getState = () => state;' +
  '\n;globalThis.__setInactive = v => { inactiveProjects = v; };' +
  '\n;globalThis.__getInactive = () => inactiveProjects;' +
  // Reach anything else declared with let/const inside the app scope.
  '\n;globalThis.__in = function (code) { return eval(code); };'
);

/* A clean slate between test cases. */
global.resetApp = function () {
  __setState(defaultRoot());
  __setInactive([]);
};

module.exports = global;
