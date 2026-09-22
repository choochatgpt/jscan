/* tests/learn_folder_test.mjs — the folder-remembering layer, without a phone.
 *
 * WHAT THIS IS FOR
 * ----------------
 * The client was asked to pick his photos a second time and said:
 *
 *   "it just go back to the upload pop up of the browser. can you think of something like
 *    read directly since you already have the photo names and locations?"
 *
 * js/77-fs-handle.js is the answer to that: a FileSystemDirectoryHandle kept in IndexedDB,
 * used later to open a SAVED FILENAME with no picker. None of it can be checked on the
 * developer's machine — there is no Android here, and no gallery of receipts — so the
 * layer is written to be checkable without one: a fake IndexedDB that behaves like the
 * real one's transaction lifecycle, a fake directory handle that RECORDS every call made
 * to it, and real `File` objects whose `size` really is the byte count.
 *
 * THE ASSERTIONS THAT MATTER MOST ARE THE NEGATIVE ONES:
 *   - the picker is opened `mode: 'read'`, and nothing in the layer ever writes to, or
 *     enumerates, the folder the user granted;
 *   - a file whose SIZE has changed is REFUSED, not fuzzy-matched;
 *   - the record holds no image bytes and no copy of any document;
 *   - where the API is missing, the banner SAYS a picker is about to open instead of
 *     opening one silently (the client's actual complaint about the setup);
 *   - "Forget it" lets go of the folder handle, so the sentence it shows is true.
 *
 * Usage:  node tests/learn_folder_test.mjs
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

/* An IndexedDB that follows the real lifecycle closely enough for the module's own
   comments to be tested: `put`/`get`/`delete` only answer through `oncomplete`, and the
   `fn(s)` call returns BEFORE the transaction handlers are attached — which is exactly the
   ordering the shipping code depends on and the reason it reads `out.result` late. */
function fakeIdb() {
  const st = { data: new Map(), created: new Set(), failOpen: false, opens: 0, blocked: false };
  const idb = {
    open(name, version) {
      st.opens++;
      const req = { result: null, error: null, name,
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
              put(v, k) { st.data.set(k, v); const r = { result: k };
                          queueMicrotask(() => t.oncomplete && t.oncomplete()); return r; },
              get(k) { const r = { result: st.data.get(k) };
                       queueMicrotask(() => t.oncomplete && t.oncomplete()); return r; },
              delete(k) { st.data.delete(k); const r = { result: true };
                          queueMicrotask(() => t.oncomplete && t.oncomplete()); return r; }
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

/* A directory handle that remembers EVERY call made to it — including calls it must never
   receive. Anything that could write to, or list, the user's folder is not merely absent:
   it is present and it records that it was reached. */
function fakeDir(files, opts) {
  opts = opts || {};
  const calls = [];
  const dir = {
    name: opts.name || 'Camera',
    kind: 'directory',
    _calls: calls,
    _perm: opts.perm || 'granted',
    queryPermission(o) { calls.push('queryPermission:' + (o && o.mode)); return Promise.resolve(dir._perm); },
    requestPermission(o) {
      calls.push('requestPermission:' + (o && o.mode));
      if (opts.requestThrows) return Promise.reject(new Error('SecurityError'));
      dir._perm = opts.requestResult || 'granted';
      return Promise.resolve(dir._perm);
    },
    getFileHandle(name) {
      calls.push('open:' + name);
      const spec = files[name];
      if (!spec) {
        const e = new Error('A requested file or directory could not be found');
        e.name = 'NotFoundError';
        return Promise.reject(e);
      }
      if (spec.throw) return Promise.reject(spec.throw);
      return Promise.resolve({
        kind: 'file',
        name,
        getFile() { calls.push('read:' + name); return Promise.resolve(spec.file); }
      });
    }
  };
  for (const forbidden of ['createWritable', 'removeEntry', 'values', 'keys', 'entries']) {
    dir[forbidden] = () => { calls.push('FORBIDDEN:' + forbidden); throw new Error('forbidden'); };
  }
  return dir;
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
  home.appendChild(empty);
  const byId = { 'view-home': home, 'empty-state': empty, 'file-gallery': gallery };
  return {
    nodes, home, empty, gallery,
    document: {
      readyState: 'complete', visibilityState: 'visible',
      createElement: el, getElementById: (id) => byId[id] || null,
      body: el('body'), addEventListener() {}, querySelectorAll: () => []
    },
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

/* ---------------------------------------------------------------- a whole world */

/* Load the two shipping files in a fresh context. Per world, so module state
   (`dbPromise`, the cached `els`, the remembered folder) is per world too. */
function makeWorld() {
  const { idb, st } = fakeIdb();
  const dom = fakeDom();
  const ls = memStore();
  const ss = memStore();
  const picked = { calls: 0, opts: null, handle: null, throws: null };
  /* The FOLDER-ROOTED FILE PICKER. Recorded exactly like the directory picker, because the
     question that matters about it is what it was asked for — `startIn` is what makes the
     files it returns the FOLDER's own files under their real names. */
  const opened = { calls: 0, opts: null, handles: null, throws: null };

  const win = { document: dom.document, localStorage: ls, sessionStorage: ss,
                indexedDB: idb, isSecureContext: true, File, Blob,
                addEventListener() {}, removeEventListener() {}, console,
                showDirectoryPicker: (opts) => {
                  picked.calls++;
                  picked.opts = opts;
                  if (picked.throws) return Promise.reject(picked.throws);
                  return Promise.resolve(picked.handle);
                },
                showOpenFilePicker: (opts) => {
                  opened.calls++;
                  opened.opts = opts;
                  if (opened.throws) return Promise.reject(opened.throws);
                  return Promise.resolve(opened.handles || []);
                } };
  win.window = win;

  const sandbox = {
    console, Promise, JSON, Object, Array, Number, String, Math, Date, RegExp, Error,
    Map, Set, isFinite, File, Blob, Uint8Array, queueMicrotask, setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  sandbox.window = win;
  sandbox.self = sandbox;
  sandbox.document = dom.document;      // bare `document` inside the files resolves here
  win.JS = {};
  win.JS.$ = dom.$;
  win.JS.VERSION = '1.10.0';

  const load = (f) => vm.runInContext(
    fs.readFileSync(path.join(REPO_ROOT, 'js', f), 'utf8'), sandbox, { filename: f });

  load('77-fs-handle.js');
  load('78-learn-recall.js');

  const JS = win.JS;
  if (!JS.fsHandle) { console.error('FAIL: js/77-fs-handle.js did not define JS.fsHandle'); process.exit(1); }
  if (!JS.recall) { console.error('FAIL: js/78-learn-recall.js did not define JS.recall'); process.exit(1); }

  /* The collaborators 78 calls into. Only the ones the file under test needs; each one
     that a test cares about records what it was asked. */
  const spy = {
    hints: [], added: [], comments: [], busy: [], renderHome: 0, invalidated: 0
  };
  JS.hint = (m) => { spy.hints.push(m); };
  JS.showBusy = (m) => { spy.busy.push(m); };
  JS.hideBusy = () => { spy.busy.push(null); };
  JS.renderHome = () => { spy.renderHome++; };
  JS.invalidate = () => { spy.invalidated++; };
  JS.quadOk = () => true;
  JS.MODE_DEFAULTS = { original: { id: 'original' }, bw: { id: 'bw' }, gray: { id: 'gray' } };
  JS.learnMask = { restore: () => null, isEmpty: () => true, toJSON: () => null };
  JS.learnUI = {
    currentComment: () => 'receipt stack',
    setComment: (c) => { spy.comments.push(c); }
  };
  JS.app = { pages: [], active: 0 };

  return {
    win, JS, sandbox, dom, ls, ss, idb, st, picked, spy, opened,
    FH: JS.fsHandle,
    RC: JS.recall,
    hideFilePicker() { delete win.showOpenFilePicker; },
    showFilePicker() {
      win.showOpenFilePicker = (opts) => {
        opened.calls++;
        opened.opts = opts;
        if (opened.throws) return Promise.reject(opened.throws);
        return Promise.resolve(opened.handles || []);
      };
    },
    lastHint: () => spy.hints[spy.hints.length - 1] || '',
    hidePicker() { delete win.showDirectoryPicker; },
    showPicker() {
      win.showDirectoryPicker = (opts) => {
        picked.calls++;
        picked.opts = opts;
        if (picked.throws) return Promise.reject(picked.throws);
        return Promise.resolve(picked.handle);
      };
    }
  };
}

/* A page in the shape js/30-pipeline.js `makePage` produces, and an edit on top of it. */
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
function editedPage(file) {
  const p = newPage(file);
  p.coarse = 90;
  p.fine = -3;
  p.corners = [{ x: 0.1, y: 0.08 }, { x: 0.9, y: 0.08 }, { x: 0.9, y: 0.94 }, { x: 0.1, y: 0.94 }];
  p.cornersFrom = 'manual';
  p.autoRan = true;
  p.autoOutcome = 'refused';
  p.mode = 'bw';
  p.adj = { bright: 4, contrast: 22, wb: 70, sat: 0, warmth: 0, flat: 70, thr: 0, sharp: 0 };
  return p;
}
/* A real File, so `size` is a real byte count and a size mismatch is a real mismatch. */
function photo(name, bytes, opts) {
  opts = opts || {};
  return new File([Buffer.alloc(bytes, 0x41)], name,
                  { type: opts.type === undefined ? 'image/jpeg' : opts.type,
                    lastModified: opts.lastModified || 1700000000000 });
}

/* ============================================================================ */
console.log('\njs/77-fs-handle.js — the detect');

{
  const W = makeWorld();
  eq(W.FH.supported(), true, 'supported() is true when the API exists and the context is secure');

  W.hidePicker();
  eq(W.FH.supported(), false, 'supported() is a FEATURE DETECT, so it is false without the API');
  W.win.isSecureContext = false;
  W.showPicker();
  eq(W.FH.supported(), false, 'and false on an insecure context even with the API present');
  W.win.isSecureContext = true;

  // Without the API: `pick()` is what a caller who forgot to feature-detect would call.
  W.hidePicker();
  const unsupported = await W.FH.pick().then(() => 'resolved', (e) => e.message);
  eq(unsupported, 'UNSUPPORTED', 'pick() rejects rather than throwing into a tap handler');
  eq(W.picked.calls, 0, 'and it never reached the picker');

  W.showPicker();
  const h = fakeDir({});
  W.picked.handle = h;
  const got = await W.FH.pick();
  eq(got, h, 'pick() resolves with the handle');
  eq(W.picked.opts.mode, 'read', 'THE PICKER IS OPENED READ-ONLY — mode:"read" is all this app needs');
  eq(W.picked.opts.id, 'jscanner-photos', 'and with an id, so the OS reopens where he was last time');
  eq(W.st.data.get('photo-dir'), h, 'the handle was remembered');
}

console.log('\njs/77-fs-handle.js — the handle in IndexedDB');

{
  const W = makeWorld();
  eq(await W.FH.remembered(), null, 'a phone that has never run this before remembers nothing');

  const h = fakeDir({}, { name: 'Download' });
  await W.FH.remember(h);
  eq(await W.FH.remembered(), h, 'remember() then remembered() is the handle back again');
  eq(W.st.data.size, 1, 'the store holds EXACTLY one thing');
  eq(W.st.data.get('photo-dir'), h, 'and the thing is the handle itself, not a copy of his files');
  eq(W.st.created.has('handles'), true, 'the object store is created on the upgrade');

  await W.FH.forget();
  eq(await W.FH.remembered(), null, 'forget() empties it');
  eq(W.st.data.size, 0, 'nothing is left behind');

  // A value that is not a handle — an older version, or a hand-edited store.
  W.st.data.set('photo-dir', 'Camera/DCIM');
  eq(await W.FH.remembered(), null, 'a remembered STRING is refused: a path is not a handle');
}

{
  const W = makeWorld();
  W.st.failOpen = true;
  eq(await W.FH.remembered(), null, 'an IndexedDB that will not open is a fallback, not a crash');
  W.st.failOpen = false;
  const h = fakeDir({}, { name: 'Camera' });
  await W.FH.remember(h);
  eq(await W.FH.remembered(), h, 'THE FAILED OPEN IS NOT CACHED — the next attempt works');
}

{
  const W = makeWorld();
  W.st.blocked = true;
  let settled = false;
  const p = W.FH.remembered().then(() => { settled = true; }, () => { settled = true; });
  await Promise.race([p, new Promise((r) => setTimeout(r, 30))]);
  eq(settled, true, 'an IDB_BLOCKED open settles the promise (a button that never comes back is worse)');
}

{
  const W = makeWorld();
  delete W.win.indexedDB;
  eq(await W.FH.remembered(), null, 'no IndexedDB at all: remembered() is null and does not throw');
  const h = fakeDir({}, { name: 'Camera' });
  eq(await W.FH.remember(h), h, 'remember() still answers with the handle — it works this session');
}

console.log('\njs/77-fs-handle.js — permission, and the prompt that must not repeat');

{
  const W = makeWorld();
  eq(await W.FH.ensurePermission(null), 'unavailable', 'no handle is "unavailable"');
  eq(await W.FH.ensurePermission({}), 'unavailable', 'something that is not a handle is too');

  const granted = fakeDir({}, { perm: 'granted' });
  eq(await W.FH.ensurePermission(granted), 'granted', 'a live grant is granted');
  eq(granted._calls.filter((c) => c.indexOf('requestPermission') === 0).length, 0,
     'AND IT DOES NOT ASK AGAIN — no prompt over a grant that already exists');

  const asked = fakeDir({}, { perm: 'prompt' });
  eq(await W.FH.ensurePermission(asked), 'granted', 'a "prompt" is asked and granted');
  eq(asked._calls.filter((c) => c.startsWith('requestPermission:read')).length, 1,
     'exactly one request, for read');
  eq(asked._calls.filter((c) => c.startsWith('queryPermission:read')).length, 1,
     'after one query — which is the documented sequence for a re-grant');

  const denied = fakeDir({}, { perm: 'denied' });
  eq(await W.FH.ensurePermission(denied), 'denied', 'a denial is reported as a denial');
  eq(denied._calls.filter((c) => c.indexOf('requestPermission') === 0).length, 0,
     'AND IS NOT RE-ASKED. requestPermission throws on a denied handle on some builds, so ' +
     'asking again would surface a refusal as a missing folder');

  const throws = fakeDir({}, { perm: 'prompt', requestThrows: true });
  eq(await W.FH.ensurePermission(throws), 'prompt',
     'a throw from requestPermission is "prompt", which the caller offers as a tap');

  const badQuery = { queryPermission: () => Promise.reject(new Error('nope')) };
  eq(await W.FH.ensurePermission(badQuery), 'prompt', 'a throwing queryPermission is "prompt"');
}

console.log('\njs/77-fs-handle.js — reading by name, one at a time');

{
  const W = makeWorld();
  const a = photo('IMG_0421.JPG', 900);
  const b = photo('IMG_0422.JPG', 1200);
  const c = photo('IMG_0423.JPG', 700);
  const dir = fakeDir({
    'IMG_0421.JPG': { file: a },
    'IMG_0422.JPG': { file: b },
    'IMG_0423.JPG': { file: c }
  }, { name: 'Camera' });

  const saved = [
    { name: 'IMG_0421.JPG', size: 900, last_modified: 1700000000000 },
    { name: 'IMG_0422.JPG', size: 1200, last_modified: 1700000000000 },
    { name: 'IMG_0423.JPG', size: 700, last_modified: 1700000000000 }
  ];
  const seen = [];
  const info = await W.FH.readMany(dir, saved, (i, n, name) => seen.push(i + '/' + n + '/' + name));

  eq(info.files.length, 3, 'all three files came back');
  eq(info.missing.length + info.changed.length + info.denied.length, 0, 'with no complaints');
  eq(info.exact, 3, 'and all three matched the saved timestamp exactly');
  eq(info.names.join(','), 'IMG_0421.JPG,IMG_0422.JPG,IMG_0423.JPG', 'in the saved order');

  eq(dir._calls.join(' '),
     'open:IMG_0421.JPG read:IMG_0421.JPG open:IMG_0422.JPG read:IMG_0422.JPG ' +
     'open:IMG_0423.JPG read:IMG_0423.JPG',
     'SEQUENTIAL, NOT PARALLEL: each file finishes being read before the next is opened ' +
     '(twenty simultaneous opens through an Android content provider is how a tab stalls)');
  ok(dir._calls.every((x) => x.indexOf('FORBIDDEN:') !== 0),
     'and nothing listed or wrote to the folder: ' + JSON.stringify(dir._calls.filter((x) => x.indexOf('FORBIDDEN:') === 0)));
  eq(seen.length, 3, 'progress is reported per file, for the "Reading 2 of 20…" line');
  eq(seen[1], '2/3/IMG_0422.JPG', 'with the position and the name');
}

{
  const W = makeWorld();
  const same = photo('IMG_0421.JPG', 900);
  const dir = fakeDir({
    'IMG_0421.JPG': { file: same },
    'GONE.JPG': undefined,
    'RESIZED.JPG': { file: photo('RESIZED.JPG', 4096) },
    'LOCKED.JPG': { throw: Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }) }
  });

  const info = await W.FH.readMany(dir, [
    { name: 'IMG_0421.JPG', size: 900, last_modified: 1700000000000 },
    { name: 'GONE.JPG', size: 500, last_modified: 1700000000000 },
    { name: 'RESIZED.JPG', size: 1000, last_modified: 1700000000000 },
    { name: 'LOCKED.JPG', size: 800, last_modified: 1700000000000 }
  ]);

  eq(info.files.length, 1, 'one file restored');
  eq(info.missing.join(','), 'GONE.JPG', 'a name the folder no longer has is "missing"');
  eq(info.changed.join(','), 'RESIZED.JPG',
     'A FILE WHOSE SIZE CHANGED IS REFUSED. The stored quad is a rectangle on a photograph ' +
     'whose pixels are not the ones that were cropped — a wrong crop is worse than no crop');
  eq(info.denied.join(','), 'LOCKED.JPG', 'a refused read is "denied", not "missing"');
  ok(info.files.every((f) => String(f.name) !== 'RESIZED.JPG'),
     'the changed file is NOT in the list handed to the importer');
}

{
  const W = makeWorld();
  const dir = fakeDir({
    'NOSIZE.JPG': { file: photo('NOSIZE.JPG', 640) },
    'NOEXPECTED.JPG': { file: photo('NOEXPECTED.JPG', 640) }
  });
  const info = await W.FH.readMany(dir, [
    { name: 'NOSIZE.JPG' },                                  // saved with no size at all
    { name: 'NOEXPECTED.JPG', size: 640, last_modified: 0 }  // right size, unknown timestamp
  ]);
  eq(info.changed.join(','), 'NOSIZE.JPG',
     'an entry with no saved size is refused: name alone is not identity for a photo ' +
     '(the camera input hands out the same generic name for every shot)');
  eq(info.files.length, 1, 'the other one is fine');
  eq(info.exact, 0, 'a file whose timestamp differs is restored but not counted exact');
}

{
  const W = makeWorld();
  const dir = fakeDir({ 'A.JPG': { file: photo('A.JPG', 10) } });
  const info = await W.FH.readMany(dir, [{ size: 10 }, null, { name: '' }, { name: 'A.JPG', size: 10 }]);
  eq(info.files.length, 1, 'entries with no name are skipped rather than crashing the read');

  const err = await W.FH.readByName(null, 'A.JPG').then(() => null, (e) => e.message);
  eq(err, 'NO_HANDLE', 'readByName without a handle rejects');

  const missing = await W.FH.readByName(dir, 'NOT-THERE.JPG').then(() => null, (e) => e.name);
  eq(missing, 'NotFoundError', 'and a name that is not there surfaces the real error');
}

console.log('\njs/77-fs-handle.js — the filename type repair');

{
  const W = makeWorld();
  const empty = photo('IMG_0421.JPG', 800, { type: '' });
  const fixed = W.FH.typed(empty);
  ok(fixed !== empty, 'a file with an empty type is repaired');
  eq(fixed.type, 'image/jpeg', 'to the type its own extension names');
  eq(fixed.size, 800, 'with the byte size preserved (a File built from a File reports the same)');
  eq(fixed.lastModified, empty.lastModified, 'and the timestamp preserved');
  eq(fixed.name, 'IMG_0421.JPG', 'and the name');

  const already = photo('IMG_0421.JPG', 800, { type: 'image/jpeg' });
  eq(W.FH.typed(already), already, 'a correct type is left completely alone');
  const png = photo('scan.PNG', 10, { type: '' });
  eq(W.FH.typed(png).type, 'image/png', 'the lookup is case-insensitive');
  const unknown = photo('scan.xyz', 10, { type: '' });
  eq(W.FH.typed(unknown), unknown, 'an extension it does not know is not guessed at');
  const noExt = photo('scan', 10, { type: '' });
  eq(W.FH.typed(noExt), noExt, 'and neither is a filename with no extension');
  eq(W.FH.typed(null), null, 'null passes through');

  eq(W.FH.label(fakeDir({}, { name: 'Download' })), 'Download',
     'label() is the folder\'s OWN display name, which is what a person recognises');
  eq(W.FH.label(null), 'the folder you chose', 'with words rather than an empty string');
  eq(W.FH.label({}), 'the folder you chose', 'and never a path, because no page is given one');
}

/* ============================================================================ */
console.log('\njs/78-learn-recall.js — the banner says what is going to happen');

{
  const W = makeWorld();
  const rec = { schema: 'jscan.recall/1', saved_utc: '2026-09-21T08:30:00Z',
                folder: 'Camera', pages: [{ name: 'a' }, { name: 'b' }], masks_omitted: false };
  const bar = () => find(W.dom.home, (n) => n.id === 'recall-banner')[0];

  /* case 1: the handle is live — no picker of any kind */
  W.RC.setFolder(fakeDir({}, { name: 'Camera' }));
  W.RC.paint(rec, null);
  const t1 = bar().children[0].textContent;
  ok(/there is nothing to pick/.test(t1), 'folder case: the copy promises no picking at all');
  ok(/2 photos saved/.test(t1), 'and says how many photos and when');
  ok(/from “Camera”/.test(t1), 'and names the folder he chose');
  ok(byText(bar(), 'Reload my last selection') !== null, 'the primary action is "Reload my last selection"');
  eq(byText(bar(), 'Reload my last selection')._act, W.RC.restoreFromFolder,
     'and it is wired to the folder restore');
  eq(byText(bar(), 'Choose a different folder')._act, W.RC.chooseFolder,
     'with an escape hatch to a different folder');

  /* case 2: the API exists but nothing is remembered — one picker, and it says so */
  W.RC.setFolder(null);
  W.RC.paint(rec, null);
  const t2 = bar().children[0].textContent;
  ok(/folder picker will open once/.test(t2),
     'setup case: THE PICKER IS ANNOUNCED BEFORE IT OPENS, which is the client\'s complaint');
  ok(/reopen them by name/.test(t2), 'and it says what the one-time cost buys him');
  ok(/Nothing is copied off your phone/.test(t2), 'and that no copy of his documents is made');
  eq(byText(bar(), 'Choose your photo folder')._act, W.RC.chooseFolder, 'primary is the one-time folder choice');
  eq(byText(bar(), 'Pick the photos again')._act, W.RC.startRepick, 'with the fallback still reachable');

  /* case 3: no API — the fallback, labelled honestly */
  W.hidePicker();
  W.RC.paint(rec, null);
  const t3 = bar().children[0].textContent;
  ok(/will not let a page reopen a folder/.test(t3),
     'fallback case: it says WHY he is being asked to pick, rather than surprising him');
  ok(/a file picker will open/.test(t3), 'and that a picker will open, in plain words');
  ok(/your crops, tone and covering still come back/.test(t3),
     'and that the edits come back even on the fallback path');
  eq(byText(bar(), 'Pick the photos again')._act, W.RC.startRepick, 'primary is the re-pick');
  eq(buttons(bar()).filter((b) => !b.hidden).length, 3,
     'three buttons are on screen: the one action this case has, plus Not now and Forget it');
  ok(buttons(bar()).filter((b) => !b.hidden).every((b) =>
       typeof b._act === 'function' || b.textContent === 'Not now' || b.textContent === 'Forget it'),
     'AND EVERY BUTTON ON SCREEN HAS SOMETHING BEHIND IT — a dead button is how a banner ' +
     'looks broken');
  ok(buttons(bar()).filter((b) => b.hidden).every((b) => !b._act),
     'and the button with no action for this case is hidden rather than shown empty');
  W.showPicker();
}

/* ============================================================================ */
console.log('\njs/78-learn-recall.js — the payoff: reopen by name, with no picker');

{
  const W = makeWorld();
  const f1 = photo('IMG_0421.JPG', 1500);
  const f2 = photo('IMG_0422.JPG', 2100);
  const f3 = photo('IMG_0423.JPG', 800);

  /* Session one: three photos, edited, then captured — the ordinary import path. */
  W.JS.app.pages = [editedPage(f1), editedPage(f2), newPage(f3)];
  W.JS.app.pages[1].coarse = 180;
  W.JS.app.pages[1].mode = 'gray';
  const folder = fakeDir({
    'IMG_0421.JPG': { file: f1 },
    'IMG_0422.JPG': { file: f2 },
    'IMG_0423.JPG': { file: f3 }
  }, { name: 'Camera' });
  W.RC.setFolder(folder);
  eq(W.RC.capture(), true, 'session one: the selection is captured');

  /* Session two: a fresh launch. The pages are new objects, the files are the same files. */
  W.JS.app.pages = [newPage(f1), newPage(f2), newPage(f3)];
  W.picked.calls = 0;
  folder._calls.length = 0;
  W.JS.addFiles = (files) => {
    W.spy.added.push(files.slice());
    W.JS.app.pages = files.map(newPage);       // the real addFiles decodes each into a new page
    W.RC.onFilesAdded();                        // ...and then tells recall the selection changed
    return Promise.resolve();
  };

  const okResult = await W.RC.restoreFromFolder();
  eq(okResult, undefined, 'restoreFromFolder ran to completion');

  eq(W.picked.calls, 0, 'NO PICKER WAS OPENED. This is the client\'s whole request');
  eq(W.spy.added.length, 1, 'the files were handed to the importer in one batch');
  eq(W.spy.added[0].length, 3, 'all three of them');
  eq(W.spy.added[0].map((f) => f.name).join(','), 'IMG_0421.JPG,IMG_0422.JPG,IMG_0423.JPG',
     'opened by the names that were saved');
  eq(folder._calls.filter((c) => c.indexOf('open:') === 0).length, 3,
     'each one opened by name inside the folder, not listed and filtered');

  const pages = W.JS.app.pages;
  eq(pages[0].coarse, 90, 'the crop rotation came back on photo 1');
  eq(pages[0].fine, -3, 'and the de-skew');
  eq(pages[0].mode, 'bw', 'and the mode');
  eq(pages[0].adj.wb, 70, 'and the tone');
  ok(pages[0].corners && pages[0].corners.length === 4, 'and the crop quad');
  eq(pages[0].cornersFrom, 'manual', 'with the knowledge that he drew it by hand');
  eq(pages[1].coarse, 180, 'photo 2 got its own rotation, not photo 1\'s');
  eq(pages[1].mode, 'gray', 'and its own mode');
  eq(pages[2].coarse, 0, 'photo 3 was untouched and stays untouched');
  eq(pages[2].mode, 'original', 'including its mode');
  eq(W.RC.currentFolder().name, 'Camera', 'the folder is still remembered for next time');
  ok(/Put your edits back on 3 of 3 photos/.test(W.lastHint()),
     'and it says what came back: ' + JSON.stringify(W.lastHint()));
  eq(W.spy.comments.join(','), 'receipt stack', 'the comment from last session is restored');
}

{
  /* The named-report path: one file has been re-taken since it was cropped. */
  const W = makeWorld();
  const f1 = photo('IMG_0421.JPG', 1500);
  const f2 = photo('IMG_0422.JPG', 2100);
  W.JS.app.pages = [editedPage(f1), editedPage(f2)];
  W.RC.setFolder(fakeDir({ 'IMG_0421.JPG': { file: f1 } }, { name: 'Camera' }));
  W.RC.capture();

  const folder = fakeDir({
    'IMG_0421.JPG': { file: f1 },
    'IMG_0422.JPG': { file: photo('IMG_0422.JPG', 9999) }   // same name, different photo
  }, { name: 'Camera' });
  W.RC.setFolder(folder);

  const second = [newPage(f1), newPage(photo('IMG_0422.JPG', 9999))];
  W.JS.app.pages = second;
  W.JS.addFiles = (files) => {
    W.JS.app.pages = files.map(newPage);
    W.RC.onFilesAdded();
    return Promise.resolve();
  };
  await W.RC.restoreFromFolder();

  eq(W.JS.app.pages.length, 1, 'only the file that is still the same photo is restored');
  eq(second[1].coarse, 0, 'and the changed photo is left exactly as imported');
  const hint = W.lastHint();
  ok(/Changed since you cropped them, so left alone: IMG_0422.JPG/.test(hint),
     'A CHANGED FILE IS NAMED IN THE MESSAGE, so he can go and look at that one photo: ' + JSON.stringify(hint));
  ok(/Not in that folder/.test(hint) === false, 'and it is not also reported as missing');
}

{
  /* Nothing came back: the folder is wrong, or the phone gave us different names. */
  const W = makeWorld();
  const f1 = photo('IMG_0421.JPG', 1500);
  W.JS.app.pages = [editedPage(f1), editedPage(photo('IMG_0422.JPG', 2100))];
  W.RC.setFolder(fakeDir({ 'IMG_0421.JPG': { file: f1 } }, { name: 'Camera' }));
  W.RC.capture();

  W.RC.setFolder(fakeDir({}, { name: 'Screenshots' }));
  W.JS.app.pages = [newPage(f1)];
  let addFilesCalled = 0;
  W.JS.addFiles = () => { addFilesCalled++; return Promise.resolve(); };

  const res = await W.RC.restoreFromFolder();
  eq(res, false, 'restoreFromFolder reports that it restored nothing');
  eq(addFilesCalled, 0, 'IT DOES NOT IMPORT AN EMPTY SELECTION — the app is left alone');
  ok(/not in “Screenshots” any more/.test(W.lastHint()),
     'and it says WHICH folder and WHICH files: ' + JSON.stringify(W.lastHint()));
  ok(/nothing was changed/.test(W.lastHint()), 'and reassures him nothing was half-applied');
}

{
  /* A refusal. The banner comes back with the re-pick FIRST, so he is never stuck. */
  const W = makeWorld();
  const f1 = photo('IMG_0421.JPG', 1500);
  W.JS.app.pages = [editedPage(f1)];
  const folder = fakeDir({ 'IMG_0421.JPG': { file: f1 } }, { name: 'Camera' });
  W.RC.setFolder(folder);
  W.RC.capture();

  folder._perm = 'denied';
  W.JS.app.pages = [newPage(f1)];
  let addFilesCalled = 0;
  W.JS.addFiles = () => { addFilesCalled++; return Promise.resolve(); };

  const res = await W.RC.restoreFromFolder();
  eq(res, false, 'a denied permission restores nothing');
  eq(folder._calls.filter((c) => c.indexOf('open:') === 0).length, 0,
     'AND NO READ IS ATTEMPTED — the denial is respected, not worked around');
  eq(addFilesCalled, 0, 'nothing is imported');
  ok(/did not let me back into that folder/.test(W.lastHint()),
     'and the refusal is reported as a refusal, in its own words: ' + JSON.stringify(W.lastHint()));
  ok(/pick the photos again and your edits still come back/.test(W.lastHint()),
     'with the way forward in the same sentence');

  const repainted = find(W.dom.home, (n) => n.id === 'recall-banner')[0];
  eq(byText(repainted, 'Pick the photos again')._act, W.RC.startRepick,
     'and the banner that comes back offers the re-pick first');
}

{
  /* Dismissing the OS picker is not an error. */
  const W = makeWorld();
  const f1 = photo('IMG_0421.JPG', 1500);
  W.JS.app.pages = [editedPage(f1)];
  W.RC.capture();
  W.RC.setFolder(null);
  W.picked.throws = Object.assign(new Error('dismissed'), { name: 'AbortError' });
  await W.RC.chooseFolder();
  eq(W.spy.hints.length, 0, 'an AbortError says nothing at all — he knows what he just did');

  W.picked.throws = new Error('SecurityError');
  await W.RC.chooseFolder();
  ok(/would not open a folder picker/.test(W.lastHint()), 'a real picker failure does say so');
}

console.log('\njs/78-learn-recall.js — the fallback is not silently dead');

{
  const W = makeWorld();
  const f1 = photo('IMG_0421.JPG', 1500);
  W.JS.app.pages = [editedPage(f1)];
  W.RC.capture();
  W.RC.setFolder(null);

  W.dom.gallery._clicks = 0;
  eq(W.RC.startRepick(), true, 'startRepick reports that it acted');
  eq(W.dom.gallery._clicks, 1,
     'AND THE GALLERY INPUT IS ACTUALLY CLICKED. It is only ever called from a tap handler, ' +
     'because input.click() needs transient activation and from a promise continuation it ' +
     'does nothing at all — a button that looks dead');

  W.dom.gallery._clicks = 0;
  W.RC.paint({ schema: 'jscan.recall/1', saved_utc: '2026-09-21T08:30:00Z', pages: [{ name: 'a' }] }, null);
  const bar = find(W.dom.home, (n) => n.id === 'recall-banner')[0];
  byText(bar, 'Pick the photos again').click();          // the real listener, a real tap
  eq(W.dom.gallery._clicks, 1, 'and the button in the banner really is wired to it');

  /* ...and an ordinary import after it is a restore, not a new capture. */
  W.JS.app.pages = [newPage(f1)];
  W.JS.addFiles = (files) => {
    W.JS.app.pages = files.map(newPage);
    W.RC.onFilesAdded();
    return Promise.resolve();
  };
  await W.JS.addFiles([f1]);
  eq(W.JS.app.pages[0].coarse, 90, 'the re-picked photo got its edits back through the fallback');
  eq(W.JS.app.pages[0].mode, 'bw', 'including the mode');
}

console.log('\njs/78-learn-recall.js — what is kept, and what is thrown away');

{
  const W = makeWorld();
  const f1 = photo('IMG_0421.JPG', 1500);
  W.JS.app.pages = [editedPage(f1)];
  W.RC.setFolder(fakeDir({}, { name: 'Camera' }));
  W.RC.capture();

  const raw = W.ls.getItem('jscanner.recall.last');
  ok(raw && raw.length > 0, 'a record was written');
  ok(raw.length < 4000, 'and it is TINY (' + raw.length + ' chars) — it is numbers, not pixels');
  ok(raw.indexOf('data:') === -1, 'no data URI anywhere in it');
  ok(!/[A-Za-z0-9+/]{200,}/.test(raw), 'and no base64 blob: no copy of his document is stored');
  ok(raw.indexOf('"mask":null') !== -1, 'a page with no redaction stores a null mask, not a bitmap');
  ok(raw.indexOf('"name":"IMG_0421.JPG"') !== -1, 'what IS stored is the filename');
  ok(raw.indexOf('"size":1500') !== -1, 'and the size, so a different photo cannot be matched later');
  ok(raw.indexOf('"folder":"Camera"') !== -1, 'and the folder he chose, as a display name');

  const leaves = [];
  (function walk(v, key) {
    if (v === null) { leaves.push(key + '=null'); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, key + '[' + i + ']')); return; }
    if (typeof v === 'object') { Object.keys(v).forEach((k) => walk(v[k], k)); return; }
    leaves.push(key + '=' + typeof v);
    if (typeof v === 'string') ok(v.length <= 64, 'no long string in the record: ' + key);
  })(JSON.parse(raw), 'rec');
  ok(leaves.every((l) => /=(number|boolean|string|null)$/.test(l)),
     'every value in the record is a number, a boolean, a string or null — nothing with bytes in it');

  /* The other half of the promise: forgetting lets go of the folder too. */
  W.RC.setFolder(fakeDir({}, { name: 'Camera' }));
  W.RC.forget();
  eq(W.ls.getItem('jscanner.recall.last'), null, 'forget() clears the record');
  eq(W.RC.currentFolder(), null,
     'AND releases the folder handle — the button says nothing of his last selection is kept ' +
     'on this phone, and a live handle to where his documents live is exactly that');
}

console.log('\njs/78-learn-recall.js — the detector outcome survives the round trip');

{
  const W = makeWorld();
  const f1 = photo('IMG_0421.JPG', 1500);
  const p = editedPage(f1);                     // autoOutcome 'refused', autoRan true
  p.quadAuto = null;
  W.JS.app.pages = [p];
  W.RC.capture();
  ok(W.ls.getItem('jscanner.recall.last').indexOf('"auto_outcome":"refused"') !== -1,
     'a refusal is saved as an outcome, not only as a missing quad');

  W.JS.app.pages = [newPage(f1)];
  W.RC.restoreNow(null);
  eq(W.JS.app.pages[0].autoOutcome, 'refused',
     'and comes back as a refusal, so the Learn label after a reload is the label he would ' +
     'have sent anyway');
  eq(W.JS.app.pages[0].autoRan, true, 'with the fact that the detector was asked');

  /* A v1.9.0 record, written before the field existed. */
  const old = JSON.parse(W.ls.getItem('jscanner.recall.last'));
  delete old.pages[0].auto_outcome;
  W.ls.setItem('jscanner.recall.last', JSON.stringify(old));
  W.JS.app.pages = [newPage(f1)];
  W.RC.restoreNow(null);
  eq(W.JS.app.pages[0].autoOutcome, 'refused',
     'AN OLD RECORD IS BACKFILLED: asked + no quad = refused, so yesterday\'s selection ' +
     'does not silently become not_attempted today');

  old.pages[0].quad_auto = [[0, 0], [1, 0], [1, 1], [0, 1]];
  W.ls.setItem('jscanner.recall.last', JSON.stringify(old));
  W.JS.app.pages = [newPage(f1)];
  W.RC.restoreNow(null);
  eq(W.JS.app.pages[0].autoOutcome, 'found', 'and asked + a quad = found');

  old.pages[0].auto_ran = false;
  old.pages[0].quad_auto = null;
  W.ls.setItem('jscanner.recall.last', JSON.stringify(old));
  W.JS.app.pages = [newPage(f1)];
  W.RC.restoreNow(null);
  eq(W.JS.app.pages[0].autoOutcome, '',
     'a page the detector was never asked about stays unasked — the backfill cannot invent one');

  /* A page with no file record cannot be promised a restore. */
  W.JS.app.pages = [{ w: 1, h: 1 }];
  eq(W.RC.capture(), false, 'a page with no file record is not captured');
}

/* ============================================================================ */
console.log('\njs/77-fs-handle.js — the folder-rooted file picker and the name probe');

/* A `FileSystemFileHandle`, as `showOpenFilePicker` returns them. */
function fhOf(file) {
  return { kind: 'file', name: file.name, getFile: () => Promise.resolve(file) };
}
/* Let a promise chain of unknown depth settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

{
  const W = makeWorld();
  const dir = fakeDir({}, { name: 'Camera' });
  const f1 = photo('IMG_0001.jpg', 900);
  W.opened.handles = [fhOf(f1)];

  const files = await W.FH.pickFiles(dir, true);
  eq(files.length, 1, 'pickFiles resolves with the files behind the handles');
  eq(files[0].name, 'IMG_0001.jpg', 'and they are Files, with their own names');
  eq(files[0].size, 900, 'and their real byte counts');
  eq(W.opened.opts.startIn, dir,
     'STARTIN IS THE FOLDER HE GRANTED — this is the whole point: the picker opens inside' +
     ' it, so what comes back are that folder\'s own files under their REAL names');
  eq(W.opened.opts.multiple, true, 'and it is a multi-select, because he has a stack');
  ok(W.opened.opts.types && W.opened.opts.types[0].accept['image/*'].indexOf('.heic') !== -1,
     'the type filter covers what a phone camera writes, heic included');

  /* `startIn` is an optimisation, not a requirement. A build that refuses it must still be
     able to open the picker, or the one-time setup is impossible on that phone. */
  let calls = 0;
  W.win.showOpenFilePicker = (opts) => {
    calls++;
    if (calls === 1) {
      const e = new Error('no startIn for you'); e.name = 'SecurityError';
      return Promise.reject(e);
    }
    eq('startIn' in opts, false, 'the retry drops startIn rather than giving up');
    return Promise.resolve([fhOf(f1)]);
  };
  const again = await W.FH.pickFiles(dir, true);
  eq(calls, 2, 'a build that refuses startIn gets a second attempt without it');
  eq(again.length, 1, 'and the setup still completes');

  /* A dismissed picker is not a reason to try again — it is a reason to stop. */
  let aborts = 0;
  W.win.showOpenFilePicker = () => {
    aborts++;
    const e = new Error('dismissed'); e.name = 'AbortError';
    return Promise.reject(e);
  };
  const aborted = await W.FH.pickFiles(dir, true).then(() => 'resolved', (e) => e.name);
  eq(aborted, 'AbortError', 'dismissing the OS picker is passed straight back to the caller');
  eq(aborts, 1, 'and is NOT retried behind his back');

  W.hideFilePicker();
  eq(W.FH.filePickerSupported(), false, 'filePickerSupported() is a feature detect, like the folder one');
  const none = await W.FH.pickFiles(dir, true).then(() => 'resolved', (e) => e.message);
  eq(none, 'UNSUPPORTED', 'and pickFiles rejects rather than throwing into a tap handler');
  W.showFilePicker();
}

{
  const W = makeWorld();
  const f1 = photo('IMG_0421.JPG', 1500);
  const dir = fakeDir({
    'IMG_0421.JPG': { file: f1 },
    'IMG_9999.JPG': { throw: Object.assign(new Error('busy'), { name: 'NotReadableError' }) }
  }, { name: 'Camera' });

  const v = await W.FH.probe(dir, ['IMG_0421.JPG', 'IMG_9999.JPG', 'IMG_0001.JPG', '']);
  eq(v.present.join(','), 'IMG_0421.JPG,IMG_9999.JPG',
     'a name that is there is present, and A NAME THAT COULD NOT BE READ IS PRESENT TOO — an' +
     ' unreadable file is not evidence that the name is wrong, and treating it as wrong would' +
     ' push him into a re-import he does not need');
  eq(v.absent.join(','), 'IMG_0001.JPG', 'and only a genuine NotFound counts as absent');
  eq(dir._calls.join('|'), 'open:IMG_0421.JPG|open:IMG_9999.JPG|open:IMG_0001.JPG',
     'ONE getFileHandle PER NAME AND NOTHING ELSE — the folder is never listed');
  ok(dir._calls.every((c) => c.indexOf('FORBIDDEN') === -1),
     'and no enumerate/write method was ever reached');

  const empty = await W.FH.probe(null, ['x']);
  eq(empty.present.length + empty.absent.length, 0, 'probe with no handle is empty, not a throw');
}

/* ============================================================================ */
console.log('\njs/78-learn-recall.js — the folder step is reachable with NOTHING saved');

{
  const W = makeWorld();
  eq(W.RC.hasSaved(), false, 'a fresh phone has nothing saved');
  eq(W.RC.offer(), true,
     'THE BANNER STILL COMES UP. This is the client\'s bug: the setup was only reachable from' +
     ' a saved record, so the one state that needed it could never reach it');
  const bar = find(W.dom.home, (n) => n.id === 'recall-banner')[0];
  ok(/pick the folder your photos are in/.test(bar.children[0].textContent),
     'and it offers the folder step in words: ' + JSON.stringify(bar.children[0].textContent));
  eq(byText(bar, 'Choose my photo folder')._act, W.RC.chooseFolder, 'with the setup as its action');
  ok(byText(bar, 'Forget it').hidden,
     'and "Forget it" is HIDDEN, because there is no record to forget — a button with nothing' +
     ' behind it is how a banner looks broken');
}

{
  const W = makeWorld();
  W.hidePicker();
  eq(W.RC.offer(), false,
     'with no record and no folder API there is genuinely nothing to offer, so the banner' +
     ' stays down rather than showing a button that cannot work');
}

{
  /* The one-time setup on a phone with nothing saved: two taps, and the SECOND one is the
     one that cannot be removed, because the folder picker consumed the first. */
  const W = makeWorld();
  const dir = fakeDir({}, { name: 'Camera' });
  W.picked.handle = dir;
  W.JS.addFiles = (files) => {
    W.spy.added.push(files.slice());
    W.JS.app.pages = files.map(newPage);
    W.RC.onFilesAdded();
    return Promise.resolve();
  };
  W.RC.offer();
  W.opened.calls = 0;
  await W.RC.chooseFolder();

  eq(W.opened.calls, 0,
     'THE FILE PICKER IS NOT OPENED IN THE SAME TAP. showDirectoryPicker consumed the user' +
     ' activation, so calling showOpenFilePicker from the continuation would throw' +
     ' SecurityError on a real browser — a button that silently does nothing');
  eq(W.RC.currentFolder(), dir, 'but the folder is remembered');

  const bar = find(W.dom.home, (n) => n.id === 'recall-banner')[0];
  ok(/Camera/.test(bar.children[0].textContent), 'the banner names the folder he chose');
  ok(byText(bar, 'Choose my photos in that folder') !== null,
     'and puts the second step on a button, for a real tap: ' + JSON.stringify(bar.children[0].textContent));

  W.opened.handles = [fhOf(photo('IMG_0001.jpg', 900)), fhOf(photo('IMG_0002.jpg', 700))];
  byText(bar, 'Choose my photos in that folder').click();
  await flush(); await flush(); await flush();

  eq(W.opened.opts.startIn, dir, 'THE FILE PICKER OPENS INSIDE THE FOLDER HE JUST GRANTED');
  eq(W.spy.added[0].map((f) => f.name).join(','), 'IMG_0001.jpg,IMG_0002.jpg',
     'and the photos come back under the FOLDER\'s own names');

  const rec = JSON.parse(W.ls.getItem('jscanner.recall.last'));
  eq(rec.pages.map((p) => p.name).join(','), 'IMG_0001.jpg,IMG_0002.jpg',
     'AND THE RECORD IS REWRITTEN FROM THOSE NAMES. Without this the one-time setup repairs' +
     ' nothing and the next launch is back where it started');
  eq(rec.folder, 'Camera', 'and it remembers which folder they came from');
  eq(rec.where.kind, 'file-input', 'with nothing invented about a path the browser never gave');
}

/* ============================================================================ */
console.log('\njs/78-learn-recall.js — an album-picked record cannot be reopened by name');

{
  /* The client's actual state: a record written from an ALBUM selection, whose names came
     from the Android Photo Picker and therefore exist in no folder on the device. */
  const W = makeWorld();
  const synth = [photo('1000012345.jpg', 900), photo('1000012346.jpg', 700)];
  W.JS.app.pages = synth.map(editedPage);
  W.RC.capture();
  eq(JSON.parse(W.ls.getItem('jscanner.recall.last')).pages[0].name, '1000012345.jpg',
     'the record faithfully holds the name the phone gave the page');

  const dir = fakeDir({ 'IMG_0001.jpg': { file: photo('IMG_0001.jpg', 900) } }, { name: 'Camera' });
  W.picked.handle = dir;
  W.JS.addFiles = (files) => {
    W.spy.added.push(files.slice());
    W.JS.app.pages = files.map(newPage);
    W.RC.onFilesAdded();
    return Promise.resolve();
  };
  W.RC.offer();
  W.spy.hints.length = 0;
  W.opened.calls = 0;
  await W.RC.chooseFolder();

  eq(dir._calls.filter((c) => c.indexOf('open:') === 0).length, 2,
     'the app opens each saved name in the folder — and that is all it does with the folder');
  ok(dir._calls.every((c) => c.indexOf('FORBIDDEN') === -1),
     'the folder is never listed and never written to, even here');

  const bar = find(W.dom.home, (n) => n.id === 'recall-banner')[0];
  const text = bar.children[0].textContent;
  ok(/1000012345\.jpg/.test(text) || /none of your 2 saved/i.test(text),
     'THE BANNER REPORTS THE ACTUAL FAILURE: ' + JSON.stringify(text));
  ok(/album/i.test(text) && /IMG_0001\.jpg/.test(text),
     'and names the real cause — the album picker hands over a copy called 1000012345.jpg' +
     ' instead of the camera\'s own IMG_0001.jpg, a name that has never existed in the folder');
  ok(/nothing is copied off/i.test(text) === false && text.length > 0, 'and says it where he can see it');
  ok(W.RC.currentNotice().length > 0,
     'THE SENTENCE IS ON THE HOME SCREEN. JS.hint writes into #stage-hint, which is inside' +
     ' the EDITOR view — every message this module used to compose was drawn where he could' +
     ' not see it, which is why a total failure looked like nothing at all');

  const repair = byText(bar, 'Choose the photos from that folder');
  ok(repair !== null, 'the repair is a BUTTON, not a paragraph: ' + JSON.stringify(text.slice(0, 120)));
  ok(byText(bar, 'Pick them from my album again') !== null, 'and the old road is still offered');

  /* And the repair really repairs. */
  W.opened.handles = [fhOf(photo('IMG_0001.jpg', 900)), fhOf(photo('IMG_0002.jpg', 1200))];
  W.spy.added.length = 0;
  repair.click();
  await flush(); await flush(); await flush();

  eq(W.opened.opts.startIn, dir, 'the repair opens the picker inside the folder');
  eq(W.spy.added.length, 1, 'and imports from it');
  const rec = JSON.parse(W.ls.getItem('jscanner.recall.last'));
  eq(rec.pages.map((p) => p.name).join(','), 'IMG_0001.jpg,IMG_0002.jpg',
     'AND THE SYNTHETIC NAMES ARE GONE FROM THE RECORD — which is the whole repair. The next' +
     ' launch opens these names inside that folder and needs no picker');
  eq(rec.folder, 'Camera', 'with the folder still remembered');
}

{
  /* A partial miss is NOT the rename: most names resolved, so the folder is right and the
     one absent name is simply gone. It must not send him into a costly re-import. */
  const W = makeWorld();
  const f1 = photo('IMG_0001.jpg', 900);
  const f2 = photo('IMG_0002.jpg', 700);
  W.JS.app.pages = [editedPage(f1), editedPage(f2)];
  W.RC.capture();
  const dir = fakeDir({ 'IMG_0001.jpg': { file: f1 } }, { name: 'Camera' });
  W.RC.setFolder(dir);
  W.JS.app.pages = [newPage(f1), newPage(f2)];
  W.JS.addFiles = (files) => {
    W.JS.app.pages = files.map(newPage);
    W.RC.onFilesAdded();
    return Promise.resolve();
  };
  await W.RC.reconcile(JSON.parse(W.ls.getItem('jscanner.recall.last')), dir);
  ok(/Put your edits back on 1 of 2 photos/.test(W.lastHint()),
     'a partial miss goes down the ordinary read path: ' + JSON.stringify(W.lastHint()));
  ok(/Not in that folder: IMG_0002\.jpg/.test(W.lastHint()), 'and names the one that is gone');
  ok(/album/.test(W.RC.currentNotice()) === false,
     'and does NOT claim the phone renamed anything — that would be a diagnosis the evidence' +
     ' does not support');
}

{
  /* Where the browser has no folder-rooted file picker, the repair must not be offered as a
     dead button. The diagnosis still stands. */
  const W = makeWorld();
  W.JS.app.pages = [editedPage(photo('1000012345.jpg', 900))];
  W.RC.capture();
  const dir = fakeDir({ 'IMG_0001.jpg': { file: photo('IMG_0001.jpg', 900) } }, { name: 'Camera' });
  W.picked.handle = dir;
  W.hideFilePicker();
  W.RC.offer();
  await W.RC.chooseFolder();
  const bar = find(W.dom.home, (n) => n.id === 'recall-banner')[0];
  eq(byText(bar, 'Choose the photos from that folder'), null,
     'no repair button when the API behind it is missing');
  ok(byText(bar, 'Pick the photos again') !== null, 'the honest fallback is what is offered instead');
  W.showFilePicker();
}

/* ============================================================================ */
console.log('\njs/78-learn-recall.js — a folder that will not re-grant is not a loop');

{
  /* Chrome for Android does not implement persisted permissions (crbug 40101963), so
     whether a remembered folder can be re-granted after the browser has restarted is NOT
     settled by anything reachable from a desktop. What IS settled is that the app must not
     sit on a button demanding "one more tap" forever — the client's original complaint was
     a button that did not do what it said. */
  const W = makeWorld();
  const f1 = photo('IMG_0001.jpg', 900);
  const dir = fakeDir({ 'IMG_0001.jpg': { file: f1 } },
                      { name: 'Camera', perm: 'prompt', requestResult: 'prompt' });
  W.JS.app.pages = [editedPage(f1)];
  W.RC.capture();
  W.RC.setFolder(dir);
  W.RC.offer();

  await W.RC.restoreFromFolder();
  ok(dir._calls.indexOf('requestPermission:read') !== -1,
     'the tap does ask for the grant — that is the one tap the platform requires');
  ok(/one more tap/i.test(W.RC.currentNotice()),
     'a FIRST "prompt" gets one retry, honestly labelled: ' + JSON.stringify(W.RC.currentNotice()));
  let bar = find(W.dom.home, (n) => n.id === 'recall-banner')[0];
  eq(byText(bar, 'Reload my last selection')._act, W.RC.restoreFromFolder,
     'with the same button, because one retry is worth having');

  const before = dir._calls.length;
  await W.RC.restoreFromFolder();
  eq(dir._calls.length > before, true, 'the second tap really did ask again');
  ok(/did not hand back access/.test(W.RC.currentNotice()),
     'a SECOND "prompt" stops the loop rather than asking a third time: ' +
     JSON.stringify(W.RC.currentNotice()));
  ok(/Choose the folder once more/.test(W.RC.currentNotice()) &&
     /pick the photos again/.test(W.RC.currentNotice()),
     'and names both roads that still work, instead of one that does not');
  bar = find(W.dom.home, (n) => n.id === 'recall-banner')[0];
  eq(byText(bar, 'Pick the photos again')._act, W.RC.startRepick,
     'the album is a live button, not a paragraph');
  eq(byText(bar, 'Choose my photo folder')._act, W.RC.chooseFolder,
     'and so is choosing the folder again — the picker reopens where he left it');

  /* And a plain refusal is its own outcome, not a missing folder and not a retry. */
  const W2 = makeWorld();
  const f2 = photo('IMG_0001.jpg', 900);
  const dir2 = fakeDir({ 'IMG_0001.jpg': { file: f2 } }, { name: 'Camera', perm: 'denied' });
  W2.JS.app.pages = [editedPage(f2)];
  W2.RC.capture();
  W2.RC.setFolder(dir2);
  W2.RC.offer();
  await W2.RC.restoreFromFolder();
  eq(dir2._calls.indexOf('requestPermission:read'), -1,
     'a DENIED handle is not re-asked — repeating a dismissed prompt is how a page looks broken');
  ok(/did not let me back into that folder/.test(W2.RC.currentNotice()),
     'and the refusal is reported as a refusal: ' + JSON.stringify(W2.RC.currentNotice()));
  ok(/not in that folder/i.test(W2.RC.currentNotice()) === false,
     'NEVER as a missing folder — those two need different actions from him');
}

/* ============================================================================ */
console.log('\n' + (failures ? failures + ' FAILED, ' : '') +
            'learn_folder_test: ' + (failures ? '' : 'all assertions held') + '\n');
process.exit(failures ? 1 : 0);
