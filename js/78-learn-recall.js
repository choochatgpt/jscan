/* js/78-learn-recall.js — "Load your last selection?" Rebuild yesterday's work.
 *
 * THE PROBLEM
 * -----------
 * The client photographs a stack of receipts, crops and cleans each one, and then the
 * phone closes the tab — or he comes back the next morning. Everything is gone: the
 * photos are still in the gallery, but the crops, the tone, the rotation and the
 * redaction he painted have to be done again by hand, photo by photo. On a stack of
 * twenty that is the difference between using the app and giving up on it.
 *
 * WHAT IS SAVED, AND WHAT IS NEVER SAVED
 * --------------------------------------
 * METADATA ONLY, in this device's localStorage. Per photo: the name, byte size and
 * last-modified stamp of the file he picked, plus the crop quad, the coarse rotation,
 * the de-skew, the mode, the tone, and the redaction mask. Plus the comment and where
 * the photos came from when the browser will say.
 *
 * THE IMAGE BYTES ARE NEVER SAVED. Not the original, not the decoded bitmap, not a
 * thumbnail, not a canvas cache. A saved thumbnail of one of these documents in
 * localStorage is a copy of a pathology report sitting in a browser database for as
 * long as the site is used, readable by anything that can read this origin, and kept
 * after the photo itself is deleted. It would also be useless: the whole point is to
 * rebuild from the file he still has.
 *
 * NOTHING HERE IS EVER UPLOADED. The record is local. It is not part of the Learn
 * bundle, it is not in a filename, and it is not on the GitHub issue (js/70-learn.js
 * sends `note`/`note_preset` and nothing else of this).
 *
 * WHY IT RE-PICKS INSTEAD OF RE-OPENING THE FILES
 * -----------------------------------------------
 * A web page cannot reopen a file from a previous visit. `showOpenFilePicker`'s
 * directory handle can, but only on Chromium, only when the page is secure, and only
 * while the browser has not decided to re-ask for permission — and it cannot be
 * verified on the client's phone from here, which is the only place that matters. So
 * the path that works everywhere comes first: ask him to pick the same photos again,
 * recognise them by name + size + timestamp, and put the edits back. A photo that does
 * not match is simply left alone.
 *
 * RESTORING IS OPT-IN AND ALWAYS WILL BE
 * --------------------------------------
 * One prompt, once, on the sessions where something was saved, and a "Not now" that
 * holds for that session. Nothing is ever reloaded behind his back: an app that
 * silently repopulates itself with last week's documents on a phone that someone else
 * is holding is a worse bug than the one this file fixes.
 *
 * FRESH PAGES, NEVER RESURRECTED ONES
 * -----------------------------------
 * The rebuild starts from the files, so `JS.addFiles` makes new page objects and this
 * file only writes values onto them. It must never keep a page object and re-attach it:
 * `JS.stateKey` folds crop/orientation/tone/mask into the canvas cache key, and a page
 * carried over from a previous session arrives with its old caches still on it — the
 * editor would then draw last session's canvas under this session's controls.
 */
(function (global) {
  'use strict';

  var JS = global.JS = global.JS || {};

  var KEY = 'jscanner.recall.last';       // the record
  var ASKED = 'jscanner.recall.asked';    // sessionStorage: "already offered this session"
  var SCHEMA = 'jscan.recall/1';

  /* localStorage is around 5MB and shared with the Learn token. A record is a few KB of
     numbers per photo; a heavily brushed page is the only thing that can grow, and it
     grows in points. Past this the record is written WITHOUT the masks rather than
     partially — see `snapshot()`. */
  var MAX_CHARS = 1500000;

  var els = null;
  var pending = false;      // a re-pick is in flight: match instead of capture
  var noticed = false;      // "Not now" pressed, or already offered, this session

  /* ------------------------------------------------------------------ storage */

  function store() {
    try {
      var s = global.localStorage;
      if (!s) return null;
      // Private mode in some browsers hands back an object that throws on write.
      s.setItem('jscanner.recall.probe', '1');
      s.removeItem('jscanner.recall.probe');
      return s;
    } catch (e) { return null; }
  }

  function sessionFlag() {
    try {
      return global.sessionStorage ? global.sessionStorage.getItem(ASKED) : null;
    } catch (e) { return null; }
  }

  function setSessionFlag() {
    try { if (global.sessionStorage) global.sessionStorage.setItem(ASKED, '1'); } catch (e) { /* fine */ }
  }

  function load() {
    var s = store();
    if (!s) return null;
    try {
      var raw = s.getItem(KEY);
      if (!raw) return null;
      var rec = JSON.parse(raw);
      if (!rec || rec.schema !== SCHEMA || !rec.pages || !rec.pages.length) return null;
      return rec;
    } catch (e) {
      // A corrupt record is dropped rather than half-read: a partially parsed crop is
      // a wrong crop, and a wrong crop of a receipt is worse than no crop at all.
      try { store().removeItem(KEY); } catch (e2) { /* nothing to do */ }
      return null;
    }
  }

  function put(rec) {
    var s = store();
    if (!s) return false;
    try {
      s.setItem(KEY, JSON.stringify(rec));
      return true;
    } catch (e) {
      // Quota, or a browser that refuses. Drop the masks and try once more: the crops,
      // rotation and tone are small and are most of the value, and a record that says
      // its coverings are missing is honest, where a truncated one would not be.
      try {
        rec = Object.assign({}, rec, {
          masks_omitted: true,
          pages: rec.pages.map(function (p) {
            return Object.assign({}, p, { mask: null });
          })
        });
        s.setItem(KEY, JSON.stringify(rec));
        if (global.console && global.console.warn) {
          global.console.warn('Recall: saved without the redaction masks (storage is full).');
        }
        return true;
      } catch (e2) {
        try { s.removeItem(KEY); } catch (e3) { /* nothing to do */ }
        return false;
      }
    }
  }

  function forget() {
    var s = store();
    try { if (s) s.removeItem(KEY); } catch (e) { /* nothing to do */ }
    hidePrompt();
    return true;
  }

  /* ------------------------------------------------------------------ snapshot */

  function quadOut(q) {
    if (!q || q.length !== 4) return null;
    return q.map(function (p) {
      return [Number(p.x.toFixed(4)), Number(p.y.toFixed(4))];
    });
  }

  /* One page's restorable state, as plain JSON. Everything here is a NUMBER or a SHORT
     STRING: no object identity, no canvas, no image, nothing that could hold pixels. */
  function pageState(page) {
    var f = page.file;
    return {
      name: f.name,
      size: f.size,
      last_modified: f.lastModified,
      w: page.w, h: page.h,
      coarse: page.coarse,
      fine: page.fine,
      corners: quadOut(page.corners),
      corners_from: page.cornersFrom || '',
      quad_auto: quadOut(page.quadAuto),
      auto_ran: !!page.autoRan,
      mode: page.mode,
      mode_tap: page.modeTap || '',
      mode_back: page.modeBack ? Object.assign({}, page.modeBack) : null,
      adj: Object.assign({}, page.adj),
      mask: page.mask ? JS.learnMask.toJSON(page.mask) : null
    };
  }

  function snapshot() {
    var pages = (JS.app && JS.app.pages) || [];
    var out = [];
    var skipped = 0;
    for (var i = 0; i < pages.length; i++) {
      var p = pages[i];
      // A page with no file record (pasted, or from the camera input) cannot be matched
      // on the next visit, so storing it would promise a restore that can never happen.
      if (!p || !p.file || !p.file.name || !p.file.size) { skipped++; continue; }
      out.push(pageState(p));
    }
    if (!out.length) return null;
    var comment = JS.learnUI && JS.learnUI.currentComment ? JS.learnUI.currentComment() : null;
    return {
      schema: SCHEMA,
      saved_utc: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      app_version: JS.VERSION || 'unknown',
      where: whereFrom(pages),
      comment: comment,
      skipped: skipped,
      masks_omitted: false,
      pages: out
    };
  }

  /* WHERE THE PHOTOS CAME FROM, when the browser will say.
   *
   * A plain `<input type="file" multiple>` deliberately tells a page nothing about the
   * folder — `webkitRelativePath` is empty for it, and the real path is never exposed,
   * because a path on its own identifies a person. It is recorded here only when the
   * browser does provide it (a directory pick does), and it stays on this device. When
   * there is nothing to record, say so rather than storing a placeholder: the prompt
   * then tells him to pick the same photos again instead of pretending it knows where
   * they are. */
  function whereFrom(pages) {
    for (var i = 0; i < pages.length; i++) {
      var f = pages[i].file;
      if (f && f.relativePath) return { kind: 'directory', path: f.relativePath };
    }
    return { kind: 'file-input', path: null };
  }

  function capture() {
    var rec = snapshot();
    if (!rec) return false;
    var json = JSON.stringify(rec);
    if (json.length > MAX_CHARS) {
      // Too big only ever means the masks. Keep the rest, drop them explicitly, and
      // mark the record so the restore path can say the coverings are not in it.
      rec = Object.assign({}, rec, {
        masks_omitted: true,
        pages: rec.pages.map(function (p) { return Object.assign({}, p, { mask: null }); })
      });
    }
    return put(rec);
  }

  /* ------------------------------------------------------------------- restore */

  function freshQuad(q) {
    if (!q || q.length !== 4) return null;
    var out = [];
    for (var i = 0; i < 4; i++) {
      var p = q[i];
      if (!p || p.length < 2) return null;
      var x = Number(p[0]), y = Number(p[1]);
      if (!isFinite(x) || !isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
      out.push({ x: x, y: y });
    }
    // The same refusal the editor itself applies to a drag. A quad that `quadOk` rejects
    // is one the pipeline will not render — restoring it would put the page into a state
    // the UI cannot produce and cannot undo, because nothing is selected to drag back.
    return JS.quadOk && JS.quadOk(out) ? out : null;
  }

  function plain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /* Values ONTO a page that has just been decoded from the file. Nothing is read back
     out of the record object after this: every field is copied, so a later edit in the
     editor cannot reach into what was saved. */
  function applyTo(page, e) {
    var touched = false;
    if (e.coarse === 0 || e.coarse === 90 || e.coarse === 180 || e.coarse === 270) {
      if (page.coarse !== e.coarse) { page.coarse = e.coarse; touched = true; }
    }
    if (isFinite(Number(e.fine))) { page.fine = Math.max(-15, Math.min(15, Number(e.fine))); touched = true; }

    var q = freshQuad(e.corners);
    if (q) { page.corners = q; touched = true; }
    var qa = freshQuad(e.quad_auto);
    page.quadAuto = qa;
    page.autoRan = !!e.auto_ran;
    if (q && (e.corners_from === 'auto' || e.corners_from === 'manual')) {
      page.cornersFrom = e.corners_from;
    }

    if (e.mode && JS.MODE_DEFAULTS[e.mode]) { page.mode = e.mode; touched = true; }
    page.modeTap = typeof e.mode_tap === 'string' ? e.mode_tap : '';
    page.modeBack = plain(e.mode_back) ? Object.assign({}, e.mode_back) : null;

    // Only keys the page already has, and only numbers: `adj` is enumerated by
    // `JS.stateKey`, so an unknown key from an older or hand-edited record would sit in
    // the cache key forever without anything ever drawing it.
    if (plain(e.adj)) {
      Object.keys(page.adj).forEach(function (k) {
        if (typeof e.adj[k] === 'number' && isFinite(e.adj[k])) page.adj[k] = e.adj[k];
      });
      touched = true;
    }

    if (e.mask) {
      var m = JS.learnMask.restore(e.mask);
      if (!JS.learnMask.isEmpty(m)) { page.mask = m; touched = true; }
    }

    if (touched) { page.touched = true; JS.invalidate(page); }
    return touched;
  }

  /* WHICH SAVED PHOTO IS THIS ONE? Name, then size, then last-modified.
   *
   * Size is required on both sides. Two different receipts really are both called
   * IMG_0421.JPG, and the camera input hands out a generic name for every shot — a
   * name-only match would put one document's crop onto another document, which on these
   * photographs means showing the wrong part of a medical report. A photo that cannot be
   * matched is left exactly as imported.
   */
  function findMatch(list, f, exact) {
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.used) continue;
      if (e.name !== f.name) continue;
      if (!e.size || !f.size || e.size !== f.size) continue;
      if (exact && e.last_modified !== f.lastModified) continue;
      return e;
    }
    return null;
  }

  function restoreNow() {
    var rec = load();
    if (!rec) return null;
    var pages = (JS.app && JS.app.pages) || [];
    var list = rec.pages.map(function (e) { return Object.assign({ used: false }, e); });
    var matched = 0, missed = 0, restored = 0;
    for (var i = 0; i < pages.length; i++) {
      var f = pages[i].file;
      if (!f || !f.name || !f.size) continue;
      // Exact first (name + size + timestamp), then name + size. The second pass is what
      // makes a re-downloaded or re-saved copy restore too; the first is what keeps two
      // files of the same name and size apart when both are in the record.
      var e = findMatch(list, f, true) || findMatch(list, f, false);
      if (!e) { missed++; continue; }
      e.used = true;
      matched++;
      if (applyTo(pages[i], e)) restored++;
    }
    if (JS.renderHome) JS.renderHome();
    if (rec.comment && JS.learnUI && JS.learnUI.setComment) JS.learnUI.setComment(rec.comment);

    var msg = matched
      ? 'Put your edits back on ' + restored + ' of ' + pages.length + ' photo' +
        (pages.length === 1 ? '' : 's')
      : 'None of those photos matched the saved selection — nothing was changed';
    if (matched && missed) msg += ' (' + missed + ' not in the saved selection)';
    if (rec.masks_omitted) {
      msg += '. Your brush covering was NOT saved — check each photo before sending.';
    }
    if (JS.hint) JS.hint(msg);
    return { matched: matched, missed: missed, restored: restored };
  }

  /* --------------------------------------------------------------------- flow */

  /* Called by js/50-ui.js at the end of every import. Either the user asked for last
     session's work back, in which case this is the re-pick it was waiting for, or this
     is an ordinary import and it is the selection worth remembering. */
  function onFilesAdded() {
    if (pending) {
      pending = false;
      try { restoreNow(); } catch (e) {
        if (global.console && global.console.error) global.console.error('Recall: restore failed', e);
        if (JS.hint) JS.hint('Could not put your edits back — the photos are imported as normal.');
      }
      return;
    }
    capture();
  }

  function beginLoad() {
    hidePrompt();
    var input = JS.$ ? JS.$('file-gallery') : null;
    if (!input) return false;
    pending = true;
    // The same picker the Import button opens, so he picks from the same place with the
    // same multi-select. `click()` on a file input is allowed here because it is inside
    // the handler for a real tap.
    input.click();
    return true;
  }

  function hasSaved() { return !!load(); }

  /* ---------------------------------------------------------------- the prompt */

  /* IN THE PAGE'S OWN FLOW, NOT FLOATING OVER IT.
   *
   * The first version of this was a bar fixed along the bottom of the screen, and it was
   * wrong in a way that only shows up when someone else drives the app: a fixed bar
   * swallows every tap that lands on it, and the bottom of this app is where the import
   * button and the export row live. It sat on top of them. A prompt that covers the
   * controls it is asking you to use is worse than no prompt.
   *
   * So it is an ordinary block inside the home screen, above the page grid: it pushes
   * what is under it down instead of sitting on it, and it scrolls away with everything
   * else. It is also only ever on the home screen, which is where a question about
   * loading a previous selection belongs.
   */
  var CSS_BANNER =
    'display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:center;' +
    'padding:11px 13px;margin:0 0 4px;background:#2a1c0e;border:1px solid #7a4a1e;' +
    'border-radius:10px;color:#f4f4f4;box-sizing:border-box';
  var CSS_BTN =
    'padding:10px 14px;border-radius:9px;border:1px solid #666;background:#262626;color:#f4f4f4;' +
    'font:inherit;font-weight:600;min-height:44px';
  var CSS_PRIMARY = CSS_BTN + ';background:#c2410c;border-color:#c2410c;color:#fff';

  function el(tag, style, text) {
    var n = document.createElement(tag);
    if (style) n.setAttribute('style', style);
    if (text != null) n.textContent = text;
    return n;
  }

  function build() {
    if (els) return els;
    var bar = el('div', CSS_BANNER);
    bar.id = 'recall-banner';
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-label', 'Load your last selection');

    var text = el('div', 'flex:1 1 100%;text-align:center');
    var row = el('div', 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center');
    var load = el('button', CSS_PRIMARY, 'Load my last selection');
    load.type = 'button';
    var later = el('button', CSS_BTN, 'Not now');
    later.type = 'button';
    var drop = el('button', CSS_BTN, 'Forget it');
    drop.type = 'button';
    row.appendChild(load); row.appendChild(later); row.appendChild(drop);

    bar.appendChild(text);
    bar.appendChild(row);

    var home = JS.$ ? JS.$('view-home') : null;
    var anchor = JS.$ ? JS.$('empty-state') : null;
    if (home && anchor && anchor.parentNode === home) home.insertBefore(bar, anchor);
    else if (home) home.appendChild(bar);
    else document.body.appendChild(bar);

    load.addEventListener('click', function () { beginLoad(); });
    later.addEventListener('click', function () { hidePrompt(); });
    drop.addEventListener('click', function () {
      hidePrompt();
      forget();
      if (JS.hint) JS.hint('Forgotten. Nothing of your last selection is saved on this phone.');
    });

    els = { bar: bar, text: text, load: load };
    return els;
  }

  function hidePrompt() { if (els) els.bar.setAttribute('style', 'display:none'); }

  /* ASK ONCE — once per session, and the asking IS the once.
   *
   * The flag is set here, when the question is put on screen, not when "Not now" is
   * pressed. Setting it on the button only would mean a session where he simply ignored
   * the banner asked again on every reload, and on a phone the app is reloaded
   * constantly — switching to the gallery and back is a reload. A prompt that reappears
   * every time he looks at his phone is one he will press "Forget it" on to get rid of,
   * which loses the feature. Session scope is the right size for "once": a tab lives for
   * one sitting, and a fresh launch is a fresh question.
   */
  function offer() {
    if (noticed || sessionFlag()) return false;
    var rec = load();
    if (!rec) return false;
    noticed = true;
    setSessionFlag();
    var n = rec.pages.length;
    build();
    var when = String(rec.saved_utc || '').replace('T', ' ').replace('Z', ' UTC');
    var where = rec.where && rec.where.path
      ? 'from ' + rec.where.path
      : 'Pick the same photos again and your crops, tone and covering come back';
    els.text.textContent = 'Load your last selection? ' + n + ' photo' +
      (n === 1 ? '' : 's') + ' saved ' + when + '. ' + where + '.';
    els.bar.setAttribute('style', CSS_BANNER);
    return true;
  }

  /* -------------------------------------------------------------------- init */

  /* Saved on the way out, as well as after an import and after a Learn send. Mobile
     browsers freeze or discard a tab without warning, and `visibilitychange` is the last
     reliable moment to write: it fires when he switches apps, when he goes to the home
     screen, and when the page is being put away. Cheap, because the record is a few KB
     of numbers and this is not on a drag path. */
  function boot() {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { try { capture(); } catch (e) { /* best effort */ } }
    });
    global.addEventListener('pagehide', function () {
      try { capture(); } catch (e) { /* best effort */ }
    });
    if (JS.app) offer();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  JS.recall = {
    KEY: KEY, SCHEMA: SCHEMA, MAX_CHARS: MAX_CHARS,
    hasSaved: hasSaved, load: load, capture: capture, forget: forget,
    offer: offer, hidePrompt: hidePrompt, beginLoad: beginLoad,
    onFilesAdded: onFilesAdded, restoreNow: restoreNow, applyTo: applyTo,
    snapshot: snapshot, boot: boot
  };
})(typeof window !== 'undefined' ? window : globalThis);
