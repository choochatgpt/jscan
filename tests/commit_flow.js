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

// 70/75/76 are loaded for ONE reason: the Learn manifest's `state` label is derived by
// `JS.learnUI.provenance()` from fields that `commitPage` and `undoAll` write, so the claim
// "Done does not turn a refusal into not_attempted" can only be checked by driving the real
// commit and then asking the real label function. 70 only touches localStorage inside
// try/catch, so it loads with no stub.
for (const f of ['00-utils.js', '10-imageops.js', '20-detect.js', '30-pipeline.js',
                 '40-export.js', '50-ui.js', '70-learn.js', '75-learn-mask.js',
                 '76-learn-ui.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), sandbox, { filename: f });
}
const JS = sandbox.window.JS;
const app = JS.app;
if (!JS.learnUI || !JS.learnUI.provenance) {
  console.error('FAIL: js/76-learn-ui.js did not expose JS.learnUI.provenance');
  process.exit(1);
}
const label = (p) => JS.learnUI.provenance(p).state;

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

  /* ---- 7. the Learn label survives "Done" - the real wrong-provenance report ----
   *
   * A REAL v1.9.0 SUBMISSION arrived with `state: not_attempted` while the client's own
   * comment on it said "Failed to auto crop" - the app claiming auto crop had never been
   * run on a page he had run it on. The cause is `commitPage` clearing `autoRan`,
   * `quadAuto` AND `cornersFrom` together with the crop: after "Done" the detector's
   * answer is unrecoverable, and a later hand-drag then reads as a page nobody asked
   * about.
   *
   * Every step below is the real function. `JS.detectPageQuad` is stubbed to return null,
   * which is the production "No clear page edge found" outcome - the input, not the thing
   * under test.
   */
  {
    const realDetect = JS.detectPageQuad;
    JS.detectPageQuad = () => null;                       // the detector REFUSES
    const hand = [{ x: 0.11, y: 0 }, { x: 0.71, y: 0 }, { x: 0.79, y: 0.99 }, { x: 0.06, y: 0.99 }];
    const hand2 = [{ x: 0.13, y: 0.01 }, { x: 0.69, y: 0.02 }, { x: 0.77, y: 0.98 }, { x: 0.08, y: 0.97 }];

    // (a) Auto crop is pressed and refuses.
    const page = JS.createPage(new FakeImage(), 400, 600, 'IMG_0421.JPG');
    app.pages = [page]; app.active = 0;
    check('the page under test is the active one', JS.activePage() === page);
    await JS.autoDetect(page);
    check('the refusal is recorded as an outcome, not just as a missing quad',
      page.autoOutcome === 'refused', 'autoOutcome=' + JSON.stringify(page.autoOutcome));

    // (b) The user drags a corner in by hand - `moveCropDrag` is what writes these two.
    page.corners = hand;
    page.cornersFrom = 'manual';
    check('asked + refused + hand-drawn reads as refused_then_corrected',
      label(page) === 'refused_then_corrected', label(page));

    // (c) He presses Done.
    await JS.commitPage(page);
    check('Done still clears the geometry it has baked in',
      page.corners === null && page.cornersFrom === '' && page.quadAuto === null &&
      page.autoRan === false,
      `corners=${page.corners} from=${JSON.stringify(page.cornersFrom)} ` +
      `quadAuto=${page.quadAuto} autoRan=${page.autoRan}`);
    check('Done does NOT erase what the detector said about the photograph',
      page.autoOutcome === 'refused', 'autoOutcome=' + JSON.stringify(page.autoOutcome));
    check('a committed page is still reported as a refusal, not as not_attempted',
      label(page) === 'refused', label(page));

    // (d) He drags another corner on the committed page and sends. THIS is the sequence
    // that produced the wrong label: manual corners with the auto history erased.
    page.corners = hand2;
    page.cornersFrom = 'manual';
    check('THE REPORTED BUG: refused -> hand-crop -> Done -> hand-crop stays ' +
      'refused_then_corrected',
      label(page) === 'refused_then_corrected', label(page));

    // (e) The same for Undo all, which is the other full reset.
    const p2 = JS.createPage(new FakeImage(), 400, 600, 'IMG_0422.JPG');
    app.pages = [p2]; app.active = 0;
    await JS.autoDetect(p2);
    p2.corners = hand;
    p2.cornersFrom = 'manual';
    JS.undoAll();
    check('Undo all keeps the detector history too', label(p2) === 'refused', label(p2));
    p2.corners = hand2;
    p2.cornersFrom = 'manual';
    check('Undo all + a fresh hand-crop is still a refusal', label(p2) === 'refused_then_corrected',
      label(p2));

    // (f) THE FALSIFIER: a page the detector was NEVER asked about must still say
    // not_attempted. Without this the fix above would be a licence to invent refusals,
    // which is the one thing the label must never do.
    const p3 = JS.createPage(new FakeImage(), 400, 600, 'IMG_0423.JPG');
    app.pages = [p3]; app.active = 0;
    p3.corners = hand;
    p3.cornersFrom = 'manual';
    check('a hand-crop with no Auto crop at all is still not_attempted',
      label(p3) === 'not_attempted', label(p3));
    p3.quadAuto = null;
    await JS.commitPage(p3);                              // and Done must not change that
    check('and Done does not turn it into a refusal',
      label(p3) === 'not_attempted', label(p3));

    // (g) A page the detector got RIGHT and the user then moved: still corrected.
    const p4 = JS.createPage(new FakeImage(), 400, 600, 'IMG_0424.JPG');
    app.pages = [p4]; app.active = 0;
    p4.autoRan = true;
    p4.autoOutcome = 'found';
    p4.quadAuto = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    p4.corners = p4.quadAuto.map((p) => ({ x: p.x, y: p.y }));
    check('found + untouched is auto_accepted', label(p4) === 'auto_accepted', label(p4));
    p4.corners = hand;
    p4.cornersFrom = 'manual';
    check('found + moved is corrected', label(p4) === 'corrected', label(p4));
    await JS.commitPage(p4);
    p4.corners = hand2;
    p4.cornersFrom = 'manual';
    check('a page the detector got right is never relabelled as a refusal',
      label(p4) === 'corrected', label(p4));

    // (h) An OLD record with no autoOutcome falls back to the v1.9.0 derivation exactly.
    const p5 = JS.createPage(new FakeImage(), 400, 600, 'IMG_0425.JPG');
    app.pages = [p5]; app.active = 0;
    p5.autoRan = true;
    p5.autoOutcome = '';                                  // never written by v1.9.0
    p5.quadAuto = null;
    p5.corners = hand;
    p5.cornersFrom = 'manual';
    check('v1.9.0 state without autoOutcome is unchanged (refused_then_corrected)',
      label(p5) === 'refused_then_corrected', label(p5));
    p5.cornersFrom = '';
    check('v1.9.0 state without autoOutcome is unchanged (refused)',
      label(p5) === 'refused', label(p5));

    JS.detectPageQuad = realDetect;
  }

  console.log('\n' + (fail ? fail + ' failed, ' + pass + ' passed' : pass + ' passed, 0 failed') + '\n');
  process.exit(fail ? 1 : 0);
})();
