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
 * HOW THE PHOTOS COME BACK — THE CLIENT'S DESIGN, WHICH IS THE RIGHT ONE
 * ---------------------------------------------------------------------
 * He was asked to pick his photos a second time and said:
 *
 *   "it just go back to the upload pop up of the browser. can you think of something like
 *    read directly since you already have the photo names and locations?"
 *   "i did not say keep my last selection of photos. i say, keep where i selected from and
 *    the filename of the photo and what i did with them."
 *
 * So the app keeps the FOLDER, not the photographs. `js/77-fs-handle.js` holds a
 * `FileSystemDirectoryHandle` in IndexedDB — an opaque reference, not the files — and on
 * the next visit this file opens each saved FILENAME inside it directly. No picker, no
 * copy of his documents in browser storage, no second set of bytes anywhere.
 *
 * It is verified, not assumed, that this works on Android Chrome: `showDirectoryPicker`
 * is enabled there from M132 and Chrome's own documentation lists Android as supported.
 * That is a real answer and not a guess — see the release note for the sources. But the
 * API is NOT universal (no iOS Safari, no Firefox, Brave behind a flag), and Android
 * drops a folder grant after ~16 hours in the background, so:
 *
 *   - a reload always costs ONE TAP to re-grant, and that is expected, not a bug;
 *   - where the API is missing the app falls back to re-picking, and SAYS SO IN THE
 *     BANNER rather than opening a picker and letting him wonder why;
 *   - nothing here is claimed to work on a browser it has not been checked on.
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
 * The rebuild starts from the files, through `JS.addFiles`, which makes new page objects
 * and this file only writes values onto them. It must never keep a page object and
 * re-attach it: `JS.stateKey` folds crop/orientation/tone/mask into the canvas cache key,
 * and a page carried over from a previous session arrives with its old caches still on it
 * — the editor would then draw last session's canvas under this session's controls.
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
     partially — see `capture()`. */
  var MAX_CHARS = 1500000;

  var els = null;
  var pending = false;      // a re-pick or a folder read is in flight: match, don't capture
  var pendingNote = null;   // the folder read's own verdict per file, folded into the hint
  var folder = null;        // the remembered FileSystemDirectoryHandle, or null
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

  /* FORGETTING LETS GO OF THE FOLDER TOO. The button says nothing of his last selection
     is kept on this phone, and a retained directory handle is exactly that - a live
     reference to where his documents live. Clearing the record and keeping the handle
     would make the sentence untrue. */
  function forget() {
    var s = store();
    try { if (s) s.removeItem(KEY); } catch (e) { /* nothing to do */ }
    hidePrompt();
    folder = null;
    if (JS.fsHandle) { try { JS.fsHandle.forget(); } catch (e) { /* nothing to do */ } }
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
      /* WHAT THE DETECTOR SAID, kept apart from the quad that said it. `quadAuto` is
         geometry in one frame and has to go when that frame goes; this is a fact about
         the photograph and survives. See js/76-learn-ui.js `provenance()`. */
      auto_outcome: page.autoOutcome || '',
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
      folder: folder && JS.fsHandle ? JS.fsHandle.label(folder) : '',
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
   * browser does provide it, and it stays on this device.
   *
   * `folder` above is the better answer and the one that actually works: it is the
   * folder's own display name, learned from a directory handle he granted. It is a NAME
   * and never a path — Android answers with a content-provider name and no browser
   * exposes a real path to a page — so it is shown to him and is never used to open
   * anything. The opening is done by the handle. */
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
    /* The detector's own verdict. An older record (v1.9.0) has no `auto_outcome` and is
       backfilled from what it does have: asked, with a quad means found, asked without
       one means refused. Reconstructing it here rather than defaulting it to '' keeps a
       restored page's Learn label identical to the label it would have had before the
       reload — which is the whole point of restoring. */
    page.autoOutcome = (e.auto_outcome === 'found' || e.auto_outcome === 'refused')
      ? e.auto_outcome
      : (e.auto_ran ? (qa ? 'found' : 'refused') : '');
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

  function shortList(names, cap) {
    cap = cap || 3;
    var head = names.slice(0, cap).join(', ');
    return names.length > cap ? head + ' and ' + (names.length - cap) + ' more' : head;
  }

  /* ONE hint, composed from BOTH halves of what happened.
   *
   * `info` is the folder read's per-file verdict and is null on the re-pick path. When
   * the folder was read, "12 of 13" has to count against WHAT WAS SAVED, not against
   * what happened to be importable — a file that is gone from the folder must not
   * silently shrink the denominator and make a partial restore look complete.
   *
   * Every file that did not come back is NAMED, because the client has to be able to go
   * and look at that one photo. A count on its own tells him something went wrong and
   * not which document to redo. */
  function buildMessage(rec, info, r) {
    var msg;
    if (r.restored) {
      msg = 'Put your edits back on ' + r.restored + ' of ' + r.total + ' photo' +
        (r.total === 1 ? '' : 's');
    } else if (info) {
      msg = 'None of your saved photos were found in that folder — nothing was changed';
    } else {
      msg = 'None of those photos matched the saved selection — nothing was changed';
    }
    if (!info && r.restored && r.missed) msg += ' (' + r.missed + ' not in the saved selection)';
    if (info) {
      if (info.missing.length) msg += '. Not in that folder: ' + shortList(info.missing);
      // A changed file is a REFUSAL, not a fuzzy match: the stored quad is a rectangle on
      // a photograph whose pixels are not the ones that were cropped.
      if (info.changed.length) msg += '. Changed since you cropped them, so left alone: ' +
        shortList(info.changed);
      if (info.denied.length) msg += '. Could not be read: ' + shortList(info.denied);
    }
    if (rec.masks_omitted) {
      msg += '. Your brush covering was NOT saved — check each photo before sending.';
    }
    return msg;
  }

  function restoreNow(info) {
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

    var r = {
      matched: matched, missed: missed, restored: restored,
      total: info ? rec.pages.length : pages.length
    };
    if (JS.hint) JS.hint(buildMessage(rec, info, r));
    return r;
  }

  /* --------------------------------------------------------------- the folder */

  /* THE PAYOFF: one tap, permission re-granted, every saved filename opened straight out
     of the folder he chose once. No file picker, at all.
     The tap is not optional and cannot be removed — `requestPermission` needs transient
     user activation, and on Android the grant is also dropped after ~16h backgrounded. */
  function restoreFromFolder() {
    var rec = load();
    if (!rec) return Promise.resolve(false);
    if (!folder || !JS.fsHandle) { hidePrompt(); return Promise.resolve(false); }

    if (JS.showBusy) JS.showBusy('Opening your photos…');
    return JS.fsHandle.ensurePermission(folder).then(function (state) {
      if (state !== 'granted') {
        if (JS.hideBusy) JS.hideBusy();
        /* A refusal is a real outcome and gets its own words. It is NOT reported as a
           missing folder, and it is not retried behind his back: the banner comes back
           with the re-pick offered first, so he is never stuck on a button that has
           stopped working. */
        if (JS.hint) {
          JS.hint(state === 'denied'
            ? 'Android did not let me back into that folder — pick the photos again and your edits still come back.'
            : 'That folder needs one more tap. Press “Reload my last selection” again.');
        }
        paint(rec, { repickFirst: state === 'denied' });
        showPrompt();
        return false;
      }
      return JS.fsHandle.readMany(folder, rec.pages, function (i, n) {
        if (JS.showBusy) JS.showBusy('Reading ' + i + ' of ' + n + '…');
      }).then(function (info) {
        if (JS.hideBusy) JS.hideBusy();
        if (!info.files.length) {
          /* Nothing came back. Say precisely what was wrong, because the two causes need
             different actions from him: the folder is wrong (choose another) or the names
             this phone gave us are not the names in the folder (pick the photos again —
             which is the normal outcome when an Android selection came through the system
             photo picker rather than the folder). */
          var why = info.missing.length
            ? (info.missing.length + ' of your saved photos are not in “' +
               JS.fsHandle.label(folder) + '” any more')
            : 'Nothing in “' + JS.fsHandle.label(folder) + '” matched the saved file names';
          if (JS.hint) JS.hint(why + ' — nothing was changed.');
          paint(rec, { repickFirst: true });
          showPrompt();
          return false;
        }
        pending = true;
        pendingNote = info;
        hidePrompt();
        return JS.addFiles(info.files);
      });
    }).catch(function (e) {
      if (JS.hideBusy) JS.hideBusy();
      if (global.console && global.console.error) global.console.error('Recall: folder read failed', e);
      if (JS.hint) JS.hint('Could not read that folder — pick the photos again and your edits still come back.');
      paint(rec, { repickFirst: true });
      showPrompt();
      return false;
    });
  }

  /* One-time setup: choose the folder. The picker hands back a handle whose permission is
     ALREADY granted for this session, so the restore happens in the same tap — he picks
     the folder once and his edits come back before he has lifted his finger. */
  function chooseFolder() {
    var rec = load();
    if (!rec || !JS.fsHandle || !JS.fsHandle.supported()) return Promise.resolve(false);
    return JS.fsHandle.pick().then(function (h) {
      folder = h;
      return restoreFromFolder();
    }, function (e) {
      // AbortError is him dismissing the OS picker. Not a failure — put the banner back
      // and say nothing, because he knows what he just did.
      if (String((e && e.name) || '') !== 'AbortError') {
        if (JS.hint) JS.hint('This browser would not open a folder picker.');
      }
      showPrompt();
      return false;
    });
  }

  /* THE FALLBACK, for a browser with no File System Access API — or one where he has
     refused the folder. He picks the photos again and they are matched by name and size.
   *
   * ONLY EVER CALLED FROM A TAP HANDLER. `input.click()` on a file input needs transient
   * user activation, so calling it from a promise continuation silently does nothing at
   * all — a button that appears to be dead. Every path that wants the fallback therefore
   * REPAINTS THE BANNER and waits for him to tap, instead of clicking for him. */
  function startRepick() {
    hidePrompt();
    var input = JS.$ ? JS.$('file-gallery') : null;
    if (!input) return false;
    pending = true;
    pendingNote = null;
    // The same picker the Import button opens, so he picks from the same place with the
    // same multi-select.
    input.click();
    return true;
  }

  /* Called by js/50-ui.js at the end of every import. Either the user asked for last
     session's work back, in which case this is the read or re-pick it was waiting for,
     or this is an ordinary import and it is the selection worth remembering. */
  function onFilesAdded() {
    if (pending) {
      pending = false;
      var info = pendingNote;
      pendingNote = null;
      try {
        restoreNow(info);
      } catch (e) {
        if (global.console && global.console.error) global.console.error('Recall: restore failed', e);
        if (JS.hint) JS.hint('Could not put your edits back — the photos are imported as normal.');
      }
      return;
    }
    capture();
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

  /* One listener per button, and the ACTION is swapped underneath it. Adding a listener
     per repaint would stack them, and the second tap would then run every action the
     banner had ever offered. A button with no action is hidden rather than shown dead —
     every case below has two, two and one. */
  function act(btn, label, fn) {
    btn.textContent = label;
    btn._act = fn || null;
    btn.hidden = !fn;
    btn.setAttribute('style', btn._primary ? CSS_PRIMARY : CSS_BTN);
  }

  function build() {
    if (els) return els;
    var bar = el('div', CSS_BANNER);
    bar.id = 'recall-banner';
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-label', 'Load your last selection');

    var text = el('div', 'flex:1 1 100%;text-align:center');
    var row = el('div', 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center');
    var primary = el('button', CSS_PRIMARY, '');
    primary.type = 'button';
    primary._primary = true;
    var secondary = el('button', CSS_BTN, '');
    secondary.type = 'button';
    var later = el('button', CSS_BTN, 'Not now');
    later.type = 'button';
    var drop = el('button', CSS_BTN, 'Forget it');
    drop.type = 'button';
    row.appendChild(primary); row.appendChild(secondary);
    row.appendChild(later); row.appendChild(drop);

    bar.appendChild(text);
    bar.appendChild(row);

    var home = JS.$ ? JS.$('view-home') : null;
    var anchor = JS.$ ? JS.$('empty-state') : null;
    if (home && anchor && anchor.parentNode === home) home.insertBefore(bar, anchor);
    else if (home) home.appendChild(bar);
    else document.body.appendChild(bar);

    els = { bar: bar, text: text, primary: primary, secondary: secondary,
            later: later, drop: drop };

    act(primary, 'Load my last selection', null);
    act(secondary, 'Pick the photos again', null);
    primary.addEventListener('click', function () { if (primary._act) primary._act(); });
    secondary.addEventListener('click', function () { if (secondary._act) secondary._act(); });
    later.addEventListener('click', function () { hidePrompt(); });
    drop.addEventListener('click', function () {
      hidePrompt();
      forget();
      if (JS.hint) {
        JS.hint('Forgotten. Nothing of your last selection is saved on this phone, and ' +
          'the app has let go of that folder.');
      }
    });
    return els;
  }

  function hidePrompt() { if (els) els.bar.setAttribute('style', 'display:none'); }
  function showPrompt() { if (els) els.bar.setAttribute('style', CSS_BANNER); }

  /* WHAT THE BANNER SAYS, AND WHY IT SAYS ALL OF IT.
   *
   * The client's complaint about the setup was not only the picker: the banner asked
   * "Load your last selection?" and did not say that a picker was about to open, or what
   * he would get back. So every case now states (a) what the tap will do, (b) what comes
   * back, and (c) whether he has to pick anything — and the case where a picker IS
   * unavoidable says so BEFORE the tap rather than surprising him with it.
   *
   * Three cases, decided by the platform and by whether a folder is remembered:
   *   folder  the handle is live, so no picker at all
   *   setup   the API exists but no folder is remembered: one picker, once, ever
   *   repick  the API is missing, or the folder was refused: the honest fallback
   */
  function paint(rec, opts) {
    build();
    var n = rec.pages.length;
    var when = String(rec.saved_utc || '').replace('T', ' ').replace('Z', ' UTC');
    var what = n + ' photo' + (n === 1 ? '' : 's') + ' saved ' + when;
    var repickFirst = !!(opts && opts.repickFirst);
    var hasFolder = !!folder && !!JS.fsHandle;
    var canPick = !!JS.fsHandle && JS.fsHandle.supported();
    var where = rec.folder ? ' from “' + rec.folder + '”' : '';

    if (hasFolder && !repickFirst) {
      els.text.textContent = 'Load your last selection? ' + what + where + '. ' +
        'One tap and your crops, tone and covering come back — I open them straight from ' +
        'that folder, so there is nothing to pick.';
      act(els.primary, 'Reload my last selection', restoreFromFolder);
      act(els.secondary, 'Choose a different folder', chooseFolder);
    } else if (canPick && !repickFirst) {
      els.text.textContent = 'Load your last selection? ' + what + where + '. ' +
        'A folder picker will open once: choose the folder your photos are in and I can ' +
        'reopen them by name — no picking next time. Nothing is copied off your phone.';
      act(els.primary, 'Choose your photo folder', chooseFolder);
      act(els.secondary, 'Pick the photos again', startRepick);
    } else {
      els.text.textContent = 'Load your last selection? ' + what + where + '. ' +
        'This browser will not let a page reopen a folder, so a file picker will open and ' +
        'you pick the photos again — they are matched by name, and your crops, tone and ' +
        'covering still come back.';
      act(els.primary, 'Pick the photos again', startRepick);
      act(els.secondary, '', null);
    }
  }

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
    paint(rec, null);
    showPrompt();
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
    if (!JS.app) return;
    /* Read the stored handle BEFORE painting, so the banner's wording never changes under
       his eyes: "choose your folder" that becomes "reload your selection" a moment later
       is a banner that looks like it is guessing. One IndexedDB read is a few
       milliseconds, and a failure is not an error — it is the fallback case. */
    var ready = JS.fsHandle ? JS.fsHandle.remembered() : Promise.resolve(null);
    Promise.resolve(ready).then(function (h) { folder = h; offer(); },
                                 function () { folder = null; offer(); });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  JS.recall = {
    KEY: KEY, SCHEMA: SCHEMA, MAX_CHARS: MAX_CHARS,
    hasSaved: hasSaved, load: load, capture: capture, forget: forget,
    offer: offer, hidePrompt: hidePrompt, paint: paint,
    onFilesAdded: onFilesAdded, restoreNow: restoreNow, applyTo: applyTo,
    snapshot: snapshot, boot: boot,
    /* The folder half, exported for the tests and for anything that needs to ask the same
       questions: which case the banner is in, and which folder is remembered. */
    restoreFromFolder: restoreFromFolder, chooseFolder: chooseFolder,
    startRepick: startRepick, currentFolder: function () { return folder; },
    setFolder: function (h) { folder = h || null; return folder; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
