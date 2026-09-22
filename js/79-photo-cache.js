/* js/79-photo-cache.js — the last selection's PHOTOGRAPHS, kept on this phone only.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT js/78-learn-recall.js
 * ------------------------------------------------------------
 * The client, asked to pick his photos a second time (v1.11.0's folder route):
 *
 *   "i expect that right after i pick the button, immediately the previous 6 photos are
 *    already loaded inside the app"
 *
 * — with NO PICKER. The folder route in js/77-fs-handle.js cannot do that for the
 * photographs he actually picks, and the reason is a platform fact rather than a bug:
 *
 *   WHEN A PHOTO IS CHOSEN FROM THE ANDROID ALBUM / PHOTO PICKER, THE PAGE RECEIVES A COPY
 *   UNDER A SYNTHETIC NAME — "1000012345.jpg" — AND NEVER THE CAMERA'S OWN "IMG_0001.jpg".
 *   The proxy is materialised by MediaProvider under
 *   /sdcard/.transforms/synthetic/picker/<pkg>/<id>.jpg, and NO BROWSER API returns the
 *   original name (Chromium issue 40123366). A record built from an album selection
 *   therefore holds a name that has never existed inside any folder, so `getFileHandle`
 *   could not open it on that launch or on any later one.
 *
 * Therefore: an album-picked photo can NEVER be reopened by name, by any means. The only
 * way to have the previous selection back with no picker is to keep the PHOTOGRAPHS
 * THEMSELVES — and the client was asked and chose exactly that ("Cache the photos on the
 * phone"). That choice deliberately revises his earlier "don't keep the photos", and it is
 * HIS data on HIS phone: this file is the narrowest possible implementation of it.
 *
 * WHAT IS KEPT, AND WHERE
 * -----------------------
 * IndexedDB (database `jscanner.photos`), NOT localStorage: localStorage is ~5MB, holds
 * strings only, and would have to base64 the bytes — which inflates them by a third and
 * puts a copy of a pathology report inside the same store as the Learn token. IndexedDB
 * stores Blobs directly and is the only storage a browser will grant meaningful quota to.
 *
 * One record, one key. The manifest and every photograph are written by a SINGLE `put` in
 * a SINGLE transaction, which is what makes a half-written selection impossible: IndexedDB
 * commits a record or it does not, so the store can only ever hold the whole of the
 * previous selection or the whole of this one. There is no state in which it holds three of
 * six photographs and a manifest promising six.
 *
 * Alongside the bytes, the same restorable state js/78-learn-recall.js records — crop quad,
 * coarse rotation, fine angle, mode, tone, the redaction mask and the comment — so the
 * cache brings back the WORK as well as the photographs. That state is written by
 * `JS.recall.pageState` and read back by `JS.recall.applyTo`, so there is one definition of
 * what "a page's state" means and not two.
 *
 * FRESH PAGE OBJECTS, ALWAYS
 * --------------------------
 * The restore re-imports the cached bytes through `JS.addFiles`, which decodes them and
 * makes NEW page objects, and only then writes the saved values onto them. It must never
 * keep a page object and re-attach it: `JS.stateKey` folds crop/orientation/tone/mask into
 * the canvas cache key, so a page carried over from a previous session arrives with last
 * session's caches still on it and the editor draws the wrong canvas under the right
 * controls.
 *
 * NOTHING HERE IS EVER UPLOADED. NOT EVER.
 * ---------------------------------------
 * These photographs include pathology reports, a passport page and identity cards. This
 * file has NO network path of any kind: no `fetch`, no `XMLHttpRequest`, no `sendBeacon`,
 * no WebSocket, no service worker, and no call into `JS.learn` — the Learn transport in
 * js/70-learn.js is the only thing in this app that may send anything, and the cache is
 * deliberately not wired to it. It does not attach a cached photo to a bundle, it does not
 * pre-fill a bundle, and it does not know what a bundle is.
 * `tests/learn_cache_test.mjs` enforces that with spies on every one of those APIs across a
 * full save/load/forget cycle, and by scanning this file's own source for the names.
 *
 * IT ALSO SAYS SO, WHERE HE CAN SEE IT. Caching is not sending, and a client who believed a
 * cached photograph had been sent (or that sending was the same as caching) would be badly
 * misled — so the banner states, at the moment the selection is cached, that the photos stay
 * on this phone and are not uploaded, and it names Learn as the separate thing that
 * transmits.
 *
 * BOUNDED, AND SHOWING WHAT IT USES
 * ---------------------------------
 * `MAX_PHOTOS` and `MAX_BYTES` cap the cache. Past a cap the OLDEST entries are dropped —
 * oldest-first, which within one selection is the ones he picked first — and the count of
 * dropped photos is carried in the record and said out loud rather than silently shrinking
 * the restore. The banner shows the photo count and the bytes it is using, and reports
 * honestly what `navigator.storage.persist()` answered: a browser that will not promise to
 * keep the data is a real answer and is not dressed up as one that will.
 *
 * FORGETTING IS ONE TAP AND IS VERIFIED
 * -------------------------------------
 * "Forget saved photos" deletes the record and then READS THE STORE BACK to prove it is
 * empty before telling him it is gone. A confirmation that cannot fail is a claim, not a
 * report.
 */
(function (global) {
  'use strict';

  var JS = global.JS = global.JS || {};

  if (!JS.recall) {
    /* LOUD, not silent, and for the same reason js/76-learn-ui.js is: a module that bails
       quietly is a button that does nothing and logs nothing — the bug v1.8.0 shipped when
       a script tag was missing from index.html. */
    if (global.console && global.console.error) {
      global.console.error('Photo cache: js/79-photo-cache.js needs JS.recall ' +
        '(js/78-learn-recall.js) for the saved crop/tone/covering record and for ' +
        'JS.addFiles. Check the script tags in index.html.');
    }
    return;
  }

  /* One database of our own, deliberately NOT the one js/77-fs-handle.js keeps the folder
     handle in. They are different things with different lifetimes — "which folder" and
     "which photographs" — and mixing them would make "Forget saved photos" and "Forget it"
     two names for one destructive act. */
  var DB = 'jscanner.photos';
  var STORE = 'cache';
  var KEY = 'last';
  var VERSION = 1;
  var SCHEMA = 'jscan.photocache/1';

  /* THE CAPS. These are a safety net, not the design: the client's own use is about six
     photographs. At JS.WORK_MAX (2400px) a document photograph re-encodes to roughly
     0.3-1.2MB, so 24 photographs is 8-29MB and the byte cap binds first on the heavy end.
     Both exist so the cache cannot grow without limit on a phone this app does not own. */
  var MAX_PHOTOS = 24;
  var MAX_BYTES = 48 * 1024 * 1024;

  /* A blob smaller than this is not a JPEG header, let alone a photograph. Cheap enough to
     check before asking a decoder about it. */
  var MIN_BLOB = 16;

  var els = null;
  var notice = '';          // the sentence currently shown in the banner, if any
  var busy = false;         // a restore or a wipe is in flight
  var loading = false;      // this import IS a restore: do not overwrite the record with it
  var persistState = '';    // '' unknown | 'already' | 'granted' | 'denied' | 'unavailable'
  var shownBytes = 0;
  var lastSig = null;       // what the store is already holding; see `save`

  /* ------------------------------------------------------------------- storage */

  function supported() {
    return !!global.indexedDB && typeof global.File === 'function' &&
           typeof global.Blob === 'function';
  }

  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) { reject(new Error('IDB_UNAVAILABLE')); return; }
      var req;
      try { req = global.indexedDB.open(DB, VERSION); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IDB_OPEN_FAILED')); };
      req.onblocked = function () { reject(new Error('IDB_BLOCKED')); };
    });
    // NOT CACHED ON FAILURE: private-mode Firefox and some locked-down Android builds
    // reject the open, and caching that rejection would make every later attempt fail with
    // the first one's error, so the recovery would need a reload to take effect.
    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }

  /* One transaction, and the value is read at `oncomplete` rather than at `onsuccess` —
     a request's `result` is only the answer once the transaction commits. */
  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t, out;
        try {
          t = db.transaction(STORE, mode);
          out = fn(t.objectStore(STORE));
        } catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(out ? out.result : undefined); };
        t.onerror = function () { reject(t.error || new Error('IDB_TX_FAILED')); };
        t.onabort = function () { reject(t.error || new Error('IDB_TX_ABORTED')); };
      });
    });
  }

  /* Quota is reported three different ways across the browsers this app runs on (the
     legacy `code` 22, the name, and only inside the message on some builds), so all three
     are asked. Getting this wrong is not cosmetic: an unrecognised quota error would be
     reported to the client as an unexplained failure instead of "this phone is full". */
  function isQuota(e) {
    if (!e) return false;
    if (String(e.name || '') === 'QuotaExceededError') return true;
    if (e.code === 22) return true;
    return String(e.message || '').indexOf('QuotaExceededError') !== -1;
  }

  /* A record that does not parse, or that belongs to a schema this build does not know, is
     DROPPED rather than half-read: a partially understood selection restores as a wrong
     crop on a document, which is worse than restoring nothing. */
  function readRecord() {
    return tx('readonly', function (s) { return s.get(KEY); }).then(function (rec) {
      if (!rec || rec.schema !== SCHEMA || !rec.items || !rec.items.length) return null;
      for (var i = 0; i < rec.items.length; i++) {
        var it = rec.items[i];
        if (!it || !it.name || !it.blob) return null;
      }
      return rec;
    }, function () { return null; });
  }

  function sumBytes(items) {
    var n = 0;
    for (var i = 0; i < items.length; i++) n += items[i].bytes || 0;
    return n;
  }

  function fmtBytes(n) {
    if (JS.fmtBytes) return JS.fmtBytes(n);
    return n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  }

  /* --------------------------------------------------------------------- caps */

  /* OLDEST FIRST. `items` arrives in the order the pages are on screen, which is the order
     he picked them, so the oldest are at the front and are the ones that go. The alternative
     — dropping the tail — would hand back a stack that starts at photograph 7, which reads
     as a bug even when it is not one; a prefix that is short is at least obviously short,
     and the banner says how many went. */
  function trim(items) {
    var kept = items.slice();
    var dropped = 0;
    var total = sumBytes(kept);
    while (kept.length > MAX_PHOTOS) { total -= kept[0].bytes || 0; kept.shift(); dropped++; }
    // `kept.length > 1` and not `> 0`: one photograph on its own is what the feature is for,
    // and it is already bounded by the ingest cap, so it is never the thing to drop.
    while (kept.length > 1 && total > MAX_BYTES) {
      total -= kept[0].bytes || 0;
      kept.shift();
      dropped++;
    }
    return { kept: kept, dropped: dropped };
  }

  /* ------------------------------------------------------------- persistence */

  /* WHAT `persist()` ACTUALLY ANSWERED, reported as itself.
   *
   * Best-effort on Android, which may evict an origin under storage pressure; `persist()`
   * asks it not to. The answer differs by platform and by engagement heuristics, so it is
   * never assumed: 'already' and 'granted' are promises the browser made, 'denied' is one it
   * refused, 'unavailable' means the API is not there at all. The banner says which. */
  function askPersist() {
    var s = global.navigator && global.navigator.storage;
    if (!s || typeof s.persist !== 'function') {
      persistState = 'unavailable';
      return Promise.resolve(persistState);
    }
    if (persistState === 'already' || persistState === 'granted') return Promise.resolve(persistState);
    return Promise.resolve(typeof s.persisted === 'function' ? s.persisted() : false)
      .catch(function () { return false; })
      .then(function (already) {
        if (already) { persistState = 'already'; return persistState; }
        return Promise.resolve(s.persist()).then(function (yes) {
          persistState = yes ? 'granted' : 'denied';
          return persistState;
        }, function () {
          // A refusal and a throw are the same answer here, and neither is a reason to
          // keep asking: `persist()` needs user activation on some builds and the next save
          // may have it, so the state is left re-askable only when it was never answered.
          persistState = 'denied';
          return persistState;
        });
      });
  }
  function persistNow() { return askPersist(); }

  /* THE WRITE, AND WHAT HAPPENS WHEN THE PHONE IS FULL.
   *
   * Step 1 is one `put` of one record: atomic, so a quota failure leaves the PREVIOUS
   * selection exactly as it was. The old record is only ever destroyed on purpose.
   *
   * Step 2 runs only after a real QuotaExceededError. The record is being replaced anyway,
   * so the old one is cleared first — otherwise a full phone could never accept a new
   * selection — and then the NEW selection is written with its newest half. Half rather
   * than none, because the client's complaint is about reopening photographs, and some of
   * them with a stated count beats none of them.
   *
   * Step 3 is the honest failure: the cache is left EMPTY rather than holding a record that
   * promises photographs it does not have. Empty is a state the app can describe ("nothing
   * is saved"); a manifest with missing blobs is not. */
  function persistRecord(rec) {
    return tx('readwrite', function (s) { s.put(rec, KEY); })
      .then(function () { return { ok: true, trimmed: rec.trimmed || 0, quota: false }; },
        function (e) {
          if (!isQuota(e)) throw e;
          return tx('readwrite', function (s) { s.delete(KEY); }).then(function () {
            var half = Math.max(1, Math.floor(rec.items.length / 2));
            var small = {
              schema: rec.schema,
              saved_utc: rec.saved_utc,
              app_version: rec.app_version,
              comment: rec.comment,
              total_bytes: sumBytes(rec.items.slice(rec.items.length - half)),
              trimmed: (rec.trimmed || 0) + (rec.items.length - half),
              skipped: rec.skipped,
              items: rec.items.slice(rec.items.length - half)
            };
            return tx('readwrite', function (s) { s.put(small, KEY); }).then(function () {
              return { ok: true, trimmed: small.trimmed, quota: true };
            }, function () {
              return tx('readwrite', function (s) { s.delete(KEY); }).then(
                function () { return { ok: false, reason: 'quota', trimmed: 0 }; },
                function () { return { ok: false, reason: 'quota', trimmed: 0 }; });
            });
          });
        });
  }

  /* ----------------------------------------------------------------- capturing */

  /* Every page that can be brought back, with its bytes and its restorable state.
   *
   * A page with no `file` record (pasted, or from the camera input) has no name to be
   * identified by, and a page with no encoded blob has nothing to restore FROM. Both are
   * counted and skipped, and the count is carried in the record so the banner does not
   * claim a selection is complete when it is not. */
  function collect() {
    var pages = (JS.app && JS.app.pages) || [];
    var items = [];
    var skipped = 0;
    for (var i = 0; i < pages.length; i++) {
      var p = pages[i];
      if (!p || !p.file || !p.file.name || !p.file.size) { skipped++; continue; }
      // `_blob` is the encoded page source itself (js/50-ui.js `canvasToSource`), so this
      // costs no second encode and no second copy: it is the same bytes the preview draws.
      var blob = p.source && p.source._blob;
      if (!blob || typeof blob.size !== 'number' || blob.size < MIN_BLOB) { skipped++; continue; }
      items.push({
        name: p.file.name,
        size: p.file.size,
        lastModified: p.file.lastModified || 0,
        type: blob.type || 'image/jpeg',
        bytes: blob.size,
        state: JS.recall.pageState(p),
        blob: blob
      });
    }
    return { items: items, skipped: skipped };
  }

  /* A CHEAP FINGERPRINT OF EVERYTHING IN THE RECORD EXCEPT THE BYTES.
   *
   * `save` runs on every `visibilitychange` as well as after every import, and on a phone
   * that means every app switch. Each one would otherwise re-write the whole selection —
   * several megabytes of flash for a state that had not moved — while the device is being
   * frozen, which is the worst moment to start a long write. The fingerprint is taken over
   * the names, the sizes, the ORIGINAL last-modified stamps, the byte counts and the whole
   * saved state (crop, rotation, tone, adj, mask revision), plus the comment; `saved_utc` is
   * left out because it changes every time by design.
   *
   * Equality therefore means "this store already holds exactly this", and a save is skipped
   * only then. The one way it could be wrong is a store that lost the record underneath us,
   * so `lastSig` is cleared whenever that is known to have happened: on a purge, and on a
   * launch that finds nothing there. */
  function fingerprint(items, skipped, comment) {
    var parts = ['v1', String(skipped), JSON.stringify(comment || null)];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      parts.push(it.name + '|' + it.size + '|' + it.lastModified + '|' + it.bytes + '|' +
                 JSON.stringify(it.state));
    }
    return parts.join('\u0000');
  }

  /* Cache the selection on this phone. Resolves with a report; never rejects, because it is
     called from an import and from `pagehide` and must not be able to break either. */
  function save() {
    if (!supported()) return Promise.resolve({ ok: false, reason: 'unsupported' });
    var got = collect();
    if (!got.items.length) return Promise.resolve({ ok: false, reason: 'nothing' });
    var t = trim(got.items);
    var comment = (JS.learnUI && JS.learnUI.currentComment) ? JS.learnUI.currentComment() : null;
    var rec = {
      schema: SCHEMA,
      saved_utc: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      app_version: JS.VERSION || 'unknown',
      comment: comment,
      total_bytes: sumBytes(t.kept),
      trimmed: t.dropped,
      skipped: got.skipped,
      items: t.kept
    };
    /* NOTHING MOVED, SO NOTHING IS WRITTEN. Reporting the same numbers keeps every caller's
       sentence true — they are saved, and they were saved already. */
    var sig = fingerprint(t.kept, got.skipped, comment);
    if (sig === lastSig) {
      return Promise.resolve({
        ok: true, unchanged: true, photos: t.kept.length, bytes: rec.total_bytes,
        trimmed: t.dropped, persist: persistState
      });
    }
    return askPersist().then(function () { return persistRecord(rec); })
      .then(function (r) {
        // Only a write that really landed may claim the store holds this.
        if (r.ok) lastSig = sig;
        r.photos = t.kept.length;
        r.bytes = rec.total_bytes;
        r.persist = persistState;
        return r;
      }, function (e) {
        // Anything that is not quota: the record is untouched (nothing was written), which
        // is why this is a report and not a crash.
        return { ok: false, reason: 'failed', error: String((e && e.message) || e) };
      });
  }

  /* ---------------------------------------------------------------- restoring */

  /* IS THIS STILL AN IMAGE? Asked of a real decoder, before the client is shown anything.
   *
   * A byte-length check would pass a truncated JPEG, and a truncated JPEG decodes to a grey
   * band or to nothing — which, handed to `JS.addFiles`, is silently skipped, so the
   * restore would come back one photograph short with no explanation. The requirement is
   * that a bad entry is DROPPED AND SAID OUT LOUD, and neither half is possible without
   * asking a decoder first.
   *
   * SEQUENTIAL ON PURPOSE, like js/77-fs-handle.js `readMany`: two dozen simultaneous
   * 2400px decodes is how a phone tab runs out of memory. */
  function decodable(blob) {
    if (!blob || typeof blob.size !== 'number' || blob.size < MIN_BLOB) return Promise.resolve(false);
    if (typeof global.createImageBitmap === 'function') {
      return Promise.resolve()
        .then(function () { return global.createImageBitmap(blob); })
        .then(function (bmp) {
          var ok = !!(bmp && bmp.width > 0 && bmp.height > 0);
          if (bmp && bmp.close) { try { bmp.close(); } catch (e) { /* cosmetic */ } }
          return ok;
        }, function () { return false; });
    }
    // No createImageBitmap: an <img> round trip is the only other decoder a page has.
    if (typeof global.Image !== 'function' || !global.URL || !global.URL.createObjectURL) {
      return Promise.resolve(false);
    }
    return new Promise(function (resolve) {
      var url = global.URL.createObjectURL(blob);
      var im = new global.Image();
      var done = false;
      function fin(ok) {
        if (done) return;
        done = true;
        try { global.URL.revokeObjectURL(url); } catch (e) { /* cosmetic */ }
        resolve(ok);
      }
      im.onload = function () { fin(!!(im.naturalWidth || im.width)); };
      im.onerror = function () { fin(false); };
      // A truncated image can hang a decoder rather than error it. The timeout is the only
      // thing that keeps a bad entry from becoming a banner that never comes back.
      global.setTimeout(function () { fin(false); }, 3000);
      im.src = url;
    });
  }

  function verify(rec) {
    var list = rec.items.slice();
    var good = [];
    var dropped = 0;
    var i = 0;
    function step() {
      if (i >= list.length) return Promise.resolve({ items: good, dropped: dropped });
      var it = list[i++];
      return decodable(it.blob).then(function (ok) {
        if (ok) good.push(it); else dropped++;
        return step();
      });
    }
    return step();
  }

  /* THE PAYOFF. One tap, no picker, nothing to choose: the cached bytes are re-imported
     through the ordinary path and the saved values are written onto the fresh pages. */
  function load() {
    if (busy) return Promise.resolve(null);
    if (!supported()) return Promise.resolve({ ok: false, reason: 'unsupported' });
    busy = true;
    loading = true;
    return readRecord().then(function (rec) {
      if (!rec) {
        // Nothing in the store: whatever `lastSig` believed is no longer true of it.
        lastSig = null;
        loading = false; busy = false;
        return { ok: false, reason: 'empty' };
      }
      if (JS.showBusy) JS.showBusy('Checking the photos saved on this phone…');
      return verify(rec).then(function (v) {
        if (!v.items.length) {
          /* EVERY copy unreadable, which is what an evicted or half-cleared store looks
             like. The record is purged rather than left to fail the same way next launch. */
          return purge().then(function () {
            loading = false; busy = false;
            if (JS.hideBusy) JS.hideBusy();
            if (JS.recall.mute) JS.recall.mute(false);
            report('None of the photos saved on this phone could be read back, so they ' +
              'have been dropped. Pick your photos again and this will build itself anew.');
            return { ok: false, reason: 'unreadable', dropped: v.dropped };
          });
        }
        var files = v.items.map(function (it) {
          return new global.File([it.blob], it.name, {
            type: it.type || 'image/jpeg', lastModified: it.lastModified || 0
          });
        });
        if (JS.hideBusy) JS.hideBusy();
        var before = (JS.app && JS.app.pages) ? JS.app.pages.length : 0;
        return Promise.resolve(JS.addFiles(files)).then(function () {
          var r = applySaved(rec, v.items, before);
          loading = false; busy = false;
          r.dropped = v.dropped;
          r.total = rec.items.length;
          var msg = 'Loaded ' + r.restored + ' of ' + rec.items.length + ' photos from this ' +
            'phone — no picker. Your crops, tone and covering are back.';
          if (v.dropped) {
            msg += ' ' + v.dropped + ' saved photo' + (v.dropped === 1 ? '' : 's') +
              ' could not be read back and ' + (v.dropped === 1 ? 'was' : 'were') +
              ' dropped.';
          }
          r.message = msg;
          paintOutcome(rec, msg);
          return r;
        });
      });
    }).catch(function (e) {
      loading = false; busy = false;
      if (JS.hideBusy) JS.hideBusy();
      report('Could not reopen the photos saved on this phone: ' +
        String((e && e.message) || e) + '. They are still there — try again, or pick them.');
      return { ok: false, reason: 'failed' };
    });
  }

  /* The saved values, onto pages that were just decoded from the saved bytes. NOTHING is
     read back out of the record after this: `JS.recall.applyTo` copies every field. */
  function applySaved(rec, items, before) {
    var pages = (JS.app && JS.app.pages) || [];
    var fresh = pages.slice(before);
    var used = [];
    var restored = 0;
    var unmatched = 0;
    for (var i = 0; i < fresh.length; i++) {
      var page = fresh[i];
      var want = page.file && page.file.name;
      var hit = null;
      for (var j = 0; j < items.length; j++) {
        if (!used[j] && items[j].name === want) { hit = items[j]; used[j] = true; break; }
      }
      // A page the decoder produced but no saved entry matches is left exactly as imported:
      // putting one document's crop onto another is the failure this whole path must not
      // have, so nothing is ever applied by position alone.
      if (!hit) { unmatched++; continue; }
      /* THE FILE THE PAGE CAME FROM IS THE FILE HE PICKED, not the cached copy of it. The
         bytes here are the page's own capped re-encode, so `size` would otherwise become
         the blob's length and the record would describe something he never had — and the
         folder route and any later re-pick match on name + size. */
      page.file = { name: hit.name, size: hit.size, lastModified: hit.lastModified || 0 };
      if (JS.recall.applyTo(page, hit.state)) restored++;
    }
    if (JS.renderHome) JS.renderHome();
    if (rec.comment && JS.learnUI && JS.learnUI.setComment) JS.learnUI.setComment(rec.comment);
    /* AND THE METADATA RECORD IS BROUGHT BACK INTO STEP.
       `JS.addFiles` calls `JS.recall.onFilesAdded()` BEFORE this function runs, so the
       ordinary capture in js/78-learn-recall.js has just written a record describing these
       pages as they came out of the decoder — no crop, no tone, no covering. Left alone,
       a cache restore would quietly downgrade the folder route's record to an unedited
       selection. Re-capturing now writes the applied values, which is what the pages on
       screen actually are. */
    if (JS.recall.capture) { try { JS.recall.capture(); } catch (e) { /* best effort */ } }
    return { restored: restored, pages: fresh.length, unmatched: unmatched };
  }

  /* ------------------------------------------------------------------ forgetting */

  function purge() {
    return tx('readwrite', function (s) { s.delete(KEY); })
      .then(function () {
        // The store no longer holds what `lastSig` describes, so no save may be skipped
        // on the strength of it. See `fingerprint`.
        lastSig = null;
        return true;
      }, function () { return false; });
  }

  /* Delete it, then READ THE STORE BACK and report what is actually there. A wipe that
     answers only "I called delete" cannot tell a client his documents are gone. */
  function forget() {
    if (!supported()) return Promise.resolve({ ok: true, verified: false });
    return purge().then(function () {
      return readRecord().then(function (left) {
        return { ok: !left, verified: true };
      }, function () { return { ok: true, verified: false }; });
    }).then(function (r) {
      shownBytes = 0;
      if (r.ok) lastSig = null;
      if (JS.recall.mute) JS.recall.mute(false);
      if (r.ok) {
        report(r.verified
          ? 'Forgotten. The photos saved on this phone are gone — I checked the store and ' +
            'it is empty. Your photos in the gallery are untouched, and nothing was ever ' +
            'uploaded.'
          : 'Forgotten. Your photos in the gallery are untouched, and nothing was ever ' +
            'uploaded.');
      } else {
        report('This browser would not clear the saved photos, so they are still on this ' +
          'phone. Nothing has been uploaded either way.');
      }
      return r;
    });
  }

  /* ------------------------------------------------------------------- the banner */

  /* IN THE PAGE'S OWN FLOW, like the recall banner and for the same reason: a fixed bar
     swallows every tap that lands on it, and the bottom of the home screen is where the
     import and export buttons live. It is a block above the page grid that pushes what is
     under it down and scrolls away with everything else. */
  var CSS_BANNER =
    'display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:center;' +
    'padding:11px 13px;margin:0 0 4px;background:#10222a;border:1px solid #1d5a6b;' +
    'border-radius:10px;color:#f4f4f4;box-sizing:border-box';
  var CSS_BTN =
    'padding:10px 14px;border-radius:9px;border:1px solid #666;background:#262626;color:#f4f4f4;' +
    'font:inherit;font-weight:600;min-height:44px';
  var CSS_PRIMARY = CSS_BTN + ';background:#0e7490;border-color:#0e7490;color:#fff';
  var CSS_SMALL = 'font-size:12.5px;opacity:.85;margin-top:4px';

  function el(tag, style, text) {
    var n = document.createElement(tag);
    if (style) n.setAttribute('style', style);
    if (text != null) n.textContent = text;
    return n;
  }

  /* One listener per button with the ACTION swapped underneath it: adding a listener per
     repaint would stack them and the second tap would run every action the banner had ever
     offered. A button with no action is hidden rather than shown dead. */
  function act(btn, label, fn) {
    btn.textContent = label;
    btn._act = fn || null;
    btn.hidden = !fn;
    btn.setAttribute('style', btn._primary ? CSS_PRIMARY : CSS_BTN);
  }

  function build() {
    if (els) return els;
    var bar = el('div', CSS_BANNER);
    bar.id = 'cache-banner';
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-label', 'Photos saved on this phone');

    var text = el('div', 'flex:1 1 100%;text-align:center');
    var meta = el('div', CSS_SMALL);
    var row = el('div', 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center');
    var primary = el('button', CSS_PRIMARY, '');
    primary.type = 'button';
    primary._primary = true;
    var forgetBtn = el('button', CSS_BTN, '');
    forgetBtn.type = 'button';
    var later = el('button', CSS_BTN, 'Not now');
    later.type = 'button';
    row.appendChild(primary); row.appendChild(forgetBtn); row.appendChild(later);

    bar.appendChild(text);
    bar.appendChild(meta);
    bar.appendChild(row);

    var home = JS.$ ? JS.$('view-home') : null;
    var anchor = JS.$ ? JS.$('empty-state') : null;
    if (home && anchor && anchor.parentNode === home) home.insertBefore(bar, anchor);
    else if (home) home.appendChild(bar);
    else document.body.appendChild(bar);

    els = { bar: bar, text: text, meta: meta, primary: primary, forget: forgetBtn, later: later };

    act(primary, '', null);
    act(forgetBtn, 'Forget saved photos', doForget);
    primary.addEventListener('click', function () { if (primary._act) primary._act(); });
    forgetBtn.addEventListener('click', function () { if (forgetBtn._act) forgetBtn._act(); });
    later.addEventListener('click', hide);
    return els;
  }

  function hide() { if (els) els.bar.setAttribute('style', 'display:none'); }
  function show() { if (els) els.bar.setAttribute('style', CSS_BANNER); }
  function currentNotice() { return notice; }

  function doForget() {
    if (busy) return Promise.resolve(null);
    busy = true;
    return forget().then(function (r) { busy = false; return r; });
  }

  /* THE PRIVACY SENTENCE, and it is not a flourish.
   *
   * Caching is not sending. A client who read "your photos are saved" and believed they had
   * been sent — or who read it and worried that they had — would be misled in the one place
   * this app must not mislead him, and the photographs include a passport page and identity
   * cards. So every version of this banner says what is on the phone, says it is not
   * uploaded, and names Learn as the separate thing that does transmit. */
  var PRIVACY =
    'They stay on this phone and are not uploaded anywhere. Learn is the separate thing ' +
    'that sends a photo, and only the ones you brush and press Send on.';

  function persistLine() {
    if (persistState === 'already' || persistState === 'granted') {
      return 'Android has agreed to keep these for you.';
    }
    if (persistState === 'denied') {
      return 'Android has NOT promised to keep them — it may clear them if the phone runs ' +
        'out of space.';
    }
    if (persistState === 'unavailable') {
      return 'This browser cannot promise to keep them, so they may be cleared if the phone ' +
        'runs out of space.';
    }
    return '';
  }

  /* The offer, or the report. `report` swaps the buttons for a single OK. */
  function paint(rec, asReport) {
    build();
    var n = rec.items.length;
    var bytes = rec.total_bytes || sumBytes(rec.items);
    shownBytes = bytes;
    var head = n + ' photo' + (n === 1 ? '' : 's') + ' saved on this phone · ' + fmtBytes(bytes);
    els.text.textContent = notice ? notice : head;
    var lines = [notice ? head + '.' : '', PRIVACY];
    if (rec.trimmed) {
      lines.push(rec.trimmed + ' of the photos you picked were not saved — this phone only ' +
        'keeps the newest ' + MAX_PHOTOS + '.');
    }
    if (rec.skipped) {
      lines.push(rec.skipped + ' page' + (rec.skipped === 1 ? '' : 's') + ' could not be ' +
        'saved (no file of its own to reopen).');
    }
    lines.push(persistLine());
    els.meta.textContent = lines.filter(Boolean).join(' ');
    els.bar.setAttribute('style', CSS_BANNER);

    if (asReport) {
      act(els.primary, 'OK', hide);
      act(els.forget, '', null);
      els.later.hidden = true;
      return true;
    }
    els.later.hidden = false;
    act(els.primary, 'Load my last ' + n + ' photo' + (n === 1 ? '' : 's'), load);
    act(els.forget, 'Forget saved photos', doForget);
    return true;
  }

  /* THE OUTCOME OF A RESTORE, painted from the record that is already in hand.
   *
   * It does not re-read the store, and that is not an optimisation: a re-read paints a
   * moment later, so the banner would show the OFFER for a beat before correcting itself to
   * the result — and on a slow store the client would see "3 photos saved" after tapping to
   * load them, which reads as nothing having happened.
   *
   * The buttons are OK and Forget. NOT the load button again: the photographs are on screen
   * now, and a second tap on the same button would import a second copy of all of them.
   * Forget stays reachable, because it is the promise this whole feature rests on, and the
   * offer comes back by itself on the next launch. */
  function paintOutcome(rec, msg) {
    build();
    var n = rec.items.length;
    var bytes = rec.total_bytes || sumBytes(rec.items);
    shownBytes = bytes;
    els.text.textContent = msg;
    var lines = [n + ' photo' + (n === 1 ? '' : 's') + ' saved on this phone · ' + fmtBytes(bytes) + '.',
                 PRIVACY];
    if (rec.trimmed) {
      lines.push(rec.trimmed + ' of the photos you picked were not saved — this phone only ' +
        'keeps the newest ' + MAX_PHOTOS + '.');
    }
    if (rec.skipped) {
      lines.push(rec.skipped + ' page' + (rec.skipped === 1 ? '' : 's') + ' could not be ' +
        'saved (no file of its own to reopen).');
    }
    lines.push(persistLine());
    els.meta.textContent = lines.filter(Boolean).join(' ');
    els.bar.setAttribute('style', CSS_BANNER);
    els.later.hidden = true;
    act(els.primary, 'OK', hide);
    act(els.forget, 'Forget saved photos', doForget);
    return true;
  }

  /* A report: the outcome of something he just asked for. It is the CACHE banner because
     `JS.hint` writes into #stage-hint, which lives inside the EDITOR — every sentence this
     module composes would otherwise be painted onto a screen he is not looking at. */
  function report(msg, asOffer) {
    notice = msg || '';
    if (asOffer) {
      return readRecord().then(function (rec) {
        if (!rec) { return paintEmptyReport(msg); }
        return paintOutcome(rec, msg);
      }, function () { return paintEmptyReport(msg); });
    }
    return paintEmptyReport(msg);
  }

  function paintEmptyReport(msg) {
    build();
    els.text.textContent = msg;
    els.meta.textContent = '';
    act(els.primary, 'OK', hide);
    act(els.forget, '', null);
    els.later.hidden = true;
    els.bar.setAttribute('style', CSS_BANNER);
    return true;
  }

  /* ---------------------------------------------------------------- the wiring */

  /* CALLED BY js/50-ui.js AT THE END OF EVERY IMPORT, including a restore — and that is
     why `loading` exists. A restore imports through the same door, and re-caching what was
     just restored would rewrite `saved_utc` as "now" and, worse, capture the state of pages
     whose saved values have not been applied yet. The record being restored from is the
     record; it is not replaced by its own shadow. */
  function onFilesAdded() {
    if (loading) return Promise.resolve(null);
    if (!supported()) return Promise.resolve(null);
    if (els) notice = '';
    return save().then(function (r) {
      if (!r.ok) {
        /* NOTHING CACHED IS NOT A SILENT EVENT when he has just picked photographs and the
           reason is that the phone is full: that is the moment he most needs to know the
           reopen feature will not be there next time. */
        if (r.reason === 'quota') {
          report('This phone is full, so the photos could not be saved for reopening next ' +
            'time. They are still open in the app. ' + PRIVACY);
        }
        return r;
      }
      if (JS.recall.mute) JS.recall.mute(true);
      var n = r.photos;
      notice = 'Saved on this phone: ' + n + ' photo' + (n === 1 ? '' : 's') + ', ' +
        fmtBytes(r.bytes) + '. One tap brings them back with your crops, tone and covering ' +
        '— no picker.';
      return readRecord().then(function (rec) {
        if (rec) paint(rec, false);
        return r;
      }, function () { return r; });
    }, function () { return { ok: false, reason: 'failed' }; });
  }

  function usage() {
    return readRecord().then(function (rec) {
      if (!rec) return { photos: 0, bytes: 0, persisted: persistState, saved_utc: '' };
      return {
        photos: rec.items.length,
        bytes: rec.total_bytes || sumBytes(rec.items),
        trimmed: rec.trimmed || 0,
        saved_utc: rec.saved_utc || '',
        persisted: persistState
      };
    }, function () { return { photos: 0, bytes: 0, persisted: persistState, saved_utc: '' }; });
  }

  function hasSaved() { return readRecord().then(function (r) { return !!r; }, function () { return false; }); }

  /* SAVED ON THE WAY OUT, as well as after an import. Mobile browsers freeze or discard a
     tab without warning, and `visibilitychange` is the last reliable moment to write: it
     fires when he switches apps, when he goes to the home screen, and when the page is
     being put away. Cheap, because the Blobs are already in the browser's blob store and
     this is not on a drag path. */
  function boot() {
    if (typeof document === 'undefined') return;
    if (!supported()) return;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && !loading) { try { save(); } catch (e) { /* best effort */ } }
    });
    global.addEventListener('pagehide', function () {
      if (!loading) { try { save(); } catch (e) { /* best effort */ } }
    });
    if (!JS.app) return;
    /* The offer is painted only when there is something to offer, and it is painted AFTER
       the record has been read — so the banner never appears saying "no photos saved" and
       then corrects itself a moment later. `persisted()` is asked at the same time, so the
       sentence about whether Android will keep it is the browser's answer and not a guess. */
    readRecord().then(function (rec) {
      lastSig = null;   // nothing is known to be held until a read says so
      if (!rec) return null;
      return Promise.resolve(persistNow()).then(function () {
        // A cached selection makes every route js/78-learn-recall.js can offer the worse
        // answer: they all cost a picker, and the folder one cannot work at all on a photo
        // he chose from his album (see this file's header).
        if (JS.recall.mute) JS.recall.mute(true);
        return paint(rec, false);
      });
    }, function () { /* no IndexedDB here: the folder route is still on offer */ });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  JS.photoCache = {
    DB: DB, STORE: STORE, KEY: KEY, SCHEMA: SCHEMA,
    MAX_PHOTOS: MAX_PHOTOS, MAX_BYTES: MAX_BYTES,
    supported: supported,
    hasSaved: hasSaved, usage: usage,
    save: save, load: load, forget: forget, onFilesAdded: onFilesAdded,
    /* Exported for the tests, which have to drive a save and a restore without a phone and
       have to be able to ask what the module thinks it is holding. */
    trim: trim, collect: collect, verify: verify, decodable: decodable,
    isQuota: isQuota, persistNow: persistNow,
    currentPersist: function () { return persistState; },
    currentNotice: currentNotice, paint: paint, report: report,
    boot: boot, hide: hide, shownBytes: function () { return shownBytes; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
