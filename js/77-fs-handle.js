/* js/77-fs-handle.js — the one place this app touches the File System Access API.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The client, after the app asked him to pick his photos a second time:
 *
 *   "it just go back to the upload pop up of the browser. can you think of something like
 *    read directly since you already have the photo names and locations?"
 *
 * He is right that the names and the folder are already recorded (js/78-learn-recall.js).
 * What a web page cannot do is turn a recorded string into a file — there is no API that
 * opens `/storage/emulated/0/DCIM/Camera/IMG_0421.JPG` from a path. What DOES exist is a
 * handle: `showDirectoryPicker()` hands back a `FileSystemDirectoryHandle` that is
 * structured-cloneable, so it can be kept in IndexedDB and used months later to open
 * `IMG_0421.JPG` BY NAME with no picker and no path.
 *
 * THE THREE FACTS THIS DESIGN RESTS ON, AND WHERE EACH ONE CAME FROM
 * -----------------------------------------------------------------
 * 1. `showDirectoryPicker()` EXISTS ON CHROME FOR ANDROID. Enabled in M132 (stable
 *    January 2025); Chrome's own documentation lists the API as supported on "Windows,
 *    macOS, ChromeOS, Linux, and Android". This was VERIFIED rather than assumed — see
 *    the browser-verification section of the release note. It does NOT exist on iOS
 *    Safari or Firefox, and Brave keeps it behind a flag, so `supported()` is a feature
 *    detect and the caller MUST have a fallback.
 *
 * 2. A HANDLE KEPT IN INDEXEDDB SURVIVES A RELOAD, BUT ITS PERMISSION DOES NOT.
 *    Handles have been serializable since M83. After a reload (or a new tab)
 *    `queryPermission()` returns "prompt", so `requestPermission()` has to be called
 *    again — and because the API requires transient user activation, that call MUST
 *    happen inside a real tap handler. That is why the restore is one deliberate tap
 *    and not something that runs on page load.
 *
 * 3. ON ANDROID A GRANT IS ALSO DROPPED WHEN THE TAB HAS BEEN BACKGROUNDED FOR ~16 HOURS
 *    (Chromium commit efea8fd, "Expire FileSystemAccess grants for android after 16hrs",
 *    which attaches the one-time-permission tracker to Android). So even a folder he
 *    allowed yesterday will ask again tomorrow. That is the expected behaviour, it costs
 *    him one tap, and it is the reason this file reports "prompt" as its own outcome
 *    instead of pretending a denial happened.
 *
 * 4. A NAME FROM THE ANDROID PHOTO PICKER IS NOT A NAME IN HIS FOLDER, AND THIS IS THE
 *    FACT THE FIRST VERSION OF THIS FILE WAS BUILT WITHOUT. `getFileHandle(name)` only
 *    helps when `name` is the file's real name. When the client selects from his
 *    ALBUM the system Photo Picker returns a proxy whose display name is derived from
 *    the media id — "1000012345.jpg", not "IMG_20240101_120000.jpg" (Chromium issue
 *    40123366; the proxy is materialised under
 *    /sdcard/.transforms/synthetic/picker/<pkg>/<id>.jpg). The page is never told the
 *    original name. So a record built from an album selection holds names that do not
 *    exist in DCIM/Camera, and no amount of folder access can rescue it: the app has to
 *    take the photographs FROM the folder once, which is what `pickFiles` below is for.
 *    `probe` is what lets the app tell the client WHICH of the two situations he is in.
 *
 * WHAT IS NEVER DONE HERE
 * -----------------------
 * NOTHING IS WRITTEN INTO HIS FOLDER. The picker is opened `mode: 'read'` and no code
 * path in this file calls `createWritable`, `removeEntry` or `getFileHandle(create:true)`.
 *
 * THE DIRECTORY IS NEVER LISTED. There is no `for await (const entry of handle.values())`
 * anywhere in this file, deliberately. On Android the picker itself enumerates a folder
 * before it returns a handle, and a large one can make the tab unresponsive
 * (crbug.com/376097630 — reported against DCIM, which is exactly where a phone camera
 * puts these photographs). This file cannot make that worse, but it must not add to it,
 * so every read is a `getFileHandle(name)` for a name that is already known.
 *
 * NO IMAGE BYTES ARE STORED. Only the handle — which is an opaque reference, not the
 * files — goes into IndexedDB, and only the file's own metadata is read out.
 */
(function (global) {
  'use strict';

  var JS = global.JS = global.JS || {};

  /* One database, one store, one key. The app has no other IndexedDB use, so a single
     record per origin is right: he has one photo folder, and "which folder did I use"
     is a question with one answer. */
  var DB = 'jscanner.fs';
  var STORE = 'handles';
  var KEY = 'photo-dir';
  var VERSION = 1;

  /* `id` makes the OS picker reopen in the directory this origin last used, so the second
     time he is choosing a folder he is not hunting for it again. */
  var PICKER_ID = 'jscanner-photos';

  /* Extensions a phone camera or a scanner produces. Used ONLY to repair a missing MIME
     type; see `typed()`. */
  var IMAGE_TYPES = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', jfif: 'image/jpeg',
    png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
    heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', tif: 'image/tiff',
    tiff: 'image/tiff'
  };

  var dbPromise = null;

  /* ------------------------------------------------------------------ the detect */

  /* Does this browser have the API at all? A feature detect, never a user-agent test:
     the same Chrome build can differ by flag, by enterprise policy, and by whether the
     page is a secure context. */
  function supported() {
    return typeof global.showDirectoryPicker === 'function' &&
           global.isSecureContext !== false;
  }

  /* ---------------------------------------------------------------------- idb */

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
      // Another tab holding an old version open would leave this hanging forever, and a
      // promise that never settles is a button that never comes back.
      req.onblocked = function () { reject(new Error('IDB_BLOCKED')); };
    });
    // A FAILED OPEN IS NOT CACHED. Private-mode Firefox and some locked-down Android
    // builds reject the open; caching that rejection would make every later attempt fail
    // with the first one's error, so the recovery would need a reload to take effect.
    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }

  function withStore(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t, s, out;
        try {
          t = db.transaction(STORE, mode);
          s = t.objectStore(STORE);
          out = fn(s);
        } catch (e) { reject(e); return; }
        // `oncomplete`, not `onsuccess`: a read request's `result` is only the answer once
        // the transaction commits, and reading it earlier is how a store returns a value
        // the browser is about to throw away.
        t.oncomplete = function () { resolve(out ? out.result : undefined); };
        t.onerror = function () { reject(t.error || new Error('IDB_TX_FAILED')); };
        t.onabort = function () { reject(t.error || new Error('IDB_TX_ABORTED')); };
      });
    });
  }

  /* ------------------------------------------------------------------- the handle */

  /** Remember the folder. Resolves with the handle even if the store refused it: a
   *  folder that works for this session is still worth using. */
  function remember(handle) {
    return withStore('readwrite', function (s) { return s.put(handle, KEY); })
      .then(function () { return handle; },
            function () { return handle; });
  }

  /** The remembered folder, or null. Never throws: a missing or blocked IndexedDB is a
   *  reason to fall back, not a reason to break the home screen. */
  function recalled() {
    return withStore('readonly', function (s) { return s.get(KEY); })
      .then(function (h) { return h && typeof h.getFileHandle === 'function' ? h : null; },
            function () { return null; });
  }

  function forget() {
    return withStore('readwrite', function (s) { return s.delete(KEY); })
      .then(function () { return true; }, function () { return false; });
  }

  /* Open the OS folder picker. MUST be called from inside a real tap handler, or the
     browser raises SecurityError — "Transient user activation is required".
     `mode: 'read'` is the whole of what this app needs and the least it can ask for. */
  function pick() {
    if (!supported()) return Promise.reject(new Error('UNSUPPORTED'));
    var opts = { id: PICKER_ID, mode: 'read' };
    return global.showDirectoryPicker(opts).then(remember);
  }

  /* ------------------------------------------------- the folder-rooted file picker */

  /* WHY THIS SECOND PICKER EXISTS AT ALL, AND WHY IT IS NOT REDUNDANT.
   *
   * A directory handle tells the app WHICH FOLDER, and this file may not enumerate it, so
   * the app can only reopen a FILENAME it already knows. The directory picker therefore
   * cannot import anything by itself — it has no names to open.
   *
   * On Android the names a page receives from the system PHOTO PICKER are not the names in
   * the folder: the picker hands back a proxy whose name is derived from the media id
   * ("1000012345.jpg") rather than the camera's own "IMG_20240101_120000.jpg" (Chromium
   * 40123366; the proxy lives under /sdcard/.transforms/synthetic/picker/...). A record
   * built from an album selection therefore holds names that `getFileHandle` will never
   * resolve inside DCIM/Camera, and NO amount of folder access can fix that — the name is
   * simply not the file's name.
   *
   * The only honest repair is to take the photographs FROM THE FOLDER once. This picker is
   * `showOpenFilePicker` with `startIn` set to the handle he just granted, so the OS opens
   * already inside that folder and the files that come back are the folder's own files,
   * under their REAL names. After one such import every later restore matches by name, and
   * the picker is never seen again.
   *
   * It is the FOLDER picker's sibling, not a replacement: `pick()` chooses where, this
   * chooses which. Both are read-only, both are only reachable from a tap handler, and
   * neither can write to his folder. */
  function filePickerSupported() {
    return typeof global.showOpenFilePicker === 'function' &&
           global.isSecureContext !== false;
  }

  var FILE_TYPES = [{
    description: 'Photos',
    accept: { 'image/*': ['.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.webp', '.gif',
                          '.bmp', '.heic', '.heif', '.avif', '.tif', '.tiff'] }
  }];

  function pickFiles(dir, multiple) {
    if (!filePickerSupported()) return Promise.reject(new Error('UNSUPPORTED'));
    function attempt(withDir) {
      var opts = { multiple: multiple !== false, types: FILE_TYPES };
      if (withDir && dir) opts.startIn = dir;
      return global.showOpenFilePicker(opts);
    }
    // `startIn` is an optimisation, never a requirement: a build that refuses a directory
    // handle as a start location must still be able to open the picker somewhere, or the
    // one-time setup is impossible and the feature is dead on that phone.
    return attempt(true).catch(function (e) {
      if (!dir || String((e && e.name) || '') === 'AbortError') throw e;
      return attempt(false);
    }).then(function (handles) {
      return Promise.all(Array.prototype.map.call(handles || [], function (h) {
        return h.getFile();
      }));
    });
  }

  /* ----------------------------------------------------------------- permission */

  /* The outcome of asking for permission, as one of:
   *
   *   granted       the caller may read right now
   *   denied        he said no, or the browser refused. DO NOT ask again in this session:
   *                 repeating a prompt the user has dismissed is how a page looks broken.
   *   prompt        the question could not be put (no user activation, or the API is
   *                 missing). The caller must offer a tap, not retry on its own.
   *   unavailable   there is no handle, or it is not a directory handle.
   *
   * `requestPermission` is only ever called when the state really is "prompt", because it
   * THROWS on a denied handle on some builds, and a throw here would be reported as a
   * missing folder rather than as a refusal. */
  function ensurePermission(handle) {
    if (!handle || typeof handle.queryPermission !== 'function') {
      return Promise.resolve('unavailable');
    }
    var opts = { mode: 'read' };
    return Promise.resolve(handle.queryPermission(opts)).then(function (state) {
      if (state === 'granted') return 'granted';
      if (state === 'denied') return 'denied';
      return Promise.resolve(handle.requestPermission(opts)).then(function (after) {
        return after === 'granted' ? 'granted' : (after === 'denied' ? 'denied' : 'prompt');
      }, function () { return 'prompt'; });
    }, function () { return 'prompt'; });
  }

  /* ---------------------------------------------------------------------- read */

  /* Some Android builds hand back a file with an empty `type` even though the name ends
     in .jpg, and `JS.addFiles` drops anything whose type is not `image/*` — so a restore
     that read twenty correct files would silently import none of them. The type is
     repaired from the extension and from nothing else. It is metadata the filename
     already carries; no bytes are touched, and `size`/`lastModified` are preserved
     because a `File` built from another `File` reports the same values. */
  function typed(file) {
    if (!file || (file.type && file.type.indexOf('image/') === 0)) return file;
    var dot = String(file.name || '').lastIndexOf('.');
    if (dot < 0) return file;
    var ext = String(file.name).slice(dot + 1).toLowerCase();
    var mime = IMAGE_TYPES[ext];
    if (!mime || typeof global.File !== 'function') return file;
    try {
      return new global.File([file], file.name, { type: mime, lastModified: file.lastModified });
    } catch (e) { return file; }
  }

  /* Open ONE file by name. This is the whole payoff: the name was stored last session and
     the browser resolves it inside the folder he chose once, with no picker. */
  function readByName(handle, name) {
    if (!handle || typeof handle.getFileHandle !== 'function') {
      return Promise.reject(new Error('NO_HANDLE'));
    }
    return handle.getFileHandle(name).then(function (fh) {
      if (typeof fh.getFile !== 'function') throw new Error('NO_FILE');
      return fh.getFile();
    });
  }

  /* Read a list of saved entries, one at a time, and say exactly what happened to each.
   *
   * SEQUENTIAL ON PURPOSE. These files live behind an Android content provider, and twenty
   * simultaneous opens through it is how a picker result turns into a stalled tab.
   *
   * THE VERDICT IS PER FILE, AND EVERY FILE GETS ONE:
   *   files    read, and the size agreed — these are safe to restore
   *   missing  the folder does not have that name any more
   *   changed  the name is there but the size is not, so it is NOT the file that was
   *            edited and its stored crop is about different pixels
   *   denied   the read was refused
   * A wrong crop is worse than no crop — the stored quad is a rectangle on a photograph
   * that may since have been re-taken — so `changed` is a refusal, not a fuzzy match. */
  function readMany(handle, entries, onProgress) {
    var list = (entries || []).filter(function (e) { return e && e.name; });
    var out = { files: [], names: [], missing: [], changed: [], denied: [], exact: 0 };
    var i = 0;

    function step() {
      if (i >= list.length) return Promise.resolve(out);
      var e = list[i++];
      if (onProgress) { try { onProgress(i, list.length, e.name); } catch (err) { /* cosmetic */ } }
      return readByName(handle, e.name).then(function (file) {
        // `size` is required on both sides. Two different receipts really are both called
        // IMG_0421.JPG, and the size is what tells them apart.
        if (!e.size || !file.size || e.size !== file.size) {
          out.changed.push(e.name);
          return;
        }
        if (e.last_modified && file.lastModified === e.last_modified) out.exact++;
        out.files.push(typed(file));
        out.names.push(e.name);
      }, function (err) {
        var n = String((err && err.name) || '');
        if (n === 'NotFoundError' || n === 'TypeMismatchError') out.missing.push(e.name);
        else out.denied.push(e.name);
      }).then(step);
    }

    return step();
  }

  /* Which of these names does the folder actually have?
   *
   * ONE `getFileHandle` PER NAME AND NOTHING ELSE — no listing, no glob, no fallback scan.
   * The folder is never enumerated (see the header), so this is the only way to answer the
   * question, and it is cheap: one call per saved photo.
   *
   * It exists because "the folder is wrong" and "the names are not this folder's names"
   * need DIFFERENT actions from the client, and before this the app could not tell them
   * apart — it reported both as "not in that folder any more", which sent him to look for
   * photographs that were never missing.
   *
   * A read failure that is not a NotFound is counted as PRESENT: an unreadable file is not
   * evidence that the name is wrong, and treating it as wrong would push him into a costly
   * re-import he does not need. */
  function probe(handle, names) {
    var list = (names || []).filter(function (n) { return !!n; });
    var out = { present: [], absent: [] };
    if (!handle || typeof handle.getFileHandle !== 'function') return Promise.resolve(out);
    var i = 0;
    function step() {
      if (i >= list.length) return Promise.resolve(out);
      var n = list[i++];
      return handle.getFileHandle(n).then(function () { out.present.push(n); }, function (err) {
        var e = String((err && err.name) || '');
        if (e === 'NotFoundError' || e === 'TypeMismatchError') out.absent.push(n);
        else out.present.push(n);
      }).then(step);
    }
    return step();
  }

  /* -------------------------------------------------------------------- report */

  /** The folder's OWN display name — "Camera", "Download" — which is what a person
   *  recognises. It is NOT a path and is never presented as one: Android answers with a
   *  content-provider name, and no browser exposes a real path to a page. */
  function label(handle) {
    var n = handle && handle.name ? String(handle.name) : '';
    return n || 'the folder you chose';
  }

  JS.fsHandle = {
    DB: DB, STORE: STORE, KEY: KEY,
    supported: supported,
    pick: pick, remembered: recalled, remember: remember, forget: forget,
    ensurePermission: ensurePermission,
    readByName: readByName, readMany: readMany, typed: typed,
    /* The folder-rooted file picker and the name probe. Both are read-only, both are
       used only by the one-time setup in js/78-learn-recall.js, and both are feature
       detected by their callers. */
    filePickerSupported: filePickerSupported, pickFiles: pickFiles, probe: probe,
    label: label
  };
})(typeof window !== 'undefined' ? window : globalThis);
