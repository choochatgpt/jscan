/* js/75-learn-mask.js — the redaction mask for "Learn". The privacy-critical half.
 *
 * WHY THIS FILE EXISTS SEPARATELY, AND WHY IT IS THE RISKY PART
 * -------------------------------------------------------------
 * Everything else in Learn can fail visibly. Redaction can fail INVISIBLY: the user
 * brushes out a name, sees it covered on screen, and an uncovered name rides to
 * GitHub in the exported bytes. So the coordinate space is chosen to make that class
 * of bug structurally impossible rather than merely tested-for.
 *
 * THE SPACE: normalised ORIENTED-SOURCE coordinates — (0..1, 0..1) over the canvas
 * returned by JS.orientedCanvas(page, maxDim), i.e. the source after the coarse
 * rotation and before the crop quad. NOT the rectified/finished-page space, and not
 * raw source pixels.
 *
 *   * It is resolution-independent, so one mask paints identically at the 900px
 *     preview and at the 2400px work size.
 *   * It is crop-independent, and that is the entire point. before.jpg and after.jpg
 *     are DIFFERENT crops of the same photograph. A mask stored in finished-page
 *     space lands correctly on one image and somewhere else entirely on the other —
 *     a name covered in the before-image and bare in the after-image.
 *
 * THE GUARANTEE, which is stronger than "both mappings agree": we never map the mask
 * onto the two outputs at all. `redactedSource()` paints the strokes ONCE into the
 * oriented source, and BOTH images are then derived from that single painted canvas.
 * Identical redaction is therefore true by construction; there is no second mapping
 * that could disagree.
 *
 * THE CACHE TRAP: JS.stateKey (js/30-pipeline.js) enumerates coarse|fine|corners|
 * mode|adj. A mask that is not folded into it is served a STALE cached canvas — the
 * user paints, the preview does not change, and the exported bytes differ from what
 * was on screen. Hence `mask.rev`, a counter bumped by every mutation, folded into
 * stateKey. A counter rather than a coordinate hash: it is O(1), and it changes
 * exactly when the mask changes, so it cannot go stale by a coordinate that rounds
 * the same.
 *
 * NO DOM AT LOAD TIME, same discipline as js/70-learn.js: this file is loaded and
 * unit-tested in Node. `document` is touched only inside functions that need it.
 */
(function (global) {
  'use strict';

  var JS = global.JS = global.JS || {};

  /* Brush size as a fraction of the oriented source's SHORTER side, so a stroke covers
   * the same physical part of the page whatever the resolution. Roughly a fingertip. */
  var DEFAULT_RADIUS = 0.022;
  var MIN_RADIUS = 0.006;
  var MAX_RADIUS = 0.10;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /**
   * A mask is a list of strokes plus a revision counter.
   *   stroke = { r: radius (normalised), pts: [{x,y}, ...] (normalised) }
   */
  function create() {
    return { strokes: [], rev: 1, radius: DEFAULT_RADIUS };
  }

  function setRadius(mask, r) {
    mask.radius = clamp(Number(r) || DEFAULT_RADIUS, MIN_RADIUS, MAX_RADIUS);
    mask.rev++;
    return mask.radius;
  }

  function beginStroke(mask, x, y) {
    mask.strokes.push({ r: mask.radius, pts: [{ x: x, y: y }] });
    mask.rev++;
    return mask.strokes[mask.strokes.length - 1];
  }

  function extendStroke(mask, stroke, x, y) {
    if (!stroke) return;
    var last = stroke.pts[stroke.pts.length - 1];
    // Skip sub-pixel jitter: it bloats the manifest and changes nothing on screen.
    if (last && Math.abs(last.x - x) < 0.0008 && Math.abs(last.y - y) < 0.0008) return;
    stroke.pts.push({ x: x, y: y });
    mask.rev++;
  }

  function clear(mask) {
    mask.strokes = [];
    mask.rev++;
    return mask;
  }

  function isEmpty(mask) { return !mask || !mask.strokes.length; }

  function strokeCount(mask) { return mask && mask.strokes ? mask.strokes.length : 0; }

  /** Folded into JS.stateKey so the render cache cannot serve an unredacted canvas. */
  function key(mask) { return mask ? 'm' + mask.rev : 'n'; }

  /* ------------------------------------------------------------------ painting */

  /**
   * Rasterise the mask onto a 2D context covering w x h pixels of the ORIENTED SOURCE.
   * Opaque black, round caps and joins, so a stroke reads as a deliberate redaction
   * rather than a smudge — and so nothing underneath is legible at the edges, which
   * is where a thin brush leaks an outline of what it covers.
   */
  function paint(ctx, mask, w, h) {
    if (isEmpty(mask)) return 0;
    var s = Math.min(w, h);
    var drawn = 0;
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (var i = 0; i < mask.strokes.length; i++) {
      var st = mask.strokes[i];
      var rad = Math.max(1, st.r * s);
      if (st.pts.length === 1) {
        var p0 = st.pts[0];
        ctx.beginPath();
        ctx.arc(p0.x * w, p0.y * h, rad, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.lineWidth = rad * 2;
        ctx.beginPath();
        ctx.moveTo(st.pts[0].x * w, st.pts[0].y * h);
        for (var j = 1; j < st.pts.length; j++) ctx.lineTo(st.pts[j].x * w, st.pts[j].y * h);
        ctx.stroke();
      }
      drawn++;
    }
    ctx.restore();
    return drawn;
  }

  /* ------------------------------------------------------------------ redaction */

  /**
   * The oriented source with the mask burned in. This is the ONE place redaction is
   * applied; both exported images descend from the result.
   * Returns a canvas, or null when there is nothing to redact.
   */
  function redactedSource(page, mask, maxDim) {
    if (isEmpty(mask)) return null;
    if (typeof document === 'undefined') return null;
    var src = JS.orientedCanvas(page, maxDim || JS.WORK_MAX);
    if (!src) return null;
    var out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    var ctx = out.getContext('2d');
    ctx.drawImage(src, 0, 0);
    paint(ctx, mask, out.width, out.height);
    return out;
  }

  /**
   * A page-like object whose source IS the redacted image, oriented, with the original
   * crop quad preserved. Feed this to JS.renderPage to get after.jpg, and to
   * JS.canvasToBlob on `redactedSource` itself for before.jpg.
   *
   * The quad needs no remapping: the mask lives in oriented-source space, which is the
   * same space the quad already lives in (see js/30-pipeline.js:151), and the redacted
   * canvas is that same space at the same pixel size. That is the whole reason this
   * space was chosen.
   */
  function redactedPage(page, mask, maxDim) {
    var canvas = redactedSource(page, mask, maxDim);
    if (!canvas) return Promise.resolve(null);
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) { reject(new Error('redact: toBlob failed')); return; }
        var url = global.URL.createObjectURL(blob);
        var img = new global.Image();
        img.onload = function () {
          resolve({
            id: page.id,
            name: page.name,
            source: img,
            w: canvas.width,
            h: canvas.height,
            coarse: 0,                 // already oriented; re-rotating would undo it
            fine: page.fine,           // retained for the manifest, folded in below
            corners: page.corners ? page.corners.map(function (p) { return { x: p.x, y: p.y }; }) : null,
            mode: page.mode,
            modeTap: page.modeTap,
            modeBack: page.modeBack,
            adj: page.adj,
            touched: true,
            bakedMode: '',
            _bakedKey: '',
            _oriented: {}, _rects: {}, _thumb: null, _thumbKey: '',
            _redactedUrl: url
          });
        };
        img.onerror = function () { reject(new Error('redact: image decode failed')); };
        img.src = url;
      }, 'image/png');
    });
  }

  function releaseRedacted(tempPage) {
    if (tempPage && tempPage._redactedUrl) {
      try { global.URL.revokeObjectURL(tempPage._redactedUrl); } catch (e) { /* already gone */ }
      tempPage._redactedUrl = '';
    }
  }

  /** What the manifest records. Counts and a note, never the stroke coordinates. */
  function describe(mask) {
    var pts = 0;
    if (mask && mask.strokes) {
      for (var i = 0; i < mask.strokes.length; i++) pts += mask.strokes[i].pts.length;
    }
    return {
      tool: 'brush',
      space: 'oriented_source_normalised',
      strokes: strokeCount(mask),
      points: pts,
      revision: mask ? mask.rev : 0
    };
  }

  JS.learnMask = {
    DEFAULT_RADIUS: DEFAULT_RADIUS, MIN_RADIUS: MIN_RADIUS, MAX_RADIUS: MAX_RADIUS,
    create: create, setRadius: setRadius,
    beginStroke: beginStroke, extendStroke: extendStroke,
    clear: clear, isEmpty: isEmpty, strokeCount: strokeCount, key: key,
    paint: paint, redactedSource: redactedSource, redactedPage: redactedPage,
    releaseRedacted: releaseRedacted, describe: describe
  };
})(typeof window !== 'undefined' ? window : globalThis);
