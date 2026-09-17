/* ==========================================================================
   10-imageops.js — pixel-level image processing
   Everything here operates on plain typed arrays so it stays fast on phones.
   ========================================================================== */
'use strict';

(function (JS) {

  /* ---------------------------------------------------------------- basics */

  /** RGB ImageData -> single-channel Uint8Array luminance. */
  JS.toGray = function (data, w, h) {
    var n = w * h, g = new Uint8Array(n);
    for (var i = 0, j = 0; j < n; i += 4, j++) {
      g[j] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    }
    return g;
  };

  /**
   * Otsu's method.
   *
   * Returns the *last bin of the darker class*, so the correct reading is
   * `v <= t` is dark and `v > t` is light. (Using `<` here misclassifies a
   * perfectly bimodal image, where the optimum lands exactly on the dark peak.)
   */
  JS.otsu = function (gray) {
    var hist = new Uint32Array(256), i;
    for (i = 0; i < gray.length; i++) hist[gray[i]]++;
    var total = gray.length;
    var sum = 0;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, best = 0, thr = 128;
    for (i = 0; i < 256; i++) {
      wB += hist[i];
      if (wB === 0) continue;
      var wF = total - wB;
      if (wF === 0) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = i; }
    }
    return thr;
  };

  /**
   * Summed-area table. Returns a Float64Array of (w+1)*(h+1) with a zero
   * first row/column so window sums need no bounds branching.
   *
   * `sq` builds the table of *squared* values instead, which is what a window's
   * standard deviation is read from. Squares of 0..255 sum exactly in a double
   * far past any phone photo — 255² × 12M is 7.8e11 against a 9.0e15 ceiling —
   * so the subtraction in `JS.sauvolaThreshold` below loses nothing.
   */
  JS.integral = function (gray, w, h, sq) {
    var st = w + 1;
    var I = new Float64Array(st * (h + 1));
    for (var y = 0; y < h; y++) {
      var rowsum = 0, src = y * w, cur = (y + 1) * st, prev = y * st;
      for (var x = 0; x < w; x++) {
        var v = gray[src + x];
        rowsum += sq ? v * v : v;
        I[cur + x + 1] = I[prev + x + 1] + rowsum;
      }
    }
    return I;
  };

  /** Sum over the inclusive rectangle [x1..x2] x [y1..y2] using an integral. */
  JS.rectSum = function (I, st, x1, y1, x2, y2) {
    return I[(y2 + 1) * st + (x2 + 1)] - I[y1 * st + (x2 + 1)]
         - I[(y2 + 1) * st + x1] + I[y1 * st + x1];
  };

  /* --------------------------------------------------- document algorithms */

  /**
   * Bradley–Roth adaptive threshold.
   * Each pixel is compared with the mean of its (2r+1)² neighbourhood scaled by
   * (1 - t). Handles the uneven lighting of a phone photo far better than a
   * single global threshold, which is exactly what OCR needs.
   *
   * `bias` shifts the threshold (positive = lighter / less ink).
   *
   * `floor` is an absolute cut-off. A purely local rule whitens the interior of
   * any dark region wider than the window — a filled logo, a barcode, a heavy
   * rule — because there the local mean equals the pixel itself. Anything
   * darker than `floor` is called ink regardless of its surroundings.
   */
  JS.adaptiveThreshold = function (gray, w, h, radius, t, bias, floor) {
    var I = JS.integral(gray, w, h), st = w + 1;
    var out = new Uint8Array(w * h);
    var r = Math.max(1, radius | 0);
    bias = bias || 0;
    floor = floor || 0;
    for (var y = 0; y < h; y++) {
      var y1 = y - r < 0 ? 0 : y - r;
      var y2 = y + r >= h ? h - 1 : y + r;
      var rowBase = y * w;
      for (var x = 0; x < w; x++) {
        var x1 = x - r < 0 ? 0 : x - r;
        var x2 = x + r >= w ? w - 1 : x + r;
        var count = (x2 - x1 + 1) * (y2 - y1 + 1);
        var mean = JS.rectSum(I, st, x1, y1, x2, y2) / count;
        var v = gray[rowBase + x];
        out[rowBase + x] = (v < mean * (1 - t) + bias || v < floor) ? 0 : 255;
      }
    }
    return out;
  };

  /**
   * Sauvola local threshold — Bradley's test with the local *contrast* added.
   *
   * Bradley compares a pixel against the mean of its neighbourhood, so it
   * decides on brightness alone. That is enough for a hard-edged scan and not
   * enough for a photograph of faint or slightly blurred print: every stroke is
   * a grey ramp there, the ramp's shoulders sit on the wrong side of one fixed
   * fraction of the mean, and a letter comes back in pieces — which is the
   * "words get broken after cleaning" the button was reported for.
   *
   * Sauvola's threshold is `T = m · (1 + k · (s / R − 1))` for a window with
   * mean `m` and standard deviation `s`, with `R` the dynamic range of a grey
   * level (128). Read it at the two ends:
   *
   *   s → R   a window full of both ink and paper — a stroke runs through it —
   *           and `T` rises towards `m`, so the whole ramp down to the local
   *           average is called ink. Thin strokes keep their edges.
   *   s → 0   a window that is flat: bare paper, a shadow, a smudge. `T` falls
   *           to `m · (1 − k)`, which is exactly Bradley's rule, so nothing that
   *           was clean before becomes speckled now.
   *
   * So `k` is Bradley's `t`, and this is never stricter than Bradley with the
   * same setting — it only ever adds the ink a busy window justifies. Everything
   * below `m · (1 − k)` is unchanged, which is why the two agree on a crisp page
   * and part company on a soft one.
   *
   * `bias` and `floor` mean what they mean in `JS.adaptiveThreshold`: the same
   * "+ text weight" offset, and the same absolute cut-off that keeps a solid
   * dark area — a logo, a barcode, a heavy rule — filled in, since there the
   * window is uniformly dark, `s` collapses, and the local rule alone would
   * whiten the middle of it.
   */
  JS.sauvolaThreshold = function (gray, w, h, radius, k, bias, floor) {
    var I = JS.integral(gray, w, h, false), st = w + 1;
    var I2 = JS.integral(gray, w, h, true);
    var out = new Uint8Array(w * h);
    var r = Math.max(1, radius | 0);
    var R = 128;
    bias = bias || 0;
    floor = floor || 0;
    for (var y = 0; y < h; y++) {
      var y1 = y - r < 0 ? 0 : y - r;
      var y2 = y + r >= h ? h - 1 : y + r;
      var rowBase = y * w;
      for (var x = 0; x < w; x++) {
        var x1 = x - r < 0 ? 0 : x - r;
        var x2 = x + r >= w ? w - 1 : x + r;
        var count = (x2 - x1 + 1) * (y2 - y1 + 1);
        var mean = JS.rectSum(I, st, x1, y1, x2, y2) / count;
        // E[x²] − E[x]², which rounding can push a hair below zero on a window
        // that is genuinely flat.
        var varc = JS.rectSum(I2, st, x1, y1, x2, y2) / count - mean * mean;
        var std = varc > 0 ? Math.sqrt(varc) : 0;
        var t = mean * (1 + k * (std / R - 1));
        var v = gray[rowBase + x];
        out[rowBase + x] = (v < t + bias || v < floor) ? 0 : 255;
      }
    }
    return out;
  };

  /**
   * Illumination flattening / shadow removal.
   * Estimates the local background with a large box blur and divides it out, so
   * a shadow across the page stops being a dark band and becomes uniform white.
   * `strength` 0..1 blends between the original and the fully flattened result.
   */
  JS.flattenBackground = function (gray, w, h, radius, strength) {
    var I = JS.integral(gray, w, h), st = w + 1;
    var out = new Uint8Array(w * h);
    var r = Math.max(2, radius | 0);
    for (var y = 0; y < h; y++) {
      var y1 = y - r < 0 ? 0 : y - r;
      var y2 = y + r >= h ? h - 1 : y + r;
      for (var x = 0; x < w; x++) {
        var x1 = x - r < 0 ? 0 : x - r;
        var x2 = x + r >= w ? w - 1 : x + r;
        var count = (x2 - x1 + 1) * (y2 - y1 + 1);
        var bg = JS.rectSum(I, st, x1, y1, x2, y2) / count;
        if (bg < 1) bg = 1;
        var v = gray[y * w + x] * 255 / bg;
        if (v > 255) v = 255;
        // Blend towards the flattened value.
        out[y * w + x] = gray[y * w + x] + (v - gray[y * w + x]) * strength;
      }
    }
    return out;
  };

  /**
   * Ceiling on how far a shadow may be lifted, as a gain on the pixel value.
   * Paper under a real shadow is maybe three times darker than lit paper, so a
   * cap of ~3 covers the shadows that matter while refusing to turn a solid
   * black logo white. The colour-mode counterpart of the adaptive threshold's
   * absolute floor.
   */
  JS.SHADOW_GAIN_MAX = 3.2;

  /**
   * Illumination flattening for a colour buffer, in place. The same idea as
   * `flattenBackground`, extended to RGB.
   *
   * The estimate is taken from luminance and every channel is divided by that
   * one gain, so a shadow lifts without dragging the colour along with it.
   * Dividing each channel by its own local mean would instead flatten a
   * shadowed red stamp into a grey one — the cast being removed is the
   * *illumination*, not the ink.
   */
  JS.flattenRGB = function (data, w, h, radius, strength) {
    if (!(strength > 0)) return data;
    var gray = JS.toGray(data, w, h);
    var I = JS.integral(gray, w, h), st = w + 1;
    var r = Math.max(2, radius | 0);
    var cap = JS.SHADOW_GAIN_MAX;

    for (var y = 0; y < h; y++) {
      var y1 = y - r < 0 ? 0 : y - r;
      var y2 = y + r >= h ? h - 1 : y + r;
      for (var x = 0; x < w; x++) {
        var x1 = x - r < 0 ? 0 : x - r;
        var x2 = x + r >= w ? w - 1 : x + r;
        var count = (x2 - x1 + 1) * (y2 - y1 + 1);
        var bg = JS.rectSum(I, st, x1, y1, x2, y2) / count;
        if (bg < 1) bg = 1;
        var k = 255 / bg;
        if (k > cap) k = cap;
        // Blend the gain back towards 1 so `strength` still means something.
        var gain = 1 + (k - 1) * strength;
        var o = (y * w + x) << 2;
        var v = data[o] * gain;     data[o]     = v > 255 ? 255 : v;
        v = data[o + 1] * gain;     data[o + 1] = v > 255 ? 255 : v;
        v = data[o + 2] * gain;     data[o + 2] = v > 255 ? 255 : v;
      }
    }
    return data;
  };

  /**
   * Separable box blur of radius `r` on a single-channel buffer.
   *
   * Two sliding windows rather than an integral image: the radius here is sized
   * from the buffer (see JS.SHARP_RADIUS_DIV), so on a 2400px export it reaches
   * five pixels, and an integral of that buffer is a 61MB Float64Array. The
   * sliding sum is the same O(n) for a window's worth of memory.
   */
  JS.blurGray = function (src, w, h, radius) {
    var r = Math.max(1, radius | 0);
    var tmp = new Float32Array(w * h), out = new Uint8Array(w * h);
    var x, y, sum, n, row, add, drop, base;
    for (y = 0; y < h; y++) {
      row = y * w;
      sum = 0; n = 0;
      for (x = 0; x <= r && x < w; x++) { sum += src[row + x]; n++; }
      for (x = 0; x < w; x++) {
        tmp[row + x] = sum / n;
        add = x + r + 1; drop = x - r;
        if (add < w) { sum += src[row + add]; n++; }
        if (drop >= 0) { sum -= src[row + drop]; n--; }
      }
    }
    for (x = 0; x < w; x++) {
      sum = 0; n = 0;
      for (y = 0; y <= r && y < h; y++) { sum += tmp[y * w + x]; n++; }
      for (y = 0; y < h; y++) {
        base = y * w + x;
        out[base] = sum / n;
        add = y + r + 1; drop = y - r;
        if (add < h) { sum += tmp[add * w + x]; n++; }
        if (drop >= 0) { sum -= tmp[drop * w + x]; n--; }
      }
    }
    return out;
  };

  /**
   * Flip isolated pixels so black-and-white output has no salt-and-pepper
   * speckle. Only pixels differing from *every* neighbour are changed, so thin
   * strokes survive.
   */
  JS.despeckle = function (bw, w, h) {
    var out = new Uint8Array(bw);
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var i = y * w + x, v = bw[i], same = 0;
        if (bw[i - 1] === v) same++;
        if (bw[i + 1] === v) same++;
        if (bw[i - w] === v) same++;
        if (bw[i + w] === v) same++;
        if (bw[i - w - 1] === v) same++;
        if (bw[i - w + 1] === v) same++;
        if (bw[i + w - 1] === v) same++;
        if (bw[i + w + 1] === v) same++;
        if (same === 0) out[i] = v ? 0 : 255;
      }
    }
    return out;
  };

  /* --------------------------------------------------------- tone / colour */

  /** How far the paper white balance is allowed to move a channel. */
  JS.PAPER_WB_MAX = 1.55;

  /** Where in each channel's histogram the paper is read from. */
  JS.PAPER_WB_PCT = 0.90;

  /**
   * Paper white balance, in place. This is what actually takes the yellow out.
   *
   * `autoLevelsLUTs` below is the *other* colour control, and on a real
   * photograph it cannot do this job. Its stretch is affine per channel, so it
   * can neutralise the ink end of the histogram or the paper end, not both —
   * the cast measured on a real page is multiplicative in the highlights and
   * additive at the black point — and once `flattenRGB` has run, the paper's
   * blue sits clipped behind a (255,255,255) highlight with nothing left to
   * correct against. Measured on a photograph of a page with a warm cast
   * multiplied onto it (paper R-B +53.7):
   *
   *     flatten, then levels, wb 70     +46.2
   *     flatten, then levels, wb 100    +46.0     the slider does nothing
   *     levels alone, wb 100            +35.6
   *
   * So the paper is made the reference instead, which is what it is for: on a
   * document it is most of the pixels and it is meant to be white. Read its
   * colour at a high percentile per channel, take the gains that would make it
   * neutral, and apply them. The gains are normalised through the paper's own
   * luminance, so this removes the *colour* of the light without darkening the
   * page. `strength` blends them towards 1, so 0 is exactly the old behaviour
   * and the slider still means something.
   *
   * The clamp is what keeps it honest when there is no white reference to find:
   * a full-bleed colour brochure has no paper in it, and without a limit the
   * gains would be whatever its brightest artwork happened to be.
   */
  JS.paperWhiteBalance = function (data, strength) {
    if (!(strength > 0)) return data;
    var hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    var n = data.length / 4, i, c;
    for (i = 0; i < data.length; i += 4) {
      hist[0][data[i]]++; hist[1][data[i + 1]]++; hist[2][data[i + 2]]++;
    }
    var paper = [];
    for (c = 0; c < 3; c++) paper.push(JS.histPercentile(hist[c], n, JS.PAPER_WB_PCT));
    var y = JS.luma(paper[0], paper[1], paper[2]);

    var gains = [1, 1, 1], moved = false;
    for (c = 0; c < 3; c++) {
      if (paper[c] < 1) continue;            // a black frame has no reference
      var g = JS.clamp(y / paper[c], 1 / JS.PAPER_WB_MAX, JS.PAPER_WB_MAX);
      gains[c] = 1 + (g - 1) * strength;
      if (gains[c] !== 1) moved = true;
    }
    if (!moved) return data;

    var gr = gains[0], gg = gains[1], gb = gains[2], v;
    for (i = 0; i < data.length; i += 4) {
      v = data[i] * gr;         data[i]     = v > 255 ? 255 : v;
      v = data[i + 1] * gg;     data[i + 1] = v > 255 ? 255 : v;
      v = data[i + 2] * gb;     data[i + 2] = v > 255 ? 255 : v;
    }
    return data;
  };

  /**
   * Per-channel percentile stretch ("auto levels").
   * Also computes a luminance stretch and blends the two, which removes a
   * colour cast (tungsten yellow, fluorescent green) without destroying
   * genuinely coloured content such as a red stamp or a logo.
   *
   * Returns { lutR, lutG, lutB }.
   */
  JS.autoLevelsLUTs = function (data, colorStrength) {
    var hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    var histY = new Uint32Array(256);
    var n = data.length / 4, i, c;
    for (i = 0; i < data.length; i += 4) {
      hist[0][data[i]]++; hist[1][data[i + 1]]++; hist[2][data[i + 2]]++;
      histY[(data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 | 0]++;
    }
    var loY = JS.histPercentile(histY, n, 0.004);
    var hiY = JS.histPercentile(histY, n, 0.996);
    if (hiY - loY < 12) { loY = 0; hiY = 255; }

    var los = [], his = [];
    for (c = 0; c < 3; c++) {
      var lo = JS.histPercentile(hist[c], n, 0.004);
      var hi = JS.histPercentile(hist[c], n, 0.996);
      if (hi - lo < 12) { lo = loY; hi = hiY; }
      los.push(lo + (loY - lo) * (1 - colorStrength));
      his.push(hi + (hiY - hi) * (1 - colorStrength));
    }

    function mk(lo, hi) {
      var span = hi - lo;
      if (span < 1) span = 1;
      var scale = 255 / span;
      return JS.lut(function (v) { return (v - lo) * scale; });
    }
    return { lutR: mk(los[0], his[0]), lutG: mk(los[1], his[1]), lutB: mk(los[2], his[2]) };
  };

  /** Classic contrast curve around mid-grey. `amount` in -100..100. */
  JS.contrastLUT = function (amount) {
    var c = JS.clamp(amount, -100, 100) * 2.55;
    var f = (259 * (c + 255)) / (255 * (259 - c));
    return JS.lut(function (v) { return f * (v - 128) + 128; });
  };

  JS.brightnessLUT = function (amount) {
    var b = JS.clamp(amount, -100, 100) * 1.28;
    return JS.lut(function (v) { return v + b; });
  };

  /** Warmth shifts red up and blue down (or the reverse when negative). */
  JS.warmthLUTs = function (amount) {
    var k = JS.clamp(amount, -100, 100) * 0.32;
    return {
      lutR: JS.lut(function (v) { return v + k; }),
      lutG: JS.lut(function (v) { return v + k * 0.15; }),
      lutB: JS.lut(function (v) { return v - k; })
    };
  };

  /**
   * How hard `amount` (0..100) pushes an edge. Shared by the two unsharp masks
   * below so that "sharpen 100" is the same strength in colour and in grey.
   */
  JS.SHARP_GAIN = 1.35;

  /**
   * The unsharp mask's blur radius, as a fraction of the buffer's long edge.
   *
   * A fixed radius is wrong here twice over.
   *
   * What a phone camera smears a stroke edge over is three or four pixels, and
   * the 3x3 box this used to be read a band finer than that — so it sharpened
   * grain rather than text, which is the opposite of the job. Measured on a page
   * blurred by 1.6px, sharpen 100, as acutance gain over the unsharpened render:
   * radius 1 gives +3.45, radius 3 gives +8.91. The mask was reading the wrong
   * band, and no amount of gain would have fixed that.
   *
   * And `enhance` runs at whatever size it is asked for — the preview caps at
   * 900px, the export at 2400px — so one fixed radius is 2.7x finer in document
   * terms on the page that gets saved than on the page that was tuned by eye.
   * Acutance gain at 900px against 2400px:
   *
   *     fixed 3x3       +6.2%   +3.5%    the export gets 57% of the preview
   *     r = dim/450    +11.2%  +11.4%    the two agree
   *
   * so the radius tracks the long edge and the preview stops lying about what
   * the export will look like.
   */
  JS.SHARP_RADIUS_DIV = 450;

  /** Blur radius in pixels for a w x h buffer, never less than one. */
  JS.unsharpRadius = function (w, h) {
    var r = Math.round((w > h ? w : h) / JS.SHARP_RADIUS_DIV);
    return r < 1 ? 1 : r;
  };

  /**
   * Unsharp mask on a single-channel buffer, in place. This is the form the
   * thresholding modes need: they have already thrown the colour away, and the
   * mask has to happen *before* the threshold rather than after it, because a
   * threshold is a decision per pixel and sharpening a binary image can only
   * thicken strokes that already crossed.
   */
  JS.unsharpGray = function (gray, w, h, amount) {
    if (amount <= 0) return gray;
    var a = amount / 100 * JS.SHARP_GAIN;
    var blur = JS.blurGray(gray, w, h, JS.unsharpRadius(w, h));
    for (var i = 0; i < gray.length; i++) {
      var v = gray[i] + (gray[i] - blur[i]) * a;
      gray[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    return gray;
  };

  /**
   * Unsharp mask. Blurs the luminance, then pushes each channel away from that
   * blur — the same delta added to all three, so edge definition comes back
   * without the colour moving. Recovers what a phone's noise reduction smears,
   * which measurably helps OCR.
   */
  JS.unsharp = function (data, w, h, amount) {
    if (amount <= 0) return;
    var a = amount / 100 * JS.SHARP_GAIN;
    var gray = JS.toGray(data, w, h);
    var blur = JS.blurGray(gray, w, h, JS.unsharpRadius(w, h));
    for (var i = 0, j = 0; j < gray.length; i += 4, j++) {
      var d = (gray[j] - blur[j]) * a;
      if (d === 0) continue;
      data[i]     = data[i] + d;
      data[i + 1] = data[i + 1] + d;
      data[i + 2] = data[i + 2] + d;
    }
  };

  /** Blend towards luminance. `amount` in -100..100. */
  JS.applySaturation = function (data, amount) {
    if (amount === 0) return;
    var s = 1 + JS.clamp(amount, -100, 100) / 100;
    for (var i = 0; i < data.length; i += 4) {
      var r = data[i], g = data[i + 1], b = data[i + 2];
      var y = r * 0.299 + g * 0.587 + b * 0.114;
      data[i]     = y + (r - y) * s;
      data[i + 1] = y + (g - y) * s;
      data[i + 2] = y + (b - y) * s;
    }
  };

  /** Apply three per-channel LUTs in one pass. */
  JS.applyLUTs = function (data, lutR, lutG, lutB) {
    for (var i = 0; i < data.length; i += 4) {
      data[i]     = lutR[data[i]];
      data[i + 1] = lutG[data[i + 1]];
      data[i + 2] = lutB[data[i + 2]];
    }
  };

  /** Write a single-channel buffer back out as neutral RGB. */
  JS.grayToRGB = function (data, gray) {
    for (var i = 0, j = 0; j < gray.length; i += 4, j++) {
      var v = gray[j];
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  };

})(window.JS);
