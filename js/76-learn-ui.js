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
 * THE `state` LABEL, AND WHY IT IS DERIVED RATHER THAN ASKED FOR
 * -------------------------------------------------------------
 * `page.corners` is written by two different things - Auto crop (js/30-pipeline.js) and
 * the user's finger (js/50-ui.js) - so the page itself records which one wrote last
 * (`cornersFrom`), what the detector answered when it was asked (`quadAuto`), and
 * whether it was ever asked at all (`autoRan`). From those three:
 *
 *   refused                the detector was asked, found nothing, and the crop is not
 *                          the user's -> the failure the training set wants most
 *   corrected              the detector succeeded, the user moved the corners
 *   refused_then_corrected the detector was asked and refused, the user then drew it
 *   auto_accepted          the detector succeeded and the user left it alone
 *   not_attempted          Auto crop was never pressed; nothing can be attributed
 *
 * The last two are not padding. Without `auto_accepted` a page the detector got right
 * would be filed as a correction; without `not_attempted` a page hand-drawn before Auto
 * crop was ever pressed would be filed as a REFUSAL, and a fabricated refusal is worse
 * than a missing label - the PC would train on a crop the detector never saw.
 *
 * A FAILED SEND LOSES NOTHING
 * ---------------------------
 * The overlay, the brush mask, the corners, the tone and the comment all survive a
 * failure, and Send is re-enabled so the next attempt is one tap. An expired token in
 * particular opens the token box INSIDE the overlay: the first version told the user to
 * "press Learn again", and pressing Learn again rebuilds the screen from scratch, which
 * silently threw away the redaction he had just painted. That is the one thing this
 * screen must never do - the redaction is the user's own work and the only thing
 * standing between his documents and a public repository.
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

  // NO touch-action:none HERE. It belongs on the brush canvas (which needs it so a drag
  // paints instead of scrolling) and nowhere else. On the overlay it killed touch panning
  // while the overlay was taller than the screen, so the button row sat below the fold and
  // could not be scrolled to - the client could paint but never reach Send, and overflow:auto
  // was useless because panning was disabled. touch-action is inherited, so putting it here
  // also fought the canvas's own setting.
  var CSS_OVERLAY =
    'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.88);color:#f4f4f4;' +
    'font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
    'display:flex;flex-direction:column;align-items:center;overflow-y:auto;' +
    '-webkit-overflow-scrolling:touch;padding:14px 14px 0;' +
    'box-sizing:border-box;-webkit-user-select:none;user-select:none';
  // Sticky, so Send is on screen whatever the photo's aspect ratio does to the height.
  // The client must never have to hunt for the button that sends a photograph off the phone.
  var CSS_ROW =
    'position:sticky;bottom:0;display:flex;gap:8px;flex-wrap:wrap;justify-content:center;' +
    'width:100%;padding:10px 0 14px;margin-top:auto;' +
    'background:linear-gradient(rgba(0,0,0,0),rgba(0,0,0,.88) 22%);';
  var CSS_BTN =
    'padding:12px 16px;border-radius:9px;border:1px solid #666;background:#262626;color:#f4f4f4;' +
    'font:inherit;font-weight:600;min-height:44px';
  var CSS_PRIMARY = CSS_BTN + ';background:#c2410c;border-color:#c2410c;color:#fff';
  var CSS_INPUT =
    'padding:10px;border-radius:9px;border:1px solid #666;background:#1b1b1b;' +
    'color:#f4f4f4;font:inherit;width:100%;box-sizing:border-box';
  var CSS_NOTE_WRAP =
    'max-width:420px;width:100%;margin:2px 0 10px;padding:10px 11px;' +
    'background:#1d1d1d;border:1px solid #444;border-radius:9px';

  /* The comment's two fields are ONE feature with TWO values, and they are never
     re-derived from each other at send time:
       note_preset  what he picked, frozen at pick time
       note         what the box actually says when Send is pressed
     Picking a preset FILLS the box, and he may then edit that text - so the pair can
     legitimately disagree (preset 'sheared_skewed', note 'a bit crooked at the top').
     Collapsing them into one field would throw away the choice every time the wording
     was improved, which is exactly the signal worth keeping.
     `prevPresetId` exists only so that returning to "(no preset)" can take back the
     preset's own wording without also taking back words he typed himself. */
  var prevPresetId = '';

  function presetById(id) {
    var list = (JS.learn.NOTE_PRESETS || []);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return { id: '', text: '(no preset)' };
  }

  function quadPairs(q) {
    if (!q) return null;
    return q.map(function (p) { return [Number(p.x.toFixed(4)), Number(p.y.toFixed(4))]; });
  }

  /* WHO WROTE THE CROP, AND WHAT THE DETECTOR SAID ABOUT IT.
   *
   * Three fields on the page, and the label follows from them:
   *   page.autoRan      Auto crop has been pressed at least once
   *   page.quadAuto     the detector's quad, or null if it found nothing
   *   page.cornersFrom  'auto' | 'manual' | '' (nobody has written one)
   *
   * `quad_user` is sent ONLY when the finger wrote the current corners. A page that was
   * rotated - or one the detector cropped - has non-null corners without the user having
   * moved anything, and sending those as `quad_user` would invent a correction.
   *
   * The two labels beyond the three the PC names exist so that neither of those cases is
   * mislabelled as a refusal. A refusal is what the training set wants most, which is
   * exactly why it must never be produced by a page the detector was not asked about. */
  function provenance(page) {
    var auto = page.quadAuto || null;
    var manual = page.cornersFrom === 'manual';
    var state;
    if (!page.autoRan && !manual) state = 'not_attempted';
    else if (auto && manual) state = 'corrected';
    else if (auto) state = 'auto_accepted';
    else if (!page.autoRan) state = 'not_attempted';
    else if (manual) state = 'refused_then_corrected';
    else state = 'refused';
    return {
      state: state,
      quadAuto: quadPairs(auto),
      quadUser: manual ? quadPairs(page.corners) : null
    };
  }

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

    var noteWrap = h('div', { id: 'learn-note-wrap', style: CSS_NOTE_WRAP });
    noteWrap.appendChild(h('div', { style: 'font-weight:600;margin-bottom:6px' },
      'Comment (optional)'));
    var noteSel = h('select', { id: 'learn-note-preset', style: CSS_INPUT });
    // Built from the ONE list in js/70-learn.js. Adding a preset is one line there.
    (JS.learn.NOTE_PRESETS || []).forEach(function (p) {
      noteSel.appendChild(h('option', { value: p.id }, p.text));
    });
    var noteTxt = h('input', { id: 'learn-note', type: 'text', maxlength: '300',
      autocomplete: 'off', spellcheck: 'false',
      placeholder: '…or say it in your own words',
      style: CSS_INPUT + ';margin-top:6px' });
    noteWrap.appendChild(noteSel);
    noteWrap.appendChild(noteTxt);
    noteWrap.appendChild(h('div', { style: 'opacity:.75;font-size:12.5px;margin-top:6px' },
      'Pick one or type your own. It is recorded with the photos only — never in a ' +
      'filename, never posted on the GitHub issue, and it never stops you sending.'));

    var status = h('div', { id: 'learn-status',
      style: 'max-width:420px;min-height:20px;margin:2px 0 8px;opacity:.9' });

    var row = h('div', { style: CSS_ROW });
    var clear = h('button', { type: 'button', style: CSS_BTN }, 'Clear brush');
    var nothing = h('button', { type: 'button', style: CSS_BTN }, 'Nothing sensitive here');
    var cancel = h('button', { type: 'button', style: CSS_BTN }, 'Cancel');
    var send = h('button', { type: 'button', style: CSS_PRIMARY, disabled: 'disabled' }, 'Send');

    row.appendChild(clear); row.appendChild(nothing); row.appendChild(cancel); row.appendChild(send);
    overlay.appendChild(title); overlay.appendChild(warn); overlay.appendChild(canvasWrap);
    overlay.appendChild(sized); overlay.appendChild(noteWrap);
    overlay.appendChild(status); overlay.appendChild(row);
    document.body.appendChild(overlay);

    els = {
      overlay: overlay, title: title, warn: warn, canvas: canvas, size: size,
      noteWrap: noteWrap, noteSel: noteSel, noteTxt: noteTxt,
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
      // The point count of the LIVE stroke, not strokes[0]. Using strokes[0] measured the
      // wrong stroke entirely, so a SECOND stroke never registered as having changed and
      // never painted while being drawn - it only appeared once the finger lifted.
      var before = live.pts.length;
      JS.learnMask.extendStroke(state.mask, live, q.x, q.y);
      if (live.pts.length !== before) {
        drawStroke(c.getContext('2d'), { r: live.r, pts: live.pts.slice(-2) }, c.width, c.height);
      }
    });
    function end() { live = null; repaint(); refreshButtons(); }
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', function () { if (live) { live = null; refreshButtons(); } });
  }

  /* --------------------------------------------------------------------- token */

  /* The token box, shown INSIDE the open overlay rather than after a restart.
     `reason` is how an expired token is explained without losing the redaction: the
     mask lives in `state.mask`, which this function does not touch, so saving a new
     token below puts the SAME redacted photo back on screen and finishes the send. */
  function showTokenEntry(reason) {
    // One token box, not one per failure: a second call (expired token, then a
    // failed save) must replace the first rather than stack a second copy.
    if (els.tokenWrap) { els.overlay.removeChild(els.tokenWrap); els.tokenWrap = null; }
    els.warn.setAttribute('style', 'display:none');
    els.canvas.parentNode.setAttribute('style', 'display:none');
    els.size.parentNode.setAttribute('style', 'display:none');
    els.noteWrap.setAttribute('style', 'display:none');
    els.clear.setAttribute('style', 'display:none');
    els.nothing.setAttribute('style', 'display:none');
    els.title.textContent = 'Learn — one-time setup';
    els.status.setAttribute('style', els.statusStyle);
    els.status.textContent = (reason ? reason + ' ' : '') +
      'Paste your GitHub token for this phone. It is stored in this ' +
      'browser only, and never leaves it except to GitHub. Your covering is kept — ' +
      'saving a token here sends the same redacted photos.';

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
      els.tokenWrap = null;
      resetForPhoto();
      // Continue the send they already asked for, but only if they had actually
      // prepared something - a stray Send must not post an unredacted photo.
      if (!JS.learnMask.isEmpty(state.mask) || state.declaredNothing) send();
    });

    els.overlay.insertBefore(wrap, els.status);
    els.tokenWrap = wrap;
  }

  /* ---------------------------------------------------------------------- open */

  /* Back to the photo screen. Wipes nothing the user made: not the mask (that lives in
     `state`, which this does not touch) and deliberately not the comment either. A stack
     of receipts that all failed the same way is one comment repeated, and retyping it per
     photo would be the kind of small friction that stops the feature being used at all.
     "(no preset)" is one tap away when it is no longer wanted. */
  function resetForPhoto() {
    els.title.textContent = 'Learn';
    els.warn.setAttribute('style', els.warn.getAttribute('style'));
    els.canvas.parentNode.setAttribute('style', 'position:relative;margin:2px 0 8px');
    els.size.parentNode.setAttribute('style', 'display:flex;align-items:center;gap:10px;margin-bottom:10px');
    els.noteWrap.setAttribute('style', CSS_NOTE_WRAP);
    els.clear.setAttribute('style', CSS_BTN);
    els.nothing.setAttribute('style', CSS_BTN);
    // Re-read the select rather than assume the last change event told us: the note
    // fields survive across photos, so `prevPresetId` has to start this photo matching
    // what the box below actually shows.
    prevPresetId = els.noteSel.value;
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
    // 0.40 rather than 0.5 of the viewport height: the warning block above and the sticky
    // button row below both come out of the same budget, and Send must not be pushed off.
    var scale = Math.min(MAX_DISPLAY / oriented.width, (global.innerHeight * 0.40) / oriented.height, 1);
    els.canvas.width = Math.max(1, Math.round(oriented.width * scale));
    els.canvas.height = Math.max(1, Math.round(oriented.height * scale));

    state = {
      page: page,
      oriented: oriented,
      /* A mask restored from last session (js/78-learn-recall.js) is picked up here,
         and only here — it lives on the page so that closing Learn and opening it again
         shows it still painted. Otherwise every open starts clean, which is what a
         fresh import wants and what the rest of this function assumes.

         The page's own slot is FILLED, not just read. Everything below paints into
         `state.mask` by reference, so without this the covering existed only in this
         module: it survived nothing. Closing Learn and opening it again showed a blank
         page, and `JS.recall.snapshot()` reads `page.mask`, so the brushwork was the one
         thing the last-selection record could never save. */
      mask: page.mask || (page.mask = JS.learnMask.create()),
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

  /* What the comment says right now, for the last-selection record
     (js/78-learn-recall.js). Returns null before the overlay has ever been built, so a
     record written without anyone having opened Learn simply has no comment rather than
     an invented empty one. */
  function currentComment() {
    if (!els) return null;
    return { preset: els.noteSel.value || '', note: els.noteTxt.value || '' };
  }

  /** Put a saved comment back into the two fields. Used by the restore path. */
  function setComment(c) {
    if (!c) return;
    // BUILT FIRST. The overlay does not exist until something asks for it, and on the
    // page that has just restored a selection nothing has yet - so checking `els` before
    // building threw the comment away silently, and the client's own words were gone by
    // the time he next pressed Learn.
    build();
    if (!els) return;
    if (typeof c.preset === 'string') els.noteSel.value = c.preset;
    if (typeof c.note === 'string') els.noteTxt.value = c.note;
    prevPresetId = els.noteSel.value;
  }

  /* ---------------------------------------------------------------------- send */

  function send() {
    if (!state || state.busy) return;
    if (!JS.learn.hasToken()) { showTokenEntry(); return; }
    state.busy = true;
    refreshButtons();
    els.status.setAttribute('style', els.statusStyle);

    var mask = state.mask, page = state.page;
    var prov = provenance(page);
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
          // Read off the page's own record of who wrote the corners and what the
          // detector said (see `provenance()` above). Not inferred here, and never
          // guessed: an unknown state would train the PC on a label this file made up.
          state: prov.state,
          provenance: 'tracked',
          redacted: redacted,
          redaction: redacted ? JS.learnMask.describe(mask)
                              : { tool: 'none', declared_nothing_sensitive: true },
          quadAuto: prov.quadAuto,
          quadUser: prov.quadUser,
          // The comment is two fields and neither of them can stop a send: the
          // preset is the choice, the note is the final text.
          notePreset: els.noteSel.value || null,
          note: (els.noteTxt.value || '').trim() || null,
          tone: { mode: page.mode, adj: page.adj }
        }
      });
    }).then(function (res) {
      state.busy = false;
      els.send.textContent = 'Sent';
      els.send.disabled = true;
      els.status.setAttribute('style', els.statusStyle);
      // The moment the selection is worth remembering: this is the crop, the tone, the
      // covering and the comment exactly as the client settled on them. Best effort,
      // and never allowed to affect the send that has already succeeded.
      if (JS.recall) { try { JS.recall.capture(); } catch (e) { /* not the send's problem */ } }
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
      /* NOTHING IS TORN DOWN HERE. The overlay stays open, the mask stays painted, the
         corners, the tone and the comment are all still in place, and `refreshButtons`
         above has just put Send back. The next attempt is one tap.

         An expired token used to clear the token and tell the user to "press Learn
         again" - and pressing Learn again calls open(), which rebuilds the whole screen
         and starts an EMPTY mask. The redaction he had just painted was destroyed by the
         instruction to fix a credential problem, on a screen whose entire warning is
         about not sending things by accident. The token box opens in place instead. */
      if (m.indexOf('401') !== -1 || m.indexOf('Bad credentials') !== -1) {
        JS.learn.clearToken();
        showTokenEntry('Your GitHub token has expired or was revoked.');
      } else if (m === 'NO_TOKEN') {
        showTokenEntry();
      } else {
        fail('Could not send: ' + m + ' — your covering and comment are kept. Press ' +
             'Send to try again.');
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
    /* Picking a preset FILLS the box; the box is free text from then on. Going back to
       "(no preset)" takes back the preset's own wording - but only if the box still holds
       it, because "(no preset)" means "no category", not "delete what I wrote". */
    els.noteSel.addEventListener('change', function () {
      var p = presetById(els.noteSel.value);
      var was = presetById(prevPresetId);
      if (p.id) els.noteTxt.value = p.text;
      else if (els.noteTxt.value === was.text) els.noteTxt.value = '';
      prevPresetId = p.id;
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

  JS.learnUI = {
    open: open, close: close, wire: wire, boot: boot,
    currentComment: currentComment, setComment: setComment
  };
})(typeof window !== 'undefined' ? window : globalThis);
