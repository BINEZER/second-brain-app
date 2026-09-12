'use strict';
/* Parses the app's inline script without running it. Cheapest possible gate:
   a syntax error here means the deployed page would be a blank screen. */
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'second-brain-website', 'index.html');
const html = fs.readFileSync(file, 'utf8');
const marker = "<script>\n'use strict';";
const open = html.indexOf(marker);
if (open < 0) { console.error('FAIL: could not find the app script in index.html'); process.exit(1); }
const close = html.indexOf('</script>', open);
const src = html.slice(open + '<script>'.length, close);

try {
  new vm.Script(src, { filename: 'index.html (inline script)' });
} catch (e) {
  console.error('FAIL: the app script does not parse');
  console.error('  ' + e.message);
  process.exit(1);
}

// Guard against the inline script being accidentally truncated by an edit.
const lines = src.split('\n').length;
if (lines < 1500) { console.error(`FAIL: app script is only ${lines} lines — looks truncated`); process.exit(1); }

console.log(`syntax: ok (${lines} lines parse cleanly)`);
