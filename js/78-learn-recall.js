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
 * ONE MORE THING ABOUT ANDROID THAT IS NOT ASSUMED EITHER WAY. Chrome does not implement
 * PERSISTED permissions on Android — `chrome_file_system_access_permission_context.cc`
 * returns false under `BUILDFLAG(IS_ANDROID)` with `TODO(crbug.com/40101963)`, so a folder
 * grant is not written to disk. The handle itself still survives in IndexedDB, but whether
 * `requestPermission()` can re-grant it after the browser has been restarted is NOT settled
 * here and cannot be settled from a desktop — it is the one question only his phone can
 * answer. The code therefore does not depend on the answer: it asks, and when the answer
 * comes back "prompt" twice running it stops asking and offers the two roads that still
 * work (choose the folder again; pick from the album) instead of leaving a button that
 * demands one more tap forever. See `restoreFromFolder` and `addRepairButton`.
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
  var reseed = false;       // this import is a folder import: the record must be rewritten
  var folder = null;        // the remembered FileSystemDirectoryHandle, or null
  var noticed = false;      // "Not now" pressed, or already offered, this session
  var notice = '';          // the sentence currently shown in the banner, if any
  var promptStrikes = 0;    // consecutive "prompt" outcomes; see restoreFromFolder

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
    notice = '';
    reseed = false;
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
    r.message = buildMessage(rec, info, r);
    if (JS.hint) JS.hint(r.message);
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
    notice = '';

    if (JS.showBusy) JS.showBusy('Opening your photos…');
    return JS.fsHandle.ensurePermission(folder).then(function (state) {
      if (state !== 'granted') {
        if (JS.hideBusy) JS.hideBusy();
        /* "prompt" MEANS THE QUESTION COULD NOT BE PUT, and there are two reasons for that:
           the tap's activation had already been spent when the call ran (transient, worth
           exactly one more try), or this browser will not re-grant a remembered folder at
           all. Chrome for Android does not implement persisted permissions — the grant is
           not written to disk (chrome_file_system_access_permission_context.cc returns false
           under IS_ANDROID, TODO(crbug.com/40101963)) — so the second reading is a real
           possibility on the client's phone and NOT something to loop on. After one retry the
           banner stops offering the tap and offers the two roads that still work. A button
           that asks for "one more tap" forever is the failure this file exists to remove. */
        if (state === 'prompt' && ++promptStrikes < 2) {
          say('That folder needs one more tap. Press “Reload my last selection” again.');
          paint(rec, null);
          showPrompt();
          return false;
        }
        promptStrikes = 0;
        /* A refusal is a real outcome and gets its own words. It is NOT reported as a
           missing folder, and it is not retried behind his back: the banner comes back
           with the re-pick offered first, so he is never stuck on a button that has
           stopped working. */
        say(state === 'denied'
          ? 'Android did not let me back into that folder — pick the photos again and your edits still come back.'
          : 'Android did not hand back access to that folder, and asking again did not work. ' +
            'Choose the folder once more — the picker reopens where you left it — or pick the ' +
            'photos again and your edits still come back.');
        paint(rec, { repickFirst: true });
        showPrompt();
        return false;
      }
      promptStrikes = 0;
      return JS.fsHandle.readMany(folder, rec.pages, function (i, n) {
        if (JS.showBusy) JS.showBusy('Reading ' + i + ' of ' + n + '…');
      }).then(function (info) {
        if (JS.hideBusy) JS.hideBusy();
        if (!info.files.length) {
          /* Nothing came back, and the two causes need different actions from him: the
             folder is wrong, or the names this phone gave us are not the names in the
             folder. When EVERY name is missing the second reading is much the likelier
             one, and it has a fix of its own — see `nameMismatch`. */
          var why = info.missing.length
            ? (info.missing.length + ' of your saved photos are not in “' +
               JS.fsHandle.label(folder) + '” any more')
            : 'Nothing in “' + JS.fsHandle.label(folder) + '” matched the saved file names';
          say(why + ' — nothing was changed.');
          paint(rec, { repickFirst: true });
          showPrompt();
          /* THE BUTTON THAT ACTUALLY FIXES IT. "Not in that folder any more" is true and,
             on a phone whose album picker renames files, permanently useless — the
             photograph was never missing and no amount of looking will find that name. The
             repair is offered alongside the diagnosis, never instead of it. */
          if (rec.pages.length && info.missing.length === rec.pages.length) {
            addRepairButton(false);
          }
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
      say('Could not read that folder — pick the photos again and your edits still come back.');
      paint(rec, { repickFirst: true });
      showPrompt();
      return false;
    });
  }

  /* ------------------------------------------------------------------ the repair */

  /* THE NAMES ARE NOT THIS FOLDER'S NAMES.
   *
   * The folder is right, the permission is right, and every single saved name is missing
   * from it. There is exactly one common cause and it is not something the client did: on
   * Android, when he picks from his ALBUM, the system Photo Picker hands the page a PROXY
   * of each photograph whose name comes from the media id — "1000012345.jpg" — and never
   * the camera's own "IMG_20240101_120000.jpg". No browser API gives a page the original
   * name back (Chromium issue 40123366). So the record faithfully stored a name that has
   * never existed inside DCIM/Camera, and `getFileHandle` will not find it there, today or
   * on any later launch. Left alone, this is a button that fails identically forever.
   *
   * The repair is to take the photographs FROM THE FOLDER once. `pickFiles` opens the OS
   * file picker already inside that folder (`startIn`), so what comes back are the
   * folder's own files under their REAL names; the import that follows writes a NEW record
   * built from those names, and every later restore matches.
   *
   * THE COST IS STATED, NOT HIDDEN: his crops cannot be matched to photographs whose names
   * changed, so they have to be done once more. It is said in the banner BEFORE he taps,
   * because a re-import that quietly threw away the work on six cropped receipts would be
   * a worse bug than the one being fixed. */
  /* The sentence that names the real cause. Returned, not painted, so the two callers can
     put it where each of them needs it. */
  function renameNote() {
    return 'That is what an album selection does: this phone hands the app a copy called ' +
      'something like 1000012345.jpg instead of your camera’s own IMG_0001.jpg, and that ' +
      'name has never existed inside the folder — so it is not that your photos are gone. ' +
      'Choose them FROM THE FOLDER once and from then on one tap reopens them with no ' +
      'picker. Your crops cannot be matched to photos whose names changed, so they will ' +
      'need doing one more time.';
  }

  /* Put two NAMED actions on the banner, carrying whatever `notice` currently says.
   *
   * Every repair path ends here, so a button is never relabelled without its action being
   * rewritten in the same breath — the failure `act()` exists to prevent. A no-op when
   * there is no banner: a headless caller still gets the sentence from `say`, and the
   * wiring it has nowhere to put is simply not attempted. */
  function actions(primary, primaryFn, secondary, secondaryFn, hideDrop) {
    if (!els) return false;
    act(els.primary, primary, primaryFn);
    act(els.secondary, secondary || '', secondaryFn || null);
    els.drop.hidden = !!hideDrop;
    els.later.hidden = false;
    if (notice) els.text.textContent = notice;
    els.bar.setAttribute('style', CSS_BANNER);
    return true;
  }

  /* ADDITIVE, never a replacement: it leaves the diagnosis and the action already on the
     banner in place where it can, because "the folder is wrong" and "the phone renamed your
     photos" are both still in play and only he can tell them apart. */
  function addRepairButton(primaryIsRepair) {
    if (!els) return false;
    notice = notice ? notice + ' ' + renameNote() : renameNote();
    /* NO FOLDER-ROOTED FILE PICKER MEANS THE ONE REPAIR THAT WORKS CANNOT BE OFFERED. Leaving
       the banner as it was would leave "Reload my last selection" on screen to fail in
       exactly the same way on every tap, for as long as he keeps pressing it — the
       button-that-fails-identically-forever this file exists to remove. The album is then the
       only road in, and the banner says so. */
    if (!JS.fsHandle || !JS.fsHandle.filePickerSupported()) {
      notice += ' This browser cannot open a file list inside a folder, so pick them from ' +
        'your album again — your crops come back for the ones that match.';
      return actions('Pick the photos again', startRepick, '', null, false);
    }
    var open = function () { folderImport(folder); };
    if (primaryIsRepair) return actions('Choose the photos from that folder', open,
                                        'Pick them from my album again', startRepick, false);
    return actions(els.primary.textContent, els.primary._act,
                   'Choose the photos from that folder', open, false);
  }

  /* THE SECOND TAP, AND WHY IT CANNOT BE ENGINEERED AWAY.
   *
   * `showDirectoryPicker` consumes the tap's transient user activation, so
   * `showOpenFilePicker` called from the continuation would throw SecurityError on a real
   * browser. Calling it anyway would produce a button that appears to do nothing — which
   * is the class of bug this whole file exists to remove. The banner is therefore
   * repainted with the second step ON it, and it waits for a genuine tap. */
  function askForFolderImport(handle) {
    var label = handle && handle.name ? String(handle.name) : 'that folder';
    say('Folder “' + label + '” remembered. Now choose the photos inside it once: the ' +
        'picker opens in that folder, and from then on one tap brings them back with no ' +
        'picker at all.');
    paint(load(), null);
    if (!JS.fsHandle || !JS.fsHandle.filePickerSupported()) {
      return actions('Pick them from my album', startRepick, '', null, true);
    }
    return actions('Choose my photos in that folder', function () { folderImport(folder); },
                   'Pick them from my album', startRepick, true);
  }

  /* ONE-TIME SETUP: IMPORT STRAIGHT OUT OF THE FOLDER.
   *
   * This is the step that makes the folder route work on a phone whose album picker renames
   * things, and it is also the best way in for someone setting the folder up before any
   * selection exists — the record it writes is built from the folder's own names, so the
   * very next launch can reopen them with no picker.
   *
   * MUST BE REACHED FROM A TAP. `showOpenFilePicker` needs transient user activation, so
   * every path that wants this REPAINTS THE BANNER and waits, rather than calling it from
   * a promise continuation where it would silently do nothing. */
  function folderImport(handle) {
    if (!JS.fsHandle || !JS.fsHandle.filePickerSupported()) {
      say('This browser cannot open a file list inside a folder — pick the photos again and ' +
        'your crops still come back.');
      paint(load(), { repickFirst: true });
      showPrompt();
      return Promise.resolve(false);
    }
    notice = '';
    if (JS.showBusy) JS.showBusy('Opening that folder…');
    return JS.fsHandle.pickFiles(handle, true).then(function (files) {
      if (JS.hideBusy) JS.hideBusy();
      var imgs = (files || []).map(function (f) {
        return JS.fsHandle.typed ? JS.fsHandle.typed(f) : f;
      }).filter(function (f) { return f && f.type && f.type.indexOf('image/') === 0; });
      if (!imgs.length) return false;
      pending = true;
      pendingNote = null;
      /* THE RECORD IS REWRITTEN FROM WHAT WAS JUST IMPORTED. Without this the one-time
         repair repairs nothing: the import would restore nothing and the old, unusable
         names would be re-saved on the way out. See `onFilesAdded`. */
      reseed = true;
      hidePrompt();
      return JS.addFiles(imgs);
    }, function (e) {
      if (JS.hideBusy) JS.hideBusy();
      // Dismissing the OS picker is not a failure and says nothing.
      if (String((e && e.name) || '') !== 'AbortError') {
        say('This browser would not open that folder’s file list — pick the photos again.');
        paint(load(), { repickFirst: true });
        showPrompt();
      }
      return false;
    });
  }

  /* One-time setup: choose the folder. The picker hands back a handle whose permission is
     ALREADY granted for this session, so the restore happens in the same tap — he picks
     the folder once and his edits come back before he has lifted his finger. */
  function chooseFolder() {
    // NO RECORD IS NOT A REASON TO REFUSE. The setup has to be able to run before there is
    // anything to load — that is the state the client was stuck in.
    if (!JS.fsHandle || !JS.fsHandle.supported()) return Promise.resolve(false);
    var rec = load();
    notice = '';
    promptStrikes = 0;
    return JS.fsHandle.pick().then(function (h) {
      folder = h;
      if (!rec) return askForFolderImport(h);
      return reconcile(rec, h);
    }, function (e) {
      // AbortError is him dismissing the OS picker. Not a failure — put the banner back
      // and say nothing, because he knows what he just did.
      if (String((e && e.name) || '') !== 'AbortError') {
        say('This browser would not open a folder picker.');
        paint(rec, null);
      }
      showPrompt();
      return false;
    });
  }

  /* THE FOLDER IS GRANTED. ARE THE NAMES WE SAVED NAMES THIS FOLDER HAS?
   *
   * Skipping this question is what made the folder route fail SILENTLY: the app opened
   * every saved name, got NotFoundError for all of them, and reported "not in that folder
   * any more" — which is true and useless, because the file was never missing. Asking it
   * first costs one `getFileHandle` per saved photo, needs no listing, and lets the app
   * tell "wrong folder" apart from "the phone renamed your photos", which call for two
   * completely different actions. */
  function reconcile(rec, handle) {
    if (!JS.fsHandle.probe) return restoreFromFolder();
    return JS.fsHandle.probe(handle, rec.pages.map(function (p) { return p.name; }))
      .then(function (v) {
        if (!v || !v.absent.length) return restoreFromFolder();
        if (v.present.length) return restoreFromFolder();   // partial: the read reports the rest
        /* EVERY saved name is absent from a folder he has just deliberately chosen, so it
           is not a wrong-folder mistake — it is the rename. This is the case that used to
           report "not in that folder any more" and then ask him to pick from the album
           again, which put him straight back into the same trap. */
        say('None of your ' + rec.pages.length + ' saved photo name' +
            (rec.pages.length === 1 ? '' : 's') + ' exist in “' +
            (folder && JS.fsHandle ? JS.fsHandle.label(folder) : 'that folder') +
            '” under those names.');
        paint(rec, null);
        addRepairButton(true);
        showPrompt();
        return false;
      }, function () { return restoreFromFolder(); });
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
    notice = '';
    pending = true;
    pendingNote = null;
    reseed = false;
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
      var r = null;
      try {
        r = restoreNow(info);
      } catch (e) {
        if (global.console && global.console.error) global.console.error('Recall: restore failed', e);
        say('Could not put your edits back — the photos are imported as normal.');
      }
      /* A FOLDER IMPORT MUST LEAVE A RECORD BUILT FROM THE FOLDER'S OWN NAMES, or the
         one-time repair repairs nothing and the next launch starts over. Only ever set by
         `folderImport`; a re-pick must NOT re-capture, because the saved record is the
         thing being matched against. */
      if (reseed) {
        reseed = false;
        try { capture(); } catch (e2) { /* best effort, as everywhere in this file */ }
      }
      /* THE OUTCOME GOES WHERE HE CAN SEE IT. The banner is hidden while the import runs,
         and `JS.hint` writes into the editor — so a restore that brought back four of six
         photos, naming the two that did not come back, used to finish in silence. */
      if (r && r.message) paintResult(r.message);
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

  /* WHERE THE ANSWERS ARE ACTUALLY SHOWN.
   *
   * Every outcome this module produces used to go through `JS.hint`, and `JS.hint` writes
   * into `#stage-hint` — which lives inside the EDITOR view (index.html:142). This module
   * only ever runs on the HOME screen. So every sentence it composed was painted into an
   * element that was not on screen: "6 of your saved photos are not in “Camera” any more"
   * — the one message that tells the client which photograph to go and redo — was drawn
   * where he could not see it, on a screen where the banner said nothing at all. A missing
   * file, an unreadable file, a changed file and a folder that is simply wrong all looked
   * identical from where he was standing, which is to say they all looked like nothing.
   *
   * So the BANNER carries the outcome. `say` still calls `JS.hint` as well — the editor
   * shares the same sentences and a probe reads them — but the banner is the surface that
   * the client actually has in front of him, and it is the one that must never be silent. */
  function say(msg) {
    notice = msg || '';
    if (JS.hint) { try { JS.hint(notice); } catch (e) { /* the banner copy is the one that counts */ } }
    if (els && els.text) els.text.textContent = notice;
    return notice;
  }

  /* The banner, used purely as a report: the outcome of something he just asked for, with
     one button that puts it away. Guarded on `els`, because a module reached without the
     banner ever having been painted has nothing to report into and must not conjure one. */
  function paintResult(msg) {
    if (!els) return false;
    notice = msg;
    els.text.textContent = msg;
    act(els.primary, 'OK', function () { hidePrompt(); });
    act(els.secondary, '', null);
    els.drop.hidden = true;
    els.later.hidden = true;
    els.bar.setAttribute('style', CSS_BANNER);
    return true;
  }

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
    var repickFirst = !!(opts && opts.repickFirst);
    var hasFolder = !!folder && !!JS.fsHandle;
    var canPick = !!JS.fsHandle && JS.fsHandle.supported();
    var base;

    /* "Forget it" clears a record, so with no record it is a button with nothing behind
       it — and a button with nothing behind it is how a banner looks broken. */
    els.drop.hidden = !rec;
    els.later.hidden = false;

    if (!rec) {
      /* NOTHING SAVED YET, AND THE SETUP IS STILL ON OFFER.
       *
       * This branch is the whole of the client's bug. The folder step used to exist only as
       * a button on a banner that only appeared when a saved record already existed — and
       * the record he had was written by a build that had no folder concept, so the one
       * thing that could have made the folder work was the one thing he could not reach.
       * The step is now offered on its own, before and independently of any selection. */
      base = 'Save a step every time: pick the folder your photos are in, once, and from ' +
        'then on one tap reopens them with no picker at all. Nothing is copied off this ' +
        'phone and nothing is ever written to that folder.';
      els.text.textContent = notice ? base + ' ' + notice : base;
      act(els.primary, 'Choose my photo folder', chooseFolder);
      act(els.secondary, '', null);
      return;
    }

    var n = rec.pages.length;
    var when = String(rec.saved_utc || '').replace('T', ' ').replace('Z', ' UTC');
    var what = n + ' photo' + (n === 1 ? '' : 's') + ' saved ' + when;
    var where = rec.folder ? ' from “' + rec.folder + '”' : '';

    if (hasFolder && !repickFirst) {
      base = 'Load your last selection? ' + what + where + '. ' +
        'One tap and your crops, tone and covering come back — I open them straight from ' +
        'that folder, so there is nothing to pick.';
      act(els.primary, 'Reload my last selection', restoreFromFolder);
      act(els.secondary, 'Choose a different folder', chooseFolder);
    } else if (canPick && !repickFirst) {
      base = 'Load your last selection? ' + what + where + '. ' +
        'A folder picker will open once: choose the folder your photos are in and I can ' +
        'reopen them by name — no picking next time. Nothing is copied off your phone.';
      act(els.primary, 'Choose your photo folder', chooseFolder);
      act(els.secondary, 'Pick the photos again', startRepick);
    } else {
      base = 'Load your last selection? ' + what + where + '. ' +
        'This browser will not let a page reopen a folder, so a file picker will open and ' +
        'you pick the photos again — they are matched by name, and your crops, tone and ' +
        'covering still come back.';
      act(els.primary, 'Pick the photos again', startRepick);
      /* The re-pick may be on screen because the LAST folder attempt failed rather than
         because the browser cannot do folders at all. Where the API exists, the better
         road stays on the banner instead of vanishing the moment one attempt went wrong. */
      if (canPick) act(els.secondary, 'Choose my photo folder', chooseFolder);
      else act(els.secondary, '', null);
    }
    els.text.textContent = notice ? base + ' ' + notice : base;
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
    /* NOTHING SAVED IS NOT NOTHING TO OFFER. The folder step is the thing that has to be
       reachable BEFORE a record exists — gating it behind a saved selection is exactly how
       it became unreachable on the phone that needed it. With no record and no folder API
       there is genuinely nothing to say, so the banner stays down. */
    var canPick = !!JS.fsHandle && JS.fsHandle.supported();
    if (!rec && !canPick) return false;
    noticed = true;
    setSessionFlag();
    notice = '';
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
    setFolder: function (h) { folder = h || null; return folder; },
    /* The folder-import and name-repair half, exported for the same reason: it is the path
       that only runs on a phone whose picker renames files, and the only way to assert what
       it does is to ask it. */
    folderImport: folderImport, reconcile: reconcile, askForFolderImport: askForFolderImport,
    addRepairButton: addRepairButton, renameNote: renameNote,
    currentNotice: function () { return notice; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
