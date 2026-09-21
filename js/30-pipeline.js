/* ==========================================================================
   30-pipeline.js — page model, geometry warp, tone pipeline

   Two decisions here exist to keep memory flat as pages pile up:

   * `page.source` is an <img> backed by a JPEG blob, not a pinned canvas.
     Browsers can evict and re-decode image data under pressure; a canvas is
     pinned forever. A 2400px canvas is ~17 MB, so a dozen of them kills a
     phone tab.
   * `page.corners` is stored normalised (0..1) in the oriented frame, so any
     oriented canvas at any scale maps onto it without a rebuild.
   ========================================================================== */
'use strict';

(function (JS) {

  /** Long-edge cap for the stored source. ~200 dpi on an A4 sheet. */
  JS.WORK_MAX = 2400;
  JS.PREVIEW_MAX = 900;
  JS.THUMB_MAX = 260;

  /**
   * How many derived canvases to keep per page before evicting.
   *
   * Three, because three sizes are genuinely live at once: the fast preview a
   * slider drag redraws at PREVIEW_FAST, the full-quality preview it redraws at
   * PREVIEW_MAX when the finger lifts, and the THUMB_MAX grid thumbnail that a
   * re-render of the home screen asks for. At two the smallest is the one
   * evicted, so one of those three pays a full re-warp of the page every time
   * it comes round.
   */
  var CACHE_SLOTS = 3;

  /**
   * Output aspect to hold while a crop handle is being dragged, or 0 for none.
   *
   * The handles sit on the corners of the box the preview is drawn in, and the
   * box is sized from the output — so an output whose shape followed the quad
   * would move the corner out from under the finger that is dragging it. Pinned
   * for the length of a drag, cleared on release, and part of the buffer cache
   * key in between, because the same corners at a different pin are a different
   * picture.
   */
  JS.cropPin = 0;

  /* ------------------------------------------------------------ page model */

  /**
   * Per-mode recommended tuning. `flat` is shadow removal, 0..100.
   *
   * The continuous-tone values are high because `flat` is a *blend* towards the
   * flattened result, not a switch: at 45 a good third of the shadow's depth
   * survives, which reads as a shadow that was never removed at all.
   *
   * Measured on a cast shadow across a thermal receipt, as the paper level —
   * the 90th percentile of each half, which ignores the print. A mean over the
   * same halves reports the *ink* as much as the shadow, because the printed
   * bars do not reach the edge of the paper, and a mean makes removal look far
   * less complete than it is:
   *
   *     flat   45     70     85    100
   *     left  193    253    255    255   (paper level, lit side 255)
   *     left   39%     1%     0%     0%   of the shadow left
   *
   * At 85 the paper is at 255 across the whole strip. Going higher buys only
   * the last few levels at the knee of the shadow's ramp.
   *
   * `auto` and `receipt` sharing 85 does not make them equally aggressive. They
   * run different code: continuous tone goes through `flattenRGB`, which caps
   * the gain at SHADOW_GAIN_MAX, while the threshold modes go through
   * `flattenBackground`, which has no cap but is immediately followed by a
   * threshold that discards the difference anyway.
   */
  JS.MODE_DEFAULTS = {
    original: { flat: 0,  thr: 0,  sharp: 0,  contrast: 0,  wb: 0,  sat: 0 },
    auto:     { flat: 85, thr: 0,  sharp: 32, contrast: 12, wb: 70, sat: 6 },
    bw:       { flat: 70, thr: 0,  sharp: 0,  contrast: 0,  wb: 70, sat: 0 },
    receipt:  { flat: 85, thr: -6, sharp: 0,  contrast: 0,  wb: 70, sat: 0 }
  };

  JS.MODE_LABELS = {
    original: 'Original',
    auto: 'Auto colour',
    bw: 'Black & white',
    receipt: 'Receipt'
  };

  /**
   * The three sharpen steps the Sharpen chip walks through, and what the chip
   * calls "off".
   *
   * Off is deliberately **not** zero. It is the sharpness the page's own mode
   * asks for — 32 in Auto colour, 0 in Black & white — so the fourth tap is an
   * undo rather than a change of look: a page sharpened twice and tapped back
   * is identical to one that never went near the button. Zero would quietly
   * leave Auto colour less sharp than it arrived.
   *
   * The steps are absolute rather than relative to that starting point, so
   * tapping once from a page whose mode already sharpens lands in the same
   * place as tapping once from one that does not. `JS.unsharp` scales them by
   * 1.35, so 40/70/100 is an edge gain of 0.54/0.95/1.35 against the 0.43 that
   * Auto colour starts with.
   */
  JS.SHARP_LEVELS = [40, 70, 100];

  function sharpOff(mode) {
    var d = JS.MODE_DEFAULTS[mode] || JS.MODE_DEFAULTS.auto;
    return d.sharp;
  }

  /**
   * Which step a page is on: 0 for off, then 1..3 for the levels above.
   *
   * It is the *nearest* of the four values rather than the largest one below,
   * so a sharpness set with the slider still reads as the step it is closest
   * to. Ties go to the earlier value, which is what stops a mode whose own
   * sharpness happened to equal a level from showing as sharpened on arrival.
   */
  JS.sharpenLevel = function (page) {
    var vals = [sharpOff(page.mode)].concat(JS.SHARP_LEVELS);
    var v = page.adj.sharp, best = 0;
    for (var i = 1; i < vals.length; i++) {
      if (Math.abs(v - vals[i]) < Math.abs(v - vals[best])) best = i;
    }
    return best;
  };

  /** The next step, wrapping off the end back to the mode's own sharpness. */
  JS.cycleSharpen = function (page) {
    var vals = [sharpOff(page.mode)].concat(JS.SHARP_LEVELS);
    var next = (JS.sharpenLevel(page) + 1) % vals.length;
    page.adj.sharp = vals[next];
    return next;
  };

  JS.createPage = function (source, w, h, name) {
    // The tone defaults a page opens with are taken from the Auto colour preset
    // rather than restated, so a page that opens in that mode cannot render
    // differently from one that arrived there by pressing Auto clean. Contrast
    // and saturation stay gentler than the preset: the first look at a photo
    // should still be the photo.
    var auto = JS.MODE_DEFAULTS.auto;
    return {
      id: JS.uid(),
      name: name || 'photo',
      source: source,          // HTMLImageElement backed by a blob URL
      w: w,
      h: h,
      coarse: 0,               // 0 | 90 | 180 | 270
      fine: 0,                 // de-skew angle in degrees
      corners: null,           // normalised quad in the oriented frame
      mode: 'auto',
      modeTap: '',             // the mode chip the user turned on, if any
      modeBack: null,          // the tone that chip replaced; see JS.setMode
      adj: {
        bright: 0, contrast: 0, wb: 70, sat: 0, warmth: 0,
        flat: auto.flat, thr: auto.thr, sharp: auto.sharp
      },
      touched: false,
      bakedMode: '',           // what "Done" committed, for the grid badge
      _bakedKey: '',           // state key at the moment of that commit
      _oriented: {},           // maxDim -> { key, canvas }
      _rects: {},              // maxDim -> { key, canvas }
      _thumb: null,
      _thumbKey: ''
    };
  };

  /**
   * A signature of everything that affects the rendered result. Two states with
   * the same key render identically, so this serves both as a cache key and as
   * the test for "has anything changed since this page was committed".
   *
   * Deriving committed-ness from a signature rather than a boolean means no
   * mutating code path can forget to clear it: change a slider, rotate, redrag a
   * corner, and the key moves on its own.
   */
  JS.stateKey = function (page) {
    var a = page.adj;
    // Enumerate the adjustments rather than listing them: a slider added later
    // clears the badge by existing, with nothing to remember.
    var adjKey = Object.keys(a).sort().map(function (k) { return k + '=' + a[k]; }).join(',');
    return page.coarse + '|' + page.fine.toFixed(2) + '|' +
           (page.corners
             ? page.corners.map(function (p) {
                 return p.x.toFixed(3) + ':' + p.y.toFixed(3);
               }).join(',')
             : 'full') +
           '|' + page.mode + '|' + adjKey +
           // The Learn redaction mask (js/75-learn-mask.js). It must be in here or a
           // painted-over name is served a stale cached canvas: the user sees it covered
           // and the exported bytes still contain it. `key` is a revision counter, so it
           // is O(1) and moves exactly when the mask moves. Guarded because 30- loads
           // before 75-, and 'n' means "no mask", which is every page that has not been
           // through Learn.
           '|' + (JS.learnMask ? JS.learnMask.key(page.mask) : 'n');
  };

  /**
   * The adjustment state a committed page carries: every control neutral, so the
   * tone stage is a no-op and the baked pixels are exactly what renders.
   * Shared with the tests so the two cannot drift apart.
   */
  JS.COMMITTED_ADJ = Object.freeze({
    bright: 0, contrast: 0, wb: 0, sat: 0, warmth: 0, flat: 0, thr: 0, sharp: 0
  });

  /**
   * True when the page's pixels already are the finished result: it was
   * committed and nothing has been applied since. Re-baking then would only
   * cost a generation of JPEG quality.
   */
  JS.isCommitted = function (page) {
    return !!page._bakedKey && page._bakedKey === JS.stateKey(page);
  };

  /**
   * Drop the warped buffers and the thumbnail.
   * The oriented canvas is deliberately kept: its cache key embeds the coarse
   * angle and the buffer size, so a rotation invalidates it on its own, and
   * rebuilding it is the single most expensive step in the pipeline.
   */
  JS.invalidate = function (page) {
    page._rects = {};
    page._thumb = null;
    page._thumbKey = '';
  };

  /**
   * Drop every derived buffer including the oriented canvas. Needed when the
   * *source* is replaced rather than just the state: the oriented cache is keyed
   * on the coarse angle and the buffer dimensions, which does not identify the
   * pixels, so a new source could otherwise be served the old one's canvas.
   */
  JS.forgetSource = function (page) {
    page._oriented = {};
    JS.invalidate(page);
  };

  /** Drop only the expensive warped buffers. Used during crop drags. */
  JS.releaseBuffers = function (page) {
    page._rects = {};
  };

  function cachePut(store, key, entry) {
    store[key] = entry;
    var keys = Object.keys(store);
    if (keys.length > CACHE_SLOTS) {
      // Evict the lowest resolution first — it is the cheapest to rebuild.
      keys.sort(function (a, b) { return Number(a) - Number(b); });
      for (var i = 0; i < keys.length - CACHE_SLOTS; i++) delete store[keys[i]];
    }
  }

  /* ------------------------------------------------------- oriented canvas */

  JS.rectCorners01 = function () {
    return [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  };

  /**
   * Where the source lands inside the oriented canvas.
   *
   * The canvas takes the *rotated* dimensions, but the source must be drawn at
   * its own aspect ratio — drawing it into the swapped width/height stretches
   * the page before the rotation, which overflows the canvas and clips it.
   * Pure maths, so it is unit-testable without a canvas.
   *
   * Coordinates are relative to the canvas centre, in the rotated frame.
   */
  JS.orientedLayout = function (page, maxDim) {
    maxDim = maxDim || JS.PREVIEW_MAX;
    var swap = page.coarse === 90 || page.coarse === 270;
    var fw = swap ? page.h : page.w;
    var fh = swap ? page.w : page.h;
    var s = Math.min(1, maxDim / Math.max(fw, fh));
    // One uniform scale for both the canvas and the source.
    var dw = page.w * s, dh = page.h * s;
    return {
      scale: s,
      canvasW: Math.max(1, Math.round(fw * s)),
      canvasH: Math.max(1, Math.round(fh * s)),
      drawX: -dw / 2,
      drawY: -dh / 2,
      drawW: dw,
      drawH: dh
    };
  };

  /**
   * The source rotated by the coarse angle, capped to `maxDim` on the long
   * edge. Cached per maxDim so the cheap preview buffer and the expensive
   * export buffer coexist without thrashing.
   */
  JS.orientedCanvas = function (page, maxDim) {
    maxDim = maxDim || JS.PREVIEW_MAX;
    var L = JS.orientedLayout(page, maxDim);

    var key = page.coarse + ':' + L.canvasW + 'x' + L.canvasH;
    var hit = page._oriented[maxDim];
    if (hit && hit.key === key) return hit.canvas;

    var c = JS.makeCanvas(L.canvasW, L.canvasH);
    var g = JS.ctx2d(c);
    g.save();
    g.translate(L.canvasW / 2, L.canvasH / 2);
    g.rotate(page.coarse * Math.PI / 180);
    g.drawImage(page.source, L.drawX, L.drawY, L.drawW, L.drawH);
    g.restore();
    cachePut(page._oriented, maxDim, { key: key, canvas: c });
    return c;
  };

  /** Active quad in normalised oriented coordinates. */
  JS.getCorners = function (page) {
    return page.corners || JS.rectCorners01();
  };

  /** Active quad in pixels of a specific oriented canvas. */
  JS.getCornersPx = function (page, oc) {
    return JS.getCorners(page).map(function (p) {
      return { x: p.x * oc.width, y: p.y * oc.height };
    });
  };

  /**
   * Rotate the page by ±90°. Normalised corners rotate about the centre, which
   * is exactly (x,y) -> (1-y,x) clockwise and (x,y) -> (y,1-x) anticlockwise,
   * so the user's crop stays glued to the same feature of the photo.
   */
  /**
   * Turn the page a quarter turn, carrying the crop with it.
   *
   * Two things have to happen, and the second is the one that gets forgotten:
   * move each corner, *and* re-index the list so it still reads
   * [top-left, top-right, bottom-right, bottom-left] in the new frame.
   *
   * `rectify` takes its output width from the length of edge (q0,q1) and its
   * height from edge (q0,q3), which is only right while index 0 is the top-left.
   * Rotating the coordinates alone leaves the list cyclically shifted by one, so
   * those two edges swap roles and every rotated page comes out transposed —
   * the content turns on screen but the frame does not, which reads as the
   * rotate button doing nothing. It also defeats rectify's `isPlain` fast path,
   * because a full-frame page no longer has a corner at (0,0), so a plain
   * quarter turn pays for the whole per-pixel homography.
   */
  JS.rotateCoarse = function (page, dir) {
    var q = JS.getCorners(page);
    var turn = dir > 0
      ? function (p) { return { x: 1 - p.y, y: p.x }; }
      : function (p) { return { x: p.y, y: 1 - p.x }; };
    // Which old corner the turn carries onto the new top-left: under dir > 0
    // that is the old bottom-left (index 3), under dir < 0 the old top-right
    // (index 1). Start the list there and the ordering is canonical again.
    var off = dir > 0 ? 3 : 1;
    page.corners = [0, 1, 2, 3].map(function (i) { return turn(q[(off + i) % 4]); });
    page.coarse = (page.coarse + (dir > 0 ? 90 : 270)) % 360;
    JS.invalidate(page);
  };

  /* ------------------------------------------------------------- rectify */

  function geometryKey(page, maxDim) {
    var oc = JS.orientedCanvas(page, maxDim);
    var q = JS.getCorners(page);
    var ks = q.map(function (p) {
      return p.x.toFixed(4) + ':' + p.y.toFixed(4);
    }).join(',');
    return page.coarse + '|' + page.fine.toFixed(2) + '|' + oc.width + 'x' + oc.height + '|' + ks
         + '|' + (JS.cropPin > 0 ? JS.cropPin.toFixed(4) : '');
  }

  /**
   * Warp the quad (with the de-skew rotation folded in) into an upright
   * rectangle. Sampling runs backwards — output pixel to source pixel — with
   * bilinear filtering.
   */
  JS.rectify = function (page, maxDim) {
    maxDim = maxDim || JS.PREVIEW_MAX;
    var key = geometryKey(page, maxDim);
    var cached = page._rects[maxDim];
    if (cached && cached.key === key) return cached.canvas;

    var oc = JS.orientedCanvas(page, maxDim);
    var basePx = JS.getCornersPx(page, oc);

    var rad = page.fine * Math.PI / 180;
    var cx = oc.width / 2, cy = oc.height / 2;
    var quad = basePx.map(function (p) { return JS.rotateAbout(p, cx, cy, rad); });

    // Page proportions: the *average* of each pair of opposite sides, not the
    // longer one.
    //
    // Shot at an angle, the near edge of a page genuinely measures longer than
    // the far edge — that difference is the perspective, and it is the thing
    // the warp is here to remove. Sizing the output to the longer edge keeps
    // the difference as a permanent stretch: every pixel along the far edge is
    // pulled out to a width it never had. Averaging splits the difference, so
    // the near edge is compressed and the far edge stretched by the same
    // amount, which is what "square to the camera" actually looks like.
    //
    // For a quad already filling the frame the pairs are equal, so the average
    // is a no-op and the buffer passes through untouched.
    var top = JS.dist(quad[0], quad[1]), bottom = JS.dist(quad[3], quad[2]);
    var left = JS.dist(quad[0], quad[3]), right = JS.dist(quad[1], quad[2]);
    var ow = (top + bottom) / 2;
    var oh = (left + right) / 2;
    if (!(ow > 1) || !(oh > 1)) {
      quad = JS.rectCorners(oc.width, oc.height);
      ow = oc.width; oh = oc.height;
    }

    // Keep the longest edge at full resolution, bounded by maxDim, and never
    // upscale past the oriented buffer — it is already capped.
    var scale = Math.min(1, maxDim / Math.max(ow, oh));
    ow = Math.max(1, Math.round(ow * scale));
    oh = Math.max(1, Math.round(oh * scale));

    // Under a drag the frame keeps the shape it was pinned at and only its area
    // follows the quad. The longest edge stays the longest edge, so the pixel
    // budget is unchanged and only the ratio is held. See `JS.cropPin`.
    var pin = JS.cropPin;
    if (pin > 0) {
      var long = Math.max(ow, oh);
      ow = Math.max(1, Math.round(pin >= 1 ? long : long * pin));
      oh = Math.max(1, Math.round(pin >= 1 ? long / pin : long));
    }

    var out = JS.makeCanvas(ow, oh, true);
    var g = JS.ctx2d(out, true);

    var isPlain = Math.abs(page.fine) < 0.01 &&
                  Math.abs(basePx[0].x) < 1 && Math.abs(basePx[0].y) < 1 &&
                  Math.abs(basePx[2].x - oc.width) < 1 && Math.abs(basePx[2].y - oc.height) < 1;

    if (isPlain) {
      g.drawImage(oc, 0, 0, oc.width, oc.height, 0, 0, ow, oh);
      cachePut(page._rects, maxDim, { key: key, canvas: out });
      return out;
    }

    var H = JS.solveHomography(JS.rectCorners(ow, oh), quad);
    if (!H) {
      g.drawImage(oc, 0, 0, oc.width, oc.height, 0, 0, ow, oh);
      cachePut(page._rects, maxDim, { key: key, canvas: out });
      return out;
    }

    var src = JS.ctx2d(oc, true).getImageData(0, 0, oc.width, oc.height).data;
    var sw = oc.width, sh = oc.height;
    var img = g.createImageData(ow, oh);
    var dst = img.data;
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], gg = H[6], hh = H[7];

    for (var v = 0; v < oh; v++) {
      var vc = v + 0.5;
      var rowBase = v * ow * 4;
      for (var u = 0; u < ow; u++) {
        var uc = u + 0.5;
        var den = gg * uc + hh * vc + 1;
        if (den === 0) den = 1e-9;
        var sx = (a * uc + b * vc + c) / den - 0.5;
        var sy = (d * uc + e * vc + f) / den - 0.5;

        var o = rowBase + u * 4;
        if (sx < -1 || sy < -1 || sx > sw || sy > sh) { dst[o + 3] = 255; continue; }

        var x0 = sx | 0, y0 = sy | 0;
        if (x0 < 0) x0 = 0; else if (x0 > sw - 1) x0 = sw - 1;
        if (y0 < 0) y0 = 0; else if (y0 > sh - 1) y0 = sh - 1;
        var x1 = x0 + 1 < sw ? x0 + 1 : sw - 1;
        var y1 = y0 + 1 < sh ? y0 + 1 : sh - 1;

        var fx = sx - x0, fy = sy - y0;
        if (fx < 0) fx = 0; else if (fx > 1) fx = 1;
        if (fy < 0) fy = 0; else if (fy > 1) fy = 1;

        var i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
        var i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
        var w01 = (1 - fx) * fy, w11 = fx * fy;

        dst[o]     = src[i00]     * w00 + src[i10]     * w10 + src[i01]     * w01 + src[i11]     * w11;
        dst[o + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
        dst[o + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
        dst[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    cachePut(page._rects, maxDim, { key: key, canvas: out });
    return out;
  };

  /* --------------------------------------------------------- manual crop */

  /**
   * A map from a point on the finished page back to a corner of the photo.
   *
   * `rectify` answers "which photo pixel goes here", and this is the same
   * homography read the other way: (0,0) is the top-left of what the preview
   * shows, (1,1) its bottom-right, and the answer is in the normalised oriented
   * frame that `page.corners` lives in. Dragging a handle is the whole use of
   * it — the finger's position on the page says which part of the photo should
   * become that corner.
   *
   * Two things are easy to get wrong here and both were. The fine angle is
   * folded into the quad inside `rectify`, so the map has to be built from the
   * *rotated* quad and un-rotated again on the way out, or a corner dragged
   * after an Auto crop lands up to 15° away from the finger. And the whole map
   * is normalised, so no part of it depends on `maxDim`, the oriented buffer
   * size or the output size — the editor builds it once, when the handle is
   * grabbed, and holds it for the drag. Rebuilding it per move would make the
   * handle chase its own output.
   */
  JS.cropMapper = function (page) {
    var oc = JS.orientedCanvas(page, JS.PREVIEW_MAX);
    var rad = page.fine * Math.PI / 180;
    var cx = oc.width / 2, cy = oc.height / 2;
    var quad = JS.getCornersPx(page, oc).map(function (p) {
      return JS.rotateAbout(p, cx, cy, rad);
    });
    var H = JS.solveHomography(JS.rectCorners(1, 1), quad);
    if (!H) return null;
    return function (u, v) {
      var p = JS.applyH(H, u, v);
      if (!p) return null;
      var back = JS.rotateAbout(p, cx, cy, -rad);
      return { x: back.x / oc.width, y: back.y / oc.height };
    };
  };

  /* -------------------------------------------------------------- enhance */

  /**
   * True when no slider that `original` mode honours would change a pixel.
   * Lets a committed page skip the pixel pass entirely.
   *
   * `wb` and `thr` are deliberately absent: both are consumed only by the
   * automatic passes, which `original` skips, so they cannot move a pixel here.
   * `flat` is present because shadow removal is not an automatic pass — it is
   * lighting correction the user asked for by name, and it runs in every mode.
   */
  JS.manualNeutral = function (adj) {
    return adj.bright === 0 && adj.contrast === 0 && adj.sat === 0 &&
           adj.warmth === 0 && adj.sharp === 0 && adj.flat === 0;
  };

  /**
   * Tone pipeline, run on an already-rectified canvas.
   *
   *  original  — no automatic tone; the manual sliders still apply
   *  auto      — paper white balance, then shadow removal, then auto levels
   *              and a gentle contrast boost (keeps colour)
   *  bw        — shadow removal + adaptive threshold: crisp text on white
   *  receipt   — as bw, tuned for faint thermal print
   *
   * There was a fifth, Greyscale, and it is gone rather than hidden: the
   * Saturation slider already reaches it at -100, so a mode that duplicated a
   * slider was a whole row of the tone table spent on nothing. Sharpening is
   * not affected — it applies in every mode, including the two that threshold.
   *
   * `original` deliberately still honours the manual sliders. "Done" commits a
   * page into this mode, and leaving the user with controls that do nothing on
   * the page they just finished would be worse than having no controls. With
   * every slider neutral — the state a commit leaves behind — it costs nothing.
   */
  JS.enhance = function (rectCanvas, page, maxDim) {
    var w = rectCanvas.width, h = rectCanvas.height;
    var out = JS.makeCanvas(w, h, true);
    var g = JS.ctx2d(out, true);
    g.drawImage(rectCanvas, 0, 0);

    var mode = page.mode;
    var adj = page.adj;
    var auto = mode !== 'original';

    // Nothing automatic and nothing manual: hand back the rectified pixels
    // untouched, skipping the pixel pass entirely. This is the steady state of
    // a committed page, which is what most exports are made of.
    if (!auto && JS.manualNeutral(adj)) return out;

    var img = g.getImageData(0, 0, w, h);
    var data = img.data;

    if (mode === 'bw' || mode === 'receipt') {
      var gray = JS.toGray(data, w, h);

      // Shadow removal first: thresholding alone still darkens a lighting
      // gradient, whereas dividing the background out makes it uniform.
      if (adj.flat > 0) {
        var bgRadius = Math.max(6, Math.round(Math.max(w, h) / 12));
        gray = JS.flattenBackground(gray, w, h, bgRadius, adj.flat / 100);
      }

      // Sharpen before the threshold, not after it. Thresholding is a decision
      // per pixel with no way to undo it, so sharpening the binary result would
      // only thicken strokes that already crossed; sharpening the grey lifts
      // the faint ones across the line, which is the whole point of reaching
      // for the button on a blurry page. The mode's own sharpness is 0, so a
      // page that never touches Sharpen renders exactly as it did before.
      if (adj.sharp > 0) JS.unsharpGray(gray, w, h, adj.sharp);

      // Sauvola rather than Bradley, and this is the fix for the report that
      // cleaning "breaks the words" on faint or blurry print. Bradley decides on
      // the local mean alone, so on a photograph every stroke is a grey ramp and
      // its shoulders fall on the wrong side of one fixed fraction of the mean —
      // the letter comes back in pieces. Sauvola adds the window's *contrast*, so
      // a window a stroke runs through is judged more leniently and a flat one
      // not at all. Measured on a page of print made progressively fainter and
      // softer, against the marks the crisp page actually has (99 of them), at
      // the receipt's own window: whole marks recovered, and marks recovered in
      // pieces —
      //
      //     blur 1   Bradley  88 whole / 11 in pieces     Sauvola  95 / 4
      //     blur 2   Bradley  71 whole / 28 in pieces     Sauvola  81 / 18
      //     blur 3   Bradley  30 whole /  5 in pieces     Sauvola  52 / 8
      //
      // — better at every level, with the ink up by about a tenth, which is the
      // direction that keeps a thin stroke joined to itself. See
      // `JS.sauvolaThreshold`.
      var radius = mode === 'receipt'
        ? Math.max(4, Math.round(w / 46))
        : Math.max(6, Math.round(w / 30));
      var t = mode === 'receipt' ? 0.09 : 0.15;
      var bias = -adj.thr;   // more "text weight" keeps more ink

      // Keeps solid dark areas (logos, barcodes, heavy rules) filled in.
      var floor = 55;
      var bw = JS.sauvolaThreshold(gray, w, h, radius, t, bias, floor);
      // Despeckle flips only a pixel that differs from *all eight* of its
      // neighbours — a lone dot, never a thin stroke, which always has
      // neighbours on the same side. It is left as it is: it cannot be what
      // breaks a word.
      if (mode === 'receipt') bw = JS.despeckle(bw, w, h);

      JS.grayToRGB(data, bw);
      g.putImageData(img, 0, 0);
      return out;
    }

    // --- continuous tone --------------------------------------------------
    // White balance first of all, and that order is load-bearing twice over.
    // It has to precede the levels for the obvious reason — the levels are what
    // make the page bright, and a cast left in them is a cast left in the
    // output. It has to precede the *shadow removal* because flattening divides
    // every channel by one luminance gain and clamps at 255: it turns warm
    // paper into (255,255,~208) with clipped white above it, and a clipped
    // highlight is no longer a measurement of anything. Measuring the paper
    // after that is measuring the clamp.
    if (auto) JS.paperWhiteBalance(data, JS.clamp(adj.wb, 0, 100) / 100);

    // Shadow removal next, and before the levels — a shadow is a lighting
    // gradient, so the histogram spans it and the percentile stretch ends up
    // normalising the shadow rather than the page. Flattening first gives the
    // levels a page that is evenly lit to work on.
    if (adj.flat > 0) {
      JS.flattenRGB(data, w, h, Math.max(6, Math.round(Math.max(w, h) / 12)), adj.flat / 100);
    }

    // Auto levels are the "automatic" half; `original` skips them and applies
    // only what the user set by hand.
    if (auto) {
      var luts = JS.autoLevelsLUTs(data, JS.clamp(adj.wb, 0, 100) / 100);
      JS.applyLUTs(data, luts.lutR, luts.lutG, luts.lutB);
    }

    if (adj.bright !== 0) {
      var bl = JS.brightnessLUT(adj.bright);
      JS.applyLUTs(data, bl, bl, bl);
    }

    JS.applySaturation(data, adj.sat);
    if (adj.warmth !== 0) {
      var wl = JS.warmthLUTs(adj.warmth);
      JS.applyLUTs(data, wl.lutR, wl.lutG, wl.lutB);
    }

    if (adj.contrast !== 0) {
      var cl = JS.contrastLUT(adj.contrast);
      JS.applyLUTs(data, cl, cl, cl);
    }

    if (adj.sharp > 0) JS.unsharp(data, w, h, adj.sharp);

    g.putImageData(img, 0, 0);
    return out;
  };

  JS.renderPage = function (page, maxDim) {
    return JS.enhance(JS.rectify(page, maxDim), page, maxDim);
  };

  /* ------------------------------------------------------------ auto tools */

  /**
   * Find the page quad, then measure the tilt of the rectified result and fold
   * that back in as the fine angle. This is the whole of the Auto crop button;
   * Auto all calls it too, and then goes on to clean.
   */
  JS.autoDetect = async function (page) {
    var oc = JS.orientedCanvas(page, JS.PREVIEW_MAX);
    var quad = JS.detectPageQuad(oc, 420);
    if (quad) {
      page.corners = quad.map(function (p) {
        return { x: JS.clamp(p.x / oc.width, 0, 1), y: JS.clamp(p.y / oc.height, 0, 1) };
      });
      page.fine = 0;
      JS.invalidate(page);
    }
    var small = JS.rectify(page, 420);
    page.fine = JS.clamp(JS.estimateSkew(small, 320), -15, 15);
    JS.invalidate(page);
    page.touched = true;
    return { found: !!quad, skew: page.fine };
  };

  /**
   * Apply cleanup for the current mode without touching tone choice.
   * Auto clean owns only shadow flattening, threshold bias and sharpening.
   * Colour/tone controls, selected mode and chip-toggle history belong to the
   * user and survive the button.
   */
  JS.autoEnhance = function (page) {
    var d = JS.MODE_DEFAULTS[page.mode] || JS.MODE_DEFAULTS.original;
    page.adj.flat = d.flat;
    page.adj.thr = d.thr;
    page.adj.sharp = d.sharp;
    page.touched = true;
    JS.invalidate(page);
  };

  /**
   * Pick a mode from the page's shape. A long narrow strip is nearly always a
   * receipt, which wants the more aggressive treatment.
   */
  JS.suggestMode = function (page) {
    var oc = JS.orientedCanvas(page, JS.PREVIEW_MAX);
    var q = JS.getCornersPx(page, oc);
    var w = Math.max(JS.dist(q[0], q[1]), JS.dist(q[3], q[2]));
    var h = Math.max(JS.dist(q[0], q[3]), JS.dist(q[1], q[2]));
    if (w < 1 || h < 1) return 'auto';
    return Math.max(w, h) / Math.min(w, h) > 2.1 ? 'receipt' : 'auto';
  };

  /**
   * Crop, then clean in whichever mode the page is already in. Both halves.
   *
   * It deliberately does not choose a mode. It used to: it read the page's
   * shape, and on a long narrow strip switched the page to Receipt. That made
   * the shape reading the only route into Receipt, so removing it would have
   * put the mode out of reach — hence the chip, which is the honest way to pick
   * a look. What is left is the division the two buttons always wanted: Auto
   * crop finds the page, Auto all finds it and cleans it, and neither second-
   * guesses the mode.
   *
   * The detect result is what makes the hint honest: this can come back having
   * found the page or having found nothing, and the caller cannot tell the two
   * apart from `mode` alone — the mode is unchanged either way. Returning the
   * mode it *applied* is still what the hint needs to name the tone.
   */
  JS.autoAll = async function (page) {
    var res = await JS.autoDetect(page);
    JS.autoEnhance(page);
    return { found: res.found, skew: res.skew, mode: page.mode };
  };

})(window.JS);
