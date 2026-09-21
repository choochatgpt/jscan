/* ==========================================================================
   00-utils.js — tiny helpers, geometry, homography
   ========================================================================== */
'use strict';

var JS = window.JS || (window.JS = {});

/* The one place the version is written down. The home screen prints it from
   here rather than carrying its own copy, so a bump cannot leave the screen
   claiming a build it is not: ui_flow asserts the two agree, which is only a
   real check while the markup has nothing to agree with on its own.
   Bump it by hand, and say what changed — there is no changelog behind this
   and the number is for telling two builds apart, not for promising anything. */
JS.VERSION = '1.7.8';

/* ---------- misc ---------- */

JS.$ = function (id) { return document.getElementById(id); };

JS.clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };

JS.uid = (function () {
  var n = 0;
  return function () { return 'p' + (++n) + '_' + (n * 2654435761 % 100000); };
})();

/** Yield to the browser so spinners can paint between heavy stages. */
JS.yieldToUI = function () {
  return new Promise(function (res) {
    requestAnimationFrame(function () { setTimeout(res, 0); });
  });
};

JS.fmtBytes = function (n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
};

/* ---------- canvas helpers ---------- */

JS.makeCanvas = function (w, h, readFrequently) {
  var c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
};

JS.ctx2d = function (canvas, readFrequently) {
  return canvas.getContext('2d', readFrequently ? { willReadFrequently: true } : undefined);
};

/**
 * The rectangle a `sw x sh` image occupies when fitted inside `bw x bh` and
 * centred — `{x, y, w, h}` in box coordinates, with integer extents so it can
 * size a canvas. The preview letterboxes the finished page into the stage with
 * this, and nothing else.
 */
JS.fitBox = function (bw, bh, sw, sh) {
  // A zero or missing source dimension would make the scale Infinity and the
  // extents NaN, and assigning NaN to canvas.width throws. Nothing to fit is a
  // degenerate answer, not a crash.
  if (!(bw > 0) || !(bh > 0) || !(sw > 0) || !(sh > 0)) {
    return { x: 0, y: 0, w: 1, h: 1, scale: 0 };
  }
  var s = Math.min(bw / sw, bh / sh);
  var w = Math.max(1, Math.round(sw * s));
  var h = Math.max(1, Math.round(sh * s));
  return { x: (bw - w) / 2, y: (bh - h) / 2, w: w, h: h, scale: s };
};

/* ---------- the view: pinch zoom and pan ---------- */

/**
 * The preview's view: a scale about *the stage's top-left*, plus a translation.
 *
 * One transform for the whole stage contents — the canvas and the crop layer
 * together — rather than a CSS `scale()` on the canvas alone. The four crop
 * handles are an SVG over the same box, so two elements scaled by two styles
 * would drift apart at the corners, which is the one place they have to agree:
 * a handle half a pixel off its corner is a crop that is half a pixel wrong.
 *
 * All screen coordinates here are relative to the stage's box, and `tx`/`ty` are
 * in screen pixels, so the map is `screen = stage * z + t`. Plain numbers rather
 * than a matrix read back from `getComputedStyle`, because every one of these
 * has to be checkable in a test with no layout at all.
 */
JS.viewIdentity = function () { return { z: 1, tx: 0, ty: 0 }; };

/** Zoomed to fit and nothing else: the only view in which the whole page shows. */
JS.VIEW_MIN = 1;

/* Past about 6x the preview is being upscaled from fewer pixels than it is
   drawn at (the preview renders at PREVIEW_MAX and the stage is ~350px), so more
   is a magnifying glass over mush rather than a closer look at the words. */
JS.VIEW_MAX = 6;

/* How far a corner grab zooms in. Two is enough to place a dot against the
   printed corner — a 17px dot at 2x is a 34px target on a page whose details are
   now legible — and small enough that the rest of the page stays recognisable,
   which is what tells the user which corner they are moving. */
JS.CORNER_ZOOM = 2;

/** A point in the stage's own coordinates, as it appears on screen. */
JS.viewToScreen = function (v, x, y) {
  return { x: x * v.z + v.tx, y: y * v.z + v.ty };
};

/** A point on screen, back in the stage's own coordinates. */
JS.viewToStage = function (v, x, y) {
  return { x: (x - v.tx) / v.z, y: (y - v.ty) / v.z };
};

/**
 * Scale by `factor` about a screen point, holding that point still.
 *
 * This is what makes a pinch feel attached to the fingers: the pixel between
 * them does not move. `sx`/`sy` are in the view's own screen coordinates, and
 * the factor actually applied is clamped — so the returned `z` is the truth and
 * a caller must use it rather than assuming its own factor landed.
 */
JS.viewZoomAt = function (v, sx, sy, factor) {
  var z = JS.clamp(v.z * factor, JS.VIEW_MIN, JS.VIEW_MAX);
  var k = z / v.z;
  return { z: z, tx: sx - (sx - v.tx) * k, ty: sy - (sy - v.ty) * k };
};

/** Move the view by a screen-pixel delta. Panning is at screen speed. */
JS.viewPan = function (v, dx, dy) {
  return { z: v.z, tx: v.tx + dx, ty: v.ty + dy };
};

/**
 * Keep the page reachable.
 *
 * There is no scrollbar and no reset button, so a pan that put the photo
 * entirely outside the stage would leave a blank editor with no way back — the
 * only route home would be a pinch the user has no reason to try. The rule is
 * that the *image's own centre* stays inside the box it was fitted in, which is
 * one clamp per axis and cannot be satisfied by a view that shows nothing.
 *
 * It is deliberately not the tighter "the image must cover the box" rule a photo
 * viewer uses, and the reason is the corner grab. Zooming in on a corner holds
 * that corner still — the zoom is about the corner's own position — and a cover
 * clamp will not allow it: for a letterboxed page the corner sits `fit.x` in
 * from the edge of the box, so covering the box shifts the image out from under
 * the finger by exactly that much, and the dot being aimed at ends up 43px away
 * from the thumb aiming at it. Holding all four corners exactly — which this
 * does, to the last bit — is worth more here than forbidding the strip of empty
 * stage the looser rule permits. That strip is small and only exists just above
 * fit zoom: measured over every pan the clamp allows, the emptiest stage still
 * shows 74.9% page, against the 72% the fitted view itself shows; past 1.33x the
 * page covers the stage completely on both axes and the rule costs nothing.
 *
 * At fit zoom there is exactly one view and this returns it: the image is no
 * larger than the box on either axis, so both are centred — which is where
 * `fitBox` already put them. A pan at 1x therefore cannot move anything, and a
 * stray touch on an unzoomed preview cannot nudge the page.
 *
 * `fit` is where `fitBox` put the image, in the stage's client coordinates —
 * the same rectangle the four crop handles are drawn on.
 */
JS.viewClamp = function (v, fit) {
  if (!(v.z > JS.VIEW_MIN) || !fit) return JS.viewIdentity();
  // The image's centre lands at `centre * z + t`; keep that inside the fitted
  // rectangle, `[fit.x, fit.x + fit.w]`, and solve for `t`.
  var cx = (fit.x + fit.w / 2) * v.z;
  var cy = (fit.y + fit.h / 2) * v.z;
  return {
    z: v.z,
    tx: JS.clamp(v.tx, fit.x - cx, fit.x + fit.w - cx),
    ty: JS.clamp(v.ty, fit.y - cy, fit.y + fit.h - cy)
  };
};

/* ---------- geometry ---------- */

JS.dist = function (a, b) { return Math.hypot(a.x - b.x, a.y - b.y); };

JS.quadArea = function (q) {
  var a = 0;
  for (var i = 0; i < 4; i++) {
    var p = q[i], r = q[(i + 1) % 4];
    a += p.x * r.y - r.x * p.y;
  }
  return Math.abs(a) / 2;
};

/** Rotate point p about (cx,cy) by `rad`. */
JS.rotateAbout = function (p, cx, cy, rad) {
  var c = Math.cos(rad), s = Math.sin(rad);
  var dx = p.x - cx, dy = p.y - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
};

JS.rectCorners = function (w, h) {
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
};

JS.cloneQuad = function (q) {
  return q.map(function (p) { return { x: p.x, y: p.y }; });
};

/**
 * Solve the 8-unknown homography H mapping src[i] -> dst[i]  (i = 0..3).
 * Returns [a,b,c,d,e,f,g,h] with
 *     u = (a x + b y + c) / (g x + h y + 1)
 *     v = (d x + e y + f) / (g x + h y + 1)
 * Returns null when the system is degenerate.
 */
JS.solveHomography = function (src, dst) {
  var A = [], B = [], i;
  for (i = 0; i < 4; i++) {
    var x = src[i].x, y = src[i].y, u = dst[i].x, v = dst[i].y;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v);
  }
  // Gaussian elimination with partial pivoting on the augmented 8x9 system.
  for (var col = 0; col < 8; col++) {
    var piv = col, best = Math.abs(A[col][col]);
    for (var r = col + 1; r < 8; r++) {
      var m = Math.abs(A[r][col]);
      if (m > best) { best = m; piv = r; }
    }
    if (best < 1e-12) return null;
    if (piv !== col) {
      var t = A[piv]; A[piv] = A[col]; A[col] = t;
      var tb = B[piv]; B[piv] = B[col]; B[col] = tb;
    }
    var pv = A[col][col];
    for (var c2 = col; c2 < 8; c2++) A[col][c2] /= pv;
    B[col] /= pv;
    for (var r2 = 0; r2 < 8; r2++) {
      if (r2 === col) continue;
      var f = A[r2][col];
      if (f === 0) continue;
      for (var c3 = col; c3 < 8; c3++) A[r2][c3] -= f * A[col][c3];
      B[r2] -= f * B[col];
    }
  }
  return B;
};

/** Where H sends (x,y). Inverse of `solveHomography`'s own construction. */
JS.applyH = function (H, x, y) {
  var den = H[6] * x + H[7] * y + 1;
  if (den === 0) return null;
  return { x: (H[0] * x + H[1] * y + H[2]) / den,
           y: (H[3] * x + H[4] * y + H[5]) / den };
};

/**
 * Can this quad be used as a crop? In normalised frame coordinates, so it is
 * pure maths and needs no canvas.
 *
 * Three ways a quad goes bad, and `quadArea` sees none of them. Drag one corner
 * past its neighbour and the quad crosses itself — a bowtie — which inverts the
 * homography and renders the page inside out; `quadArea` takes the absolute
 * value of the shoelace sum, so a bowtie measures the same as the rectangle it
 * should have been. Drag one corner *inside* the triangle of the other three and
 * the quad is concave: nothing is inverted and the maths is happy, but the warp
 * folds the page over along the diagonal, and a document scanner that returns a
 * page with a mirrored wedge in it is worse than one that refuses the drag.
 * Bring two corners together and it collapses to a sliver, where the warp
 * samples the same few pixels across the whole output.
 *
 * All three are one question about winding. Every turn of a convex quad goes
 * the same way round; a concave or crossed one turns both ways. A collinear turn
 * (three corners in a line) is neither, and goes with them. `minEdge` is the
 * sliver test, as a fraction of the frame.
 */
JS.quadOk = function (q, minEdge) {
  if (!q || q.length !== 4) return false;
  var min = minEdge || 0.02;
  var first = 0;
  for (var i = 0; i < 4; i++) {
    var p = q[i], r = q[(i + 1) % 4], s = q[(i + 2) % 4];
    if (!p || !isFinite(p.x) || !isFinite(p.y)) return false;
    // A corner dragged out of the frame is not a crop, it is a hole: the warp
    // would spend real work filling the outside with blank pixels.
    if (p.x < -1e-6 || p.x > 1 + 1e-6 || p.y < -1e-6 || p.y > 1 + 1e-6) return false;
    var ax = r.x - p.x, ay = r.y - p.y;
    var bx = s.x - r.x, by = s.y - r.y;
    var cross = ax * by - ay * bx;
    if (Math.abs(cross) < 1e-9) return false;
    if (i === 0) first = cross;
    else if ((cross > 0) !== (first > 0)) return false;
    if (Math.hypot(ax, ay) < min) return false;
  }
  return true;
};

/* ---------- colour helpers ---------- */

JS.luma = function (r, g, b) { return (r * 299 + g * 587 + b * 114) / 1000; };

/** Build a 256-entry lookup table from a function. */
JS.lut = function (fn) {
  var t = new Uint8ClampedArray(256);
  for (var i = 0; i < 256; i++) t[i] = fn(i);
  return t;
};

/** Value at percentile `p` (0..1) of a 256-bin histogram with `total` samples. */
JS.histPercentile = function (hist, total, p) {
  var target = total * p, acc = 0;
  for (var i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return 255;
};
