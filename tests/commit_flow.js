/* ==========================================================================
   tests/commit_flow.js — drives the real JS.commitPage from js/50-ui.js.

   smoke.js checks the commit *contract* (state signature, and that a committed
   page costs no pixel work). This checks the commit *act*: that the render
   happens before the state is wiped, that the page ends up holding a source
   that is the cleaned image, and that blob URLs are revoked only when nobody
   else is still using them.

   The ordering assertion is the important one. Reset the state first and the
   bake re-renders the untouched original — which is exactly the symptom the
   user reported, arrived at from the other direction.

   Run:  node tests/commit_flow.js
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* ---------- stubs: canvases, images, object URLs ---------- */

const urls = new Map();          // url -> { w, h }
const liveUrls = new Set();      // created and not yet revoked
let urlSeq = 0;

function stubCanvas() {
  const c = { width: 300, height: 150, style: {}, _ctx: null, _draws: [] };
  c.getContext = () => {
    if (c._ctx) return c._ctx;
    c._ctx = {
      canvas: c,
      imageSmoothingQuality: '',
      save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
      setTransform() {}, clearRect() {},
      drawImage(src) { c._draws.push(src); },
      createImageData(w, h) {
        return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      },
      getImageData(x, y, w, h) {
        return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      },
      putImageData() {}
    };
    return c._ctx;
  };
  // The blob remembers the canvas it came from, so the fake <img> that loads it
  // can report the right intrinsic size.
  c.toBlob = (cb) => cb({ _w: c.width, _h: c.height });
  return c;
}

class FakeImage {
  constructor() { this._src = ''; this.width = 0; this.height = 0; }
  set src(v) {
    this._src = v;
    const d = urls.get(v) || { w: 1, h: 1 };
    this.naturalWidth = d.w;
    this.naturalHeight = d.h;
    this.width = d.w;
    this.height = d.h;
    if (this.onload) Promise.resolve().then(() => this.onload());
  }
  get src() { return this._src; }
  decode() { return Promise.resolve(); }
}

// Permissive element stub. Enough of 50-ui.js runs headless that the delete and
// clear paths can be exercised for real rather than reimplemented in the test.
function fakeEl() {
  return {
    hidden: false, disabled: false, textContent: '', innerHTML: '', value: '',
    style: {}, dataset: {}, children: [], childElementCount: 0,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener() {}, appendChild() {}, removeAttribute() {}, setAttribute() {},
    querySelector: () => null, closest: () => null, getContext: () => null
  };
}

const sandbox = {
  window: { devicePixelRatio: 1 },
  document: {
    createElement: (tag) => (tag === 'canvas' ? stubCanvas() : fakeEl()),
    getElementById: () => fakeEl(),
    querySelectorAll: () => []
  },
  navigator: {},
  Image: FakeImage,
  URL: {
    createObjectURL(blob) {
      const url = 'blob:' + (++urlSeq);
      urls.set(url, { w: blob._w, h: blob._h });
      liveUrls.add(url);
      return url;
    },
    revokeObjectURL(url) { liveUrls.delete(url); }
  },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  setTimeout, clearTimeout,
  console,
  TextEncoder,
  Uint8Array, Uint8ClampedArray, Float64Array, Int32Array, Uint32Array,
  Math, JSON, Object, Array, Number, String, Promise, Date, RegExp, Error, Map, Set
};
sandbox.window.JS = {};
sandbox.window.window = sandbox.window;
sandbox.self = sandbox;
vm.createContext(sandbox);

for (const f of ['00-utils.js', '10-imageops.js', '20-detect.js', '30-pipeline.js',
                 '40-export.js', '50-ui.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), sandbox, { filename: f });
}
const JS = sandbox.window.JS;
const app = JS.app;

/* ---------- harness ---------- */

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -- ' + detail : '')); }
}

/** A page in the state a user would reach "Done" from. */
function editedPage(source) {
  const p = JS.createPage(source || new FakeImage(), 400, 600, 'receipt.jpg');
  p.coarse = 90;
  p.fine = -2;
  p.corners = [{ x: 0.1, y: 0.05 }, { x: 0.9, y: 0.08 }, { x: 0.88, y: 0.95 }, { x: 0.12, y: 0.92 }];
  p.mode = 'bw';
  p.adj = { bright: 3, contrast: 20, wb: 70, sat: 0, warmth: 0, flat: 70, thr: 0, sharp: 0 };
  p._bakedKey = '';
  return p;
}

(async function main() {
  console.log('\ncommit flow');

  /* ---- 1. the render must happen before the state is reset ---- */
  {
    app.pages = [editedPage()];
    const page = app.pages[0];

    const realRender = JS.renderPage;
    let seen = null;
    JS.renderPage = function (p, maxDim) {
      seen = { mode: p.mode, coarse: p.coarse, fine: p.fine, corners: !!p.corners, maxDim };
      return realRender(p, maxDim);
    };

    await JS.commitPage(page);
    JS.renderPage = realRender;

    check('the render saw the finished state, not the wiped one',
      seen && seen.mode === 'bw' && seen.coarse === 90 && seen.fine === -2 && seen.corners,
      seen ? `saw mode=${seen.mode} coarse=${seen.coarse} fine=${seen.fine} corners=${seen.corners}` : 'never called');
    check('the render ran at working resolution', seen && seen.maxDim === JS.WORK_MAX,
      seen ? 'maxDim=' + seen.maxDim : '');
  }

  /* ---- 2. the page ends up holding the cleaned image ---- */
  {
    const page = app.pages[0];
    check('mode resets to original', page.mode === 'original', page.mode);
    check('rotation resets', page.coarse === 0 && page.fine === 0,
      `coarse=${page.coarse} fine=${page.fine}`);
    check('crop resets', page.corners === null, String(page.corners));
    check('every slider is neutral',
      JS.manualNeutral(page.adj) && page.adj.wb === 0 && page.adj.flat === 0,
      JSON.stringify(page.adj));
    check('the page reads as committed', JS.isCommitted(page));
    check('the baked mode is remembered for the badge', page.bakedMode === 'bw', page.bakedMode);
    check('the source was replaced', page.source instanceof FakeImage);
    check('dimensions come from the baked render, not the original',
      page.w === page.source.naturalWidth && page.h === page.source.naturalHeight,
      `${page.w}x${page.h} vs source ${page.source.naturalWidth}x${page.source.naturalHeight}`);
    check('the derived caches were dropped',
      Object.keys(page._oriented).length === 0 && Object.keys(page._rects).length === 0);
  }

  /* ---- 3. re-rendering a committed page draws the baked source ---- */
  {
    const page = app.pages[0];
    const src = page.source;
    const oc = JS.orientedCanvas(page, 600);
    check('the oriented canvas draws the baked source',
      (oc._draws || []).indexOf(src) !== -1,
      'drawImage never received the baked image');
  }

  /* ---- 4. committing twice is a no-op, so quality is not eaten ---- */
  {
    const page = app.pages[0];
    const before = page.source;
    const urlsBefore = liveUrls.size;
    const again = await JS.commitPage(page);
    check('a second commit reports nothing to do', again === false, String(again));
    check('a second commit does not re-encode', page.source === before && liveUrls.size === urlsBefore,
      `urls ${urlsBefore} -> ${liveUrls.size}`);
  }

  /* ---- 5. a shared source is not revoked out from under its twin ---- */
  {
    const shared = new FakeImage();
    shared._url = null;
    const a = editedPage(shared);
    const b = editedPage(shared);          // duplicatePage shares the element
    b.source = shared;
    app.pages = [a, b];

    // Give the shared element a live URL, as decodeToPage would have.
    const url = sandbox.URL.createObjectURL({ _w: 400, _h: 600 });
    shared._url = url;

    await JS.commitPage(a);
    check('the twin keeps its blob while it still points at it', liveUrls.has(url),
      'the shared URL was revoked and would have blanked the duplicate');

    await JS.commitPage(b);
    check('the blob is released once the last holder is done', !liveUrls.has(url),
      'the URL leaked after both pages moved on');
  }

  /* ---- 6. deleting a page releases its blob ---- */
  {
    const p = editedPage();
    app.pages = [p];
    const url = sandbox.URL.createObjectURL({ _w: 400, _h: 600 });
    p.source._url = url;
    JS.deletePage(0);
    check('deleting a page revokes its blob', !liveUrls.has(url));
  }

  console.log('\n' + (fail ? fail + ' failed, ' + pass + ' passed' : pass + ' passed, 0 failed') + '\n');
  process.exit(fail ? 1 : 0);
})();
