/* ==========================================================================
   50-ui.js — state, screens, controls, export flow

   One screen, one panel, one preview, and the preview shows the finished page —
   the same pixels the export writes. There is no second view of the original.
   Straightening is Auto crop plus the rotate buttons and the fine-angle slider;
   the four corners of the page are draggable for when Auto crop misses; and the
   stage can be pinched and panned to read what it is showing.
   ========================================================================== */
'use strict';

(function (JS) {

  var app = JS.app = {
    pages: [],
    active: -1,
    view: 'home',
    fmt: 'pdf',
    quality: 0.9,
    maxDim: 2400,
    busy: false
  };

  var PREVIEW_FULL = JS.PREVIEW_MAX;
  var PREVIEW_FAST = 560;

  var rafPending = false;
  var renderFast = false;

  function activePage() {
    return app.active >= 0 && app.active < app.pages.length ? app.pages[app.active] : null;
  }
  JS.activePage = activePage;

  /** Backing-store scale for the preview and inset canvases. */
  function dpr() {
    return Math.min(window.devicePixelRatio || 1, 2.5);
  }

  /* ----------------------------------------------------------- busy / hint */

  var busyDepth = 0;
  function showBusy(text) {
    busyDepth++;
    var b = JS.$('busy');
    JS.$('busy-text').textContent = text || 'Working…';
    b.hidden = false;
  }
  function hideBusy() {
    busyDepth = Math.max(0, busyDepth - 1);
    if (busyDepth === 0) JS.$('busy').hidden = true;
  }
  JS.showBusy = showBusy;
  JS.hideBusy = hideBusy;

  var hintTimer = null;
  function hint(text, ms) {
    var el = JS.$('stage-hint');
    if (!text) { el.classList.remove('is-on'); return; }
    el.textContent = text;
    el.classList.add('is-on');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { el.classList.remove('is-on'); }, ms || 2600);
  }
  JS.hint = hint;

  /* ---------------------------------------------------------------- views */

  function setView(name) {
    app.view = name;
    JS.$('view-home').classList.toggle('is-active', name === 'home');
    JS.$('view-edit').classList.toggle('is-active', name === 'edit');
    // The handles belong to the editor. Nothing re-renders the preview on the way
    // out, so they have to be taken off here or they stay painted over the grid.
    // The zoom goes with them, for the same reason and one more: the next page
    // opened has no relation to where this one was being looked at.
    if (name !== 'edit') { placeHandles(null, null); resetView(); }
    if (name === 'home') {
      // The grid only needs thumbnails, so let go of the full-size buffers.
      app.pages.forEach(JS.releaseBuffers);
      renderHome();
    }
  }
  JS.setView = setView;

  function openSheet(id) { JS.$(id).hidden = false; }
  function closeSheet(id) { JS.$(id).hidden = true; }
  JS.closeSheet = closeSheet;

  /* ------------------------------------------------------------ home view */

  /** Short label for the grid badge on a page that "Done" has committed. */
  var BAKED_LABELS = {
    auto: 'Colour', bw: 'B&W', receipt: 'Receipt', original: 'As-is'
  };

  function thumbKey(page) {
    return JS.stateKey(page);
  }

  function renderHome() {
    var grid = JS.$('page-grid');
    var empty = JS.$('empty-state');
    var n = app.pages.length;

    empty.hidden = n > 0;
    grid.hidden = n === 0;
    JS.$('btn-export').disabled = n === 0;
    JS.$('btn-clear').disabled = n === 0;
    JS.$('export-count').textContent = String(n);

    if (n === 0) { grid.innerHTML = ''; return; }

    // Rebuild only when the set of pages changed; otherwise just refresh art.
    if (grid.childElementCount !== n) {
      grid.innerHTML = '';
      app.pages.forEach(function (page, i) {
        var d = document.createElement('div');
        d.className = 'thumb';
        d.dataset.index = String(i);

        var img = document.createElement('img');
        img.alt = 'Page ' + (i + 1);
        img.dataset.role = 'art';
        d.appendChild(img);

        var num = document.createElement('span');
        num.className = 'thumb-num';
        num.textContent = String(i + 1);
        d.appendChild(num);

        var del = document.createElement('button');
        del.className = 'thumb-del';
        del.type = 'button';
        del.setAttribute('aria-label', 'Delete page ' + (i + 1));
        del.textContent = '×';
        del.dataset.role = 'del';
        d.appendChild(del);

        var badge = document.createElement('span');
        badge.className = 'thumb-badge';
        badge.dataset.role = 'badge';
        badge.hidden = true;
        d.appendChild(badge);

        grid.appendChild(d);
      });
    }

    app.pages.forEach(function (page, i) {
      var d = grid.children[i];
      if (!d) return;

      // A page shows the badge only while its pixels still are the committed
      // result — edit anything and the state key moves, so it clears itself.
      var badge = d.querySelector('[data-role="badge"]');
      if (badge) {
        var done = JS.isCommitted(page);
        badge.hidden = !done;
        if (done) badge.textContent = BAKED_LABELS[page.bakedMode] || 'Done';
      }

      var img = d.querySelector('[data-role="art"]');
      var key = thumbKey(page);
      if (page._thumb && page._thumbKey === key) {
        if (img.src !== page._thumb) img.src = page._thumb;
        return;
      }
      try {
        var c = JS.renderPage(page, JS.THUMB_MAX);
        page._thumb = c.toDataURL('image/jpeg', 0.72);
        page._thumbKey = key;
        img.src = page._thumb;
      } catch (e) {
        img.removeAttribute('src');
      }
    });
  }
  JS.renderHome = renderHome;

  /* ---------------------------------------------------------- editor view */

  function openEditor(index) {
    if (index < 0 || index >= app.pages.length) return;
    app.active = index;
    setView('edit');
    resetView();
    syncEditorChrome();
    renderPreview(true);
  }
  JS.openEditor = openEditor;

  function syncEditorChrome() {
    var page = activePage();
    if (!page) return;
    JS.$('edit-index').textContent = (app.active + 1) + ' / ' + app.pages.length;
    JS.$('edit-name').textContent = page.name;

    JS.$('btn-prev').disabled = app.active === 0;
    JS.$('btn-next').disabled = app.active === app.pages.length - 1;

    JS.$('in-fine').value = String(page.fine);
    JS.$('val-fine').textContent = page.fine.toFixed(1) + '°';

    var a = page.adj;
    setSlider('in-bright', 'val-bright', a.bright, String(a.bright));
    setSlider('in-contrast', 'val-contrast', a.contrast, String(a.contrast));
    setSlider('in-wb', 'val-wb', a.wb, a.wb + '%');
    setSlider('in-sat', 'val-sat', a.sat, String(a.sat));
    setSlider('in-warmth', 'val-warmth', a.warmth, String(a.warmth));
    setSlider('in-flat', 'val-flat', a.flat, a.flat + '%');
    setSlider('in-thr', 'val-thr', a.thr, String(a.thr));
    setSlider('in-sharp', 'val-sharp', a.sharp, String(a.sharp));

    var lit = false;
    Array.prototype.forEach.call(JS.$('mode-chips').children, function (chip) {
      if (!chip.dataset.mode) return;      // Sharpen is a control, not a mode
      var on = chip.dataset.mode === page.mode;
      if (on) lit = true;
      chip.classList.toggle('is-active', on);
    });
    /* One of the modes has no chip of its own. Auto all picks Receipt for a long
       narrow page, and the only other place that name appears is the stage hint,
       which fades after a couple of seconds — so a page cleaned as a receipt
       ended up looking like a page nothing had been applied to. This says it
       instead, and stays quiet when a lit chip is already saying it.

       `original` is the other chipless mode and gets nothing. It is what a page
       is before anything has been done to it, the row already reads "Tone:" with
       no chip lit, and spending 60px of a 300px row to say "as imported" is the
       worse trade.

       It takes the label's place rather than following it, because the two words
       together are wider than the smallest phone's row and the row wrapping is
       exactly the cost this layout exists to avoid. */
    var named = (lit || page.mode === 'original')
      ? '' : (JS.MODE_LABELS[page.mode] || '');
    JS.$('tone-label').hidden = !!named;
    JS.$('mode-name').textContent = named;
    syncSharpenChip(page);
  }

  /* The Sharpen chip is a step counter, not a switch. It reads the sharpness
     the page is actually carrying and names the nearest step, so it cannot
     disagree with the slider in the drawer — drag that to 80 and the chip says
     3, because that is what it is. Off is just "Sharpen": the label *is* the
     level, because there is no room in this row for a second line.

     "Sharpen 3" and not "Sharpen ×3": the times sign costs 8px, and the row has
     8.7px of slack on a 320px phone once the chip is at its longest. The label
     growing with the step is the point, so the label growing *past the row* is
     the one thing it must not do — a row that re-wraps when you tap it moves
     the stage under your finger. */
  var SHARP_LABELS = ['Sharpen', 'Sharpen 1', 'Sharpen 2', 'Sharpen 3'];

  function syncSharpenChip(page) {
    var chip = JS.$('chip-sharpen');
    var level = JS.sharpenLevel(page);
    chip.textContent = SHARP_LABELS[level];
    chip.classList.toggle('is-active', level > 0);
    chip.setAttribute('aria-pressed', level > 0 ? 'true' : 'false');
  }

  function setSlider(inputId, labelId, value, label) {
    JS.$(inputId).value = String(value);
    JS.$(labelId).textContent = label;
  }

  /* --------------------------------------------------------- preview draw */

  /**
   * The room the preview may use inside the stage.
   *
   * Not the whole stage: the four crop handles ride the corners of the preview
   * box, and `.crop-layer` is clipped by the stage, so a box that reaches the
   * stage's edge puts a dot exactly on the clip — drawn as a half-disc, with a
   * pixel at its centre that hit testing cannot reach. Reserving the dot's radius
   * on all four sides keeps the dots whole and the corners grabbable, and costs a
   * few pixels of preview, which is cheap next to a handle you cannot put a thumb
   * on. `pad` comes back with the box so the caller can put the letterbox back
   * where it belongs.
   */
  var HANDLE_PAD = 11;

  function stageBox() {
    var st = JS.$('stage');
    return { w: Math.max(0, st.clientWidth - HANDLE_PAD * 2),
             h: Math.max(0, st.clientHeight - HANDLE_PAD * 2),
             pad: HANDLE_PAD };
  }

  /* -------------------------------------------------------- the view (zoom) */

  // Where the page is being looked at from: a scale and a translation, applied
  // as one CSS transform on `#stage-zoom`. See `JS.viewZoomAt` and friends.
  var view = JS.viewIdentity();

  // The zoom the canvas on screen was last rendered at. The backing store is a
  // function of this, so a gesture that settles somewhere new owes the display
  // one more render — but not one per frame, or a pinch would run the whole
  // pipeline sixty times a second instead of letting the browser scale the
  // canvas it already has.
  var renderedZ = JS.VIEW_MIN;

  function applyView() {
    var el = JS.$('stage-zoom');
    if (!el) return;
    // The identity is written as no transform at all rather than as
    // `scale(1)`: an unzoomed preview should be a plain canvas in a flexbox,
    // with no composited layer, no rounding and nothing for a screenshot
    // comparison to disagree with.
    el.style.transform = (view.z === 1 && !view.tx && !view.ty)
      ? ''
      : 'translate(' + view.tx.toFixed(2) + 'px,' + view.ty.toFixed(2) + 'px) ' +
        'scale(' + view.z.toFixed(4) + ')';
  }

  /**
   * Back to fit. Called by everything that changes the page's shape under the
   * view — a new page, a rotation, a crop, a resize — because a view is a way of
   * looking at a page and not a property of it, and one carried across a 90°
   * turn would be pointing at a corner that is no longer there.
   *
   * It does not render: every caller is about to. `renderedZ` is set because at
   * fit the canvas is correct at whatever backing it already has.
   */
  function resetView() {
    view = JS.viewIdentity();
    renderedZ = JS.VIEW_MIN;
    applyView();
  }

  /** Re-render if the zoom has settled somewhere that needs a sharper canvas. */
  function settleView() {
    if (renderedZ !== view.z) renderPreview(false);
  }

  /** The view, read-only. The editor's state is inspectable like the rest of it. */
  JS.getView = function () {
    return { z: view.z, tx: view.tx, ty: view.ty };
  };

  /* ------------------------------------------------------ pinch and pan */

  // Pointers that went down on the stage, by id — two fingers are two pointers
  // and which one lifts first is not something this code gets to choose.
  var pointers = {};
  // The view and the finger positions the current gesture is measured from.
  // Rebased whenever a finger lands or lifts, so the page never jumps by the
  // distance the remaining finger travelled while it was not being watched.
  var gesture = null;

  /** A pointer's position in the stage's own coordinates, which is what `view` maps. */
  function stagePoint(e) {
    var st = JS.$('stage');
    var r = st.getBoundingClientRect();
    // The stage has a border and `view` is measured from its padding box, which
    // is where `previewFit` and the crop handles are measured from too.
    return { x: e.clientX - r.left - st.clientLeft,
             y: e.clientY - r.top - st.clientTop };
  }

  function livePoints() {
    return Object.keys(pointers).map(function (id) { return pointers[id]; });
  }

  function rebaseGesture() {
    var pts = livePoints();
    gesture = pts.length
      ? { view: view, pts: pts.map(function (p) { return { x: p.x, y: p.y }; }) }
      : null;
  }

  function gestureMove() {
    if (!gesture) return;
    var pts = livePoints();
    var from = gesture.pts;
    if (!pts.length || !from.length) return;

    var next;
    if (pts.length > 1 && from.length > 1) {
      // Two fingers: the distance between them is the zoom and their midpoint is
      // the pan, both read off the same two points so that a pinch which also
      // drifts does both at once, the way a hand does.
      var dFrom = Math.hypot(from[0].x - from[1].x, from[0].y - from[1].y);
      var dNow = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      var midFrom = { x: (from[0].x + from[1].x) / 2, y: (from[0].y + from[1].y) / 2 };
      var midNow = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      next = JS.viewZoomAt(gesture.view, midFrom.x, midFrom.y,
                           dFrom > 0 ? dNow / dFrom : 1);
      next = JS.viewPan(next, midNow.x - midFrom.x, midNow.y - midFrom.y);
    } else {
      // One finger is a pan of the page under the finger. At fit zoom this does
      // nothing at all — `viewClamp` has exactly one answer there — so a stray
      // touch on the preview cannot nudge an unzoomed page.
      next = JS.viewPan(gesture.view, pts[0].x - from[0].x, pts[0].y - from[0].y);
    }

    if (!previewFit) return;
    view = JS.viewClamp(next, previewFit);
    applyView();
  }

  function gestureUp(e) {
    if (!pointers[e.pointerId]) return;
    delete pointers[e.pointerId];
    if (livePoints().length) { rebaseGesture(); return; }
    gesture = null;
    settleView();
  }

  /* --------------------------------------------------------- manual crop */

  // Where the preview box sits inside the stage, as of the last render. The four
  // handles ride its corners, and the corners of that box are exactly where the
  // corners of the crop are drawn — the box *is* the crop — so this is the only
  // geometry the handles need, and it is also what `JS.viewClamp` keeps the page
  // from wandering out of. In the stage's client coordinates, which is what the
  // transform on `#stage-zoom` works in; `renderPreview` shifts it back out of
  // the reserved box to get there.
  var previewFit = null;

  // Live between a handle going down and coming up; null at rest.
  var cropDrag = null;

  /* The eight handles, clockwise from the top-left. Even indices are the
     corners, in the order the crop quad stores them (TL, TR, BR, BL); odd ones
     sit on the middle of a side, and the side between corner j and corner
     j + 1 is `HANDLES[2 * j + 1]`. Writing the fractions rather than deriving
     each x and y from comparisons is what lets the same table place the handle
     and work out which corners a drag on it moves. */
  var HANDLES = [
    { fx: 0,   fy: 0   },   // 0  corner, top-left
    { fx: 0.5, fy: 0   },   // 1  side, top
    { fx: 1,   fy: 0   },   // 2  corner, top-right
    { fx: 1,   fy: 0.5 },   // 3  side, right
    { fx: 1,   fy: 1   },   // 4  corner, bottom-right
    { fx: 0.5, fy: 1   },   // 5  side, bottom
    { fx: 0,   fy: 1   },   // 6  corner, bottom-left
    { fx: 0,   fy: 0.5 }    // 7  side, left
  ];

  function handleNodes() {
    var layer = JS.$('crop-layer');
    return layer && layer.children ? layer.children : [];
  }

  /** Put the handles on the corners and the middle of each side, or take them off. */
  function placeHandles(page, fit) {
    var layer = JS.$('crop-layer');
    if (!layer) return;
    var on = !!page && !!fit && app.view === 'edit';
    layer.classList.toggle('is-on', on);
    if (!on) return;
    var nodes = handleNodes();
    for (var i = 0; i < nodes.length && i < HANDLES.length; i++) {
      var h = HANDLES[i];
      nodes[i].setAttribute('transform',
        'translate(' + (fit.x + h.fx * fit.w) + ' ' + (fit.y + h.fy * fit.h) + ')');
    }
  }

  function startCropDrag(e, i) {
    var page = activePage();
    if (!page || app.view !== 'edit' || !previewFit || cropDrag) return;
    var h = HANDLES[i];
    if (!h) return;
    // The map from the page back to the photo, taken now and held for the whole
    // drag: it has to be the one the finger went down on, or the handle ends up
    // chasing its own output.
    var mapper = JS.cropMapper(page);
    if (!mapper) return;
    var f = previewFit;

    // Zoom onto the handle the finger has just taken hold of. Placing a dot
    // against a printed corner means seeing both, and at fit zoom on a phone a
    // receipt's corner detail is smaller than the dot covering it. The handle's
    // own position is the point to hold still — it is where the finger is — and
    // it is already zoomed past 2x by a pinch, this does not zoom back out.
    var at = JS.viewToScreen(view, f.x + h.fx * f.w, f.y + h.fy * f.h);
    var target = Math.min(JS.VIEW_MAX, Math.max(view.z, JS.CORNER_ZOOM));
    var zoomed = JS.viewClamp(JS.viewZoomAt(view, at.x, at.y, target / view.z), f);

    // An even index is corner `i / 2`; an odd one is the side from corner
    // `(i - 1) / 2` to the next one round, and both of those corners move.
    cropDrag = { page: page, handle: i, corner: (i % 2) ? -1 : i / 2,
                 side: (i % 2) ? (i - 1) / 2 : -1,
                 start: JS.getCorners(page).map(function (p) { return { x: p.x, y: p.y }; }),
                 anchor: (i % 2) ? mapper(h.fx, h.fy) : null,
                 mapper: mapper, fit: f, view: zoomed, back: view };
    // The view is frozen for the whole drag: a corner moving at twice the
    // finger's speed because the page under it is magnified is a crop you can
    // aim, and a view that chased the handle would be a map redrawn while it is
    // being used.
    view = zoomed;
    applyView();
    renderPreview(false);

    // Hold the frame at the shape it has now. The handle is on the corner of the
    // box, so a box that resized itself as the quad changed would take the
    // finger's own target with it.
    JS.cropPin = f.w / f.h;
    JS.releaseBuffers(page);
    var layer = JS.$('crop-layer');
    if (layer.setPointerCapture) layer.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function moveCropDrag(e) {
    if (!cropDrag) return;
    var layer = JS.$('crop-layer');
    if (!layer.getBoundingClientRect) return;
    var r = layer.getBoundingClientRect();
    var f = cropDrag.fit;
    // Where on the finished page the finger is, 0..1 across and down. Clamped
    // first, so the corner cannot leave the photo.
    //
    // The stage contents are under a transform, so the layer's own rect is the
    // *scaled* box and `clientX - r.left` is a screen distance. Dividing by the
    // zoom turns it back into the stage coordinates that `f` is measured in —
    // and it has to be the drag's own frozen zoom, not whatever the view is now,
    // because those are the numbers the drag's map was built from.
    var z = cropDrag.view.z;
    var u = JS.clamp(((e.clientX - r.left) / z - f.x) / f.w, 0, 1);
    var v = JS.clamp(((e.clientY - r.top) / z - f.y) / f.h, 0, 1);
    var q = cropDrag.mapper(u, v);
    if (!q) return;
    var page = cropDrag.page;
    var next;
    if (cropDrag.corner >= 0) {
      next = JS.getCorners(page).map(function (p) { return { x: p.x, y: p.y }; });
      next[cropDrag.corner] = q;
    } else {
      // A side handle moves its two corners together, by however far the finger
      // has travelled from where the side's midpoint started. Taking the corners
      // from the drag's own start — not from the page's current quad — is what
      // keeps the pair rigid: measured against a quad that the previous move
      // already shifted, the second corner would be given the delta twice and
      // the side would stretch away from the finger.
      var dx = q.x - cropDrag.anchor.x, dy = q.y - cropDrag.anchor.y;
      var a = cropDrag.side, b = (a + 1) % 4;
      // The finger is clamped to the photo, but the offset it produced is not:
      // the side it is dragging runs along the same edge, so pushing it *down*
      // the page also pushes its far end past the left or right of the picture.
      // Unclamped, that end leaves [0,1], `JS.quadOk` refuses the whole move and
      // the side simply will not budge — a handle that looks live and does
      // nothing. So the offset is trimmed to the most that keeps both corners on
      // the photo, which is the same "slide until it stops" a single corner gets.
      var mnx = Math.min(cropDrag.start[a].x, cropDrag.start[b].x);
      var mxx = Math.max(cropDrag.start[a].x, cropDrag.start[b].x);
      var mny = Math.min(cropDrag.start[a].y, cropDrag.start[b].y);
      var mxy = Math.max(cropDrag.start[a].y, cropDrag.start[b].y);
      dx = JS.clamp(dx, -mnx, 1 - mxx);
      dy = JS.clamp(dy, -mny, 1 - mxy);
      next = cropDrag.start.map(function (p) { return { x: p.x, y: p.y }; });
      next[a].x += dx; next[a].y += dy;
      next[b].x += dx; next[b].y += dy;
    }
    // Past its neighbour the quad crosses, and inside their triangle it folds
    // the page over itself; onto its neighbour it collapses to a sliver. All
    // three would render something that is not the crop the finger asked for,
    // so the last good quad stays and the corner stops there. See `JS.quadOk`.
    // For a side this is also what stops the edge being pushed out through the
    // far one and turning the page inside out.
    if (!JS.quadOk(next)) return;
    page.corners = next;
    JS.invalidate(page);
    scheduleRender(true);
  }

  function endCropDrag() {
    if (!cropDrag) return;
    var page = cropDrag.page;
    // Back to the view the corner was grabbed from. The zoom was a way of aiming
    // at one dot, and holding it after the dot has been placed would leave the
    // user looking at a corner with no idea how they got there — and with no
    // pinch they were going to try that gets them out.
    view = cropDrag.back;
    cropDrag = null;
    JS.cropPin = 0;
    page.touched = true;
    applyView();
    JS.invalidate(page);
    syncEditorChrome();
    renderPreview(true);
  }

  function scheduleRender(fast) {
    if (fast) renderFast = true;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      var f = renderFast;
      renderFast = false;
      renderPreview(false, f);
    });
  }
  JS.scheduleRender = scheduleRender;

  function renderPreview(force, fast) {
    var page = activePage();
    if (!page || app.view !== 'edit') return;

    var box = stageBox();
    if (box.w < 2 || box.h < 2) return;

    var scale = dpr();
    var maxDim = fast ? PREVIEW_FAST : PREVIEW_FULL;

    // The finished page — the same pixels the export writes. There is no other
    // thing this canvas is ever allowed to show.
    var src = JS.renderPage(page, maxDim);

    var fit = JS.fitBox(box.w, box.h, src.width, src.height);
    // Back into the stage's own coordinates. Centring inside the reserved box and
    // then shifting by the reservation is the same place the flexbox puts the
    // canvas — it centres whatever size the canvas ends up — so the box this
    // describes is still exactly the canvas on screen, which is what the handles
    // are drawn on.
    fit.x += box.pad;
    fit.y += box.pad;

    // The backing store grows with the zoom, so that pinching in shows the
    // page's own detail instead of a magnified copy of the fitted view — which
    // is the entire reason to pinch in, when the question being asked is whether
    // the small print came out legible.
    //
    // It stops at the page itself. Past that the canvas would be interpolating
    // its own interpolation, and since `src` is capped at PREVIEW_MAX the
    // ceiling costs a megabyte at most. The `scale` floor is what keeps an
    // unzoomed preview — and a page smaller than the box showing it — rendered
    // exactly as it was before any of this existed.
    var q = Math.max(scale, Math.min(scale * view.z,
                                      src.width / fit.w, src.height / fit.h));

    var prev = JS.$('preview');
    prev.style.width = fit.w + 'px';
    prev.style.height = fit.h + 'px';
    prev.width = Math.max(1, Math.round(fit.w * q));
    prev.height = Math.max(1, Math.round(fit.h * q));
    var g = JS.ctx2d(prev, true);
    g.setTransform(q, 0, 0, q, 0, 0);
    g.clearRect(0, 0, fit.w, fit.h);
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, fit.w, fit.h);

    renderedZ = view.z;

    previewFit = fit;
    placeHandles(page, fit);
  }
  JS.renderPreview = renderPreview;

  /* --------------------------------------------------------- page ingest */

  JS.addFiles = async function (fileList) {
    var files = Array.prototype.filter.call(fileList, function (f) {
      return f && f.type && f.type.indexOf('image/') === 0;
    });
    if (!files.length) return;

    showBusy('Loading ' + files.length + (files.length === 1 ? ' photo…' : ' photos…'));
    try {
      for (var i = 0; i < files.length; i++) {
        JS.$('busy-text').textContent = 'Loading ' + (i + 1) + ' of ' + files.length + '…';
        await JS.yieldToUI();
        try {
          var page = await decodeToPage(files[i]);
          if (page) app.pages.push(page);
        } catch (e) {
          console.warn('Skipped', files[i].name, e);
        }
      }
    } finally {
      hideBusy();
    }
    renderHome();
  };

  /**
   * Re-encode a canvas into a fresh blob-backed <img>.
   *
   * The URL is parked on the element rather than on the page because
   * `duplicatePage` shares one element between two pages, so whoever releases
   * it has to be able to ask who else is still holding on.
   */
  async function canvasToSource(canvas, quality) {
    var blob = await JS.canvasToBlob(canvas, 'image/jpeg', quality || 0.95);
    var url = URL.createObjectURL(blob);
    var img = new Image();
    await new Promise(function (resolve, reject) {
      img.onload = resolve;
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('re-encode failed')); };
      img.src = url;
    });
    if (img.decode) { try { await img.decode(); } catch (e) { /* already loaded */ } }
    img._url = url;
    return img;
  }

  /**
   * Drop the blob behind a page's source, unless another page still shares the
   * element. Duplicating a page shares it, so revoking on one page's behalf
   * would blank the other.
   */
  function releaseSource(page, keep) {
    var el = page.source;
    if (!el || !el._url || el === keep) return;
    var shared = app.pages.some(function (p) { return p !== page && p.source === el; });
    if (shared) return;
    URL.revokeObjectURL(el._url);
    el._url = null;
  }

  /**
   * Bake the current render into the page and forget the original.
   *
   * Afterwards the page's source *is* the cleaned image: rotation, crop,
   * de-skew and tone all live in the pixels. Everything downstream — the grid
   * thumbnail, the editor, the exported file — then shows the finished result
   * with no special casing, and re-opening a page no longer drops the user back
   * onto the raw photo with only an outline to suggest a crop is applied.
   *
   * The original is released, which is the point of "Done" here. The file in
   * the phone's gallery is untouched.
   */
  JS.commitPage = async function (page) {
    if (!page || JS.isCommitted(page)) return false;

    var mode = page.mode;
    var out = JS.renderPage(page, JS.WORK_MAX);
    var img = await canvasToSource(out, 0.95);

    releaseSource(page, img);
    page.source = img;
    page.w = out.width;
    page.h = out.height;

    // The effects are in the pixels now, so the state that produced them has to
    // go — leaving it would apply the whole lot a second time on the next
    // render. Neutral values plus `original` mode make the pipeline a no-op.
    page.coarse = 0;
    page.fine = 0;
    page.corners = null;
    page.mode = 'original';
    page.adj = Object.assign({}, JS.COMMITTED_ADJ);

    JS.forgetSource(page);
    page.bakedMode = mode;
    page._bakedKey = JS.stateKey(page);   // read *after* the reset
    page.touched = true;
    return true;
  };

  /** Decode a File into a downscaled, EXIF-corrected HTMLImageElement. */
  async function decodeToPage(file) {
    var src = null, w = 0, h = 0;

    if (window.createImageBitmap) {
      try {
        src = await createImageBitmap(file, { imageOrientation: 'from-image' });
        w = src.width; h = src.height;
      } catch (e) {
        src = null;   // older browsers: fall through to the <img> path
      }
    }
    if (!src) {
      src = await new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
        img.src = url;
      });
      w = src.naturalWidth || src.width;
      h = src.naturalHeight || src.height;
    }
    if (!w || !h) return null;

    // Normalise to a capped, upright canvas, then re-encode to a compact blob.
    // Keeping the result as a blob-backed <img> instead of a canvas lets the
    // browser evict decoded pixels under memory pressure.
    var long = Math.max(w, h);
    var s = Math.min(1, JS.WORK_MAX / long);
    var nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));

    var c = JS.makeCanvas(nw, nh);
    JS.ctx2d(c).drawImage(src, 0, 0, nw, nh);
    if (src.close) src.close();

    var img = await canvasToSource(c, 0.95);
    return JS.createPage(img, nw, nh, file.name || 'photo');
  }

  /* ------------------------------------------------------------- actions */

  /* Every one of these moves to a different page or turns the one it is on, so
     every one of them puts the view back to fit: a zoom is a place on a page,
     and the page it was a place on is gone. */
  JS.goPrev = function () {
    if (app.active > 0) { app.active--; resetView(); syncEditorChrome(); renderPreview(true); }
  };
  JS.goNext = function () {
    if (app.active < app.pages.length - 1) {
      app.active++; resetView(); syncEditorChrome(); renderPreview(true);
    }
  };

  JS.deletePage = function (index) {
    if (index < 0 || index >= app.pages.length) return;
    var gone = app.pages[index];
    app.pages.splice(index, 1);
    if (gone) releaseSource(gone, null);
    if (!app.pages.length) {
      app.active = -1;
      setView('home');
      return;
    }
    if (app.active >= app.pages.length) app.active = app.pages.length - 1;
    resetView();
    syncEditorChrome();
    renderPreview(true);
  };

  JS.duplicatePage = function (index) {
    var src = app.pages[index];
    if (!src) return;
    var copy = JS.createPage(src.source, src.w, src.h, src.name);
    copy.coarse = src.coarse;
    copy.fine = src.fine;
    copy.corners = src.corners ? JS.cloneQuad(src.corners) : null;
    copy.mode = src.mode;
    copy.modeTap = '';          // a copy starts with no chip of its own lit by hand
    copy.modeBack = null;
    copy.adj = Object.assign({}, src.adj);
    app.pages.splice(index + 1, 0, copy);
    app.active = index + 1;
    resetView();
    syncEditorChrome();
    renderPreview(true);
    hint('Page duplicated');
  };

  JS.applyToAll = function (index) {
    var src = app.pages[index];
    if (!src) return;
    var count = 0;
    app.pages.forEach(function (p) {
      if (p === src) return;
      p.mode = src.mode;
      // The chip's undo state is not a setting to copy: the target page has its
      // own history, and inheriting the source's would make a tap on a lit chip
      // restore a tone that page never had.
      p.modeTap = '';
      p.modeBack = null;
      p.adj = Object.assign({}, src.adj);
      JS.invalidate(p);
      count++;
    });
    hint('Clean-up settings applied to ' + count + ' other page' + (count === 1 ? '' : 's'));
    renderHome();
  };

  JS.rotateActive = function (dir) {
    var page = activePage();
    if (!page) return;
    JS.rotateCoarse(page, dir);
    resetView();
    syncEditorChrome();
    renderPreview(true);
  };

  // The adjust block with nothing applied. Eight keys, because that is what a
  // page carries — `bright` and `warmth` have no entry in MODE_DEFAULTS and
  // would be dropped by copying `MODE_DEFAULTS.original` wholesale.
  function zeroAdjust(page) {
    var d = JS.MODE_DEFAULTS.original;
    page.adj = {
      bright: 0, contrast: d.contrast, wb: d.wb, sat: d.sat,
      warmth: 0, flat: d.flat, thr: d.thr, sharp: d.sharp
    };
  }

  // Back to the photo as it came off the card: the crop, the fine angle, the 90°
  // rotation and the whole tone block. Reset tone below does the last of those
  // alone; this is the one control that undoes a rotation, so a page turned the
  // wrong way has a way back that is not turning it three more times.
  //
  // `_oriented` survives — it is keyed on the coarse angle and the buffer size —
  // so this is a re-render, not a re-decode. The page keeps its own mode rather
  // than returning to the `auto` a fresh import gets: "original" is what the
  // button says, and the tone sliders show zeros to match. No confirmation: it
  // is one tap in a panel group, it is asked for by name, and it costs a
  // re-render to reverse by hand.
  JS.undoAll = function () {
    var page = activePage();
    if (!page) return;
    page.coarse = 0;
    page.fine = 0;
    page.corners = null;
    page.mode = 'original';
    page.modeTap = '';
    page.modeBack = null;
    zeroAdjust(page);
    page.touched = false;
    JS.invalidate(page);
    resetView();
    syncEditorChrome();
    renderPreview(true);
    hint('Back to the original photo');
  };

  JS.resetAdjust = function () {
    var page = activePage();
    if (!page) return;
    page.mode = 'original';
    page.modeTap = '';
    page.modeBack = null;
    zeroAdjust(page);
    JS.invalidate(page);
    syncEditorChrome();
    renderPreview(true);
  };

  /* The tone keys a mode owns. Everything else in `adj` belongs to a slider:
     `bright` and `warmth` have no mode preset at all, and `sharp` is the
     Sharpen chip's step, which both a change of mode and an undo carry across
     rather than reset. This list is what makes "undo only Auto colour" literally
     true — the chip gives back exactly what it took and nothing else. */
  var MODE_KEYS = ['flat', 'thr', 'contrast', 'wb', 'sat'];

  /* Tapping the chip you are already on takes it back off: the tone goes back to
     whatever it was before that chip was applied, which is usually another mode
     (Receipt, if Auto all picked it) and is Original when there was nothing
     there. Crop, rotation and the sharpen step are all untouched.

     Only a *tap* can be undone by a tap. A fresh import opens in Auto colour
     without anyone having tapped anything, and so does a page Auto all cleaned,
     so `modeTap` records which chip the user actually turned on — otherwise a
     page's own starting look would read as "already on, tap to remove" and the
     first tap on Auto colour would strip the look instead of applying it. */
  JS.setMode = function (mode) {
    var page = activePage();
    if (!page) return;
    var d = JS.MODE_DEFAULTS[mode];
    if (!d) return;
    // The sharpen step is carried across the change rather than reset by it.
    // The two chips sit in the same row, and a mode is not a reason to throw
    // away a rescue: sharpening a blurry page and then switching it to Black &
    // white to make the text crisp is the obvious order to do those two things
    // in, and it used to silently drop the sharpening on the second tap. Auto
    // clean still resets it, because that button's whole contract is "make this
    // page look the way the preset says".
    var kept = JS.sharpenLevel(page);

    if (page.modeTap === mode) {
      var back = page.modeBack;
      page.mode = back ? back.mode : 'original';
      var src = back || JS.MODE_DEFAULTS.original;
      for (var k = 0; k < MODE_KEYS.length; k++) page.adj[MODE_KEYS[k]] = src[MODE_KEYS[k]];
      var off = JS.MODE_DEFAULTS[page.mode] || JS.MODE_DEFAULTS.original;
      page.adj.sharp = kept > 0 ? JS.SHARP_LEVELS[kept - 1] : off.sharp;
      page.modeTap = '';
      page.modeBack = null;
      JS.invalidate(page);
      syncEditorChrome();
      renderPreview(true);
      hint(JS.MODE_LABELS[mode] + ' off · back to ' +
           (JS.MODE_LABELS[page.mode] || page.mode));
      return;
    }

    // What this chip is about to replace, kept so that tapping it again can put
    // it back. A slider the user moved *after* the chip was applied is not in
    // here, because the chip did not set it and must not take it away.
    page.modeBack = { mode: page.mode, flat: page.adj.flat, thr: page.adj.thr,
                      contrast: page.adj.contrast, wb: page.adj.wb, sat: page.adj.sat };
    page.modeTap = mode;
    page.mode = mode;
    page.adj.flat = d.flat;
    page.adj.thr = d.thr;
    page.adj.sharp = kept > 0 ? JS.SHARP_LEVELS[kept - 1] : d.sharp;
    if (mode !== 'original') {
      page.adj.contrast = d.contrast;
      page.adj.wb = d.wb;
      page.adj.sat = d.sat;
    }
    JS.invalidate(page);
    syncEditorChrome();
    renderPreview(true);
  };

  JS.runAutoDetect = async function () {
    var page = activePage();
    if (!page) return;
    showBusy('Finding the page…');
    await JS.yieldToUI();
    try {
      var res = await JS.autoDetect(page);
      resetView();
      syncEditorChrome();
      renderPreview(true);
      hint(res.found
        ? 'Edges found · tilt corrected ' + res.skew.toFixed(1) + '°'
        : 'No clear page edge found — rotate 90° and try again');
    } finally {
      hideBusy();
    }
  };

  JS.runAutoAll = async function () {
    var page = activePage();
    if (!page) return;
    showBusy('Detecting and cleaning…');
    await JS.yieldToUI();
    try {
      var res = await JS.autoAll(page);
      resetView();
      syncEditorChrome();
      renderPreview(true);
      /* The mode is named only when there is no crop to report. Auto all no
         longer chooses the mode, so on a page it cropped the lit chip above is
         already saying which look it applied and repeating it here is noise.
         The no-edge case is the other way round: it has to say what *did*
         happen in place of the crop, and "cleaned" without a look is not an
         answer to that. */
      var look = JS.MODE_LABELS[res.mode] || res.mode;
      hint(res.found
        ? 'Cropped · tilt ' + res.skew.toFixed(1) + '°'
        : 'No clear page edge — cleaned as ' + look);
    } finally {
      hideBusy();
    }
  };

  /* Auto clean on a page that is still in Original has to pick a mode, because
     "clean it" names no way of doing so. It used to pick Auto colour outright,
     which made the two one-tap buttons disagree: on a receipt, Auto all reads
     the shape and lands in Receipt while Auto clean landed in Auto colour, and
     the two modes do not treat a cast shadow the same way. Asking the same
     question Auto all asks costs one cached canvas and removes the last way the
     two buttons can differ. What is left is the crop, which is the whole of
     what Auto all does that Auto clean does not.

     The shape it reads is the page as it stands, so on a photo the user has not
     cropped yet it is the *frame* being measured. That is deliberate and it is
     why this asks about Original alone: Auto all measures a receipt because it
     has just cropped to one, and Auto clean, which does not crop, would be
     guessing from a frame that still has the table in it. */
  JS.runMagic = function () {
    var page = activePage();
    if (!page) return;
    if (page.mode === 'original') page.mode = JS.suggestMode(page);
    JS.autoEnhance(page);
    syncEditorChrome();
    renderPreview(true);
    hint('Auto clean applied · ' + (JS.MODE_LABELS[page.mode] || page.mode));
  };

  /* --------------------------------------------------------- export flow */

  JS.exportSummary = function () {
    var n = app.pages.length;
    var fmt = app.fmt === 'pdf' ? 'PDF' : app.fmt.toUpperCase();
    return n + (n === 1 ? ' page' : ' pages') + ' · ' + fmt + ' · up to ' + app.maxDim + ' px';
  };

  /* The size estimate is deliberately not part of exportSummary(): that is a
     pure synchronous string built at boot, before anything can be rendered.
     This adds the size to it when one is known, and is the only thing that
     knows an estimate exists — JS.buildExport has no idea, so a slow or failed
     estimate cannot touch an export. */
  var estGen = 0;
  var estTimer = 0;

  /** Abandon any estimate in flight, so a closed sheet is not still encoding. */
  function cancelEstimate() {
    estGen++;
    if (estTimer) { clearTimeout(estTimer); estTimer = 0; }
  }

  /**
   * Show the summary line, and start measuring a size for it.
   *
   * Debounced, because it is wired to two sliders that fire on every pixel of a
   * drag and each estimate encodes real pages. A generation counter stands in
   * for cancellation: moving a slider again makes the run in flight's generation
   * stale, so its answer is dropped when it lands and it stops after the page it
   * is on. The line says `measuring…` in the meantime rather than showing a
   * figure that belongs to the previous quality.
   */
  JS.refreshExportSummary = function (immediate) {
    var box = JS.$('export-summary');
    var line = JS.exportSummary();
    var gen = ++estGen;
    if (estTimer) { clearTimeout(estTimer); estTimer = 0; }

    if (!app.pages.length) { box.textContent = line; return; }
    box.textContent = line + ' · measuring…';

    var run = function () {
      estTimer = 0;
      if (gen !== estGen) return;
      var opts = { format: app.fmt, quality: app.quality, maxDim: app.maxDim };
      JS.estimateExportBytes(app.pages, opts, function () { return gen !== estGen; })
        .then(function (est) {
          if (gen !== estGen || !est) return;
          box.textContent = line + ' · ≈ ' + JS.fmtBytes(est.bytes);
        })
        .catch(function (e) {
          // A failed estimate is not a failed export. Fall back to the line
          // without a size and say nothing — the sheet still works.
          console.warn('size estimate failed', e);
          if (gen === estGen) box.textContent = line;
        });
    };

    if (immediate) run();
    else estTimer = setTimeout(run, 150);
  };

  JS.doExport = async function (viaShare) {
    if (!app.pages.length) return;
    var opts = { format: app.fmt, quality: app.quality, maxDim: app.maxDim };
    closeSheet('sheet-export');
    showBusy('Rendering page 1 of ' + app.pages.length + '…');
    try {
      var files = await JS.buildExport(app.pages, opts, function (done, total) {
        JS.$('busy-text').textContent = 'Rendering page ' + done + ' of ' + total + '…';
      });
      JS.$('busy-text').textContent = 'Saving…';
      await JS.yieldToUI();

      if (viaShare && JS.canShareFiles(files)) {
        await JS.shareFiles(files);
      } else {
        await JS.downloadFiles(files);
        if (files.length > 1) {
          hint('Saved ' + files.length + ' files to your downloads', 4000);
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') {
        // User dismissed the share sheet; not an error.
      } else {
        console.error(e);
        alert('Export failed: ' + (e && e.message ? e.message : e));
      }
    } finally {
      // Export leaves a full-resolution buffer per page behind; drop them.
      app.pages.forEach(JS.releaseBuffers);
      hideBusy();
    }
  };

  /* --------------------------------------------------------------- wiring */

  JS.wire = function () {
    var gallery = JS.$('file-gallery');
    var camera = JS.$('file-camera');

    JS.$('btn-add').addEventListener('click', function () { gallery.click(); });
    JS.$('btn-camera').addEventListener('click', function () { camera.click(); });

    function onPick(ev) {
      var files = ev.target.files;
      if (files && files.length) JS.addFiles(files);
      ev.target.value = '';
    }
    gallery.addEventListener('change', onPick);
    camera.addEventListener('change', onPick);

    JS.$('btn-help').addEventListener('click', function () { openSheet('sheet-help'); });
    JS.$('btn-back').addEventListener('click', function () { setView('home'); });
    // "Done" finishes a page: the render is baked into it and the original is
    // dropped, so the grid, the editor and the export all show the cleaned
    // result rather than the raw photo.
    JS.$('btn-save').addEventListener('click', async function () {
      var page = activePage();
      var btn = JS.$('btn-save');
      if (btn.disabled) return;               // a slow phone invites double taps
      btn.disabled = true;
      try {
        if (page && !JS.isCommitted(page)) {
          showBusy('Finishing…');
          await JS.yieldToUI();
          await JS.commitPage(page);
        }
      } catch (e) {
        console.warn('commit failed', e);
        hint('Could not finish this page');
      } finally {
        hideBusy();
        btn.disabled = false;
      }
      setView('home');
    });

    JS.$('btn-clear').addEventListener('click', function () {
      if (!app.pages.length) return;
      if (confirm('Remove all ' + app.pages.length + ' pages?')) {
        app.pages.forEach(function (p) { releaseSource(p, null); });
        app.pages = [];
        app.active = -1;
        renderHome();
      }
    });

    JS.$('btn-export').addEventListener('click', function () {
      JS.refreshExportSummary(true);          // the sheet is opening: measure now
      JS.$('btn-share').hidden = !navigator.share;
      openSheet('sheet-export');
    });
    JS.$('btn-download').addEventListener('click', function () { JS.doExport(false); });
    JS.$('btn-share').addEventListener('click', function () { JS.doExport(true); });

    // Sheets close on backdrop tap or any [data-close-sheet] element.
    Array.prototype.forEach.call(document.querySelectorAll('[data-close-sheet]'), function (el) {
      el.addEventListener('click', function () {
        var sheet = el.closest('.sheet');
        if (sheet) sheet.hidden = true;
        cancelEstimate();
      });
    });

    // Format chips.
    Array.prototype.forEach.call(JS.$('fmt-chips').children, function (chip) {
      chip.addEventListener('click', function () {
        app.fmt = chip.dataset.fmt;
        Array.prototype.forEach.call(JS.$('fmt-chips').children, function (c) {
          c.classList.toggle('is-active', c === chip);
        });
        JS.$('quality-row').style.display = app.fmt === 'png' ? 'none' : '';
        JS.refreshExportSummary();
      });
    });

    JS.$('in-quality').addEventListener('input', function (e) {
      app.quality = Number(e.target.value) / 100;
      JS.$('val-quality').textContent = e.target.value + '%';
      JS.refreshExportSummary();
    });
    JS.$('in-maxdim').addEventListener('input', function (e) {
      app.maxDim = Number(e.target.value);
      JS.$('val-maxdim').textContent = e.target.value + ' px';
      JS.refreshExportSummary();
    });

    JS.$('btn-prev').addEventListener('click', JS.goPrev);
    JS.$('btn-next').addEventListener('click', JS.goNext);

    JS.$('btn-auto').addEventListener('click', JS.runAutoDetect);
    JS.$('btn-all').addEventListener('click', JS.runAutoAll);
    JS.$('btn-undo-all').addEventListener('click', JS.undoAll);

    JS.$('btn-rot-l').addEventListener('click', function () { JS.rotateActive(-1); });
    JS.$('btn-rot-r').addEventListener('click', function () { JS.rotateActive(1); });

    // The crop handles. Each corner owns its own pointerdown, so which handle was
    // grabbed needs no hit-testing; the moves come back to the layer because the
    // drag captures the pointer there, which is also what lets a finger leave the
    // stage — or the window — mid-drag and still land the corner it was on.
    var cropLayer = JS.$('crop-layer');
    Array.prototype.forEach.call(handleNodes(), function (node, k) {
      node.addEventListener('pointerdown', function (e) { startCropDrag(e, k); });
    });
    cropLayer.addEventListener('pointermove', moveCropDrag);
    cropLayer.addEventListener('pointerup', endCropDrag);
    cropLayer.addEventListener('pointercancel', endCropDrag);

    /* Pinch and pan, on the stage underneath the handles.
       `pointerdown` here is what claims a gesture: a finger that landed on a
       crop handle is already being tracked by that handle, and one that landed
       while a corner is being dragged is not a second gesture but the same hand
       still holding still. The moves come back on `window` rather than the stage
       so that a finger leaving the stage mid-pinch keeps zooming, and so that
       nothing needs pointer capture — which the crop handles are already using
       for pointers of their own. */
    JS.$('stage').addEventListener('pointerdown', function (e) {
      if (app.view !== 'edit' || cropDrag) return;
      if (e.target.closest && e.target.closest('.crop-handle')) return;
      pointers[e.pointerId] = stagePoint(e);
      rebaseGesture();
      e.preventDefault();
    });
    window.addEventListener('pointermove', function (e) {
      if (!pointers[e.pointerId]) return;
      pointers[e.pointerId] = stagePoint(e);
      gestureMove();
    });
    window.addEventListener('pointerup', gestureUp);
    window.addEventListener('pointercancel', gestureUp);

    /* The Custom chip is the drawer's only handle, so it carries the state as
       well as setting it: `is-active` for the eye — the same pill a lit mode chip
       wears, because "these sliders are open" is the same kind of fact as "this
       mode is on" — and `aria-expanded` for anyone not looking at the pill.
       Opening it makes the panel taller and the stage shorter, so the preview
       has to be refitted: the drawer is between two rows the layout measures. */
    JS.$('chip-custom').addEventListener('click', function () {
      var open = JS.$('tune').hidden;
      JS.$('tune').hidden = !open;
      this.classList.toggle('is-active', open);
      this.setAttribute('aria-expanded', open ? 'true' : 'false');
      renderPreview(true);
    });

    JS.$('in-fine').addEventListener('input', function (e) {
      var page = activePage();
      if (!page) return;
      page.fine = Number(e.target.value);
      JS.$('val-fine').textContent = page.fine.toFixed(1) + '°';
      JS.invalidate(page);
      scheduleRender(true);
    });
    JS.$('in-fine').addEventListener('change', function () { renderPreview(true); });

    JS.$('btn-magic').addEventListener('click', JS.runMagic);
    JS.$('btn-reset-adj').addEventListener('click', JS.resetAdjust);

    Array.prototype.forEach.call(JS.$('mode-chips').children, function (chip) {
      if (!chip.dataset.mode) return;      // Sharpen is wired on its own, below
      chip.addEventListener('click', function () { JS.setMode(chip.dataset.mode); });
    });

    // Sharpen cycles off -> ×1 -> ×2 -> ×3 -> off, and "off" is the sharpness
    // the current mode asks for rather than zero, so the fourth tap is an undo.
    // It is deliberately not routed through setMode: the mode chips are
    // single-select and this one is a step counter, and a page can be
    // Black & white *and* sharpened.
    JS.$('chip-sharpen').addEventListener('click', function () {
      var page = activePage();
      if (!page) return;
      var level = JS.cycleSharpen(page);
      JS.invalidate(page);
      syncEditorChrome();
      renderPreview(true);
      hint(SHARP_LABELS[level]);
    });

    // Adjustment sliders: fast preview while dragging, full quality on release.
    [
      ['in-bright', 'bright', 'val-bright', function (v) { return String(v); }],
      ['in-contrast', 'contrast', 'val-contrast', function (v) { return String(v); }],
      ['in-wb', 'wb', 'val-wb', function (v) { return v + '%'; }],
      ['in-sat', 'sat', 'val-sat', function (v) { return String(v); }],
      ['in-warmth', 'warmth', 'val-warmth', function (v) { return String(v); }],
      ['in-flat', 'flat', 'val-flat', function (v) { return v + '%'; }],
      ['in-thr', 'thr', 'val-thr', function (v) { return String(v); }],
      ['in-sharp', 'sharp', 'val-sharp', function (v) { return String(v); }]
    ].forEach(function (spec) {
      var el = JS.$(spec[0]);
      el.addEventListener('input', function (e) {
        var page = activePage();
        if (!page) return;
        var v = Number(e.target.value);
        page.adj[spec[1]] = v;
        JS.$(spec[2]).textContent = spec[3](v);
        scheduleRender(true);
      });
      el.addEventListener('change', function () { renderPreview(true); });
    });

    // Home grid: tap to open, × to delete.
    JS.$('page-grid').addEventListener('click', function (ev) {
      var del = ev.target.closest('[data-role="del"]');
      var thumb = ev.target.closest('.thumb');
      if (!thumb) return;
      var idx = Number(thumb.dataset.index);
      if (del) {
        ev.stopPropagation();
        JS.deletePage(idx);
        renderHome();
        return;
      }
      openEditor(idx);
    });

    // Page menu.
    JS.$('btn-page-menu').addEventListener('click', function () { openSheet('sheet-menu'); });
    JS.$('sheet-menu').addEventListener('click', function (ev) {
      var item = ev.target.closest('.menu-item');
      if (!item) return;
      var act = item.dataset.act;
      closeSheet('sheet-menu');
      if (act === 'rotate-l') JS.rotateActive(-1);
      else if (act === 'rotate-r') JS.rotateActive(1);
      else if (act === 'duplicate') JS.duplicatePage(app.active);
      else if (act === 'apply-all') JS.applyToAll(app.active);
      else if (act === 'delete') {
        var idx = app.active;
        JS.deletePage(idx);
        if (app.pages.length) renderHome();
      }
    });

    // Re-render on viewport changes (rotation, keyboard, address bar). The view
    // resets with the box it was measured in: its translation is in pixels of a
    // stage that has just changed size, and the fit box it was clamped against
    // is a different box now.
    var rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () {
        if (app.view === 'edit') { resetView(); renderPreview(true); }
      }, 120);
    });
    window.addEventListener('orientationchange', function () {
      setTimeout(function () {
        if (app.view === 'edit') { resetView(); renderPreview(true); }
      }, 250);
    });

    // Warn before losing unsaved pages.
    window.addEventListener('beforeunload', function (e) {
      if (!app.pages.length) return;
      e.preventDefault();
      e.returnValue = '';
    });
  };

})(window.JS);
