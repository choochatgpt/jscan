/* tests/learn_mask_test.mjs — unit tests for the redaction mask's coordinate space.
 *
 * Loads the SHIPPING file js/75-learn-mask.js unmodified, with a recording 2D context.
 * No browser, no canvas library, no photograph: the thing under test is arithmetic and
 * a revision counter, and those are exactly where a silent redaction failure would live.
 *
 * The property that matters most is asserted directly: the mask→pixel mapping is a pure
 * function of (mask, w, h), so before.jpg and after.jpg cannot disagree about where the
 * black is. before.jpg and after.jpg are DIFFERENT crops of one photograph, so a mask
 * kept in finished-page space would cover a name in one and miss it in the other.
 *
 * Usage:  node tests/learn_mask_test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

let failures = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ok   ' + msg); return true; }
  console.error('  FAIL ' + msg); failures++; return false;
}
function eq(a, b, msg) { return ok(a === b, msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

/* A 2D context that records what it was asked to draw, in device pixels. */
function recorder() {
  const ops = [];
  const ctx = {
    ops, fillStyle: '', strokeStyle: '', lineCap: '', lineJoin: '', lineWidth: 0,
    save() { ops.push(['save']); }, restore() { ops.push(['restore']); },
    beginPath() { ops.push(['beginPath']); },
    arc(x, y, r) { ops.push(['arc', x, y, r]); },
    fill() { ops.push(['fill']); },
    moveTo(x, y) { ops.push(['moveTo', x, y]); },
    lineTo(x, y) { ops.push(['lineTo', x, y]); },
    stroke() { ops.push(['stroke', ctx.lineWidth]); },
  };
  return ctx;
}

vm.runInThisContext(fs.readFileSync(path.join(REPO_ROOT, 'js', '75-learn-mask.js'), 'utf8'));
const M = globalThis.JS && globalThis.JS.learnMask;
if (!M) { console.error('FAIL: js/75-learn-mask.js did not define JS.learnMask'); process.exit(1); }
console.log('loaded shipping js/75-learn-mask.js -> JS.learnMask present\n');

/* ------------------------------------------------------------------ basics */
console.log('mask basics');
const m = M.create();
ok(M.isEmpty(m), 'a fresh mask is empty');
eq(M.strokeCount(m), 0, 'fresh mask has no strokes');
eq(M.redactedSource({}, m), null, 'an EMPTY mask redacts nothing and returns null ' +
   '(so a bundle cannot claim redaction it did not do)');
eq(M.describe(m).space, 'oriented_source_normalised', 'describe() names the coordinate space');

/* ------------------------------------------------------- the cache trap */
console.log('\nstateKey folding — the stale-canvas trap');
const k0 = M.key(m);
const s1 = M.beginStroke(m, 0.5, 0.5);
ok(M.key(m) !== k0, 'key() changes when a stroke is added, so stateKey cannot serve a stale canvas');
const k1 = M.key(m);
M.extendStroke(m, s1, 0.6, 0.5);
ok(M.key(m) !== k1, 'key() changes when a stroke is extended');
const k2 = M.key(m);
M.extendStroke(m, s1, 0.60002, 0.50002);
eq(M.key(m), k2, 'sub-pixel jitter does NOT bump the revision (no pointless cache invalidation)');
M.setRadius(m, 0.05);
ok(M.key(m) !== k2, 'key() changes when the brush size changes');
const k3 = M.key(m);
M.clear(m);
ok(M.key(m) !== k3, 'key() changes when the mask is cleared');
ok(M.isEmpty(m), 'clear() empties the mask');
eq(M.key(undefined), 'n', 'no mask -> "n", so an unredacted page still has a stable key');

/* ------------------------------------------------- resolution independence */
console.log('\nresolution independence (preview vs work size)');
const m2 = M.create();
M.setRadius(m2, 0.02);
const st = M.beginStroke(m2, 0.25, 0.40);
M.extendStroke(m2, st, 0.75, 0.60);

const preview = recorder();
M.paint(preview, m2, 900, 1200);
const work = recorder();
M.paint(work, m2, 2400, 3200);

const pm = preview.ops.find((o) => o[0] === 'moveTo');
const wm = work.ops.find((o) => o[0] === 'moveTo');
ok(!!pm && !!wm, 'both resolutions drew a stroke');
eq(wm[1] / pm[1], 2400 / 900, 'x scales with width: 0.25 -> 225px at 900, 600px at 2400');
eq(wm[2] / pm[2], 3200 / 1200, 'y scales with height');

const pStroke = preview.ops.find((o) => o[0] === 'stroke');
const wStroke = work.ops.find((o) => o[0] === 'stroke');
eq(wStroke[1] / pStroke[1], 2400 / 900,
   'line width scales with the SHORTER side, so the brush covers the same part of the page');
ok(Math.abs(pStroke[1] - 2 * 0.02 * 900) < 1e-6, 'brush radius is a fraction of the shorter side');

/* ------------------------------- purity: the property that protects the client */
console.log('\npurity — before.jpg and after.jpg cannot disagree');
const a = recorder(); M.paint(a, m2, 1600, 2100);
const b = recorder(); M.paint(b, m2, 1600, 2100);
eq(JSON.stringify(a.ops), JSON.stringify(b.ops),
   'the same mask at the same size paints byte-identical output');
ok(a.ops.length === b.ops.length && a.ops.length > 0, 'and it painted something');

/* The same mask painted at the WORK size is what gets burned into the source; both
 * exported images descend from that one canvas, so this is the only mapping there is. */
const diff = recorder(); M.paint(diff, m2, 1000, 1300);
ok(JSON.stringify(diff.ops) !== JSON.stringify(a.ops),
   'a different output size really does produce different device pixels (the test can fail)');

/* ------------------------------------------------------------------ radius */
console.log('\nbrush radius clamping');
const m3 = M.create();
eq(M.setRadius(m3, 99), M.MAX_RADIUS, 'an absurd radius clamps to MAX_RADIUS');
eq(M.setRadius(m3, -5), M.MIN_RADIUS, 'a negative radius clamps to MIN_RADIUS');
eq(M.setRadius(m3, NaN), M.DEFAULT_RADIUS, 'a non-numeric radius falls back to the default');
eq(M.setRadius(m3, 0.02), 0.02, 'a sane radius is accepted unchanged');

/* ------------------------------------------------------------------ describe */
console.log('\ndescribe() — what the manifest records');
const m4 = M.create();
const q = M.beginStroke(m4, 0.1, 0.1);
M.extendStroke(m4, q, 0.2, 0.2);
M.extendStroke(m4, q, 0.3, 0.3);
const d = M.describe(m4);
eq(d.strokes, 1, 'one stroke');
eq(d.points, 3, 'three points');
ok(!('pts' in d) && !('strokes' in d && Array.isArray(d.strokes)),
   'describe() carries counts, never the coordinates');

console.log(failures ? '\nFAIL: ' + failures + ' assertion(s) failed' : '\nPASS — all assertions held');
process.exit(failures ? 1 : 0);
