/* js/76-learn-ui.js — the Learn screen: warning, redaction brush, token entry, send.
 *
 * THE FLOW, and why it is in this order
 * -------------------------------------
 *   press Learn
 *     -> warning: what is about to be sent, in plain words, with no reassurance
 *     -> the photograph, with a brush already live, so the user redacts BEFORE
 *        anything can leave the device
 *     -> Send, enabled once they have either brushed or said there is nothing
 *        sensitive to brush
 *     -> only THEN, if this phone has no token: the token box. Asking for a
 *        credential up front would block the whole screen behind a GitHub errand
 *        and would hide the brush from anyone who has not set one up yet.
 *     -> the bundle id, and the PC's acknowledgement when it arrives
 *
 * REDAC TION HAPPENS BEFORE UPLOAD, ALWAYS. There is no path in this file that
 * sends an unredacted image, and there is no "redact later on the PC" mode: the
 * bytes leave the phone already covered. That is the only version of this feature
 * that is safe to build at all.
 *
 * WHY "NOTHING SENSITIVE" IS OFFERED ALONGSIDE THE BRUSH
 * ------------------------------------------------------
 * The instruction was "once i brush, allow the submit button". Forcing a stroke
 * would be worse than useless: a meaningless smear recorded as a redaction teaches
 * the PC nothing and corrupts the record of what was actually redacted. So Send
 * unlocks on either a real stroke or an explicit "nothing sensitive here" - both are
 * deliberate, neither is a silent default. The manifest distinguishes them.
 *
 * A CANVAS OUTSIDE #stage, ON PURPOSE
 * -----------------------------------
 * index.html:119 documents that the stage is allowed exactly one canvas, and the
 * checks that watch the stage count on it. The brush therefore lives on a canvas in
 * this modal, appended to <body>, never inside #stage.
 *
 * WHAT IS NOT TRACKED YET, AND WHY THAT MATTERS
 * ---------------------------------------------
 * The manifest wants `state` (refused / corrected / refused_then_corrected) derived
 * from whether the corners came from Auto crop or from the user's finger. `page.corners`
 * is written by BOTH (js/30-pipeline.js:349,697 auto; js/50-ui.js:586 manual) and
 * nothing records which. Rather than guess a label - a fabricated label is worse than
 * a missing one, because the PC would train on it - this sends
 * `state: 'manual_submit'` and `provenance: 'not_tracked_yet'`. Wiring that flag is
 * the immediate follow-up.
 */
(function (global) {
  'use strict';

  var JS = global.JS = global.JS || {};
  if (!JS.learn || !JS.learnMask) {
    // LOUD, not silent. This guard shipped silent in v1.8.0 with the js/70-learn.js script
    // tag missing from index.html: JS.learn was undefined, so this returned, no click
    // listener was ever attached to the Learn chip, and pressing it did nothing at all -
    // no dialog, no error, nothing to debug from. Staying inert is still the right
    // behaviour (better a dead chip than a half-wired one), but it must say so.
    if (global.console && global.console.error) {
      global.console.error('Learn: js/76-learn-ui.js needs JS.learn (js/70-learn.js) and ' +
        'JS.learnMask (js/75-learn-mask.js). Missing: ' +
        (!JS.learn ? 'JS.learn ' : '') + (!JS.learnMask ? 'JS.learnMask' : '') +
        '. Check the script tags in index.html.');
    }
    return;
  }

  var MAX_DISPLAY = 380;                     // the brush surface, CSS px
  var els = null;
  var state = null;

  /* ------------------------------------------------------------------- helpers */

  function h(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'style') n.setAttribute('style', attrs[k]);
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    if (text != null) n.textContent = text;
    return n;
  }

  function bytesOf(canvas, quality) {
    return JS.canvasToBlob(canvas, 'image/jpeg', quality === undefined ? 0.9 : quality)
      .then(function (blob) {
        if (!blob) throw new Error('could not encode the image');
        return blob.arrayBuffer();
      })
      .then(function (buf) { return new Uint8Array(buf); });
  }

  function fail(msg) {
    if (els && els.status) {
      els.status.textContent = msg;
      els.status.setAttribute('style', els.statusStyleErr);
    }
  }

  /* --------------------------------------------------------------------- modal */

  var CSS_OVERLAY =
    'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.88);color:#f4f4f4;' +
    'font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
    'display:flex;flex-direction:column;align-items:center;overflow:auto;padding:14px;' +
    'box-sizing:border-box;-webkit-user-select:none;user-select:none;touch-action:none';
  var CSS_BTN =
    'padding:12px 16px;border-radius:9px;border:1px solid #666;background:#262626;color:#f4f4f4;' +
    'font:inherit;font-weight:600;min-height:44px';
  var CSS_PRIMARY = CSS_BTN + ';background:#c2410c;border-color:#c2410c;color:#fff';

  function build() {
    if (els) return els;
    var overlay = h('div', { id: 'learn-overlay', style: CSS_OVERLAY, role: 'dialog',
                             'aria-modal': 'true', 'aria-label': 'Learn' });
    var title = h('div', { style: 'font-size:17px;font-weight:700;margin:2px 0 8px' }, 'Learn');
    var warn = h('div', {
      style: 'max-width:420px;background:#3a1d0d;border:1px solid #c2410c;border-radius:9px;' +
             'padding:11px 12px;margin-bottom:10px'
    });
    warn.appendChild(h('div', { style: 'font-weight:700;margin-bottom:5px' },
      'This sends the photo off this phone'));
    warn.appendChild(h('div', {}, 'It goes to your own private GitHub repository and is ' +
      'removed after your PC reads it. If this photo shows a name, IC, passport, medical ' +
      'result or anything else private, paint over it below first. That covering is burned ' +
      'into the picture itself before anything is sent.'));

    var canvasWrap = h('div', { style: 'position:relative;margin:2px 0 8px' });
    var canvas = h('canvas', {
      id: 'learn-brush', style: 'display:block;border-radius:8px;background:#111;' +
                                'touch-action:none;cursor:crosshair;max-width:100%'
    });
    canvasWrap.appendChild(canvas);

    var sized = h('label', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:10px' });
    sized.appendChild(h('span', {}, 'Brush'));
    var size = h('input', { id: 'learn-brush-size', type: 'range', min: '30', max: '160',
                            value: '60', style: 'width:150px' });
    sized.appendChild(size);

    var status = h('div', { id: 'learn-status',
      style: 'max-width:420px;min-height:20px;margin:2px 0 8px;opacity:.9' });

    var row = h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center' });
    var clear = h('button', { type: 'button', style: CSS_BTN }, 'Clear brush');
    var nothing = h('button', { type: 'button', style: CSS_BTN }, 'Nothing sensitive here');
    var cancel = h('button', { type: 'button', style: CSS_BTN }, 'Cancel');
    var send = h('button', { type: 'button', style: CSS_PRIMARY, disabled: 'disabled' }, 'Send');

    row.appendChild(clear); row.appendChild(nothing); row.appendChild(cancel); row.appendChild(send);
    overlay.appendChild(title); overlay.appendChild(warn); overlay.appendChild(canvasWrap);
    overlay.appendChild(sized); overlay.appendChild(status); overlay.appendChild(row);
    document.body.appendChild(overlay);

    els = {
      overlay: overlay, title: title, warn: warn, canvas: canvas, size: size,
      status: status, clear: clear, nothing: nothing, cancel: cancel, send: send,
      statusStyle: status.getAttribute('style'),
      statusStyleErr: status.getAttribute('style') + ';color:#fca5a5;font-weight:600'
    };
    return els;
  }

  /* ------------------------------------------------------------------- brushes */

  function drawStroke(ctx, st, w, hh) {
    var s = Math.min(w, hh), rad = Math.max(1, st.r * s);
    ctx.save();
    ctx.fillStyle = '#000'; ctx.strokeStyle = '#000';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (st.pts.length === 1) {
      ctx.beginPath(); ctx.arc(st.pts[0].x * w, st.pts[0].y * hh, rad, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.lineWidth = rad * 2; ctx.beginPath();
      ctx.moveTo(st.pts[0].x * w, st.pts[0].y * hh);
      for (var i = 1; i < st.pts.length; i++) ctx.lineTo(st.pts[i].x * w, st.pts[i].y * hh);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* Redraw from the source plus the mask, never incrementally: an incremental draw
   * would leave the user unable to see what Clear actually removes. */
  function repaint() {
    var c = els.canvas, ctx = c.getContext('2d'), s = state;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(s.oriented, 0, 0, c.width, c.height);
    for (var i = 0; i < s.mask.strokes.length; i++) drawStroke(ctx, s.mask.strokes[i], c.width, c.height);
  }

  function refreshButtons() {
    if (!state) { els.send.disabled = true; return; }
    var ok = !JS.learnMask.isEmpty(state.mask) || state.declaredNothing;
    els.send.disabled = !ok || state.busy;
    els.nothing.textContent = state.declaredNothing ? 'Nothing sensitive ✓' : 'Nothing sensitive here';
    els.clear.disabled = JS.learnMask.isEmpty(state.mask) || state.busy;
  }

  function wireBrush() {
    var c = els.canvas, live = null;
    function norm(ev) {
      var r = c.getBoundingClientRect();
      return {
        x: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)),
        y: Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))
      };
    }
    c.addEventListener('pointerdown', function (ev) {
      if (state.busy) return;
      ev.preventDefault();
      try { c.setPointerCapture(ev.pointerId); } catch (e) { /* not fatal */ }
      var q = norm(ev);
      live = JS.learnMask.beginStroke(state.mask, q.x, q.y);
      state.declaredNothing = false;
      repaint(); refreshButtons();
    });
    c.addEventListener('pointermove', function (ev) {
      if (!live || state.busy) return;
      ev.preventDefault();
      var q = norm(ev);
      var before = JS.learnMask.strokeCount(state.mask) + state.mask.strokes[0].pts.length;
      JS.learnMask.extendStroke(state.mask, live, q.x, q.y);
      // Only repaint when a point was actually added: pointermove fires far more often
      // than the mask changes, and repainting the full image per event janks the brush.
      var after = JS.learnMask.strokeCount(state.mask) + state.mask.strokes[0].pts.length;
      if (after !== before) {
        var st = live;
        var ctx = c.getContext('2d');
        drawStroke(ctx, { r: st.r, pts: st.pts.slice(-2) }, c.width, c.height);
      }
    });
    function end() { live = null; repaint(); refreshButtons(); }
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', function () { if (live) { live = null; refreshButtons(); } });
  }

  /* --------------------------------------------------------------------- token */

  function showTokenEntry() {
    els.warn.setAttribute('style', 'display:none');
    els.canvas.parentNode.setAttribute('style', 'display:none');
    els.size.parentNode.setAttribute('style', 'display:none');
    els.clear.setAttribute('style', 'display:none');
    els.nothing.setAttribute('style', 'display:none');
    els.title.textContent = 'Learn — one-time setup';
    els.status.textContent = 'Paste your GitHub token for this phone. It is stored in this ' +
      'browser only, and never leaves it except to GitHub.';

    var wrap = h('div', { style: 'max-width:420px;display:flex;flex-direction:column;gap:9px' });
    var input = h('input', {
      id: 'learn-token', type: 'password', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'github_pat_…',
      style: 'padding:11px;border-radius:9px;border:1px solid #666;background:#1b1b1b;' +
             'color:#f4f4f4;font:inherit;width:100%;box-sizing:border-box'
    });
    var save = h('button', { type: 'button', style: CSS_PRIMARY }, 'Save on this phone');
    wrap.appendChild(input); wrap.appendChild(save);
    wrap.appendChild(h('div', { style: 'opacity:.75;font-size:12.5px' },
      'Steps: on this phone open github.com/settings/personal-access-tokens/new, scope it to ' +
      'ask-ai-relay only, Contents: read and write, Issues: read.'));

    save.addEventListener('click', function () {
      var v = (input.value || '').trim();
      if (v.length < 20) { fail('That does not look like a token.'); return; }
      if (!JS.learn.setToken(v)) { fail('This browser refused to store it (private mode?).'); return; }
      input.value = '';
      els.status.textContent = 'Token saved on this phone.';
      els.status.setAttribute('style', els.statusStyle);
      els.overlay.removeChild(wrap);
      resetForPhoto();
      // Continue the send they already asked for, but only if they had actually
      // prepared something - a stray Send must not post an unredacted photo.
      if (!JS.learnMask.isEmpty(state.mask) || state.declaredNothing) send();
    });

    els.overlay.insertBefore(wrap, els.status);
  }

  /* ---------------------------------------------------------------------- open */

  function resetForPhoto() {
    els.title.textContent = 'Learn';
    els.warn.setAttribute('style', els.warn.getAttribute('style'));
    els.canvas.parentNode.setAttribute('style', 'position:relative;margin:2px 0 8px');
    els.size.parentNode.setAttribute('style', 'display:flex;align-items:center;gap:10px;margin-bottom:10px');
    els.clear.setAttribute('style', CSS_BTN);
    els.nothing.setAttribute('style', CSS_BTN);
    els.status.textContent = '';
    els.status.setAttribute('style', els.statusStyle);
    els.send.textContent = 'Send';
    els.send.disabled = true;
    els.busy = false;
    refreshButtons();
  }

  function open() {
    var page = JS.activePage && JS.activePage();
    if (!page) return false;
    build();
    // Wired here rather than at load: building the overlay at load time would add
    // nodes to the initial DOM, and the DOM checks count on what is there.
    if (!els._wired) { wire(); els._wired = true; }
    resetForPhoto();

    var oriented = JS.orientedCanvas(page, JS.WORK_MAX);
    if (!oriented) { fail('Could not read this photo.'); return false; }

    // Fit the brush surface to the screen while keeping the aspect ratio, so what the
    // user paints is a faithful miniature of the pixels that will be redacted.
    var scale = Math.min(MAX_DISPLAY / oriented.width, (global.innerHeight * 0.5) / oriented.height, 1);
    els.canvas.width = Math.max(1, Math.round(oriented.width * scale));
    els.canvas.height = Math.max(1, Math.round(oriented.height * scale));

    state = {
      page: page,
      oriented: oriented,
      mask: JS.learnMask.create(),
      declaredNothing: false,
      busy: false
    };
    JS.learnMask.setRadius(state.mask, Number(els.size.value) / 1000);
    els.size.oninput = function () { JS.learnMask.setRadius(state.mask, Number(els.size.value) / 1000); };
    if (!els._brushWired) { wireBrush(); els._brushWired = true; }

    els.overlay.setAttribute('style', CSS_OVERLAY);
    repaint();
    refreshButtons();
    // The token is asked for at Send, not here: the brush has to be reachable
    // without one, both so the screen is not gated behind a GitHub errand and so
    // the redaction can be tried before any credential exists on the phone.
    if (!JS.learn.hasToken()) {
      els.status.textContent = 'Redact anything private, then press Send — it will ask for ' +
        'your GitHub token the first time.';
    }
    return true;
  }

  function close() { if (els) els.overlay.setAttribute('style', 'display:none'); }

  /* ---------------------------------------------------------------------- send */

  function send() {
    if (!state || state.busy) return;
    if (!JS.learn.hasToken()) { showTokenEntry(); return; }
    state.busy = true;
    refreshButtons();
    els.status.setAttribute('style', els.statusStyle);

    var mask = state.mask, page = state.page;
    var redacted = !JS.learnMask.isEmpty(mask);
    els.status.textContent = redacted ? 'Burning the covering into the images…'
                                      : 'Preparing the images…';

    // ONE painted canvas feeds BOTH images, so the redaction cannot differ between
    // them (see js/75-learn-mask.js, and note before.jpg and after.jpg are different
    // crops of the same photograph).
    var beforeCanvas = JS.learnMask.redactedSource(page, mask, JS.WORK_MAX) ||
                       JS.orientedCanvas(page, JS.WORK_MAX);

    JS.learnMask.redactedPage(page, mask, JS.WORK_MAX).then(function (temp) {
      var afterCanvas = temp ? JS.renderPage(temp, JS.WORK_MAX) : JS.renderPage(page, JS.WORK_MAX);
      return Promise.all([bytesOf(beforeCanvas), bytesOf(afterCanvas)]).then(function (b) {
        if (temp) JS.learnMask.releaseRedacted(temp);
        return b;
      });
    }).then(function (imgs) {
      els.status.textContent = 'Sending…';
      return JS.learn.submit({
        before: imgs[0],
        after: imgs[1],
        meta: {
          // NOT fabricated: the auto-vs-manual corner provenance is not tracked yet, so
          // the manifest says so rather than guessing a training label.
          state: 'manual_submit',
          provenance: 'not_tracked_yet',
          redacted: redacted,
          redaction: redacted ? JS.learnMask.describe(mask)
                              : { tool: 'none', declared_nothing_sensitive: true },
          quadAuto: null,
          quadUser: page.corners ? page.corners.map(function (p) {
            return [Number(p.x.toFixed(4)), Number(p.y.toFixed(4))];
          }) : null,
          tone: { mode: page.mode, adj: page.adj }
        }
      });
    }).then(function (res) {
      state.busy = false;
      els.send.textContent = 'Sent';
      els.send.disabled = true;
      els.status.setAttribute('style', els.statusStyle);
      els.status.textContent = 'Sent as ' + res.bundleId + '. Your PC will verify it, ' +
        'acknowledge it, then remove it from GitHub.';
      return JS.learn.checkAck(res.bundleId).then(function (a) {
        if (a.acknowledged) els.status.textContent = 'Sent as ' + res.bundleId + ' — ' +
          'acknowledged and removed by your PC.';
      }).catch(function () { /* the ack is a convenience; the upload already succeeded */ });
    }).catch(function (e) {
      state.busy = false;
      refreshButtons();
      var m = String((e && e.message) || e);
      // An expired token is named as such. A silent failure here reads as "Learn is
      // broken" and wastes the client's time.
      if (m.indexOf('401') !== -1 || m.indexOf('Bad credentials') !== -1) {
        JS.learn.clearToken();
        fail('Your GitHub token has expired or was revoked. Press Learn again to paste a new one.');
      } else if (m === 'NO_TOKEN') {
        showTokenEntry();
      } else {
        fail('Could not send: ' + m);
      }
    });
  }

  /* ---------------------------------------------------------------------- init */

  function wire() {
    build();
    els.cancel.addEventListener('click', close);
    els.clear.addEventListener('click', function () {
      JS.learnMask.clear(state.mask); state.declaredNothing = false; repaint(); refreshButtons();
    });
    els.nothing.addEventListener('click', function () {
      // Explicit, and it CLEARS any strokes: "nothing sensitive" and a half-drawn
      // covering must not both be recorded, or the manifest contradicts itself.
      JS.learnMask.clear(state.mask);
      state.declaredNothing = !state.declaredNothing;
      repaint(); refreshButtons();
    });
    els.send.addEventListener('click', send);
    els.overlay.setAttribute('style', 'display:none');
  }

  /* Self-wiring: this file loads last (index.html), after js/60-init.js has booted, so
   * JS.wire is already done and adding a listener to a chip there would mean editing
   * 50-ui.js for a feature that is not part of the editor. The script tags sit at the
   * end of <body>, so the element exists by the time this runs; the readyState check
   * covers the case where that ever changes. Nothing is built until the chip is
   * actually pressed. */
  function boot() {
    var chip = document.getElementById('chip-learn');
    if (!chip) return;
    chip.addEventListener('click', function () { open(); });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  JS.learnUI = { open: open, close: close, wire: wire, boot: boot };
})(typeof window !== 'undefined' ? window : globalThis);
