/* ==========================================================================
   tests/smoke.js — node-based checks for the parts that do not need a DOM.

   Run:  node tests/smoke.js
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* ---------- minimal browser stubs ---------- */

// A canvas whose 2D context records whether the pixel pass ran — the commit
// contract is "rendering a committed page costs no pixel work", and that is only
// observable by watching these calls.
//
// It also actually stores its pixels. Call counts can only say that *something*
// happened; the tone pipeline has to be checked on values, or a shadow-removal
// pass that runs and does nothing looks exactly like one that works.
function stubCanvas() {
  const c = {
    width: 300, height: 150, style: {}, _ctx: null,
    _px: null                       // Uint8ClampedArray over width*height*4
  };
  const buf = (w, h) => new Uint8ClampedArray(w * h * 4);

  c.getContext = () => {
    if (c._ctx) return c._ctx;
    const ctx = {
      canvas: c,
      calls: { getImageData: 0, putImageData: 0, drawImage: 0 },
      imageSmoothingQuality: '',
      save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
      setTransform() {}, clearRect() { c._px = null; },

      // Nearest-neighbour, not bilinear: nothing here is being graded on
      // resampling quality, only on which pixels ended up where.
      drawImage(src, ...a) {
        ctx.calls.drawImage++;
        let sx = 0, sy = 0, sw = src.width, sh = src.height;
        let dx = 0, dy = 0, dw = sw, dh = sh;
        if (a.length === 8) { [sx, sy, sw, sh, dx, dy, dw, dh] = a; }
        else if (a.length === 4) { [dx, dy, dw, dh] = a; }
        else if (a.length === 2) { [dx, dy] = a; }
        const sp = src._px, d = buf(c.width, c.height);
        if (sp && dw > 0 && dh > 0) {
          for (let y = 0; y < dh; y++) {
            const ty = Math.round(dy + y);
            if (ty < 0 || ty >= c.height) continue;
            const syi = Math.min(sh - 1, Math.max(0, Math.round(sy + y)));
            if (syi >= src.height) continue;
            for (let x = 0; x < dw; x++) {
              const tx = Math.round(dx + x);
              if (tx < 0 || tx >= c.width) continue;
              const sxi = Math.min(sw - 1, Math.max(0, Math.round(sx + x)));
              if (sxi >= src.width) continue;
              const so = (syi * src.width + sxi) * 4, to = (ty * c.width + tx) * 4;
              d[to] = sp[so]; d[to + 1] = sp[so + 1];
              d[to + 2] = sp[so + 2]; d[to + 3] = sp[so + 3];
            }
          }
        }
        c._px = d;
      },

      createImageData(w, h) { return { width: w, height: h, data: buf(w, h) }; },

      getImageData(x, y, w, h) {
        ctx.calls.getImageData++;
        const d = buf(w, h);
        if (c._px) {
          for (let y2 = 0; y2 < h; y2++) {
            const sy2 = y + y2;
            if (sy2 < 0 || sy2 >= c.height) continue;
            for (let x2 = 0; x2 < w; x2++) {
              const sx2 = x + x2;
              if (sx2 < 0 || sx2 >= c.width) continue;
              const so = (sy2 * c.width + sx2) * 4, to = (y2 * w + x2) * 4;
              d[to] = c._px[so]; d[to + 1] = c._px[so + 1];
              d[to + 2] = c._px[so + 2]; d[to + 3] = c._px[so + 3];
            }
          }
        }
        return { width: w, height: h, data: d };
      },

      putImageData(img, dx, dy) {
        ctx.calls.putImageData++;
        if (!c._px) c._px = buf(c.width, c.height);
        for (let y = 0; y < img.height; y++) {
          const ty = dy + y;
          if (ty < 0 || ty >= c.height) continue;
          for (let x = 0; x < img.width; x++) {
            const tx = dx + x;
            if (tx < 0 || tx >= c.width) continue;
            const so = (y * img.width + x) * 4, to = (ty * c.width + tx) * 4;
            c._px[to] = img.data[so]; c._px[to + 1] = img.data[so + 1];
            c._px[to + 2] = img.data[so + 2]; c._px[to + 3] = img.data[so + 3];
          }
        }
      }
    };
    c._ctx = ctx;
    return ctx;
  };
  return c;
}

const SOURCES = ['00-utils.js', '10-imageops.js', '20-detect.js', '30-pipeline.js', '40-export.js'];

/**
 * Load the app's scripts into a fresh sandbox. `strip` may edit a source on the
 * way in, which is how the checks below replay the code as it was before a
 * guard existed.
 */
function loadJs(strip) {
  const sandbox = {
    window: {},
    document: { createElement: () => stubCanvas() },
    navigator: {},
    TextEncoder,
    Uint8Array, Uint8ClampedArray, Float64Array, Int32Array, Uint32Array,
    Math, JSON, Object, Array, Number, String, Promise, console, setTimeout
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  for (const f of SOURCES) {
    let src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
    if (strip) src = strip(src, f);
    vm.runInContext(src, sandbox, { filename: f });
  }
  return sandbox.JS;
}

const JS = loadJs(null);

/* ---------- the pre-guard detector, for falsifiers ---------- */

// Several checks below are only worth something if the behaviour they describe
// could plausibly have been otherwise, so they run the same input through a
// copy of 20-detect.js with the guards removed and assert the two disagree.
//
// The cuts are literal source text. If a later edit renames or reflows one of
// them the cut stops matching and this throws — loudly, at the top of the
// suite, rather than leaving a check that quietly proves nothing.
let unguarded = null, unguardedNoAgree = null;

/** Load 20-detect.js with `cuts` (pairs of literal source text) removed. */
function loadDetectWith(cuts) {
  return loadJs((src, f) => {
    if (f !== '20-detect.js') return src;
    for (const [from, to] of cuts) {
      if (src.indexOf(from) < 0) {
        throw new Error('20-detect.js no longer contains: ' + JSON.stringify(from));
      }
      src = src.split(from).join(to);
    }
    return src;
  });
}

// And the second threshold, which is not a guard but a whole second candidate:
// before 1.7.0 the crop was the frame-split one and nothing could displace it.
// Cutting the pick is what makes the reconstruction the *old crop* rather than
// the old guards with a new crop underneath them.
const OLD_PICK_CUT = [
  'var pick = strict && scoreStrict > scoreLoose + SWITCH_MARGIN ? strict : loose;',
  'var pick = loose;'
];

/**
 * The detector with the second candidate's guard cut but the second candidate
 * kept: the agreement between the two thresholds about which side of the
 * background the page is on. Only reachable once the polarity guard is gone, so
 * mutating it means cutting that too — and the wrong answer it then produces is
 * a different crop from the one `detectorWithoutGuards` produces, which is what
 * the check below pins.
 */
function detectorWithoutPolarityAgreement() {
  if (unguardedNoAgree) return unguardedNoAgree;
  unguardedNoAgree = loadDetectWith(GUARD_CUTS.concat([[
    '        if (strict && strict.light !== loose.light) strict = null;\n', ''
  ]]));
  return unguardedNoAgree;
}

const GUARD_CUTS = [
    // quadFromGray: refuse an ambiguous background polarity.
    ['    if (Math.abs(bg - thr) < delta && bgSd >= delta) {', '    if (false && Math.abs(bg - thr) < delta && bgSd >= delta) {'],
    // skewFromGray: refuse a peak sitting on the edge of the coarse scan.
    ['    if (best === -LIMIT || best === LIMIT) return 0;\n\n', ''],
    // skewFromGray: refuse a curve whose minimum is a large fraction of its
    // peak — no alignment in it to act on.
    ['    if (minScore > bestScore * 0.25) return 0;\n\n', ''],
    // skewFromGray: pin the fine scan's centre so it cannot chase its own bound.
    ['    var centre = best;\n', ''],
    ['for (a = centre - 1; a <= centre + 1', 'for (a = best - 1; a <= best + 1'],
    // refineOnce: keep the frame's own border pixels out of the edge fits, and
    // do not tally them either — without the tally no side can be inherited, so
    // the pass refuses exactly where it used to.
    ["      if (onFrame(p, w, h)) { onBorder[best]++; continue; }\n", ''],
    // refineOnce: never inherit a side from the rough quad.
    ['        if (buckets[i].length || !onBorder[i] || ++border > 1) return null;\n'
     + '        lines.push(lineThrough(q[i], q[(i + 1) % 4]));\n'
     + '        continue;\n', '        return null;\n'],
    // quadFromEdges: refuse a hull whose corners are the photo's, not the page's.
    ['    if (fromHull && !fitted) {\n'
     + '      for (var k = 0; k < 4; k++) if (onFrame(q[k], w, h)) return null;\n'
     + '    }\n', '']
];

/** The pre-1.7.0 detector: every guard gone and the frame-split crop kept. */
function detectorWithoutGuards() {
  if (unguarded) return unguarded;
  unguarded = loadDetectWith(GUARD_CUTS.concat([OLD_PICK_CUT]));
  return unguarded;
}

// The broad-peak guard on its own. `detectorWithoutGuards` removes all of them
// at once, which is right for the checks that predate it but cannot show *which*
// guard refused a given input. This one cuts only the broad-peak test.
let withoutPeakGuard = null;
function skewWithoutPeakGuard() {
  if (withoutPeakGuard) return withoutPeakGuard;
  const cut = '    if (minScore > bestScore * 0.25) return 0;\n\n';
  withoutPeakGuard = loadJs((src, f) => {
    if (f !== '20-detect.js') return src;
    if (src.indexOf(cut) < 0) {
      throw new Error('20-detect.js no longer contains: ' + JSON.stringify(cut));
    }
    return src.split(cut).join('');
  });
  return withoutPeakGuard;
}

/* ---------- tiny test harness ---------- */

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -- ' + detail : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= (tol === undefined ? 1e-6 : tol); }

/* ================= 1. homography ================= */
console.log('\nhomography');

{
  // A trapezoid: the classic photo-of-a-page-at-an-angle shape.
  const src = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 300 }, { x: 0, y: 300 }];
  const dst = [{ x: 18, y: 25 }, { x: 190, y: 8 }, { x: 205, y: 288 }, { x: 5, y: 305 }];
  const H = JS.solveHomography(src, dst);
  check('solves a non-degenerate system', !!H);

  let maxErr = 0;
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const den = H[6] * x + H[7] * y + 1;
    const u = (H[0] * x + H[1] * y + H[2]) / den;
    const v = (H[3] * x + H[4] * y + H[5]) / den;
    maxErr = Math.max(maxErr, Math.abs(u - dst[i].x), Math.abs(v - dst[i].y));
  }
  check('maps all four corners back exactly', maxErr < 1e-9, 'maxErr=' + maxErr);
}

{
  // Degenerate: three collinear points must be refused, not silently guessed.
  const src = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }, { x: 0, y: 30 }];
  const dst = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 0, y: 3 }];
  check('refuses a degenerate quad', JS.solveHomography(src, dst) === null);
}

/* ================= 2. image operations ================= */
console.log('\nimage operations');

{
  // Otsu returns the last bin of the dark class, so a clean bimodal image
  // should classify every pixel correctly under `v <= t is dark`.
  const gray = new Uint8Array(1000);
  for (let i = 0; i < 500; i++) gray[i] = 30;
  for (let i = 500; i < 1000; i++) gray[i] = 220;
  const t = JS.otsu(gray);
  check('otsu separates a bimodal image', t >= 30 && t < 220, 't=' + t);

  let darkRight = true, lightRight = true;
  for (let i = 0; i < gray.length; i++) {
    const isDark = gray[i] <= t;
    if (i < 500 && !isDark) darkRight = false;
    if (i >= 500 && isDark) lightRight = false;
  }
  check('otsu classifies the dark mode as dark', darkRight);
  check('otsu classifies the light mode as light', lightRight);
}

{
  // Integral image must agree with a brute-force rectangle sum.
  const w = 17, h = 13;
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) gray[i] = (i * 37) % 256;
  const I = JS.integral(gray, w, h);
  let ok = true;
  for (const [x1, y1, x2, y2] of [[0, 0, w - 1, h - 1], [3, 2, 9, 7], [5, 5, 5, 5], [0, 0, 0, 0]]) {
    let brute = 0;
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) brute += gray[y * w + x];
    const fast = JS.rectSum(I, w + 1, x1, y1, x2, y2);
    if (brute !== fast) { ok = false; console.log('     mismatch', x1, y1, x2, y2, brute, fast); }
  }
  check('integral image matches brute force', ok);
}

{
  // A dark block on a light field: adaptive threshold must separate them, and
  // must do so even when the field has a lighting gradient.
  const w = 200, h = 200;
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gradient = 255 - Math.round(x * 90 / w);      // left bright, right dim
      const inBlock = x > 80 && x < 120 && y > 80 && y < 120;
      gray[y * w + x] = inBlock ? 40 : gradient;
    }
  }
  const bw = JS.adaptiveThreshold(gray, w, h, 12, 0.15, 0, 55);
  const centre = bw[100 * w + 100];
  const corner = bw[5 * w + 5];
  const dimCorner = bw[5 * w + (w - 6)];
  check('threshold marks the dark block as ink', centre === 0, 'v=' + centre);
  check('threshold leaves the bright field clear', corner === 255, 'v=' + corner);
  check('threshold survives a lighting gradient', dimCorner === 255, 'v=' + dimCorner);

  // Without the absolute floor the block interior washes out — the artefact
  // the floor exists to prevent.
  const noFloor = JS.adaptiveThreshold(gray, w, h, 12, 0.15, 0, 0);
  check('without a floor the block interior washes out',
    noFloor[100 * w + 100] === 255, 'v=' + noFloor[100 * w + 100]);
}

{
  // A thin stroke must survive the same rule that keeps solid areas filled.
  const w = 200, h = 200;
  const gray = new Uint8Array(w * h).fill(240);
  for (let y = 40; y < 160; y++) for (let x = 98; x < 102; x++) gray[y * w + x] = 20;
  const bw = JS.adaptiveThreshold(gray, w, h, 12, 0.15, 0, 55);
  check('a thin stroke is detected', bw[100 * w + 100] === 0);
  check('paper beside the stroke stays clear', bw[100 * w + 130] === 255);
}

{
  // Sauvola has to do everything Bradley does — the same block, the same
  // gradient, the same floor — because it replaced it on every thresholded
  // render and a regression here is a regression in what the user sees.
  const w = 200, h = 200;
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gradient = 255 - Math.round(x * 90 / w);
      const inBlock = x > 80 && x < 120 && y > 80 && y < 120;
      gray[y * w + x] = inBlock ? 40 : gradient;
    }
  }
  const bw = JS.sauvolaThreshold(gray, w, h, 12, 0.15, 0, 55);
  check('sauvola marks the dark block as ink', bw[100 * w + 100] === 0);
  check('sauvola leaves the bright field clear', bw[5 * w + 5] === 255);
  check('sauvola survives a lighting gradient', bw[5 * w + (w - 6)] === 255);
  const noFloor = JS.sauvolaThreshold(gray, w, h, 12, 0.15, 0, 0);
  check('sauvola keeps the floor load-bearing too',
    noFloor[100 * w + 100] === 255, 'v=' + noFloor[100 * w + 100]);

  const thin = new Uint8Array(w * h).fill(240);
  for (let y = 40; y < 160; y++) for (let x = 98; x < 102; x++) thin[y * w + x] = 20;
  const tb = JS.sauvolaThreshold(thin, w, h, 12, 0.15, 0, 55);
  check('sauvola detects a thin stroke', tb[100 * w + 100] === 0);
  check('sauvola leaves paper beside it clear', tb[100 * w + 130] === 255);
}

{
  // The reason the threshold was replaced at all. A faint, soft stroke is a
  // grey ramp rather than an edge, and the local-mean rule cuts the ramp's
  // shoulders off — the letter comes back in pieces. The local-contrast rule
  // rises towards the local mean inside a window a stroke runs through, so the
  // whole ramp is called ink. Both are asked the same question; the new one has
  // to answer with more of the stroke and none of the paper.
  const w = 200, h = 200;
  const soft = new Uint8Array(w * h).fill(238);
  for (let y = 0; y < h; y++) {
    for (let x = 96; x < 104; x++) {
      // A blurry stroke: a shallow ramp down to 190, not a black line at 20.
      const d = Math.abs(x - 99.5) / 4;
      soft[y * w + x] = Math.round(238 - (1 - d) * 48);
    }
  }
  const bradley = JS.adaptiveThreshold(soft, w, h, 12, 0.09, 0, 0);
  const sauvola = JS.sauvolaThreshold(soft, w, h, 12, 0.09, 0, 0);
  const count = (bw, want) => {
    let n = 0;
    for (let i = 0; i < bw.length; i++) if (bw[i] === want) n++;
    return n;
  };
  const bInk = count(bradley, 0), sInk = count(sauvola, 0);
  check('the soft stroke is there to be found', bInk > 0, 'bradley ink=' + bInk);
  check('and the local-contrast rule finds it too', sInk > 0, sInk);
  // The property that makes the replacement safe, and the one that can be
  // stated exactly: Sauvola's threshold is Bradley's plus a term that is zero on
  // a flat window and positive on a busy one, so it can only ever *add* ink.
  // Nothing the old rule found can disappear under the new one.
  let lost = 0;
  for (let i = 0; i < bradley.length; i++) if (bradley[i] === 0 && sauvola[i] !== 0) lost++;
  check('the new rule loses nothing the old one found', lost === 0, lost + ' pixels lost');
  check('and it is still only the stroke, not the paper',
    sInk < w * h * 0.25, sInk + ' of ' + (w * h));
  // Solid paper has no contrast to justify ink, so a flat field stays flat even
  // where it is dark: the floor is what stops the rule eating a filled shape.
  const flat = new Uint8Array(w * h).fill(230);
  const fb = JS.sauvolaThreshold(flat, w, h, 12, 0.09, 0, 55);
  check('a flat field of paper comes back all paper', count(fb, 0) === 0);
}

{
  // Shadow removal should pull a gradient field towards uniform white.
  const w = 160, h = 160;
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) gray[y * w + x] = 255 - Math.round(x * 100 / w);
  }
  const flat = JS.flattenBackground(gray, w, h, 20, 1);
  const left = flat[80 * w + 10], right = flat[80 * w + 150];
  check('shadow removal evens out a gradient', Math.abs(left - right) < 12,
    'left=' + left + ' right=' + right);
}

{
  // Despeckle flips a lone pixel but must leave a solid run alone.
  const w = 9, h = 9;
  const bw = new Uint8Array(w * h).fill(255);
  bw[4 * w + 4] = 0;                       // isolated speck
  bw[7 * w + 2] = 0; bw[7 * w + 3] = 0; bw[7 * w + 4] = 0;   // a short stroke
  const out = JS.despeckle(bw, w, h);
  check('despeckle removes an isolated pixel', out[4 * w + 4] === 255);
  check('despeckle keeps a stroke', out[7 * w + 3] === 0);
}

{
  // Auto levels should stretch a low-contrast image to the full range.
  const n = 400;
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = 100 + (i % 50);             // sits in 100..149
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  const luts = JS.autoLevelsLUTs(data, 0);
  const lo = luts.lutR[100], hi = luts.lutR[149];
  check('auto levels stretches the dark end down', lo < 20, 'lo=' + lo);
  check('auto levels stretches the bright end up', hi > 235, 'hi=' + hi);
}

/* ================= 3. page detection ================= */
console.log('\npage detection');

/** Bright sheet on a dark field, rotated by `deg` about the image centre. */
function sheetScene(w, h, deg, paperW, paperH, paperVal, bgVal) {
  const gray = new Uint8Array(w * h).fill(bgVal);
  const rad = deg * Math.PI / 180;
  const cs = Math.cos(rad), sn = Math.sin(rad);
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      // Inverse rotation: is this pixel inside the un-rotated rectangle?
      const u = dx * cs + dy * sn;
      const v = -dx * sn + dy * cs;
      if (Math.abs(u) <= paperW / 2 && Math.abs(v) <= paperH / 2) gray[y * w + x] = paperVal;
    }
  }
  return gray;
}

{
  const w = 300, h = 300;
  const gray = sheetScene(w, h, 0, 200, 240, 235, 45);
  const q = JS.quadFromGray(gray, w, h);
  check('finds an upright sheet', !!q);
  if (q) {
    const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
    const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
    check('quad is centred', near(cx, 150, 3) && near(cy, 150, 3),
      'centre=' + cx.toFixed(1) + ',' + cy.toFixed(1));
    check('quad matches the sheet area', near(JS.quadArea(q), 200 * 240, 200 * 240 * 0.06),
      'area=' + JS.quadArea(q).toFixed(0) + ' want ' + (200 * 240));
  }
}

{
  // The same sheet, tilted. Corners must follow the tilt, not stay axis-aligned.
  const w = 300, h = 300, deg = 7;
  const gray = sheetScene(w, h, deg, 190, 230, 235, 45);
  const q = JS.quadFromGray(gray, w, h);
  check('finds a tilted sheet', !!q);
  if (q) {
    check('tilted quad keeps its area', near(JS.quadArea(q), 190 * 230, 190 * 230 * 0.12),
      'area=' + JS.quadArea(q).toFixed(0) + ' want ' + (190 * 230));

    // A 7-degree tilt must actually show up as a sloped top edge.
    const slope = Math.atan2(q[1].y - q[0].y, q[1].x - q[0].x) * 180 / Math.PI;
    check('tilted quad reproduces the rotation', near(slope, deg, 2.5),
      'slope=' + slope.toFixed(2) + '° want ' + deg + '°');
  }
}

{
  // Corner order must be TL, TR, BR, BL so the warp does not mirror the page.
  const w = 300, h = 300;
  const gray = sheetScene(w, h, 0, 200, 240, 235, 45);
  const q = JS.quadFromGray(gray, w, h);
  if (q) {
    check('corner 0 is top-left', q[0].x < q[1].x && q[0].y < q[2].y);
    check('corner 1 is top-right', q[1].x > q[0].x && q[1].x > q[3].x);
    check('corner 2 is bottom-right', q[2].y > q[0].y && q[2].y > q[1].y);
    check('corner 3 is bottom-left', q[3].x < q[2].x && q[3].y > q[0].y);
  }
}

{
  // A uniform frame has no sheet in it, so nothing should be reported.
  const gray = new Uint8Array(200 * 200).fill(128);
  check('uniform frame yields no quad', JS.quadFromGray(gray, 200, 200) === null);
}

{
  // A sheet photographed on a surface with no dominant tone — the reported
  // case, a pale receipt on pale marble held by a hand. The detector reads the
  // frame's border to learn what the background is, which needs the border to
  // be both decisively on one side of the Otsu split *and* a single material.
  // Here it is a shaded hand down one side and a pale counter down the other:
  // the spread says mixture, and the mean lands on the split itself, so "which
  // side is the paper on?" has no answer. Selecting the class opposite a
  // coin-flip background found the hand; the crop came back covering 44% of the
  // frame with the receipt entirely outside it, reported as "Edges found".
  const w = 300, h = 300;
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // The hand's gradient reaches up to the split, which is what makes the
      // dark class large enough to be mistaken for a page.
      gray[y * w + x] = Math.round(x < w / 2 ? 110 + 55 * x / (w / 2 - 1)
                                             : 200 + 35 * (x - w / 2) / (w / 2 - 1));
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (Math.abs(x - w / 2) <= 0.33 * w && Math.abs(y - h / 2) <= 0.40 * h) {
        gray[y * w + x] = 245;                                   // the receipt
      }
    }
  }

  const border = [];
  for (let x = 0; x < w; x++) border.push(gray[x], gray[(h - 1) * w + x]);
  for (let y = 0; y < h; y++) border.push(gray[y * w], gray[y * w + w - 1]);
  const bg = border.reduce((a, v) => a + v, 0) / border.length;
  const thr = JS.otsu(gray);
  const sd = Math.sqrt(border.reduce((a, v) => a + (v - bg) * (v - bg), 0) / border.length);
  const detail = 'border=' + bg.toFixed(1) + ' otsu=' + thr.toFixed(1)
    + ' margin=' + Math.abs(bg - thr).toFixed(1) + ' sd=' + sd.toFixed(1);

  check('a mixed-tone border yields no quad', JS.quadFromGray(gray, w, h) === null, detail);

  // The falsifier: without the guard the same frame produced a confident crop.
  const old = detectorWithoutGuards();
  const oldQuad = old.quadFromGray(gray, w, h);
  check('without the polarity guard the same frame is cropped', !!oldQuad, detail);
  if (oldQuad) {
    // ...and not to the receipt, which sits in the middle: the crop was the
    // dark half of the frame.
    const cx = (oldQuad[0].x + oldQuad[1].x + oldQuad[2].x + oldQuad[3].x) / 4;
    check('and the crop is the dark half, not the receipt', cx < w * 0.35,
      'centre x=' + cx.toFixed(0) + ' of ' + w);
  }

  // The guard on the *second* threshold, mutated the same way. The strict
  // candidate is chosen from the paper's own mode rather than the frame's
  // split, and on this frame that mode (251) is real but has no valley beneath
  // it — the counter's gradient climbs into it — so the "valley" came back as
  // the bottom of its own search range and the threshold landed at 215, on the
  // far side of the background's 175. The mask then took the class opposite the
  // background, which is now the counter and the receipt: a second confident
  // crop of a different wrong thing, outscoring the first (40.7 against 8.3)
  // and winning. Cutting the agreement check below puts it back.
  const bright = detectorWithoutPolarityAgreement().quadFromGray(gray, w, h);
  check('without that agreement the second threshold crops the other side too',
    !!bright, detail);
  if (bright) {
    const bx = (bright[0].x + bright[1].x + bright[2].x + bright[3].x) / 4;
    check('and that crop is on the bright side, where the receipt is not either',
      bx > w * 0.5, 'centre x=' + bx.toFixed(0) + ' of ' + w);
  }
}


{
  // A portrait version of the mixed-border phone case. The old polarity guard
  // still fires, but the page itself has persistent independent side/end seams,
  // so the edge-only recovery may answer without asking the border which class
  // is the background.
  const w = 300, h = 420, join = 130;
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v;
      if (x < join) {
        v = 118 + 46 * x / (join - 1);
        if ((y % 74) < 9) v *= 0.86;
      } else {
        const t = (x - join) / (w - join - 1);
        v = 204 + 26 * t + 5 * Math.sin(x * 0.04) * Math.cos(y * 0.02);
      }
      gray[y * w + x] = Math.round(v);
    }
  }
  for (let y = 30; y <= 400; y++) {
    for (let x = 110; x <= 195; x++) {
      const k = x <= join ? 0.72 : 0.72 + 0.28 * Math.min(1, (x - join) / 35);
      gray[y * w + x] = Math.round(246 * k);
    }
  }

  const border = [];
  for (let x = 0; x < w; x++) border.push(gray[x], gray[(h - 1) * w + x]);
  for (let y = 0; y < h; y++) border.push(gray[y * w], gray[y * w + w - 1]);
  const bg = border.reduce((a, v) => a + v, 0) / border.length;
  const thr = JS.otsu(gray);
  const sd = Math.sqrt(border.reduce((a, v) => a + (v - bg) * (v - bg), 0) / border.length);
  check('portrait recovery fixture really has ambiguous border polarity',
    Math.abs(bg - thr) < 16 && sd >= 16,
    'border=' + bg.toFixed(1) + ' otsu=' + thr + ' sd=' + sd.toFixed(1));

  const q = JS.quadFromGray(gray, w, h);
  check('portrait mixed-border receipt is recovered by persistent edges', !!q);
  if (q) {
    const xs = q.map(p => p.x), ys = q.map(p => p.y);
    check('portrait recovery lands on the receipt rather than the hand',
      Math.min(...xs) > w * 0.25 && Math.max(...xs) < w * 0.75 &&
      Math.min(...ys) < h * 0.12 && Math.max(...ys) > h * 0.90,
      'x=' + Math.min(...xs).toFixed(0) + '..' + Math.max(...xs).toFixed(0) +
      ' y=' + Math.min(...ys).toFixed(0) + '..' + Math.max(...ys).toFixed(0));
  }
}

/* ============ 3b. edge fitting ============ */
console.log('\nedge fitting');

{
  // fitLine must be total-least-squares, not y-on-x: a page edge is vertical
  // half the time and a regression would diverge there.
  const horizontal = [];
  for (let x = 0; x < 100; x++) horizontal.push({ x: x, y: 40 + x * 0.02 });
  const lh = JS.fitLine(horizontal);
  check('fitLine is normalised', near(Math.hypot(lh.a, lh.b), 1, 1e-9));
  check('fitLine finds a near-horizontal line',
    Math.abs(lh.a) < 0.05 && Math.abs(lh.b) > 0.99, `n=(${lh.a.toFixed(3)},${lh.b.toFixed(3)})`);
  // Every sample must sit on it.
  const worstH = Math.max(...horizontal.map(p => Math.abs(lh.a * p.x + lh.b * p.y + lh.c)));
  check('every sample lies on the fitted line', worstH < 1e-9, 'worst=' + worstH);

  const vertical = [];
  for (let y = 0; y < 100; y++) vertical.push({ x: 10 + y * 0.02, y: y });
  const lv = JS.fitLine(vertical);
  check('fitLine finds a near-vertical line',
    Math.abs(lv.b) < 0.05 && Math.abs(lv.a) > 0.99, `n=(${lv.a.toFixed(3)},${lv.b.toFixed(3)})`);

  check('fitLine refuses a single point', JS.fitLine([{ x: 1, y: 2 }]) === null);
  check('fitLine refuses coincident points',
    JS.fitLine([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }]) === null);

  // Line intersection, including the parallel case.
  const cross = JS.lineIntersect(JS.fitLine([{ x: 0, y: 0 }, { x: 10, y: 0 }]),
                                 JS.fitLine([{ x: 3, y: -5 }, { x: 3, y: 5 }]));
  check('lineIntersect finds the crossing', near(cross.x, 3, 1e-9) && near(cross.y, 0, 1e-9),
    `got (${cross.x},${cross.y})`);
  check('lineIntersect refuses parallel lines',
    JS.lineIntersect(JS.fitLine([{ x: 0, y: 0 }, { x: 10, y: 0 }]),
                     JS.fitLine([{ x: 0, y: 4 }, { x: 10, y: 4 }])) === null);
}

{
  // The core case, and the reason the fitting exists: a corner the silhouette
  // does not have. A torn, folded or shadow-clipped corner leaves the extreme
  // hull point sitting on the damage, tens of pixels inside the real corner.
  const tilt = 12, W = 500, H = 420;
  const rot = (p) => {
    const r = tilt * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    const dx = p.x - 200, dy = p.y - 150;
    return { x: 200 + dx * c - dy * s, y: 150 + dx * s + dy * c };
  };
  const truth = [{ x: 50, y: 50 }, { x: 350, y: 50 }, { x: 350, y: 250 }, { x: 50, y: 250 }].map(rot);
  const [TL, TR, BR, BL] = truth;
  const along = (from, to, d) => {
    const L = JS.dist(from, to);
    return { x: from.x + (to.x - from.x) * d / L, y: from.y + (to.y - from.y) * d / L };
  };

  // A dense perimeter cloud, the way boundaryPixels delivers one. Zero-mean
  // noise on purpose: a biased generator would shift every fitted line and the
  // comparison would be measuring the generator instead.
  let seed = 1;
  const walk = (verts, per) => {
    const out = [];
    const jit = () => ((Math.sin(seed++ * 12.9898) * 43758.5453 % 1) + 1) % 1 - 0.5;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      for (let k = 0; k < per; k++) {
        const t = k / per;
        out.push({ x: a.x + (b.x - a.x) * t + jit() * 1.6,
                   y: a.y + (b.y - a.y) * t + jit() * 1.6 });
      }
    }
    return out;
  };
  const worstErr = (q) => Math.max(...q.map((p, i) => JS.dist(p, truth[i])));

  // A 44px chamfer across the BR corner: the page's real corner is simply gone.
  const chamfered = walk([TL, TR, along(BR, TR, 31), along(BR, BL, 31), BL], 40);
  const q = JS.quadFromEdges(chamfered, W, H);
  check('a folded corner is still found', !!q);
  if (q) {
    check('the fitted corner lands on the real corner, not the fold',
      worstErr(q) < 3, 'worst=' + worstErr(q).toFixed(2) + 'px (the old pick managed 29)');
    check('the recovered corner is outside the damage, as it must be',
      JS.dist(q[2], truth[2]) < JS.dist(q[2], along(BR, TR, 31)),
      'the corner was pulled onto the chamfer instead of past it');
  }

  // A shadow blob joined to the page at BR, protruding past the corner. It is
  // genuine boundary, so it lands in a side's bucket — and it swallows the
  // corner from the hull entirely, which is why fitting edges beats picking
  // points: the hull no longer contains the corner at all.
  const blobby = walk([TL, TR, along(BR, TR, 36), rot({ x: 376, y: 272 }), along(BR, BL, 36), BL], 40);
  const q2 = JS.quadFromEdges(blobby, W, H);
  check('a protrusion at the corner does not drag the crop', !!q2 && worstErr(q2) < 3,
    q2 ? 'worst=' + worstErr(q2).toFixed(2) + 'px' : 'no quad');

  // And a clean page must not regress — the fit has to be at least as good as
  // the four extreme points were on the input they were designed for.
  const clean = walk([TL, TR, BR, BL], 40);
  const q3 = JS.quadFromEdges(clean, W, H);
  check('a clean page is fitted at least as well', !!q3 && worstErr(q3) < 1.5,
    q3 ? 'worst=' + worstErr(q3).toFixed(2) + 'px' : 'no quad');

  // Degenerate input must decline rather than invent corners.
  check('too few boundary points yields no quad',
    JS.quadFromEdges([{ x: 1, y: 2 }, { x: 3, y: 4 }], W, H) === null);
}

/* ============ 3c. the outline, not the printing ============ */
console.log('\nthe outline, not the printing');

// A sheet of paper with text on it is mostly holes. Every glyph is a gap in the
// bright region, so the rim of the printing outnumbers the rim of the paper
// several times over — and on a real photo of a report it was 3954 points
// against 1200. Take them all and the four fitted sides land on the paragraph
// margins: a crop around the text instead of around the sheet.
//
// The desk below the sheet is *outside*; the glyphs are holes. Same value in
// the mask, opposite meaning, and reachability from the frame border is the
// only thing that tells them apart.
const printingW = 120, printingH = 170, printingBottom = 128;

function printingScene() {
  const w = printingW, h = printingH, sheetBottom = printingBottom;
  const mask = new Uint8Array(w * h).fill(1);
  for (let y = sheetBottom; y < h; y++) {
    for (let x = 0; x < w; x++) mask[y * w + x] = 0;
  }
  const x0 = 14, x1 = w - 14, top = 12, lines = 14, per = 22;
  const step = (sheetBottom - top - 12) / lines, gw = (x1 - x0) / per;
  for (let li = 0; li < lines; li++) {
    for (let gi = 0; gi < per; gi++) {
      const gx = Math.round(x0 + gi * gw), gy = Math.round(top + li * step);
      for (let dy = 0; dy < Math.max(1, Math.round(step * 0.6)); dy++) {
        for (let dx = 0; dx < Math.max(1, Math.round(gw * 0.7)); dx++) {
          const px = gx + dx, py = gy + dy;
          if (px >= 0 && px < w && py >= 0 && py < sheetBottom) mask[py * w + px] = 0;
        }
      }
    }
  }
  const blob = { pixels: [] };
  for (let i = 0; i < mask.length; i++) if (mask[i]) blob.pixels.push(i);
  return { w, h, sheetBottom, mask, blob };
}

/** The three things the boundary has to get right, as a function of a detector. */
function boundaryVerdicts(boundaryPixels) {
  const s = printingScene();
  const bp = boundaryPixels(s.blob, s.mask, s.w, s.h);
  const outline = s.w + 2 * s.sheetBottom + s.w;
  return {
    bp,
    size: bp.length < 2 * outline,
    outline,
    inside: bp.filter(p => p.x > 1 && p.x < s.w - 2 &&
                            p.y > 1 && p.y < s.sheetBottom - 2).length,
    fold: bp.filter(p => p.y === s.sheetBottom - 1).length,
    w: s.w
  };
}

{
  const v = boundaryVerdicts(JS.boundaryPixels);
  // The sheet runs off the top, left and right of the frame, so its outline is
  // the two frame sides plus its own bottom edge.
  check('the boundary is the sheet outline, not the printing', v.size,
    v.bp.length + ' points against an outline of ' + v.outline);
  check('no boundary point sits inside the sheet', v.inside === 0,
    v.inside + ' inside');
  // And the edge that is genuinely there must survive: the fold between sheet
  // and desk is the whole reason there is a crop to make.
  check("the sheet's own bottom edge is all there", v.fold === v.w,
    v.fold + ' of ' + v.w + ' points on the fold');
}

/* ---- and the check above can actually fail ---- */
// A guard that has never failed is not evidence of anything, so the same three
// verdicts are run against the pre-fix boundaryPixels: every page pixel with a
// non-page neighbour, which counts the rim of every glyph as an edge. Same
// shape as `oriented_render.py legacy` — the suite carries its own falsifier
// rather than a claim in a document that one existed.
{
  const src = fs.readFileSync(path.join(ROOT, 'js', '20-detect.js'), 'utf8');
  const marker = 'JS.boundaryPixels = function (blob, mask, w, h) {';
  const TAIL = '})(window.JS);';
  // Fail loudly rather than silently stop mutating: a source rewrite that stops
  // applying would turn this block into three tautologies.
  if (!src.includes(marker)) throw new Error('boundaryPixels moved — the legacy replay cannot apply');
  if (!src.trim().endsWith(TAIL)) throw new Error('the detect module tail moved');

  const NAIVE = `
  JS.boundaryPixels = function (blob, mask, w, h) {
    var out = [];
    for (var i = 0; i < blob.pixels.length; i++) {
      var b = blob.pixels[i], x = b % w, y = (b - x) / w;
      if ((x > 0 && !mask[b - 1]) || (x < w - 1 && !mask[b + 1]) ||
          (y > 0 && !mask[b - w]) || (y < h - 1 && !mask[b + w]) ||
          x === 0 || y === 0 || x === w - 1 || y === h - 1) out.push({ x: x, y: y });
    }
    return out;
  };
`;
  const legacy = { window: {}, document: { createElement: () => stubCanvas() },
                   navigator: {}, Uint8Array, Uint8ClampedArray, Float64Array,
                   Int32Array, Uint32Array, Math, JSON, Object, Array, Number,
                   String, console };
  legacy.window = legacy;
  legacy.self = legacy;
  vm.createContext(legacy);
  const renamed = src.replace(marker, marker.replace('JS.boundaryPixels', 'JS.boundaryPixelsReal'));
  for (const f of ['00-utils.js', '10-imageops.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), legacy, { filename: f });
  }
  vm.runInContext(renamed.trim().slice(0, -TAIL.length) + NAIVE + TAIL, legacy,
                  { filename: '20-detect.js (legacy boundaryPixels)' });

  const v = boundaryVerdicts(legacy.JS.boundaryPixels);
  check('the legacy replay is live: it breaks the outline check', !v.size,
    v.bp.length + ' points against an outline of ' + v.outline);
  check('the legacy replay is live: it puts points inside the sheet', v.inside > 0,
    v.inside + ' inside, first ' + JSON.stringify(v.bp.find(
      p => p.x > 1 && p.x < printingW - 2 && p.y > 1 && p.y < printingBottom - 2)));
}

/* ================= 4. de-skew ================= */
console.log('\ndeskew');

/** Horizontal bars tilted by `deg`, so the text lines sit at angle `deg`. */
function textScene(w, h, deg, period, thickness) {
  const gray = new Uint8Array(w * h).fill(245);
  const tan = Math.tan(deg * Math.PI / 180);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = y - x * tan;                 // lines run along (1, tan)
      let m = u % period;
      if (m < 0) m += period;
      if (m < thickness) gray[y * w + x] = 25;
    }
  }
  return gray;
}

for (const deg of [0, 3, -4, 6.5]) {
  const gray = textScene(320, 320, deg, 22, 7);
  const got = JS.skewFromGray(gray, 320, 320);
  check('recovers a ' + deg + '° tilt', near(got, deg, 0.6), 'got ' + got.toFixed(2) + '°');
}

{
  // The correction must be the angle that levels the text, so applying it as
  // the fine angle has to reduce the tilt rather than double it.
  const deg = 5;
  const gray = textScene(320, 320, deg, 22, 7);
  const correction = JS.skewFromGray(gray, 320, 320);
  // Rotating the sampled content by -correction should leave it level.
  const residual = deg - correction;
  check('correction cancels the tilt instead of doubling it', Math.abs(residual) < 0.6,
    'residual=' + residual.toFixed(2) + '°');
}

{
  // The coarse scan spans the whole range the Fine angle slider can express, so
  // a tilt inside that range is measured. It used to stop at 8, which left a
  // page tilted 9 or 12 degrees beyond the search: the score rose to the bound
  // and the answer came back as 8, a correction that leaves most of the tilt in
  // place. These are the tilts the old bound could not reach.
  for (const deg of [8, 9, 12, 14]) {
    const gray = textScene(320, 320, deg, 22, 7);
    const got = JS.skewFromGray(gray, 320, 320);
    check('recovers a ' + deg + '° tilt', near(got, deg, 0.6), 'got ' + got.toFixed(2) + '°');
  }
}

{
  // The other side of the same rule. 15° is the limit itself and 20° is past
  // it; neither can be bracketed by a search that stops at 15, so neither is
  // guessed at. The slider reaches 15 by hand, which is the honest answer for
  // the first of these.
  for (const deg of [15, 20]) {
    const gray = textScene(320, 320, deg, 22, 7);
    check('refuses a ' + deg + '° tilt rather than clipping it',
      JS.skewFromGray(gray, 320, 320) === 0, 'got ' + JS.skewFromGray(gray, 320, 320));
  }
}

{
  // A blank page carries no orientation information; must not invent an angle.
  const gray = new Uint8Array(200 * 200).fill(250);
  check('blank page yields no skew', JS.skewFromGray(gray, 200, 200) === 0);
}

{
  // The same, on input that gets far enough to be dangerous. Uniform noise
  // passes the ink-fraction gate and reaches the search, where it meets the
  // score's second way to rise, unrelated to alignment: rotating further swings
  // ink out of the frame, and discarding ink raises the variance of what is
  // left. With no text lines to align, that drift is the only structure there
  // is, so the maximum walks outward to the edge of the scan — and the fine
  // scan used `best` as its own loop bound, so it walked on past the edge.
  // Measured before the guards, this buffer was given -15.0°: a full-scale
  // rotation, at the clamp, from a frame with nothing in it to level.
  const w = 320, h = 320;
  const gray = new Uint8Array(w * h);
  let seed = 12345;
  for (let i = 0; i < gray.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    gray[i] = (seed >> 16) & 255;
  }

  check('a frame with no orientation gets no angle',
    JS.skewFromGray(gray, w, h) === 0, 'got ' + JS.skewFromGray(gray, w, h));

  const old = detectorWithoutGuards().skewFromGray(gray, w, h);
  check('without the guards it is given a full-scale rotation', Math.abs(old) > 10,
    'got ' + old.toFixed(2) + '°');
}

{
  // The failure the four reported photos had, reduced to a buffer. Ink that is
  // one large round mass projects to nearly the same profile at every angle, so
  // it flattens the curve; the faint lines inside it give that flat curve a
  // slight lean, and the maximum settles on the lean rather than on alignment.
  // This is what made an upright receipt come back at -10.2°: the winning angle
  // is not evidence of anything, because the score never collapses anywhere.
  // The lines here really are tilted 8° — but they are weak evidence inside a
  // large flat mass, and acting on them is what the guard declines to do.
  const w = 320, h = 320, R = 100, pitch = 18, thick = 6;
  const cx = w / 2, cy = h / 2, tan = Math.tan(8 * Math.PI / 180);
  const gray = new Uint8Array(w * h).fill(248);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > R * R) continue;
      let m = (y - x * tan) % pitch;
      if (m < 0) m += pitch;
      gray[y * w + x] = m < thick ? 30 : 40;
    }
  }

  check('a curve with no alignment peak in it gets no angle',
    JS.skewFromGray(gray, w, h) === 0, 'got ' + JS.skewFromGray(gray, w, h));

  const before = skewWithoutPeakGuard().skewFromGray(gray, w, h);
  check('without the peak guard the same frame is rotated 14 degrees',
    Math.abs(before) >= 10, 'got ' + before.toFixed(2) + '°');
}

/* ================= 5. rotation ================= */
console.log('\nrotation');

{
  // rotateCoarse needs no canvas: corners are normalised and the cache clear
  // is just bookkeeping.
  const page = { coarse: 0, corners: [{ x: 0.25, y: 0.10 }, { x: 0.75, y: 0.10 },
                                      { x: 0.75, y: 0.90 }, { x: 0.25, y: 0.90 }],
                 _rects: {}, _thumb: null, _thumbKey: '' };

  JS.rotateCoarse(page, 1);
  check('clockwise rotation advances the angle', page.coarse === 90);
  // Content in the top-left must end up top-right after a clockwise turn — and
  // because the list is re-indexed to keep index 0 at the top-left, that corner
  // is now at index 1, not index 0. Asserting index 0 here is what let the
  // transposing bug live: it pinned the cyclic shift as if it were the contract.
  check('top-left content moves to the top-right',
    near(page.corners[1].x, 0.90, 1e-9) && near(page.corners[1].y, 0.25, 1e-9),
    'got ' + page.corners[1].x + ',' + page.corners[1].y);

  JS.rotateCoarse(page, 1);
  JS.rotateCoarse(page, 1);
  JS.rotateCoarse(page, 1);
  check('four turns return to the start', page.coarse === 0);
  check('four turns restore the corners',
    near(page.corners[0].x, 0.25, 1e-9) && near(page.corners[0].y, 0.10, 1e-9));

  // Anticlockwise must be the exact inverse of clockwise.
  const before = page.corners.map((p) => ({ x: p.x, y: p.y }));
  JS.rotateCoarse(page, -1);
  JS.rotateCoarse(page, 1);
  check('anticlockwise undoes clockwise',
    page.corners.every((p, i) => near(p.x, before[i].x, 1e-9) && near(p.y, before[i].y, 1e-9)));

  // A quad spanning the full frame must stay spanning the full frame.
  const full = { coarse: 0, corners: null, _rects: {}, _thumb: null, _thumbKey: '' };
  JS.rotateCoarse(full, 1);
  const area = JS.quadArea(full.corners);
  check('a full-frame quad still covers the frame after rotating', near(area, 1, 1e-9),
    'area=' + area);
}

/* ================= 6. oriented layout ================= */
console.log('\noriented layout');

{
  // The canvas takes the rotated dimensions; the source must be drawn at its
  // own aspect ratio. Drawing it into the swapped width/height stretches the
  // page and clips it — which is what broke rotate-after-crop.
  const shapes = [
    { w: 1000, h: 2000 },   // portrait
    { w: 2000, h: 1000 },   // landscape
    { w: 1200, h: 1200 },   // square
    { w: 3000, h: 4000 }    // large portrait, forced through the scale cap
  ];

  for (const { w, h } of shapes) {
    for (const coarse of [0, 90, 180, 270]) {
      const page = { w, h, coarse };
      const L = JS.orientedLayout(page, 900);
      const label = `${w}x${h} @${coarse}°`;

      // The source keeps its aspect ratio at every angle.
      const srcAspect = L.drawW / L.drawH;
      if (!near(srcAspect, w / h, 1e-9)) {
        check(`source keeps its aspect ${label}`, false,
          `got ${srcAspect.toFixed(4)} want ${(w / h).toFixed(4)}`);
      } else {
        check(`source keeps its aspect ${label}`, true);
      }

      // Rotating the drawn rect by the coarse angle must land exactly on the
      // canvas, with no overflow and no gap.
      const rad = coarse * Math.PI / 180;
      const cs = Math.cos(rad), sn = Math.sin(rad);
      const cx = [L.drawX, L.drawX + L.drawW, L.drawX + L.drawW, L.drawX];
      const cy = [L.drawY, L.drawY, L.drawY + L.drawH, L.drawY + L.drawH];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < 4; i++) {
        const rx = cx[i] * cs - cy[i] * sn;
        const ry = cx[i] * sn + cy[i] * cs;
        minX = Math.min(minX, rx); maxX = Math.max(maxX, rx);
        minY = Math.min(minY, ry); maxY = Math.max(maxY, ry);
      }
      const fits = near(maxX - minX, L.canvasW, 1) && near(maxY - minY, L.canvasH, 1) &&
                   near(minX, -L.canvasW / 2, 1) && near(minY, -L.canvasH / 2, 1);
      check(`rotated source fills the canvas ${label}`, fits,
        `box ${(maxX - minX).toFixed(0)}x${(maxY - minY).toFixed(0)} ` +
        `canvas ${L.canvasW}x${L.canvasH}`);
    }
  }

  // The scale cap must still be honoured on the long edge.
  const big = JS.orientedLayout({ w: 3000, h: 4000, coarse: 0 }, 900);
  check('long edge is capped', big.canvasW === 675 && big.canvasH === 900,
    `${big.canvasW}x${big.canvasH}`);
  const bigRot = JS.orientedLayout({ w: 3000, h: 4000, coarse: 90 }, 900);
  check('cap applies after rotation too', bigRot.canvasW === 900 && bigRot.canvasH === 675,
    `${bigRot.canvasW}x${bigRot.canvasH}`);

  // A small image must not be upscaled past 1:1.
  const small = JS.orientedLayout({ w: 400, h: 300, coarse: 0 }, 2400);
  check('small images are not upscaled', small.canvasW === 400 && small.canvasH === 300,
    `${small.canvasW}x${small.canvasH}`);
}

/* ============ 5b. rectify output size ============ */
console.log('\nrectify sizing');

{
  // A page shot at an angle has a near edge that measures longer than the far
  // one. Sizing the output to the longer edge keeps that difference as a
  // permanent stretch; the average splits it, which is what squaring the page
  // to the camera looks like.
  //
  // Corners are normalised, and the source is 400x400, so oc coordinates are
  // just the fraction times 400. Expected sizes below are worked out by hand
  // from the corner geometry rather than read back off the implementation.
  const src = { width: 400, height: 400 };
  const mk = (corners) => {
    const p = JS.createPage(src, 400, 400, 'p');
    p.corners = corners;
    return p;
  };

  // Full frame: nothing to warp, so the buffer must pass through untouched.
  const full = JS.rectify(mk(null), 2400);
  check('a full-frame quad is left at its own size', full.width === 400 && full.height === 400,
    `${full.width}x${full.height}`);

  // TL(100,0) TR(300,0) BR(400,400) BL(0,400):
  //   top 200, bottom 400 -> width  (200+400)/2 = 300   (max would be 400)
  //   left = right = hypot(100,400) = 412.31 -> height 412
  const trap = mk([{ x: 0.25, y: 0 }, { x: 0.75, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
  const out = JS.rectify(trap, 2400);
  check('opposite sides are averaged, not maximised',
    out.width === 300 && out.height === 412,
    `${out.width}x${out.height} want 300x412 (max would give 400x412)`);

  // The same trapezoid a quarter turn round, so the vertical pair is the one
  // that differs. TL(0,0) TR(400,100) BR(400,300) BL(0,400):
  //   left 400, right 200 -> height (400+200)/2 = 300   (max would be 400)
  //   top = bottom = hypot(400,100) = 412.31 -> width 412
  const trap2 = mk([{ x: 0, y: 0 }, { x: 1, y: 0.25 }, { x: 1, y: 0.75 }, { x: 0, y: 1 }]);
  const out2 = JS.rectify(trap2, 2400);
  check('the vertical pair is averaged too',
    out2.width === 412 && out2.height === 300,
    `${out2.width}x${out2.height} want 412x300 (max would give 412x400)`);

  // The cap still applies to the longest edge, and only to it.
  const capped = JS.rectify(trap, 100);
  check('the longest edge is capped at maxDim',
    Math.max(capped.width, capped.height) === 100,
    `${capped.width}x${capped.height}`);
  check('the short edge keeps its proportion through the cap',
    near(capped.height / capped.width, 412.31 / 300, 0.02),
    `aspect ${(capped.height / capped.width).toFixed(3)} want ${(412.31 / 300).toFixed(3)}`);

  // Nothing is ever upscaled past the oriented buffer.
  const small2 = JS.rectify(mk([{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.25 },
                                { x: 0.75, y: 0.75 }, { x: 0.25, y: 0.75 }]), 2400);
  check('a small quad is not upscaled', small2.width === 200 && small2.height === 200,
    `${small2.width}x${small2.height}`);
}

/* ============ 5d. the manual crop ============ */
console.log('\nmanual crop');

{
  // Which quads a drag is allowed to leave behind. The three ways one goes bad
  // are all the same question about winding, and the middle one is the reason
  // this is a check rather than a guard nobody looks at: a folded quad is not a
  // crash and not obviously a bug — it is a page with a mirrored wedge in it.
  const square = [{ x: .2, y: .2 }, { x: .8, y: .2 }, { x: .8, y: .8 }, { x: .2, y: .8 }];
  check('a plain rectangle is a crop', JS.quadOk(square));

  const ccw = [{ x: .2, y: .2 }, { x: .2, y: .8 }, { x: .8, y: .8 }, { x: .8, y: .2 }];
  check('and so is the same rectangle wound the other way', JS.quadOk(ccw));

  // Corner 0 pulled past corner 1, so the outline crosses.
  const bowtie = [{ x: .9, y: .2 }, { x: .2, y: .2 }, { x: .8, y: .8 }, { x: .2, y: .8 }];
  check('a crossed quad is refused', !JS.quadOk(bowtie));

  // Corner 0 pulled inside the triangle of the other three.
  const folded = [{ x: .6, y: .6 }, { x: .8, y: .2 }, { x: .8, y: .8 }, { x: .2, y: .8 }];
  check('a quad folded in on itself is refused', !JS.quadOk(folded));

  // Two corners on top of each other: no edge left to size the output from.
  const sliver = [{ x: .2, y: .2 }, { x: .21, y: .2 }, { x: .8, y: .8 }, { x: .2, y: .8 }];
  check('a quad with no edge left is refused', !JS.quadOk(sliver));

  const flat = [{ x: .2, y: .2 }, { x: .5, y: .5 }, { x: .8, y: .8 }, { x: .2, y: .8 }];
  check('and one with three corners in a line', !JS.quadOk(flat));

  const outside = [{ x: -.05, y: .2 }, { x: .8, y: .2 }, { x: .8, y: .8 }, { x: .2, y: .8 }];
  check('a corner dragged off the photo is refused', !JS.quadOk(outside));
}

{
  // The map a handle drag is inverted through: from a point on the finished page
  // back to a corner of the photo. Its four ends are the whole contract — the
  // corners of what the preview shows are the corners of the crop — and it has
  // to hold with a fine angle in play, because `rectify` folds that into the
  // quad and `page.corners` does not carry it. That mismatch is the one that
  // would put a corner up to 15° from the finger after an Auto crop.
  const corners = [{ x: .2, y: .1 }, { x: .85, y: .05 }, { x: .9, y: .8 }, { x: .15, y: .95 }];
  const mk = (fine) => {
    const p = JS.createPage({ width: 400, height: 600 }, 400, 600, 'c');
    p.corners = corners;
    p.fine = fine;
    return p;
  };
  const ends = (fine) => {
    const m = JS.cropMapper(mk(fine));
    return [m(0, 0), m(1, 0), m(1, 1), m(0, 1)];
  };

  for (const fine of [0, 8, -11.5]) {
    const got = ends(fine);
    check(`the map sends the page's corners to the crop's corners, at fine ${fine}`,
      got.every((p, i) => near(p.x, corners[i].x, 1e-9) && near(p.y, corners[i].y, 1e-9)),
      JSON.stringify(got.map((p) => [+p.x.toFixed(4), +p.y.toFixed(4)])));
  }

  // The ends alone would also be satisfied by three other maps. The interior is
  // where they part company, and there is one point inside the page whose
  // position is known without the map: the crossing of the quad's diagonals.
  // A projective map carries lines to lines, so the middle of the output is
  // wherever the two diagonals of the quad cross — built here from the four
  // corners, so this cannot agree with the implementation by construction.
  const cr = (a, b) => a.x * b.y - a.y * b.x;
  const q0 = corners[0], q1 = corners[1];
  const d1 = { x: corners[2].x - q0.x, y: corners[2].y - q0.y };
  const d2 = { x: corners[3].x - q1.x, y: corners[3].y - q1.y };
  const r = { x: q1.x - q0.x, y: q1.y - q0.y };
  const t = cr(r, d2) / cr(d1, d2);
  const diag = { x: q0.x + d1.x * t, y: q0.y + d1.y * t };

  for (const fine of [0, 8]) {
    const mid = JS.cropMapper(mk(fine))(0.5, 0.5);
    check(`the middle of the page is the crossing of the quad's diagonals, at fine ${fine}`,
      near(mid.x, diag.x, 1e-9) && near(mid.y, diag.y, 1e-9),
      `${mid.x.toFixed(6)},${mid.y.toFixed(6)} want ${diag.x.toFixed(6)},${diag.y.toFixed(6)}`);
  }
}

{
  // The frame is pinned for the length of a drag. The handles sit on the corners
  // of the box the preview is drawn in and the box is sized from the output, so
  // an output that followed the quad would move the corner out from under the
  // finger dragging it. Same quad, two pins, two shapes — and the longest edge
  // still decides the resolution, so pinning costs no sharpness.
  const mk = () => {
    const p = JS.createPage({ width: 400, height: 400 }, 400, 400, 'p');
    p.corners = [{ x: .1, y: .1 }, { x: .9, y: .1 }, { x: .9, y: .9 }, { x: .1, y: .9 }];
    return p;
  };
  const free = JS.rectify(mk(), 900);
  JS.cropPin = 0.5;
  let pinned;
  try {
    pinned = JS.rectify(mk(), 900);
  } finally {
    JS.cropPin = 0;
  }
  check('the free render is the shape the quad actually is',
    near(free.width / free.height, 1, 0.01), `${free.width}x${free.height}`);
  check('a pinned render holds the frame at the shape it was pinned at',
    near(pinned.width / pinned.height, 0.5, 0.01), `${pinned.width}x${pinned.height}`);
  check('and the long edge is still the long edge, so nothing is lost to the pin',
    Math.max(pinned.width, pinned.height) === Math.max(free.width, free.height),
    `${pinned.width}x${pinned.height} against ${free.width}x${free.height}`);
  check('the pin is part of the buffer cache key',
    JS.rectify(mk(), 900).width === free.width,
    'a stale pinned buffer was served for an unpinned render');
}

/* ============ 5c. the preview letterbox (fitBox) ============ */
console.log('\npreview letterbox');

{
  // The preview draws the finished page into the stage through this, and its
  // rect is what the canvas is sized and positioned from. Get the centring
  // wrong and the page sits off-centre or stretches.
  const wide = JS.fitBox(200, 200, 400, 100);      // landscape page in a square
  check('a wide page letterboxes top and bottom',
    wide.w === 200 && wide.h === 50 && wide.x === 0 && wide.y === 75,
    JSON.stringify(wide));

  const tall = JS.fitBox(200, 200, 100, 400);      // portrait page
  check('a tall page letterboxes left and right',
    tall.w === 50 && tall.h === 200 && tall.x === 75 && tall.y === 0,
    JSON.stringify(tall));

  // The aspect ratio must survive, in both orientations and at odd sizes.
  let worstAspect = 0;
  for (const [bw, bh, sw, sh] of [[200, 200, 400, 100], [200, 200, 100, 400],
                                  [317, 211, 1600, 1200], [91, 733, 2400, 3157]]) {
    const f = JS.fitBox(bw, bh, sw, sh);
    worstAspect = Math.max(worstAspect, Math.abs(f.w / f.h - sw / sh));
  }
  check('the fitted rect keeps the page aspect ratio', worstAspect < 0.02,
    `worst aspect error ${worstAspect}`);

  check('the fitted image never exceeds its box',
    wide.w <= 200 && wide.h <= 200 && tall.w <= 200 && tall.h <= 200);

  // Degenerate input must not produce NaN extents: assigning NaN to
  // canvas.width throws, so a zero-sized source would take the editor down
  // instead of just showing nothing.
  const bad = JS.fitBox(200, 200, 0, 0);
  check('a zero-sized source yields finite geometry',
    isFinite(bad.x) && isFinite(bad.y) && isFinite(bad.w) && isFinite(bad.h) && bad.scale === 0,
    JSON.stringify(bad));
  const badBox = JS.fitBox(0, 0, 100, 100);
  check('a zero-sized box yields finite geometry',
    isFinite(badBox.x) && isFinite(badBox.y) && badBox.scale === 0,
    JSON.stringify(badBox));
}

/* ============ 5d. the view — pinch zoom, pan, and the corner grab ========= */

/* All of this is arithmetic on four numbers, so it is checked here rather than
   through a browser: the layout it runs on is only ever the input, never part of
   the answer. The numbers below are a real receipt on a 375x667 phone — stage
   client box 353x494, page fitted to 266x472 and shifted out of the 11px handle
   reservation, so `fit` is the rectangle the crop handles are drawn on. */
console.log('\nthe view');

{
  const FIT = { x: 43.5, y: 11, w: 266, h: 472 };
  const ID = JS.viewIdentity;

  check('the view starts fitted, with no offset',
    ID().z === 1 && ID().tx === 0 && ID().ty === 0, JSON.stringify(ID()));

  // Screen and stage are inverses; every drag in the editor divides by z and
  // every handle is placed by multiplying, so a mismatch here is a systematic
  // offset in the crop that no amount of dragging removes.
  {
    const v = { z: 2.5, tx: -180.25, ty: 40 };
    let worst = 0;
    for (const [x, y] of [[0, 0], [123.5, 456.75], [-40, 900]]) {
      const s = JS.viewToScreen(v, x, y);
      const b = JS.viewToStage(v, s.x, s.y);
      worst = Math.max(worst, Math.abs(b.x - x), Math.abs(b.y - y));
    }
    check('viewToStage inverts viewToScreen', worst < 1e-9, `worst ${worst}`);
  }

  // Panning is at screen speed: the page follows the finger exactly, at any
  // zoom. Panning in stage units instead would make the page crawl at 1/z.
  {
    const fast = JS.viewPan({ z: 3, tx: 10, ty: -5 }, 40, -25);
    check('a pan moves the view by the screen delta it was given',
      fast.z === 3 && fast.tx === 50 && fast.ty === -30, JSON.stringify(fast));
  }

  // A pinch is about a point and holds it still — the pixel between the fingers
  // must not slide, which is the whole feel of the gesture.
  {
    const at = { x: 120, y: 300 };
    const z = JS.viewZoomAt(ID(), at.x, at.y, 2.5);
    const back = JS.viewToScreen(z, ...Object.values(JS.viewToStage(z, at.x, at.y)));
    check('zooming holds the point it is centred on',
      near(z.z, 2.5) && near(back.x, at.x, 1e-9) && near(back.y, at.y, 1e-9),
      JSON.stringify(z));
  }

  // The bounds are load-bearing in both directions. Below 1 there is no view of
  // a page that is already fitted; above VIEW_MAX the preview is being upscaled
  // past the pixels it was rendered from, so it is a magnifying glass over mush.
  {
    let lo = ID(), hi = ID();
    for (let i = 0; i < 40; i++) { lo = JS.viewZoomAt(lo, 0, 0, 0.5); }
    for (let i = 0; i < 40; i++) { hi = JS.viewZoomAt(hi, 0, 0, 2); }
    check('zooming out stops at the fitted view', near(lo.z, JS.VIEW_MIN), `${lo.z}`);
    check('zooming in stops at VIEW_MAX', near(hi.z, JS.VIEW_MAX), `${hi.z}`);
  }

  // At fit zoom there is exactly one view and the clamp returns it, so a stray
  // touch on an unzoomed page cannot nudge it off-centre with no way back.
  {
    let worst = 0;
    for (const [dx, dy] of [[60, 40], [-300, -900], [4, -7], [1e6, -1e6]]) {
      const c = JS.viewClamp(JS.viewPan(ID(), dx, dy), FIT);
      worst = Math.max(worst, Math.abs(c.z - 1), Math.abs(c.tx), Math.abs(c.ty));
    }
    check('a pan at fit zoom cannot move the page', worst === 0, `worst ${worst}`);
  }

  // Whatever pan the clamp lets through, the page's own centre stays inside the
  // rectangle it was fitted in. That is the whole guarantee: there is no
  // scrollbar and no reset button, so a view that showed no page would be a
  // blank editor whose only way home is a pinch nobody would think to try.
  {
    let worst = 0, emptiest = 1;
    for (const z of [1.02, 1.1, 1.33, 1.5, 2, 3, 4, 6]) {
      for (const [u, v] of [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]]) {
        const c = JS.viewClamp(
          JS.viewZoomAt(ID(), FIT.x + u * FIT.w, FIT.y + v * FIT.h, z), FIT);
        const cx = (FIT.x + FIT.w / 2) * c.z + c.tx, cy = (FIT.y + FIT.h / 2) * c.z + c.ty;
        worst = Math.max(worst, FIT.x - cx, cx - (FIT.x + FIT.w),
                                FIT.y - cy, cy - (FIT.y + FIT.h));
        // And how much page is still on screen, as a fraction of the stage.
        const l = FIT.x * c.z + c.tx, t = FIT.y * c.z + c.ty;
        const r = (FIT.x + FIT.w) * c.z + c.tx, b = (FIT.y + FIT.h) * c.z + c.ty;
        emptiest = Math.min(emptiest,
          (Math.min(r, 353) - Math.max(l, 0)) / 353 * (Math.min(b, 494) - Math.max(t, 0)) / 494);
      }
    }
    check('no allowed view puts the page centre off the fitted rect', worst <= 1e-9,
      `worst ${worst}`);
    // This is the price of the looser rule, and it has to stay small: it is only
    // paid just above fit zoom, and even there it shows more page than the
    // fitted view's own letterboxing does.
    check('no allowed view empties the stage', emptiest > 0.70, `emptiest ${emptiest}`);
  }

  // The corner grab. Taking hold of a handle zooms onto it, and the point that
  // must not move is the corner itself — it is where the finger is, so a corner
  // that drifts is a dot that jumps out from under the thumb that grabbed it and
  // then travels at a speed the finger is not moving at. This is exact, not
  // approximate: `viewZoomAt` puts the corner at tx = -corner, and the clamp's
  // bound is that same value, so the clamp returns what it was given.
  for (const [i, name] of ['TL', 'TR', 'BR', 'BL'].entries()) {
    const hx = FIT.x + (i === 1 || i === 2 ? FIT.w : 0);
    const hy = FIT.y + (i >= 2 ? FIT.h : 0);
    const at = JS.viewToScreen(ID(), hx, hy);
    const z = JS.viewClamp(JS.viewZoomAt(ID(), at.x, at.y, 2), FIT);
    const now = JS.viewToScreen(z, hx, hy);
    check(`grabbing the ${name} corner leaves it under the finger`,
      near(z.z, 2) && near(now.x, at.x, 1e-9) && near(now.y, at.y, 1e-9),
      `${name} moved to ${now.x.toFixed(3)},${now.y.toFixed(3)} from ${at.x},${at.y}`);
  }

  // And a grab when already zoomed in past the corner zoom does not zoom back
  // out — the caller asks for `max(view.z, CORNER_ZOOM)`, so this is the floor
  // being checked, and the view it returns is the one it was handed.
  {
    const deep = JS.viewClamp(JS.viewZoomAt(ID(), 176, 247, 5), FIT);
    const same = JS.viewClamp(JS.viewZoomAt(deep, 100, 100, 1), FIT);
    check('a corner grab never zooms back out', near(same.z, 5) &&
      near(same.tx, deep.tx) && near(same.ty, deep.ty),
      `${same.z} vs ${deep.z}`);
  }

  // A degenerate fit (no page, no layout) must not throw or return NaN: the
  // clamp runs on every gesture and on every resize.
  {
    const c = JS.viewClamp({ z: 3, tx: 10, ty: 10 }, null);
    check('clamping with no fit yields the identity view',
      c.z === 1 && c.tx === 0 && c.ty === 0, JSON.stringify(c));
  }
}

{
  // Rotating does two things at once and the second is easy to forget: move
  // each corner, and re-index the list so it still reads [TL,TR,BR,BL] in the
  // new frame. `rectify` sizes its output from edge (q0,q1) as the width and
  // (q0,q3) as the height, which is only true while index 0 is the top-left. A
  // list that is cyclically shifted swaps those two, and the page comes out
  // transposed — the content turns but the frame does not, which is exactly
  // what "the rotate button does nothing" looks like.
  // A real page object with a stub source, so rectify can run end to end.
  function blank() {
    return JS.createPage({ width: 1000, height: 2000 }, 1000, 2000, 'rot');
  }

  // 1. The ordering survives the turn. A full-frame page must still be the
  //    full frame, corner for corner.
  const frame = blank();
  JS.rotateCoarse(frame, 1);
  const wantTL = [[0, 0], [1, 0], [1, 1], [0, 1]];
  let worstSlot = 0;
  for (let i = 0; i < 4; i++) {
    worstSlot = Math.max(worstSlot,
      Math.abs(frame.corners[i].x - wantTL[i][0]),
      Math.abs(frame.corners[i].y - wantTL[i][1]));
  }
  check('a rotated full-frame quad is still [TL,TR,BR,BL]', worstSlot < 1e-9,
    `worst slot error ${worstSlot} — corners ${JSON.stringify(frame.corners)}`);

  // ...and the same going the other way, so the offset is not just tuned for
  // one direction.
  const frameL = blank();
  JS.rotateCoarse(frameL, -1);
  let worstSlotL = 0;
  for (let i = 0; i < 4; i++) {
    worstSlotL = Math.max(worstSlotL,
      Math.abs(frameL.corners[i].x - wantTL[i][0]),
      Math.abs(frameL.corners[i].y - wantTL[i][1]));
  }
  check('and so is one rotated the other way', worstSlotL < 1e-9,
    `worst slot error ${worstSlotL} — corners ${JSON.stringify(frameL.corners)}`);

  // 2. The user-visible consequence: the output frame swaps with the page. This
  //    is the assertion the transposed version fails, because both edges of a
  //    quarter-turned page are perpendicular and only their roles have moved.
  const rp = blank();
  const upright = JS.rectify(rp, 900);
  JS.rotateCoarse(rp, 1);
  const turned = JS.rectify(rp, 900);
  check('rotating a page turns the output frame with it',
    turned.width === upright.height && turned.height === upright.width &&
    upright.width !== upright.height,
    `${upright.width}x${upright.height} -> ${turned.width}x${turned.height}`);

  // 3. The content still tracks. The corner that was at index 0 has moved to
  //    index 1 (dir > 0), at the rotated position — the old test asserted index
  //    0 still held it, which is the very bug being fixed here.
  const page = blank();
  const before = { x: 0.25, y: 0.10 };              // 25% across, 10% down
  const L0 = JS.orientedLayout(page, 900);
  const px0 = { x: L0.drawX + before.x * L0.drawW, y: L0.drawY + before.y * L0.drawH };
  page.corners = [{ x: before.x, y: before.y }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  JS.rotateCoarse(page, 1);

  const L1 = JS.orientedLayout(page, 900);
  const rx = -px0.y, ry = px0.x;                    // +90° about the origin
  const expectX = (rx + L1.canvasW / 2) / L1.canvasW;
  const expectY = (ry + L1.canvasH / 2) / L1.canvasH;
  const moved = page.corners[1];
  check('rotated corner tracks the same content',
    near(moved.x, expectX, 1e-6) && near(moved.y, expectY, 1e-6),
    `got ${moved.x.toFixed(4)},${moved.y.toFixed(4)} ` +
    `want ${expectX.toFixed(4)},${expectY.toFixed(4)}`);
}

/* ================= 7. commit contract ================= */
console.log('\ncommit ("Done")');

{
  // What commitPage leaves behind: nothing pending, so the pipeline must be a
  // no-op. If this drifts, every page the user finished gets its tone applied a
  // second time — the failure mode that makes baking look like it did nothing.
  // Read from the same constant commitPage uses, so the two cannot diverge.
  function committedPage() {
    const p = JS.createPage({ width: 400, height: 600 }, 400, 600, 'x');
    p.coarse = 0;
    p.fine = 0;
    p.corners = null;
    p.mode = 'original';
    p.adj = Object.assign({}, JS.COMMITTED_ADJ);
    p.bakedMode = 'bw';
    p._bakedKey = JS.stateKey(p);
    return p;
  }

  const page = committedPage();
  check('a freshly committed page reads as committed', JS.isCommitted(page));

  // The tone stage must return without ever reading pixels back. `enhance`
  // draws onto a fresh canvas and returns it, so the returned canvas is what
  // carries the evidence — inspecting the *input* context proves nothing.
  const rect = JS.makeCanvas(60, 40, true);
  const out = JS.enhance(rect, page, 900);
  const calls = JS.ctx2d(out, true).calls;
  check('committed page skips the tone pixel pass',
    calls.getImageData === 0 && calls.putImageData === 0,
    `getImageData=${calls.getImageData} putImageData=${calls.putImageData}`);
  check('committed page still returns a canvas of the same size',
    out.width === 60 && out.height === 40, `${out.width}x${out.height}`);
}

{
  // Every mutation must invalidate committed-ness on its own. This is why the
  // test is a state signature and not a boolean: no mutating code path has to
  // remember to clear a flag.
  function fresh() {
    const p = JS.createPage({ width: 400, height: 600 }, 400, 600, 'x');
    p.mode = 'original';
    p.adj = Object.assign({}, JS.COMMITTED_ADJ);
    p._bakedKey = JS.stateKey(p);
    return p;
  }

  const mutations = [
    ['rotate', (p) => { p.coarse = 90; }],
    ['de-skew', (p) => { p.fine = -1.5; }],
    ['crop', (p) => { p.corners = JS.rectCorners01(); }],
    ['mode', (p) => { p.mode = 'bw'; }],
    ['brightness', (p) => { p.adj.bright = 8; }],
    ['contrast', (p) => { p.adj.contrast = -5; }],
    ['white balance', (p) => { p.adj.wb = 30; }],
    ['saturation', (p) => { p.adj.sat = 12; }],
    ['warmth', (p) => { p.adj.warmth = 20; }],
    ['shadow removal', (p) => { p.adj.flat = 60; }],
    ['text weight', (p) => { p.adj.thr = 4; }],
    ['sharpness', (p) => { p.adj.sharp = 25; }]
  ];

  // A slider nobody told stateKey about must still clear the badge.
  mutations.push(['an unknown future slider', (p) => { p.adj.vibrance = 5; }]);

  for (const [name, mutate] of mutations) {
    const p = fresh();
    mutate(p);
    check(`"${name}" clears the committed badge`, !JS.isCommitted(p));
  }

  // Changing the crop must not be masked by the key's rounding.
  const p1 = fresh();
  p1.corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  p1._bakedKey = JS.stateKey(p1);
  p1.corners[0] = { x: 0.001, y: 0 };
  check('a one-thousandth crop nudge is noticed', !JS.isCommitted(p1));

  // And the reverse: an untouched committed page must not spontaneously unset.
  const p2 = fresh();
  check('an untouched committed page stays committed', JS.isCommitted(p2));
}

{
  // `original` still honours the manual sliders, so the controls are not dead
  // on the page a user just committed.
  const p = JS.createPage({ width: 60, height: 40 }, 60, 40, 'x');
  p.mode = 'original';
  p.adj = { bright: 0, contrast: 30, wb: 0, sat: 0, warmth: 0, flat: 0, thr: 0, sharp: 0 };
  const rect = JS.makeCanvas(60, 40, true);
  const out = JS.enhance(rect, p, 900);
  check('original mode still applies manual sliders',
    JS.ctx2d(out, true).calls.putImageData === 1,
    `putImageData=${JS.ctx2d(out, true).calls.putImageData}`);
  // `wb` and `thr` are consumed only by the automatic passes that `original`
  // skips, so on their own they still cost nothing. `flat` is not: shadow
  // removal runs in every mode, so a live flat slider must defeat the fast path
  // — otherwise the one control the user asked for by name would silently do
  // nothing in the mode a committed page lives in.
  check('manualNeutral ignores the auto-only sliders', !JS.manualNeutral(p.adj) &&
    JS.manualNeutral({ bright: 0, contrast: 0, wb: 70, sat: 0, warmth: 0, flat: 0, thr: 40, sharp: 0 }));
  check('manualNeutral counts shadow removal as live',
    !JS.manualNeutral({ bright: 0, contrast: 0, wb: 0, sat: 0, warmth: 0, flat: 45, thr: 0, sharp: 0 }));
}

{
  // Shadow removal has to reach the continuous-tone modes, which is where the
  // user saw shadows survive: colour and greyscale are the modes a page of text
  // on paper is normally shot in.
  const w = 40, h = 40;
  const rect = JS.makeCanvas(w, h, true);
  const g0 = JS.ctx2d(rect, true);
  // Left half in shadow, right half lit; both carrying the same red ink.
  const img = g0.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const lit = x >= w / 2;
      const o = (y * w + x) * 4;
      const paper = lit ? 235 : 110;
      img.data[o] = paper; img.data[o + 1] = paper; img.data[o + 2] = paper;
      img.data[o + 3] = 255;
    }
  }
  // A red stamp on each half, at the same ink strength.
  for (let y = 18; y < 22; y++) {
    for (let x = 6; x < 10; x++) {
      const o = (y * w + x) * 4;
      img.data[o] = 150; img.data[o + 1] = 40; img.data[o + 2] = 40;
    }
    for (let x = 26; x < 30; x++) {
      const o = (y * w + x) * 4;
      img.data[o] = 150; img.data[o + 1] = 40; img.data[o + 2] = 40;
    }
  }
  g0.putImageData(img, 0, 0);

  const page = JS.createPage({ width: w, height: h }, w, h, 'shadow');
  page.mode = 'auto';
  page.adj = { bright: 0, contrast: 0, wb: 0, sat: 0, warmth: 0, flat: 100, thr: 0, sharp: 0 };
  const out = JS.enhance(rect, page, 900);
  const read = (canvas) => JS.ctx2d(canvas, true).getImageData(0, 0, w, h).data;
  const px = (d, x, y) => {
    const o = (y * w + x) * 4;
    return [d[o], d[o + 1], d[o + 2]];
  };
  const before = read(rect), after = read(out);

  const shadowPaperBefore = px(before, 4, 4), shadowPaperAfter = px(after, 4, 4);
  const litPaperAfter = px(after, 34, 4)[0];

  check('shadow removal lifts the shadowed paper',
    shadowPaperAfter[0] > shadowPaperBefore[0] + 60,
    `${shadowPaperBefore[0]} -> ${shadowPaperAfter[0]}`);
  check('shadow removal brings the two halves level',
    Math.abs(shadowPaperAfter[0] - litPaperAfter) < 30,
    `shadow ${shadowPaperAfter[0]} vs lit ${litPaperAfter}`);

  // The stamp must stay red — dividing per channel by its own background would
  // have flattened it towards grey along with the shadow.
  const stamp = px(after, 8, 20);
  check('the ink keeps its colour through the flatten',
    stamp[0] > stamp[1] * 1.8 && stamp[0] > stamp[2] * 1.8,
    `rgb(${stamp.join(',')})`);

  // A solid dark block must not be blown out to white by its own background
  // estimate — the gain cap, the colour-mode counterpart of the threshold floor.
  const w2 = 40, h2 = 40;
  const rect2 = JS.makeCanvas(w2, h2, true);
  const g2 = JS.ctx2d(rect2, true);
  const img2 = g2.createImageData(w2, h2);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const o = (y * w2 + x) * 4;
      const inside = x >= 8 && x < 32 && y >= 8 && y < 32;
      const v = inside ? 12 : 240;
      img2.data[o] = v; img2.data[o + 1] = v; img2.data[o + 2] = v; img2.data[o + 3] = 255;
    }
  }
  g2.putImageData(img2, 0, 0);
  const page2 = JS.createPage({ width: w2, height: h2 }, w2, h2, 'block');
  page2.mode = 'auto';
  page2.adj = { bright: 0, contrast: 0, wb: 0, sat: 0, warmth: 0, flat: 100, thr: 0, sharp: 0 };
  const after2 = read(JS.enhance(rect2, page2, 900));
  const blockCenter = px(after2, 20, 20)[0];
  check('a solid dark block survives the flatten', blockCenter < 90,
    `centre ${blockCenter} (was 12, would be 255 uncapped)`);
}

/* ============ 7b. sharpen, and the paper white balance ============ */
console.log('\nsharpen');

{
  // The radius has to follow the buffer, or the export is sharpened on a
  // different scale from the preview that was tuned by eye. See JS.SHARP_RADIUS_DIV.
  const r = (w, h) => JS.unsharpRadius(w, h);
  const long = (w, h) => Math.max(w, h);
  const sizes = [[900, 1200], [1800, 2400], [3600, 4800], [700, 500]];
  check('the sharpen radius is a fixed fraction of the long edge, rounded',
    sizes.every(([w, h]) => r(w, h) === Math.max(1, Math.round(long(w, h) / 450))),
    sizes.map(([w, h]) => `${w}x${h} -> ${r(w, h)}`).join(', '));
  check('and never collapses to nothing on a thumbnail',
    r(260, 260) === 1 && r(40, 40) === 1,
    `260 -> ${r(260, 260)}, 40 -> ${r(40, 40)}`);
  // The point of the fraction: a page rendered twice as large is sharpened
  // twice as coarsely, so the preview and the export agree to within rounding.
  const r3 = [r(900, 1200), r(1800, 2400), r(3600, 4800)];
  check('so a render twice the size is sharpened twice as coarsely',
    r3[1] >= r3[0] * 2 - 1 && r3[2] >= r3[1] * 2 - 1,
    `radii ${r3.join(' / ')} at long edges 1200 / 2400 / 4800`);

  // A soft edge, the thing a phone camera hands you. Paper 235, ink 45, with
  // the transition spread over `ramp` pixels either side.
  function softEdge(w, h, ramp) {
    const g = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const mid = w / 2;
        const d = Math.abs(x - mid);
        const t = d >= ramp ? 1 : d / ramp;
        g[y * w + x] = Math.round(45 + (235 - 45) * t);
      }
    }
    return g;
  }
  // The steepest step anywhere on the middle row: how hard the edge is.
  function slope(g, w, h) {
    const row = (h >> 1) * w;
    let m = 0;
    for (let x = 1; x < w; x++) {
      const d = Math.abs(g[row + x] - g[row + x - 1]);
      if (d > m) m = d;
    }
    return m;
  }

  const w = 600, h = 40;
  const slopes = [0, ...JS.SHARP_LEVELS].map((amount) => {
    const g = softEdge(w, h, 4);
    JS.unsharpGray(g, w, h, amount);
    return slope(g, w, h);
  });
  check('the three steps steepen a soft edge, in order',
    slopes[1] > slopes[0] && slopes[2] > slopes[1] && slopes[3] > slopes[2],
    `slope at off/1/2/3 = ${slopes.join(' / ')}`);
  check('and the top step is a visible change, not a rounding error',
    slopes[3] > slopes[0] * 1.2,
    `${slopes[0]} -> ${slopes[3]}`);

  // The mask is local: paper well away from the edge must come out untouched,
  // which is what separates it from a global contrast curve.
  const flat = softEdge(w, h, 4);
  JS.unsharpGray(flat, w, h, 100);
  check('sharpening leaves paper far from any edge exactly alone',
    flat[(h >> 1) * w + 2] === 235 && flat[(h >> 1) * w + w - 3] === 235,
    `${flat[(h >> 1) * w + 2]} and ${flat[(h >> 1) * w + w - 3]}`);

  // And the clamp: an unsharp mask overshoots at an edge by design, so the two
  // pixels either side of the stroke go past paper-white and past ink-black.
  // They must land on 0/255, not wrap around.
  const wrap = softEdge(w, h, 4);
  JS.unsharpGray(wrap, w, h, 100);
  const all = Array.prototype.every.call(wrap, (v) => v >= 0 && v <= 255);
  check('and cannot wrap a Uint8 around the end of its range', all);

  // The colour form adds the same delta to all three channels, so the colour
  // of the ink must come through untouched. Measured as the channel gaps.
  const cw = 300, ch = 30;
  const canvas = JS.makeCanvas(cw, ch, true);
  const g2 = JS.ctx2d(canvas, true);
  const img = g2.createImageData(cw, ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const o = (y * cw + x) * 4;
      const mid = cw / 2, d = Math.abs(x - mid);
      const t = d >= 3 ? 1 : d / 3;
      img.data[o] = Math.round(150 + (240 - 150) * t);
      img.data[o + 1] = Math.round(40 + (228 - 40) * t);
      img.data[o + 2] = Math.round(40 + (210 - 40) * t);
      img.data[o + 3] = 255;
    }
  }
  g2.putImageData(img, 0, 0);
  const buf = g2.getImageData(0, 0, cw, ch).data;
  const gaps = (d) => {
    const out = [];
    for (let i = 0; i < d.length; i += 4) out.push([d[i] - d[i + 1], d[i + 1] - d[i + 2]]);
    return out;
  };
  const beforeGaps = gaps(buf);
  JS.unsharp(buf, cw, ch, 100);
  const afterGaps = gaps(buf);
  // The same delta is added to all three channels, so the gaps between them are
  // invariant -- with one exception, and it is worth being exact about which.
  // A clamped channel stops rising while the others do not, so the colour does
  // move on any pixel that lands on 0 or 255. Counted separately rather than
  // averaged away: the invariant holds exactly away from the rails, and the
  // error at the rails has to stay bounded.
  const atRail = (d, i) => d[i] === 0 || d[i] === 255 || d[i + 1] === 0
    || d[i + 1] === 255 || d[i + 2] === 0 || d[i + 2] === 255;
  let moved = 0, maxMoved = 0, railed = 0, maxRailed = 0;
  for (let p = 0; p < beforeGaps.length; p++) {
    const i = p * 4;
    const dr = Math.abs(afterGaps[p][0] - beforeGaps[p][0]);
    const dg = Math.abs(afterGaps[p][1] - beforeGaps[p][1]);
    const worst = Math.max(dr, dg);
    if (atRail(buf, i)) { railed++; maxRailed = Math.max(maxRailed, worst); }
    else { if (worst > 0) moved++; maxMoved = Math.max(maxMoved, worst); }
  }
  check('the colour unsharp mask leaves the colour of the ink alone',
    moved === 0,
    `${moved} unclamped pixels moved, worst by ${maxMoved}`);
  check('and where a channel clamps, the colour error stays small',
    maxRailed <= 12,
    `${railed} pixels railed, worst gap change ${maxRailed}`);

  // The step counter the chip reads off. It names the nearest step rather than
  // remembering one, so it cannot disagree with the slider in the drawer.
  const page = JS.createPage({ width: 10, height: 10 }, 10, 10, 'sharp');
  page.mode = 'auto';
  page.adj = Object.assign({}, JS.MODE_DEFAULTS.auto);
  check('a page on its mode default reads as off',
    JS.sharpenLevel(page) === 0, `sharp ${page.adj.sharp} -> level ${JS.sharpenLevel(page)}`);
  const cycled = [];
  for (let i = 0; i < 4; i++) {
    cycled.push(JS.cycleSharpen(page));
    cycled.push(page.adj.sharp);
  }
  check('four taps cycle off, 1, 2, 3 and back to off',
    cycled[0] === 1 && cycled[2] === 2 && cycled[4] === 3 && cycled[6] === 0,
    `levels ${[cycled[0], cycled[2], cycled[4], cycled[6]].join(' ')}`);
  check('and the sharpness goes with them',
    cycled[1] === JS.SHARP_LEVELS[0] && cycled[3] === JS.SHARP_LEVELS[1]
    && cycled[5] === JS.SHARP_LEVELS[2],
    `sharpness ${[cycled[1], cycled[3], cycled[5]].join(' ')}`);
  check('the fourth tap puts back the mode\'s own sharpness, which is the undo',
    cycled[7] === JS.MODE_DEFAULTS.auto.sharp && cycled[7] > 0,
    `back to ${cycled[7]}, mode asks for ${JS.MODE_DEFAULTS.auto.sharp}`);
  // Black & white asks for no sharpening of its own, so there the undo really
  // is zero -- and the chip must not claim a step the page is not carrying.
  page.mode = 'bw';
  page.adj.sharp = 0;
  check('a mode that sharpens nothing reads as off too',
    JS.sharpenLevel(page) === 0);
  page.adj.sharp = 65;
  check('a slider value between two steps reads as the nearer one',
    JS.sharpenLevel(page) === 2, `sharp 65 -> level ${JS.sharpenLevel(page)}`);
  // 55 is exactly between 40 and 70, and the documented rule is that a tie goes
  // to the lower step -- so the chip never claims more sharpening than the page
  // is carrying.
  page.adj.sharp = 55;
  check('and a value exactly between two steps rounds down',
    JS.sharpenLevel(page) === 1, `sharp 55 -> level ${JS.sharpenLevel(page)}`);
  page.adj.sharp = 100;
  check('the top of the slider is the top step',
    JS.sharpenLevel(page) === 3);
}

console.log('\nthe paper white balance');

{
  // The colour the user reported: Auto colour adding yellow. Warm paper, dark
  // ink, and 90% of the page is paper.
  function paper(w, h, rgb, ink) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const dark = (y % 10 < 3);
        const c = dark ? ink : rgb;
        data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
      }
    }
    return data;
  }
  const paperPxAt = (d, x, y) => {
    const i = (y * 60 + x) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  };
  const cast = (d) => {
    // R-B over the paper band, which is where a colour cast shows.
    const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      hist[0][d[i]]++; hist[1][d[i + 1]]++; hist[2][d[i + 2]]++;
    }
    const p = (c) => JS.histPercentile(hist[c], n, 0.90);
    return p(0) - p(2);
  };

  const warm = paper(60, 60, [238, 222, 196], [58, 54, 48]);
  const before = cast(warm);
  check('the fixture really is yellow to start with', before > 30, `R-B ${before}`);
  JS.paperWhiteBalance(warm, 1);
  const after = cast(warm);
  check('the paper white balance takes the yellow out',
    Math.abs(after) <= 3, `R-B ${before} -> ${after}`);

  // Strength 0 is exactly the old behaviour, which is what makes the slider a
  // slider rather than a switch.
  const off = paper(60, 60, [238, 222, 196], [58, 54, 48]);
  const offCopy = new Uint8ClampedArray(off);
  JS.paperWhiteBalance(off, 0);
  check('at strength 0 it changes nothing at all',
    Array.prototype.every.call(off, (v, i) => v === offCopy[i]));

  // A page that is already neutral must not be given a cast to remove.
  const neutral = paper(60, 60, [230, 230, 230], [40, 40, 40]);
  const neutralCopy = new Uint8ClampedArray(neutral);
  JS.paperWhiteBalance(neutral, 1);
  check('a neutral page comes through untouched',
    Array.prototype.every.call(neutral, (v, i) => v === neutralCopy[i]),
    `R-B still ${cast(neutral)}`);

  // A black frame has no white reference to read. Guessing one would be worse
  // than doing nothing, so the paper bin at zero skips the channel outright.
  const black = paper(20, 20, [0, 0, 0], [0, 0, 0]);
  const blackCopy = new Uint8ClampedArray(black);
  JS.paperWhiteBalance(black, 1);
  check('a black frame is left alone rather than guessed at',
    Array.prototype.every.call(black, (v, i) => v === blackCopy[i]));

  // A very dark but not black page -- an underexposed shot -- does get a
  // reference read off it, and that reference is mostly noise. The clamp is
  // what bounds how much damage that can do.
  const dark = paper(60, 60, [14, 12, 9], [4, 4, 4]);
  const darkBefore = paperPxAt(dark, 5, 5);
  JS.paperWhiteBalance(dark, 1);
  const darkAfter = paperPxAt(dark, 5, 5);
  check('a nearly-black page can only be moved as far as the clamp allows',
    darkAfter.every((v, c) => v <= Math.ceil(darkBefore[c] * JS.PAPER_WB_MAX) + 1),
    `rgb(${darkBefore.join(',')}) -> rgb(${darkAfter.join(',')})`);

  // And the clamp. A full-bleed red page is not a page with a red cast, and
  // neutralising its brightest artwork into grey would be a real bug.
  const red = paper(60, 60, [242, 46, 44], [30, 8, 8]);
  JS.paperWhiteBalance(red, 1);
  const got = paperPxAt(red, 5, 5);
  check('a saturated page is corrected as far as the clamp allows and no further',
    got[0] > got[1] * 2 && got[0] > 100,
    `rgb(${got.join(',')}) from rgb(242,46,44)`);
}

/* ================= 8. PDF structure ================= */
console.log('\npdf');

{
  const fakeJpeg = new Uint8Array(512);
  for (let i = 0; i < fakeJpeg.length; i++) fakeJpeg[i] = (i * 7) & 0xff;
  fakeJpeg[0] = 0xFF; fakeJpeg[1] = 0xD8; fakeJpeg[2] = 0xFF;   // SOI marker

  const pages = [
    { jpeg: fakeJpeg, w: 1200, h: 1600 },
    { jpeg: fakeJpeg, w: 1600, h: 1200 }
  ];
  const bytes = JS._buildPDF(pages);
  const text = Buffer.from(bytes).toString('latin1');

  check('starts with a PDF header', text.startsWith('%PDF-1.4'));
  check('ends with EOF', text.trimEnd().endsWith('%%EOF'));
  check('declares two pages', /\/Count 2/.test(text));
  check('has a page tree', /\/Type \/Pages/.test(text));
  check('embeds DCTDecode images', (text.match(/\/DCTDecode/g) || []).length === 2);
  check('uses the right media box', /\/MediaBox \[0 0 1200 1600\]/.test(text));

  // Every xref offset must land exactly on "<n> 0 obj".
  // NB: search for the table keyword itself — "startxref" also contains "xref".
  const xrefPos = text.indexOf('\nxref\n') + 1;
  const startxref = parseInt(text.slice(text.lastIndexOf('startxref') + 9).trim(), 10);
  check('startxref points at the xref table', startxref === xrefPos,
    'startxref=' + startxref + ' xref=' + xrefPos);

  // 2 fixed objects + 3 per page, plus the free head entry.
  const expectEntries = 2 + 3 * 2 + 1;
  const entries = text.slice(xrefPos).match(/^\d{10} \d{5} [nf] \r?$/gm) || [];
  check('xref has an entry per object plus the free head', entries.length === expectEntries,
    'got ' + entries.length + ' want ' + expectEntries);
  check('every xref row is exactly 20 bytes',
    (text.slice(xrefPos).match(/^\d{10} \d{5} [nf] \r\n/gm) || []).length === expectEntries);

  let offsetsOk = true, checked = 0;
  const body = text.slice(xrefPos).split('\n');
  for (const line of body) {
    const mm = /^(\d{10}) 00000 n \r?$/.exec(line);
    if (!mm) continue;
    checked++;
    const off = parseInt(mm[1], 10);
    const expect = checked + ' 0 obj';
    const got = text.substr(off, expect.length);
    if (got !== expect) {
      offsetsOk = false;
      console.log('     object ' + checked + ' at ' + off + ' -> "' + got + '"');
    }
  }
  check('every xref offset lands on its object', offsetsOk && checked === 8,
    'checked=' + checked);

  // The declared /Length must match the bytes actually between stream/endstream.
  const imgStart = text.indexOf('/DCTDecode /Length 512');
  check('image stream length is declared', imgStart > 0);
  const afterHdr = text.indexOf('stream\n', imgStart) + 7;
  check('image bytes follow the stream keyword', bytes[afterHdr] === 0xFF && bytes[afterHdr + 1] === 0xD8);

  const cLen = /\/Length (\d+) >>\nstream\nq\n1200 0 0 1600 0 0 cm\n\/Im0 Do\nQ\nendstream/.exec(text);
  check('content stream is well formed', !!cLen);
}

/* ============ 9. export size: the container and the sample ============ */
console.log('\nsize estimate');

{
  // The container overhead is not a formula in the source — it is the real
  // writer asked how much bigger the file gets. So the check is that it tracks
  // the real writer, which is also what makes it impossible for the two to
  // drift apart when buildPDF changes.
  const realOverhead = (n, w, h, len) => {
    const pages = [];
    for (let i = 0; i < n; i++) pages.push({ w, h, jpeg: new Uint8Array(len) });
    return JS._buildPDF(pages).length - n * len;
  };
  let worst = 0;
  for (const [n, w, h, len] of [[1, 1800, 2400, 1200000], [3, 1800, 2400, 1200000],
                                [12, 900, 1200, 40000], [40, 1800, 2400, 9000000],
                                [7, 620, 2400, 180000]]) {
    const real = realOverhead(n, w, h, len);
    const ours = JS.pdfOverhead(n, w, h);
    worst = Math.max(worst, Math.abs(ours - real) / real);
  }
  // The only gap is the digit count of /Length and startxref: ~6 bytes a page.
  check('the container estimate tracks the real writer', worst < 0.02,
    `worst relative gap ${(worst * 100).toFixed(3)}%`);

  check('an empty set has no container', JS.pdfOverhead(0, 100, 100) === 0);

  // A container that is bigger than one page's JPEGs would be a real defect on
  // a small export, and the linear fit this replaced got exactly that wrong.
  check('the container is a few hundred bytes a page, not thousands',
    JS.pdfOverhead(1, 1800, 2400) < 1000 && JS.pdfOverhead(10, 1800, 2400) < 6000,
    `1 page ${JS.pdfOverhead(1, 1800, 2400)}, 10 pages ${JS.pdfOverhead(10, 1800, 2400)}`);
}

{
  // Which pages get encoded. A set at or below the cap is sampled whole, which
  // is what makes the estimate exact rather than approximate for small exports.
  const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  check('a set within the cap is sampled whole',
    eq(JS._pickSample(2, 3), [0, 1]) && eq(JS._pickSample(3, 3), [0, 1, 2]),
    JSON.stringify(JS._pickSample(3, 3)));

  const one = JS._pickSample(9, 1);
  check('a single sample is taken from the middle', eq(one, [4]), JSON.stringify(one));

  for (const n of [4, 5, 9, 10, 37]) {
    const s = JS._pickSample(n, 3);
    const sorted = s.slice().sort((a, b) => a - b);
    check(`n=${n}: the sample reaches both ends and stays in range`,
      s.length === 3 && eq(s, sorted) && s[0] === 0 && s[s.length - 1] === n - 1 &&
      s.every(v => v >= 0 && v < n),
      JSON.stringify(s));
  }

  // Reaching the ends is not the same as being spread: [0, 1, 9] reaches both
  // ends and is still three-quarters clustered at the front, which is the
  // failure this exists to catch. So the middles have to sit near their own
  // share of the way along.
  for (const n of [10, 37, 100]) {
    const s = JS._pickSample(n, 3);
    const want = [(n - 1) / 2, n - 1];
    check(`n=${n}: the samples sit where an even spread puts them`,
      Math.abs(s[1] - want[0]) <= 1 && s[2] === want[1], JSON.stringify(s));
  }
}

/* ================= summary ================= */
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
