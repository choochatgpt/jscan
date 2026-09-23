/* tests/learn_cache_test.mjs — the on-device photo cache, without a phone.
 *
 * WHAT THIS IS FOR
 * ----------------
 * The client, asked to pick his photos again:
 *
 *   "i expect that right after i pick the button, immediately the previous 6 photos are
 *    already loaded inside the app"
 *
 * — with NO PICKER. js/79-photo-cache.js is that: the last selection's PHOTOGRAPHS, kept in
 * IndexedDB on this phone, re-imported through the ordinary path on one tap. It exists
 * because a photo chosen from the Android album arrives under a synthetic name
 * ("1000012345.jpg"), so js/77-fs-handle.js can never reopen it by name.
 *
 * THE ASSERTIONS THAT MATTER MOST ARE THE NEGATIVE ONES, and there are two families:
 *
 *   IT CANNOT REACH THE NETWORK. `fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`,
 *   `EventSource` and `navigator.serviceWorker` are all installed and all RECORD being
 *   reached, and a full save/restore/forget cycle must leave every count at zero. The
 *   shipping file is also scanned, with its comments stripped, for the names — because a
 *   spy only catches the line that runs, and the line that never ran in this test could run
 *   on his phone.
 *
 *   IT CANNOT SAY SOMETHING IT DID NOT DO. "Forget saved photos" reads the store back
 *   before it claims to be done; `persist()` reports the browser's own answer rather than
 *   assuming it was granted; a cached entry that no longer decodes is dropped AND SAID, not
 *   silently skipped; quota exhaustion leaves the cache empty rather than holding a record
 *   that promises photographs it does not have.
 *
 * The photographs this caches are pathology reports, a passport page and identity cards.
 * No test here reads one, copies one, prints one or describes one; the stand-ins are
 * buffers of 0x41 whose names are made up.
 *
 * Usage:  node tests/learn_cache_test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

let failures = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ok   ' + msg); return true; }
  console.error('  FAIL ' + msg); failures++; return false;
}
function eq(a, b, msg) {
  return ok(a === b, msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');
}
function has(hay, needle, msg) {
  return ok(String(hay).indexOf(needle) !== -1,
            msg + ' — looking for ' + JSON.stringify(needle) + ' in ' +
            JSON.stringify(String(hay).slice(0, 220)));
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms || 0)); }

/* ------------------------------------------------------------ fake browser bits */

function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    _map: m
  };
}

/* An IndexedDB that follows the real lifecycle: `put`/`get`/`delete` answer only through
   `oncomplete`, the `fn(s)` call returns BEFORE the transaction handlers are attached (which
   is the ordering the shipping code depends on), and quota can be injected either as a
   synchronous throw or as a transaction abort — the two ways a real browser reports it. */
function fakeIdb() {
  const st = {
    data: new Map(), created: new Set(), failOpen: false, blocked: false,
    opens: 0, puts: 0, deletes: 0, gets: 0,
    quotaLeft: Infinity, quotaVia: 'abort'
  };
  function quotaError() {
    const e = new Error('QuotaExceededError: the quota has been exceeded.');
    e.name = 'QuotaExceededError';
    e.code = 22;
    return e;
  }
  const idb = {
    open(name, version) {
      st.opens++;
      const req = { result: null, error: null, name, version,
                    onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        if (st.failOpen) { req.error = new Error('IDB_OPEN_FAILED'); if (req.onerror) req.onerror(); return; }
        if (st.blocked) { if (req.onblocked) req.onblocked(); return; }
        const db = {
          objectStoreNames: { contains: (n) => st.created.has(n) },
          createObjectStore: (n) => { st.created.add(n); return { name: n }; },
          transaction(storeName, mode) {
            const t = { error: null, oncomplete: null, onerror: null, onabort: null, mode };
            const store = {
              put(v, k) {
                st.puts++;
                const budget = (v && v.total_bytes) || 0;
                if (budget > st.quotaLeft) {
                  const err = quotaError();
                  if (st.quotaVia === 'throw') throw err;
                  const r = { result: null, error: err };
                  queueMicrotask(() => { t.error = err; if (t.onerror) t.onerror(); });
                  return r;
                }
                st.quotaLeft -= budget;
                st.data.set(k, v);
                const r = { result: k };
                queueMicrotask(() => t.oncomplete && t.oncomplete());
                return r;
              },
              get(k) {
                st.gets++;
                const r = { result: st.data.get(k) };
                queueMicrotask(() => t.oncomplete && t.oncomplete());
                return r;
              },
              delete(k) {
                st.deletes++;
                st.data.delete(k);
                const r = { result: true };
                queueMicrotask(() => t.oncomplete && t.oncomplete());
                return r;
              }
            };
            t.objectStore = () => store;
            return t;
          }
        };
        req.result = db;
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    }
  };
  return { idb, st };
}

/* ---------------------------------------------------------------------- the DOM */

function fakeDom() {
  const nodes = [];
  function el(tag) {
    const n = {
      tagName: tag, id: '', hidden: false, textContent: '', type: '', value: '',
      children: [], parentNode: null, style: {}, dataset: {},
      _attrs: {}, _listeners: {}, _clicks: 0, _act: null, _primary: false,
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      setAttribute(k, v) { n._attrs[k] = String(v); },
      getAttribute(k) { return k in n._attrs ? n._attrs[k] : null; },
      removeAttribute(k) { delete n._attrs[k]; },
      appendChild(c) { c.parentNode = n; n.children.push(c); return c; },
      insertBefore(c, ref) {
        c.parentNode = n;
        const i = n.children.indexOf(ref);
        if (i < 0) n.children.push(c); else n.children.splice(i, 0, c);
        return c;
      },
      addEventListener(ev, fn) { (n._listeners[ev] = n._listeners[ev] || []).push(fn); },
      click() { n._clicks++; (n._listeners.click || []).forEach((f) => f({ target: n })); },
      querySelector: () => null, closest: () => null, getContext: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 })
    };
    nodes.push(n);
    return n;
  }
  const home = el('div'); home.id = 'view-home';
  const empty = el('div'); empty.id = 'empty-state';
  const gallery = el('input'); gallery.id = 'file-gallery';
  const add = el('button'); add.id = 'btn-add';
  home.appendChild(empty);
  const body = el('body');
  const byId = { 'view-home': home, 'empty-state': empty, 'file-gallery': gallery, 'btn-add': add };
  return {
    nodes, home, empty, gallery, add, body,
    document: {
      readyState: 'complete', visibilityState: 'visible',
      createElement: el, getElementById: (id) => byId[id] || null,
      body, addEventListener() {}, querySelectorAll: () => []
    },
    byId,
    $: (id) => byId[id] || null
  };
}

function find(node, pred, out) {
  out = out || [];
  if (pred(node)) out.push(node);
  (node.children || []).forEach((c) => find(c, pred, out));
  return out;
}
const buttons = (node) => find(node, (n) => n.tagName === 'button');
const byText = (node, text) => buttons(node).find((b) => b.textContent === text) || null;
const allText = (node) => find(node, () => true).map((n) => n.textContent).join(' | ');

/* A page in the shape js/30-pipeline.js `makePage` produces. */
function zeroAdj() {
  return { bright: 0, contrast: 0, wb: 0, sat: 0, warmth: 0, flat: 0, thr: 0, sharp: 0 };
}
function newPage(file) {
  return {
    file, w: 400, h: 600,
    coarse: 0, fine: 0, corners: null, cornersFrom: '', quadAuto: null,
    autoRan: false, autoOutcome: '', mode: 'original', modeTap: '', modeBack: null,
    adj: zeroAdj(), mask: null, touched: false
  };
}
/* A REAL File, so `size` is a real byte count and the round trip is through real bytes. */
function photo(name, bytes, opts) {
  opts = opts || {};
  const f = new File([Buffer.alloc(bytes, 0x41)], name,
                     { type: opts.type === undefined ? 'image/jpeg' : opts.type,
                       lastModified: opts.lastModified || 1700000000000 });
  if (opts.corrupt) f._corrupt = true;   // the fake decoder refuses it; see `makeWorld`
  return f;
}

/* ---------------------------------------------------------------- a whole world */

/* `st` may be passed in, which is how a RELAUNCH is modelled: a second world, with its own
   module state and its own DOM, looking at the same IndexedDB. That is exactly what closing
   the tab and opening the app again is, from the cache's point of view. */
function makeWorld(opts) {
  opts = opts || {};
  const store = opts.store || fakeIdb();
  const { idb, st } = store;
  const dom = fakeDom();
  /* localStorage and sessionStorage may be SHARED with an earlier world, which is what they
     are on a phone: the same origin, the same stores, a different page load. */
  const ls = opts.ls || memStore();
  const ss = opts.ss || memStore();

  /* EVERY ROAD OFF THE DEVICE, INSTALLED AND WATCHING. A missing API is not evidence of
     anything; a present API that records being reached is. */
  const net = { calls: [] };
  function netSpy(name, impl) {
    return function () { net.calls.push(name); if (impl) return impl.apply(this, arguments); };
  }

  const win = {
    document: dom.document, localStorage: ls, sessionStorage: ss,
    indexedDB: idb, isSecureContext: true, File, Blob,
    addEventListener() {}, removeEventListener() {}, console,
    /* The image decoder, asked before a cached entry is trusted. It refuses anything the
       test has marked corrupt, and refuses a truncated buffer — a real decoder does both. */
    createImageBitmap: (blob) => {
      if (blob && blob._corrupt) return Promise.reject(new Error('InvalidStateError'));
      if (!blob || blob.size < 16) return Promise.reject(new Error('InvalidStateError'));
      return Promise.resolve({ width: 400, height: 600, close() {} });
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    fetch: netSpy('fetch', () => Promise.reject(new Error('the cache must never fetch'))),
    XMLHttpRequest: function () { net.calls.push('XMLHttpRequest'); this.open = () => {}; this.send = () => {}; },
    WebSocket: function () { net.calls.push('WebSocket'); },
    EventSource: function () { net.calls.push('EventSource'); },
    caches: { open: netSpy('caches.open', () => Promise.reject(new Error('no'))) },
    navigator: {
      sendBeacon: netSpy('sendBeacon', () => true),
      serviceWorker: { register: netSpy('serviceWorker.register', () => Promise.reject(new Error('no'))),
                       ready: Promise.resolve(null), controller: null },
      storage: {
        persist: netSpy('storage.persist', () => Promise.resolve(opts.persistAnswer === undefined ? true : opts.persistAnswer)),
        persisted: netSpy('storage.persisted', () => Promise.resolve(!!opts.alreadyPersisted))
      }
    }
  };
  win.window = win;

  const sandbox = {
    console, Promise, JSON, Object, Array, Number, String, Math, Date, RegExp, Error,
    Map, Set, isFinite, File, Blob, Uint8Array, queueMicrotask, setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  sandbox.window = win;
  sandbox.self = sandbox;
  sandbox.document = dom.document;
  sandbox.indexedDB = idb;
  sandbox.File = File;
  sandbox.Blob = Blob;
  sandbox.createImageBitmap = win.createImageBitmap;
  win.JS = {};
  win.JS.$ = dom.$;
  win.JS.VERSION = '1.13.0';

  const load = (f) => vm.runInContext(
    fs.readFileSync(path.join(REPO_ROOT, 'js', f), 'utf8'), sandbox, { filename: f });

  /* THE REAL MASK LAYER, not a stand-in. A fake with its own idea of what a mask looks like
     (`{cells}`) would let this whole file pass while the shipping reader silently dropped
     every covering it was handed, because the real shape is `{radius, strokes:[{r,pts}]}`.
     js/75-learn-mask.js is written to be loaded in Node — it touches `document` only inside
     the functions that need it, and none of those are on this path. */
  load('75-learn-mask.js');
  load('78-learn-recall.js');

  const JS = win.JS;
  if (!JS.recall) { console.error('FAIL: js/78-learn-recall.js did not define JS.recall'); process.exit(1); }

  /* The collaborators the file under test calls into. Only the ones it needs, and each one
     a test cares about records what it was asked. `addFiles` is the ONE door an import can
     come through, so it is the one that has to behave like js/50-ui.js's. */
  const spy = { hints: [], added: [], comments: [], busy: [], renderHome: 0, invalidated: 0,
                logs: [], errors: [], filesSetComment: [], pickerClicks: 0 };
  JS.hint = (m) => { spy.hints.push(m); };
  JS.showBusy = (m) => { spy.busy.push(m); };
  JS.hideBusy = () => { spy.busy.push(null); };
  JS.renderHome = () => { spy.renderHome++; };
  JS.invalidate = (p) => { spy.invalidated++; if (p) p._rects = { staleMarker: true }; };
  JS.quadOk = () => true;
  JS.MODE_DEFAULTS = { original: { id: 'original' }, bw: { id: 'bw' }, gray: { id: 'gray' } };
  if (!JS.learnMask) { console.error('FAIL: js/75-learn-mask.js did not define JS.learnMask'); process.exit(1); }
  /* THE REAL SHAPE, `{preset, note}` and not a string. js/76-learn-ui.js `currentComment`
     returns those two fields and `setComment` reads them, so a fake that returned a string
     would let the cache store something the shipping reader silently ignores — the comment
     would vanish and every assertion here would still pass. */
  const COMMENT = opts.comment === undefined ? { preset: 'receipt stack', note: 'paid 12.40' } : opts.comment;
  JS.learnUI = {
    currentComment: () => ({ preset: COMMENT.preset, note: COMMENT.note }),
    setComment: (c) => { spy.comments.push(c); spy.filesSetComment.push(c); }
  };
  JS.app = { pages: [], active: 0 };

  JS.addFiles = (files) => {
    const list = Array.prototype.slice.call(files || []);
    return Promise.resolve().then(() => {
      const added = [];
      for (const f of list) {
        if (!f || String(f.type || '').indexOf('image/') !== 0) continue;
        const p = newPage({ name: f.name, size: f.size, lastModified: f.lastModified });
        p.source = { _blob: f, _url: 'blob:fake/' + encodeURIComponent(f.name) };
        JS.app.pages.push(p);
        added.push(p);
      }
      spy.added.push(added.map((p) => p.file.name));
      JS.renderHome();
      /* THE SAME ORDER js/50-ui.js CALLS THEM IN. 79 relies on being called after 78 and
         after the pages exist, and the restore path relies on `JS.addFiles` being the door
         it comes through, so this ordering is part of what is under test. */
      if (JS.recall) JS.recall.onFilesAdded();
      if (JS.photoCache) JS.photoCache.onFilesAdded();
      return added.length;
    });
  };

  /* The picker inputs, watched. `#file-gallery` is what `btn-add` opens. */
  const pickers = { fileInputClicks: 0, directory: 0, openFile: 0 };
  const gallery = dom.byId['file-gallery'];
  const realClick = gallery.click.bind(gallery);
  gallery.click = () => { pickers.fileInputClicks++; realClick(); };
  win.showDirectoryPicker = (o) => { pickers.directory++; return Promise.resolve({ name: 'Camera', kind: 'directory' }); };
  win.showOpenFilePicker = (o) => { pickers.openFile++; return Promise.resolve([]); };

  load('79-photo-cache.js');
  if (!JS.photoCache) { console.error('FAIL: js/79-photo-cache.js did not define JS.photoCache'); process.exit(1); }

  /* Console watching, so "it does not log the photos" is a measurement and not a promise. */
  const realLog = console.log, realErr = console.error;
  const catchConsole = () => {
    console.log = (...a) => { spy.logs.push(a.join(' ')); };
    console.error = (...a) => { spy.errors.push(a.join(' ')); };
  };
  const releaseConsole = () => { console.log = realLog; console.error = realErr; };

  return {
    win, JS, sandbox, dom, ls, ss, idb, st: store.st, net, spy, pickers,
    PC: JS.photoCache, RC: JS.recall,
    catchConsole, releaseConsole,
    relight() {   // a page brought back to the foreground: the last reliable save moment
      dom.document.visibilityState = 'hidden';
      return Promise.resolve();
    }
  };
}

/* Pages put on the home screen directly, WITHOUT a second import in the middle: a test that
   wants to drive one save and no more cannot use the import path, because the import path
   saves too (which is the feature). */
function stash(W, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const f = photo('q' + i + '.jpg', 1000, { lastModified: 1700000000000 + i });
    const p = newPage({ name: f.name, size: f.size, lastModified: f.lastModified });
    p.source = { _blob: f };
    W.JS.app.pages.push(p);
    out.push(p);
  }
  return out;
}

/* A first session: pick the photos, edit them, let the ordinary import path cache them. */
async function firstSession(W, n) {
  const files = [];
  const names = [];
  for (let i = 0; i < (n || 3); i++) {
    const name = 'photo-' + (i + 1) + '.jpg';
    names.push(name);
    files.push(photo(name, 1000 + i, { lastModified: 1700000000000 + i }));
  }
  W.JS.app.pages.length = 0;
  await W.JS.addFiles(files);
  const pages = W.JS.app.pages;
  pages.forEach((p, i) => {
    p.coarse = 90;
    p.fine = -3 + i;
    p.corners = [{ x: 0.1, y: 0.08 }, { x: 0.9, y: 0.08 }, { x: 0.9, y: 0.94 }, { x: 0.1, y: 0.94 }];
    p.cornersFrom = 'manual';
    p.autoRan = true;
    p.autoOutcome = i === 1 ? 'refused' : 'found';
    p.mode = i === 2 ? 'bw' : 'gray';
    p.adj = { bright: 4, contrast: 22, wb: 70, sat: 0, warmth: 0, flat: 70, thr: 0, sharp: 0 };
    /* A real brush stroke, through the API the brush handler itself uses. */
    if (i === 0) {
      const m = W.JS.learnMask.create();
      W.JS.learnMask.setRadius(m, 24);
      const st = W.JS.learnMask.beginStroke(m, 0.30, 0.22);
      W.JS.learnMask.extendStroke(m, st, 0.62, 0.24);
      p.mask = m;
    }
  });
  /* The state was changed AFTER the import, and the cache was written by the import — so
     the record on disk does not have these values, and the module must not pretend it
     does. Driving `save()` here is the same call `visibilitychange` makes. */
  await W.PC.save();
  return { files, names };
}

/* ============================================================================ */
console.log('\njs/79-photo-cache.js — the detect');

{
  const W = makeWorld();
  eq(W.PC.supported(), true, 'supported() is true when IndexedDB and File are both there');

  const V = makeWorld();
  delete V.win.indexedDB;
  eq(V.PC.supported(), false, 'supported() is a FEATURE DETECT, so it is false without IndexedDB');
}

/* ============================================================================ */
console.log('\njs/79-photo-cache.js — it can never reach the network');

{
  const W = makeWorld();
  const name = 'passport-page-01.jpg';
  W.JS.app.pages.length = 0;
  await W.JS.addFiles([photo(name, 4000)]);
  const p = W.JS.app.pages[0];
  p.coarse = 90;
  p.corners = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }];
  p.mode = 'gray';
  await W.PC.save();
  eq((await W.PC.hasSaved()), true, 'a save really did put a record in the store, so the cycle below is a real one');

  const second = makeWorld({ store: { idb: W.idb, st: W.st } });
  await wait();
  const r = await second.PC.load();
  eq(r && r.ok !== false, true, 'the restore ran (so every path below was really exercised)');
  await second.PC.forget();

  /* `navigator.storage.persist` is the LOCAL storage manager, not egress: asking the browser
     to keep its own files is the opposite of sending them. Everything else on this list is a
     road off the device, and the count for those must be zero. */
  const EGRESS = (c) => !/^storage\./.test(c);
  eq(second.net.calls.filter(EGRESS).length, 0,
     'a full save -> restore -> forget cycle made ZERO calls to any network API');
  eq(JSON.stringify(second.net.calls.filter(EGRESS)), '[]', 'and the recorded list is genuinely empty');
  eq(W.net.calls.filter(EGRESS).length, 0, 'the first session made none either');
  ok(second.net.calls.indexOf('storage.persist') !== -1,
     'while the one API that DOES get called is the storage manager, which keeps data here');
}

{
  /* THE SOURCE SCAN. A spy only proves the line that ran did not fire; it cannot see a line
     that this test's path never reaches but his phone would. Comments are stripped first,
     because this file explains at length what it does NOT do. */
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'js', '79-photo-cache.js'), 'utf8');
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')     // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments
  ok(code.length > 2000, 'the comment stripper left the code behind, not just whitespace');

  for (const word of ['fetch', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource',
                      'serviceWorker', 'navigator.geolocation']) {
    eq(code.indexOf(word), -1, 'the shipping source contains no ' + word + ' outside its comments');
  }
  /* The Learn transport is the ONLY thing in this app that may send anything, and the cache
     must not name it at all — not to submit, not to build a bundle, not to attach a photo. */
  for (const word of ['JS.learn.', 'JS.learn(', 'JS.learn.submit', 'learnUI.submit',
                      'learnUI.attach', 'bundle', 'relay', 'inbox', 'issue']) {
    eq(code.indexOf(word), -1, 'and it never reaches for the Learn/mailbox path: no ' + word);
  }
  /* The token is not merely unused, it is unreachable: no storage key of the Learn flow. */
  eq(code.indexOf('jscanner.learn'), -1, 'and it does not know the Learn token key exists');

  const html = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
  has(html, '<script src="js/79-photo-cache.js"></script>',
      'index.html loads the cache, so the orphan-script guard is satisfied');
  ok(html.indexOf('js/79-photo-cache.js') > html.indexOf('js/78-learn-recall.js'),
     'and it loads AFTER 78, whose pageState/applyTo/mute it uses');
  ok(html.indexOf('js/79-photo-cache.js') > html.indexOf('js/50-ui.js'),
     'and after 50, whose JS.addFiles is the door the restore comes through');
}

/* ============================================================================ */
console.log('\njs/79-photo-cache.js — ONE TAP AT START, NO PICKER');

{
  const W = makeWorld();
  const first = await firstSession(W, 3);
  eq(W.st.puts > 0, true, 'the first session wrote the selection to IndexedDB');
  eq(W.ls._map.size > 0, true, 'and js/78 still keeps its small metadata record in localStorage (unchanged)');

  /* The record holds BLOBS, and the manifests are small. If the bytes had been stringified
     into localStorage the store would be megabytes of base64; it is not, and this is the
     check that the whole file's reason-for-being is real. */
  const rec = W.st.data.get('last');
  ok(!!rec, 'the IndexedDB record exists under the one key');
  eq(rec.schema, 'jscan.photocache/1', 'and carries its schema tag');
  eq(rec.items.length, 3, 'with all three photographs in it');
  eq(rec.items[0].blob instanceof Blob, true, 'as Blob objects, not as strings');
  eq(rec.items[0].name, 'photo-1.jpg', 'under the name the page was given');
  eq(rec.items[0].size, 1000, 'with the ORIGINAL file size, not the cached byte count');
  eq(typeof rec.items[0].state.corners, 'object', 'and the crop quad beside the bytes');
  eq(rec.app_version, '1.13.0', 'and the version that wrote it');

  /* ---- RELAUNCH: a new page, a new world, the same phone storage. */
  const W2 = makeWorld({ store: { idb: W.idb, st: W.st }, ls: W.ls });
  await wait();
  await wait();

  eq(W2.pickers.fileInputClicks, 0, 'on start nothing opened the photo picker');
  eq(W2.pickers.directory, 0, 'and nothing opened the folder picker');
  eq(W2.pickers.openFile, 0, 'and nothing opened the file picker');
  eq(W2.JS.app.pages.length, 0, 'and no photo has been loaded yet — the offer is an offer');

  const banner = W2.dom.byId['view-home'].children.find((c) => c.id === 'cache-banner');
  ok(!!banner, 'the offer is on the home screen, before he does anything');
  const offer = byText(banner, 'Load my last 3 photos');
  ok(!!offer, 'and its button says exactly how many are waiting');
  has(allText(banner), 'saved on this phone', 'and it says where they are');
  has(allText(banner), 'not uploaded anywhere', 'and that they are not uploaded anywhere');
  has(allText(banner), 'Learn', 'and names Learn as the separate thing that sends');

  /* ---- THE ONE TAP. */
  offer.click();
  for (let i = 0; i < 40 && W2.JS.app.pages.length === 0; i++) await wait(5);
  await wait(10);

  eq(W2.pickers.fileInputClicks, 0, 'AFTER the tap: the picker was invoked 0 times');
  eq(W2.pickers.directory, 0, 'the folder picker 0 times');
  eq(W2.pickers.openFile, 0, 'the file picker 0 times');
  eq(W2.JS.app.pages.length, 3, 'and all three photos are in the app');
  eq(W2.JS.app.pages.map((p) => p.file.name).join(','), first.names.join(','),
     'in the order he picked them');

  const p0 = W2.JS.app.pages[0];
  eq(p0.file.size, 1000, 'the restored page reports the size of the file he picked');
  eq(p0.coarse, 90, 'the rotation came back');
  eq(p0.fine, -3, 'the fine angle came back');
  eq(p0.corners[0].x, 0.1, 'the crop quad came back');
  eq(p0.cornersFrom, 'manual', 'and where the quad came from');
  eq(p0.mode, 'gray', 'the tone mode came back');
  eq(p0.adj.contrast, 22, 'and the adjustments');
  eq(!!(p0.mask && p0.mask.strokes && p0.mask.strokes.length), true, 'and the redaction mask');
  eq(p0.mask.strokes[0].pts.length, 2, 'with its stroke intact');
  eq(p0.mask.strokes[0].pts[1].x, 0.62, 'to the same points it was painted on');
  ok(W2.JS.app.pages[0].mask !== W.JS.app.pages[0].mask,
     'and as a COPY of the saved strokes, not the saved array itself');
  eq(p0.autoOutcome, 'found', 'and the sticky auto outcome');
  eq(p0.touched, true, 'and the page is marked edited, as it was');
  eq(W2.JS.app.pages[1].autoOutcome, 'refused', 'the refused page is still refused');
  eq(W2.JS.app.pages[2].mode, 'bw', 'and the third page has its own tone, not the first photo\'s');
  eq(W2.JS.app.pages[1].adj.contrast, 22, 'every page got values, not just the first');
  eq(!!p0._rects, true,
     'the page was invalidated, so the render cache is rebuilt from the restored state');

  /* FRESH OBJECTS. A carried-over page would arrive with last session's canvas caches on
     it and the editor would draw the wrong canvas under the right controls. */
  const fresh = W2.JS.app.pages[0];
  ok(!W.JS.app.pages.includes(fresh),
     'the restored page is a NEW object, not the one the first session built');
  ok(fresh._oriented === undefined,
     'and it carries no orientation cache from the previous session');
  ok(fresh._thumb === undefined, 'and no thumbnail cache');
  eq(W2.spy.comments.some((c) => c && c.note === 'paid 12.40' && c.preset === 'receipt stack'), true,
     'and the saved comment went back through the app\'s own comment field');

  const after = W2.dom.byId['view-home'].children.find((c) => c.id === 'cache-banner');
  has(allText(after), 'Loaded 3 of 3', 'and it says what it did');
  has(allText(after), 'no picker', 'and that no picker was involved');

  /* THE METADATA RECORD IS BROUGHT BACK INTO STEP. js/78 writes it during the import, BEFORE
     the cache applies the saved values, so without the re-capture in `applySaved` a cache
     restore would leave the folder route's record describing an unedited selection. */
  const recallRec = JSON.parse(W2.ls.getItem('jscanner.recall.last'));
  eq(recallRec.pages[0].coarse, 90,
     'and the metadata record describes the EDITED pages, not the bare decode');
  eq(W2.RC.hasSaved(), true, 'so the metadata route still has a usable record');
}

/* ============================================================================ */
console.log('\njs/79-photo-cache.js — the banner only ASKS at the start');

{
  /* The client, on v1.12.0: "the pop up for restoring the selection keep popping up even when
     i select from fresh, like if i just clear and select 5 new photos, it will then next show
     me that it can restore the 5 new photos. But i just selected it! it is should only ask me
     when it started loading first time when app runs to see the cache has any photo to be
     loaded by user or not."

     An offer is a specific visible thing: a button labelled "Load my last N photos" with "Not
     now" beside it. So every check here reads that button, and the gate itself twice over. */
  const bannerOf = (w) => w.dom.byId['view-home'].children.find((c) => c.id === 'cache-banner');
  const offers = (w) => {
    const b = bannerOf(w);
    return !!b && buttons(b).some((x) => /^Load my last /.test(x.textContent));
  };

  const W = makeWorld();
  await firstSession(W, 5);
  await wait(5);          // the import's own save paints the banner; let it land
  eq(W.JS.app.pages.length, 5, 'he picked five photographs');
  eq(W.PC.anythingLoaded(), true, 'the module knows photographs are in the app');
  eq(W.PC.currentOffer(), false, 'and it has not asked him anything');
  eq(offers(W), false,
     'so the banner he just got is a REPORT of his own pick, not an offer to load it back');
  has(allText(bannerOf(W)), 'saved on this phone', 'which still says where they are');
  has(allText(bannerOf(W)), 'not uploaded anywhere', 'and still says they are not uploaded');
  has(allText(bannerOf(W)), 'Next time you open the app',
      'and says when the tap it promises will exist, now that the button is not on screen');

  /* CLEAR, THEN PICK FIVE FRESH ONES — the client's exact sequence. Clearing the grid takes
     the pages away and leaves the cache alone, so at the moment of the second pick there IS
     something to offer, and the app must still not offer it. */
  W.JS.app.pages.length = 0;
  await W.JS.addFiles([photo('fresh-1.jpg', 1200), photo('fresh-2.jpg', 1200)]);
  await wait(5);
  eq(W.JS.app.pages.length, 2, 'he cleared the grid and picked two more in the same session');
  eq(offers(W), false, 'and there is STILL no offer, for photographs he just chose');

  /* A RELAUNCH IS THE ONE PLACE THE QUESTION BELONGS. Nothing is open — the app has just
     started — which is exactly "when it started loading first time when app runs". */
  const W2 = makeWorld({ store: { idb: W.idb, st: W.st }, ls: W.ls });
  await wait(); await wait();
  eq(W2.JS.app.pages.length, 0, 'a fresh launch opens with nothing in it');
  eq(offers(W2), true, 'and THAT is where the offer is made');
  eq(W2.PC.currentOffer(), true, 'once');
  eq(!!byText(bannerOf(W2), 'Load my last 2 photos'), true,
     'for exactly the photographs the phone is holding');

  /* And the moment he picks anything himself, it stops being an offer — in this session, on
     the same page, with no reload in between. */
  await W2.JS.addFiles([photo('his-own.jpg', 1300), photo('his-own-2.jpg', 1300)]);
  await wait(5);
  eq(W2.PC.anythingLoaded(), true, 'he picked two photographs himself');
  eq(offers(W2), false, 'so the question is gone rather than re-asked');

  /* Taking the offer is the other door photographs come in through, and it closes the same
     way: one import later, no offer for what he is looking at. */
  const W3 = makeWorld({ store: { idb: W2.idb, st: W2.st }, ls: W2.ls });
  await wait(); await wait();
  const offer3 = byText(bannerOf(W3), 'Load my last 2 photos');
  ok(!!offer3, 'the next launch offers the two that are on the phone');
  offer3.click();
  for (let i = 0; i < 40 && W3.JS.app.pages.length === 0; i++) await wait(5);
  await wait(10);
  eq(W3.JS.app.pages.length, 2, 'and the tap brought them back');
  eq(offers(W3), false, 'with no offer left for the photographs now open');
  await W3.JS.addFiles([photo('one-more.jpg', 1400)]);
  await wait(5);
  eq(W3.PC.anythingLoaded(), true, 'one more picked by hand');
  eq(offers(W3), false, 'and picking it does not bring the question back');
}

/* ============================================================================ */
console.log('\njs/79-photo-cache.js — the comment, and the metadata record');

{
  const W = makeWorld();
  W.JS.app.pages.length = 0;
  await W.JS.addFiles([photo('a.jpg', 900)]);
  await wait(5);
  const rec = W.st.data.get('last');
  eq(JSON.stringify(rec.comment), JSON.stringify({ preset: 'receipt stack', note: 'paid 12.40' }),
     'the comment is kept beside the photos, in the shape js/76 reads');

  const W2 = makeWorld({ store: { idb: W.idb, st: W.st } });
  await wait(); await wait();
  await W2.PC.load();
  eq(JSON.stringify(W2.spy.comments[W2.spy.comments.length - 1]),
     JSON.stringify({ preset: 'receipt stack', note: 'paid 12.40' }),
     'and the restore puts both fields back into the comment field');
}

/* ============================================================================ */
console.log('\njs/79-photo-cache.js — the caps');

{
  const W = makeWorld();
  const items = [];
  for (let i = 0; i < 30; i++) items.push({ name: 'p' + i + '.jpg', bytes: 1000, size: 1000 });
  const t = W.PC.trim(items);
  eq(t.kept.length, W.PC.MAX_PHOTOS, 'past the photo cap the cache keeps exactly MAX_PHOTOS');
  eq(t.dropped, 30 - W.PC.MAX_PHOTOS, 'and reports how many it dropped');
  eq(t.kept[0].name, 'p6.jpg', 'dropping OLDEST first, so what is left is the newest run');
  eq(t.kept[t.kept.length - 1].name, 'p29.jpg', 'ending at the most recent');

  const heavy = [];
  for (let i = 0; i < 10; i++) heavy.push({ name: 'h' + i + '.jpg', bytes: 20 * 1024 * 1024, size: 1 });
  const t2 = W.PC.trim(heavy);
  const bytes = t2.kept.reduce((a, x) => a + x.bytes, 0);
  ok(bytes <= W.PC.MAX_BYTES, 'past the byte cap the total is inside MAX_BYTES (' + bytes + ' <= ' + W.PC.MAX_BYTES + ')');
  ok(t2.kept.length >= 1, 'and it never trims down to nothing — one photo always survives');
  eq(t2.kept[t2.kept.length - 1].name, 'h9.jpg', 'the survivor is the newest one');

  const one = W.PC.trim([{ name: 'only.jpg', bytes: 200 * 1024 * 1024, size: 1 }]);
  eq(one.kept.length, 1, 'a single photograph larger than the whole byte cap is still kept');
  eq(one.dropped, 0, 'and nothing is dropped for it');
}

/* ============================================================================ */
console.log('\njs/79-photo-cache.js — a full phone');

{
  /* The real browser report, as a transaction abort: the whole selection does not fit, the
     newest half does. */
  const W = makeWorld();
  W.st.quotaVia = 'abort';
  stash(W, 4);                       // four 1000-byte photos: 4000 in total, 2000 in half
  W.st.quotaLeft = 3000;             // 4000 does not fit; 2000 does
  const r = await W.PC.save();

  eq(r.ok, true, 'a quota failure does NOT lose the selection — it is retried with the newest half');
  eq(r.quota, true, 'and the report says quota was the reason');
  const rec = W.st.data.get('last');
  eq(rec.items.length, 2, 'the record holds the newest half');
  eq(rec.items.map((i) => i.name).join(','), 'q2.jpg,q3.jpg', 'and it is the NEWEST half, not the oldest');
  eq(rec.trimmed, 2, 'and the record states how many were left out');

  const W2 = makeWorld({ store: { idb: W.idb, st: W.st } });
  await wait(); await wait();
  const back = await W2.PC.load();
  eq(back.restored, 2, 'and the half that fitted really does reopen on the next launch');
  eq(W2.JS.app.pages.map((p) => p.file.name).join(','), 'q2.jpg,q3.jpg', 'as the newest two photos');
}

{
  /* A phone with no room at all, reported the other way — as a synchronous throw. */
  const W = makeWorld();
  W.st.quotaLeft = -1;
  W.st.quotaVia = 'throw';
  stash(W, 1);
  const r = await W.PC.save();

  eq(r.ok, false, 'when nothing can be written at all the save reports failure');
  eq(r.reason, 'quota', 'and names the quota as the cause');
  eq(W.st.data.has('last'), false,
     'AND LEAVES NO RECORD AT ALL — never a manifest promising photos it does not have');
  eq(await W.PC.hasSaved(), false, 'so the next launch offers nothing rather than a broken restore');
}

{
  /* A record that is already there, and a phone that fills up: the end state is EMPTY and
     STATED, not a stale record that silently restores yesterday's photos under today's
     names — and never a fragment. */
  const W = makeWorld();
  stash(W, 1);
  await W.PC.save();
  eq(W.st.data.get('last').items[0].name, 'q0.jpg', 'a good record is in place');

  W.st.quotaLeft = -1;
  W.st.quotaVia = 'throw';
  const W2 = makeWorld({ store: { idb: W.idb, st: W.st } });
  await wait(); await wait();
  W2.JS.app.pages.length = 0;
  stash(W2, 1);
  const r = await W2.PC.save();
  eq(r.ok, false, 'the replacement fails on a full phone');

  const left = W.st.data.get('last');
  ok(left === undefined || (left.items && left.items.length === 1),
     'and the store is either empty or holds exactly one whole selection — never a fragment');
  if (left) eq(left.items[0].name, 'q0.jpg', 'if anything survived, it is the WHOLE old selection');
}

/* ============================================================================ */
console.log('\njs/79-photo-cache.js — a cached entry that no longer decodes');

{
  const W = makeWorld();
  W.JS.app.pages.length = 0;
  await W.JS.addFiles([photo('good-1.jpg', 900), photo('bad.jpg', 900), photo('good-2.jpg', 900)]);
  // The import's own save is fired by js/50-ui.js without awaiting it, exactly as in the app.
  await wait(5);
  // Corrupt the MIDDLE entry in the store, as a truncated write on the phone would.
  const rec = W.st.data.get('last');
  rec.items[1].blob = photo('bad.jpg', 900, { corrupt: true });
  W.st.data.set('last', rec);

  const W2 = makeWorld({ store: { idb: W.idb, st: W.st } });
  await wait(); await wait();
  const r = await W2.PC.load();

  eq(W2.JS.app.pages.length, 2, 'the two readable photos are restored');
  eq(W2.JS.app.pages.map((p) => p.file.name).join(','), 'good-1.jpg,good-2.jpg',
     'and the unreadable one is DROPPED rather than handed to the importer');
  eq(r.dropped, 1, 'and the count of dropped entries is reported');
  eq(r.total, 3, 'against the total that was saved');
  const banner = W2.dom.byId['view-home'].children.find((c) => c.id === 'cache-banner');
  has(allText(banner), 'could not be read back', 'and it SAYS so, rather than quietly coming back one short');
  eq(W2.JS.app.pages[0].mode, 'original', 'the survivors still arrived');
  ok(W2.JS.app.pages.every((p) => p !== undefined), 'no undefined page from the dropped entry');
}

{
  /* Every entry unreadable is what an evicted or half-cleared store looks like. */
  const W = makeWorld();
  W.JS.app.pages.length = 0;
  await W.JS.addFiles([photo('a.jpg', 900), photo('b.jpg', 900)]);
  await wait(5);
  const rec = W.st.data.get('last');
  rec.items.forEach((it) => { it.blob = photo(it.name, 900, { corrupt: true }); });
  W.st.data.set('last', rec);

  const W2 = makeWorld({ store: { idb: W.idb, st: W.st } });
  await wait(); await wait();
  const r = await W2.PC.load();

  eq(r.ok, false, 'nothing is restored, because nothing could be read');
  eq(r.reason, 'unreadable', 'and the reason is named');
  eq(W2.st.data.has('last'), false, 'and the useless record is purged, not left to fail the same way next launch');
  const banner = W2.dom.byId['view-home'].children.find((c) => c.id === 'cache-banner');
  has(allText(banner), 'be read back', 'and he is told, in a sentence');
  has(allText(banner), 'Pick your photos again', 'with what to do about it');
}

{
  /* A record written by a build that does not exist yet, or damaged JSON: dropped whole. A
     half-understood record restores a WRONG crop onto a document, which is worse than none. */
  const W = makeWorld();
  W.st.data.set('last', { schema: 'jscan.photocache/99', items: [{ name: 'x.jpg', blob: new Blob(['a']) }] });
  const W2 = makeWorld({ store: { idb: W.idb, st: W.st } });
  await wait(); await wait();
  eq(await W2.PC.hasSaved(), false, 'a record from an unknown schema is ignored, not guessed at');
  eq(W2.JS.app.pages.length, 0, 'and it restores nothing');
}

/* ============================================================================ */
console.log('\njs/79-photo-cache.js — forgetting, and saying so');

{
  const W = makeWorld();
  await firstSession(W, 2);
  eq(W.st.data.has('last'), true, 'there is something to forget');

  const W2 = makeWorld({ store: { idb: W.idb, st: W.st } });
  await wait(); await wait();
  const banner = W2.dom.byId['view-home'].children.find((c) => c.id === 'cache-banner');
  const forgetBtn = byText(banner, 'Forget saved photos');
  ok(!!forgetBtn, 'the offer carries one-tap forgetting');

  forgetBtn.click();
  for (let i = 0; i < 40 && W2.st.data.has('last'); i++) await wait(5);
  await wait(10);

  eq(W2.st.data.has('last'), false, 'the store is empty');
  eq(W2.st.deletes > 0, true, 'and it was an actual delete, not a hidden record');
  const after = W2.dom.byId['view-home'].children.find((c) => c.id === 'cache-banner');
  has(allText(after), 'Forgotten', 'and it says so');
  has(allText(after), 'checked the store and it is empty', 'and that the wipe was verified, not just attempted');
  has(allText(after), 'gallery are untouched', 'and that his gallery is untouched');
  has(allText(after), 'uploaded', 'and that nothing was uploaded either way');
  eq(byText(after, 'Load my last 2 photos'), null, 'and the offer is gone, because there is nothing to offer');
}

/* ============================================================================ */
console.log('\njs/79-photo-cache.js — what persist() actually answered');

{
  const W = makeWorld({ persistAnswer: true });
  W.JS.app.pages.length = 0;
  await W.JS.addFiles([photo('a.jpg', 900)]);
  await wait();
  const banner = W.dom.byId['view-home'].children.find((c) => c.id === 'cache-banner');
  has(allText(banner), 'agreed to keep these', 'a granted persist() is reported as a promise the browser made');
  eq(W.PC.currentPersist(), 'granted', 'and the state is the browser\'s answer');
  eq(W.net.calls.filter((c) => c === 'storage.persist').length, 1, 'and it was asked once, not per repaint');
}

{
  const W = makeWorld({ alreadyPersisted: true });
  W.JS.app.pages.length = 0;
  await W.JS.addFiles([photo('a.jpg', 900)]);
  await wait();
  eq(W.PC.currentPersist(), 'already', 'an already-persisted origin is not asked to persist again');
  const banner = W.dom.byId['view-home'].children.find((c) => c.id === 'cache-banner');
  has(allText(banner), 'agreed to keep these', 'and the same honest sentence is used');
}

{
  const W = makeWorld({ persistAnswer: false });
  W.JS.app.pages.length = 0;
  await W.JS.addFiles([photo('a.jpg', 900)]);
  await wait();
  eq(W.PC.currentPersist(), 'denied', 'a refusal is recorded as a refusal');
  const banner = W.dom.byId['view-home'].children.find((c) => c.id === 'cache-banner');
  has(allText(banner), 'has NOT promised to keep them',
      'and a refusal is reported as a refusal, never dressed up as a promise');
  has(allText(banner), 'out of space', 'with what that actually means for him');
}

{
  const W = makeWorld();
  delete W.win.navigator.storage;
  W.JS.app.pages.length = 0;
  await W.JS.addFiles([photo('a.jpg', 900)]);
  await wait();
  eq(W.PC.currentPersist(), 'unavailable', 'a browser with no storage manager at all is its own answer');
  const banner = W.dom.byId['view-home'].children.find((c) => c.id === 'cache-banner');
  has(allText(banner), 'cannot promise to keep them', 'and it is stated plainly rather than skipped');
}

/* ============================================================================ */
console.log('\njs/79-photo-cache.js — the two banners do not compete');

{
  const W = makeWorld();
  await firstSession(W, 2);

  const W2 = makeWorld({ store: { idb: W.idb, st: W.st }, ls: W.ls });
  await wait(); await wait();

  /* js/78 offers a folder restore; a cached selection makes that the WORSE answer, because
     every route it can offer costs a picker and the folder route cannot work at all on a
     photo chosen from the album. */
  const offered = W2.RC.offer();
  eq(offered, false, 'while a selection is cached, js/78 refuses to put its prompt up at all');
  const recallBanner = () => W2.dom.byId['view-home'].children.find((c) => c.id === 'recall-banner');
  ok(!recallBanner() || recallBanner()._attrs.style === 'display:none',
     'so there is no recall banner competing with the cache offer');
  const cacheBanner = W2.dom.byId['view-home'].children.find((c) => c.id === 'cache-banner');
  ok(!!cacheBanner && cacheBanner._attrs.style !== 'display:none',
     'and the cache banner is the one on screen');

  /* FORGETTING UN-MUTES: the offer must come back, or the client would be left with no route
     at all the next time he wants his photos back. */
  await W2.PC.forget();
  await wait();
  const back = W2.RC.offer();
  eq(back, true, 'after forgetting, the recall route is offered again rather than left muted forever');
  ok(!!recallBanner() && recallBanner()._attrs.style !== 'display:none', 'and its banner is really visible');
  eq(W2.ls._map.has('jscanner.recall.last'), true, 'and muting never deleted the metadata record');
}

/* ============================================================================ */
console.log('\njs/79-photo-cache.js — nothing about the photos is logged');

{
  const W = makeWorld();
  const secret = 'ZZZ-IDENTITY-CARD-NAME.jpg';
  W.catchConsole();
  W.JS.app.pages.length = 0;
  await W.JS.addFiles([photo(secret, 900)]);
  await W.PC.save();
  const W2 = makeWorld({ store: { idb: W.idb, st: W.st } });
  await wait(); await wait();
  await W2.PC.load();
  await W2.PC.forget();
  W.releaseConsole();

  const all = W.spy.logs.concat(W.spy.errors).join('\n');
  eq(all.indexOf(secret), -1, 'no filename was written to the console during a full cycle');
  eq(all.indexOf('blob:'), -1, 'and no object URL either');
  eq(all.replace(/\s/g, '').length, 0, 'in fact nothing at all was logged');
}

/* ============================================================================ */
console.log('\njs/79-photo-cache.js — a hostile environment');

{
  /* NO INDEXEDDB AT ALL: the app must be exactly as usable as it was before the cache
     existed, and the folder route must still be offered (js/78 is untouched by any of it). */
  const W = makeWorld();
  delete W.win.indexedDB;
  const p = newPage({ name: 'a.jpg', size: 900, lastModified: 1 });
  p.source = { _blob: photo('a.jpg', 900) };
  W.JS.app.pages.push(p);
  eq(W.PC.supported(), false, 'with no IndexedDB the cache reports itself unsupported');
  const r = await W.PC.save();
  eq(r.ok, false, 'a save there reports failure');
  eq(r.reason, 'unsupported', 'as unsupported, rather than breaking the import that called it');
  eq(await W.PC.hasSaved(), false, 'and it offers nothing, because it has nothing');
  const lr0 = await W.PC.load();
  eq(lr0.reason, 'unsupported', 'and a restore there says the same thing');
  eq((await W.PC.forget()).ok, true, 'and forgetting is a no-op that still answers');
}

{
  /* INDEXEDDB PRESENT BUT REFUSING TO OPEN — private mode, or a locked-down build. */
  const W = makeWorld();
  W.st.failOpen = true;
  const p = newPage({ name: 'a.jpg', size: 900, lastModified: 1 });
  p.source = { _blob: photo('a.jpg', 900) };
  W.JS.app.pages.push(p);
  eq(W.PC.supported(), true, 'supported() is a feature detect, so it is true here');
  const r = await W.PC.save();
  eq(r.ok, false, 'a store that will not open is reported as a failed save, not a crash');
  eq(r.reason, 'failed', 'with the failure named');
  eq(await W.PC.hasSaved(), false, 'and nothing is offered, because nothing was stored');
  const lr = await W.PC.load();
  eq(lr.ok, false, 'and a restore there reports failure the same way');
  const fr = await W.PC.forget();
  ok(fr.ok === true || fr.ok === false, 'and forgetting still ANSWERS instead of throwing into a tap handler');
}

{
  /* Importing nothing (a cancelled picker) must not wipe a good record. */
  const W = makeWorld();
  await firstSession(W, 2);
  const before = W.st.data.get('last').saved_utc;
  W.JS.app.pages.length = 0;
  await W.JS.addFiles([]);
  await wait();
  eq(W.st.data.get('last').items.length, 2, 'an empty import leaves the cache alone');
  eq(W.st.data.get('last').saved_utc, before, 'and does not even rewrite it');
}

{
  /* A page with no file of its own — pasted, or from the camera input — cannot be reopened
     by name, so it is counted and NOT promised. */
  const W = makeWorld();
  W.JS.app.pages.length = 0;
  await W.JS.addFiles([photo('real.jpg', 900)]);
  W.JS.app.pages.push(Object.assign(newPage(null), { file: null, source: { _blob: new Blob([Buffer.alloc(900, 65)]) } }));
  const r = await W.PC.save();
  eq(r.photos, 1, 'a page with no file record is not cached');
  const rec = W.st.data.get('last');
  eq(rec.items.length, 1, 'so the record holds only what can be brought back');
  eq(rec.skipped, 1, 'and the skipped count is carried, so the count he sees is not a lie');
}

{
  /* A save during a RESTORE must not overwrite the record with the shape of its own shadow:
     the pages exist before their saved values are applied. */
  const W = makeWorld();
  await firstSession(W, 2);
  const before = W.st.data.get('last').saved_utc;
  const W2 = makeWorld({ store: { idb: W.idb, st: W.st } });
  await wait(); await wait();
  const r = await W2.PC.load();
  await wait(10);
  eq(r.restored, 2, 'the restore really did apply the saved state');
  const after = W.st.data.get('last');
  eq(after.saved_utc, before, 'and the record was NOT rewritten by the import it was feeding');
  eq(after.items[0].state.coarse, 90, 'so its saved values are still the edited ones');
}

{
  /* NOTHING MOVED, SO NOTHING IS WRITTEN. `save` is driven by `visibilitychange` as well
     as by every import, and on a phone that is every app switch: rewriting several
     megabytes of a selection that has not changed, while Android is freezing the tab, is
     the one write with no reason to exist. The guard must still never be able to freeze the
     store at a state the pages have left behind, so the second half of this block is the
     part that matters. */
  const W = makeWorld();
  await firstSession(W, 2);
  const stamped = W.st.data.get('last').saved_utc;

  const again = await W.PC.save();
  eq(again.ok, true, 'a save with nothing changed still reports photographs that ARE saved');
  eq(again.unchanged, true, 'and says outright that it wrote nothing');
  eq(again.photos, 2, 'with the same count he is being shown');
  eq(W.st.data.get('last').saved_utc, stamped, 'so the record on the phone was left alone');

  W.JS.app.pages[0].coarse = 71;
  const moved = await W.PC.save();
  eq(moved.unchanged, undefined, 'the moment a crop moves, the next save is a real write');
  eq(W.st.data.get('last').items[0].state.coarse, 71, 'and the store holds the new state');

  const W2 = makeWorld({ store: { idb: W.idb, st: W.st } });
  await wait(); await wait();
  /* A wiped store is NOT "already holding this". `forget` is the promise this feature rests
     on, so the guard is cleared with it. */
  await W2.PC.forget();
  const fresh = makeWorld({ store: { idb: W.idb, st: W.st } });
  await wait(); await wait();
  fresh.JS.app.pages.length = 0;
  stash(fresh, 1);
  const back = await fresh.PC.save();
  eq(back.unchanged, undefined, 'after a wipe the next save writes rather than skipping');
  eq(fresh.st.data.get('last').items[0].name, 'q0.jpg', 'so the store holds it again');
}

/* ============================================================================ */
console.log('');
if (failures) {
  console.error(failures + ' failed');
  process.exit(1);
}
console.log('all passed');
