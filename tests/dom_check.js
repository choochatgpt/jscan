/* ==========================================================================
   tests/dom_check.js — static check that every DOM hook the JS reaches for
   actually exists in index.html.

   A mistyped id throws only when that code path runs, which on a phone can be
   several taps deep. This catches it up front.

   Run:  node tests/dom_check.js
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const jsFiles = fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js'));
const js = jsFiles
  .map((f) => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'))
  .join('\n');

/* ---------- collect ---------- */

const htmlIds = new Set();
for (const m of html.matchAll(/\sid="([^"]+)"/g)) htmlIds.add(m[1]);

// Ids referenced as JS.$('x') or getElementById('x')
const wanted = new Map();      // id -> [files]
for (const f of jsFiles) {
  const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
  for (const m of src.matchAll(/JS\.\$\('([^']+)'\)/g)) {
    if (!wanted.has(m[1])) wanted.set(m[1], []);
    wanted.get(m[1]).push(f);
  }
  for (const m of src.matchAll(/getElementById\('([^']+)'\)/g)) {
    if (!wanted.has(m[1])) wanted.set(m[1], []);
    wanted.get(m[1]).push(f);
  }
}

/* ---------- report ---------- */

let fail = 0;

console.log('\ndom hooks');
for (const [id, files] of [...wanted].sort()) {
  if (htmlIds.has(id)) {
    console.log('  ok   #' + id);
  } else {
    fail++;
    console.log('  FAIL #' + id + ' referenced by ' + [...new Set(files)].join(', ') +
                ' but not present in index.html');
  }
}

// The reverse: ids in the HTML that nothing uses. Usually a leftover, not a bug.
const unused = [...htmlIds].filter((id) => !wanted.has(id)).sort();
console.log('\nunreferenced ids (informational)');
console.log('  ' + (unused.length ? unused.join(', ') : 'none'));

/* ---------- the hidden attribute must actually hide ---------- */

console.log('\nhidden attribute');

{
  // Strip comments first: this file's own prose mentions `[hidden]` and
  // `display`, which would otherwise satisfy the checks below on their own.
  const css = fs.readFileSync(path.join(ROOT, 'css', 'app.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // Which classes are used on elements carrying the `hidden` attribute?
  const hiddenClasses = new Set();
  for (const m of html.matchAll(/<[^>]*\shidden[^>]*>/g)) {
    const cm = /class="([^"]+)"/.exec(m[0]);
    if (cm) cm[1].split(/\s+/).forEach((c) => hiddenClasses.add(c));
  }

  // Does any of them set `display`, which would defeat the UA [hidden] rule?
  const offenders = [];
  for (const cls of hiddenClasses) {
    const re = new RegExp('\\.' + cls + '\\s*\\{[^}]*\\bdisplay\\s*:', 'm');
    if (re.test(css)) offenders.push(cls);
  }

  if (offenders.length) {
    console.log('  note classes that set display and rely on the override: ' +
                offenders.join(', '));
  }

  // The global override must be present, and must win.
  const override = /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/m.test(css);
  if (override) {
    console.log('  ok   [hidden] { display: none !important } is present');
  } else {
    fail++;
    console.log('  FAIL missing `[hidden] { display: none !important }` — ' +
                'every hidden toggle in the app is broken without it');
  }
}

/* ---------- data hooks and classes used with closest() ---------- */

console.log('\ndata attributes and selectors');

function checkAttr(attr, values) {
  for (const v of values) {
    if (html.includes(`${attr}="${v}"`)) console.log(`  ok   ${attr}="${v}"`);
    else { fail++; console.log(`  FAIL ${attr}="${v}" not found in index.html`); }
  }
}

// Values the JS dispatches on.
checkAttr('data-mode', [...js.matchAll(/data-mode="([^"]+)"/g)].map((m) => m[1]));
checkAttr('data-fmt', [...js.matchAll(/data-fmt="([^"]+)"/g)].map((m) => m[1]));
checkAttr('data-act', [...js.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]));

// Values present in the HTML that the JS must handle.
const modes = [...html.matchAll(/data-mode="([^"]+)"/g)].map((m) => m[1]);
for (const mode of modes) {
  const handled = new RegExp(`MODE_DEFAULTS[\\s\\S]*?\\b${mode}:`).test(js) ||
                  new RegExp(`'${mode}'`).test(js);
  if (handled) console.log(`  ok   mode "${mode}" has a handler`);
  else { fail++; console.log(`  FAIL mode "${mode}" has no handler in the JS`); }
}

const acts = [...html.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]);
for (const act of acts) {
  if (js.includes(`'${act}'`)) console.log(`  ok   menu action "${act}" is wired`);
  else { fail++; console.log(`  FAIL menu action "${act}" is not wired`); }
}

// Every script referenced by the page must exist on disk.
console.log('\nscript tags');
for (const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
  const p = path.join(ROOT, m[1]);
  if (fs.existsSync(p)) console.log('  ok   ' + m[1]);
  else { fail++; console.log('  FAIL ' + m[1] + ' is missing'); }
}
for (const m of html.matchAll(/<link[^>]+href="([^"]+)"/g)) {
  const p = path.join(ROOT, m[1]);
  if (fs.existsSync(p)) console.log('  ok   ' + m[1]);
  else { fail++; console.log('  FAIL ' + m[1] + ' is missing'); }
}

console.log('\n' + (fail ? fail + ' failed' : 'dom check ok') + '\n');
process.exit(fail ? 1 : 0);
