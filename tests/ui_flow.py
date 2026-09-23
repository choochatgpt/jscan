"""tests/ui_flow.py — drives the real page in a real browser.

smoke.js checks the pixel maths against a hand-written canvas stub, and
commit_flow.js checks the state machine headless. Neither can tell you whether
the editor is laid out the way it is supposed to be, whether the stage really
shows the cropped page rather than the photo, or whether the shadow removal
survives a trip through Chromium's canvas rather than the stub's.

So this loads index.html from file:// exactly as the phone would, feeds it
synthetic photographs, and drives the controls.

The two checks that matter most are the ones no other test can make. The stage
aspect is read back from the DOM and compared against the aspect the crop
geometry implies — derived independently, so the preview cannot pass by simply
being right about itself. And shadow removal is measured with a real
getImageData over the rendered page.

Run:  python tests/ui_flow.py
"""

import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TMP = os.path.join(HERE, "tmp")
FIXTURES = os.path.join(HERE, "fixtures")
# The root page by default. `JSCANNER_PAGE` points the whole suite at another
# copy of the app — after `node tools/build.mjs`, at `dist/index.html`, which is
# what ships and what a static host serves. Nothing else changes: the fixtures
# and the falsifier source are read from the project either way, so the dist run
# is only meaningful straight after a build, while the two trees are identical.
PAGE_URL = os.environ.get("JSCANNER_PAGE") or (
    "file:///" + os.path.join(ROOT, "index.html").replace("\\", "/"))

# Two synthetic photos.
#
# The first is a portrait frame with a white page on a dark desk and a soft
# shadow lying across the left of the page — the case shadow removal is for, and
# one the crop and aspect assertions can be reasoned about exactly because the
# page is axis-aligned.
IMG_W, IMG_H = 900, 1200
PAGE = (120, 150, 780, 1050)          # x0, y0, x1, y1 of the sheet of paper
SHADOW_X = (120, 380)                 # the shadow covers this band of the page

# The second is the case the user reported: the page fills the frame side to
# side and runs off the top, so the only edge left to find is the one at the
# bottom, where the paper ends and the floor begins. Auto-detect has to keep the
# full width and the top and move only that one edge.
FULL_PAGE_BOTTOM = 900                # the sheet runs off the left, right and top
FULL_PAGE_FRAC = FULL_PAGE_BOTTOM / float(IMG_H)

# The third is the case shadow removal was reported broken on: a narrow thermal
# receipt with a soft shadow cast across its left third, which is what the phone
# in your hand does to the paper it is photographing. Narrow matters — the
# flattening takes its blur radius from the longer side, so a 1:5 strip gets a
# different window than the 3:4 page above, and the dense thermal print makes the
# local mean a worse estimate of the paper than letterpress text would.
RECEIPT = (340, 90, 560, 1150)        # x0, y0, x1, y1 of the paper strip
RECEIPT_FULL = 400                    # the shadow is unbroken up to here
RECEIPT_CLEAR = 500                   # and gone by here

# The fourth is the photo the user reported: a pale receipt held between finger
# and thumb over a pale marble counter, where the frame's border is the hand on
# one side and the counter on the other and neither is the background. There is
# no crop to find here, and the app has to say so rather than crop the hand.
MIX_JOIN = 380                        # where the hand ends and the counter starts
MIX_RECEIPT = (330, 90, 560, 1150)

# The residual shadow Auto clean is allowed to leave, measured as the gap in
# *paper level* between the receipt's two halves.
#
# Paper level, not mean. The fixture's thermal bars stop short of the paper's
# right edge, so the right-hand band is blank while the left-hand band is
# printed: a mean over each band reports ink coverage as though it were shadow,
# and it plateaus around 50 no matter how hard the flattening is pushed. That
# number is an artefact of the fixture and says nothing about the shadow.
#
# The 90th percentile of a band is the paper, ink or no ink. Measured that way
# the pre-fix default (45) leaves a gap of 62 and the current one (85) leaves 0,
# so the threshold below sits between them and the check can actually fail.
SHADOW_GAP_MAX = 15


def make_photo(path):
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (IMG_W, IMG_H), (58, 60, 64))
    d = ImageDraw.Draw(img)
    d.rectangle(PAGE, fill=(248, 246, 240))

    # Text lines, so the page is a document rather than a blank rectangle.
    y = PAGE[1] + 70
    for i in range(14):
        w = 480 if i % 5 else 300
        d.rectangle([PAGE[0] + 55, y, PAGE[0] + 55 + w, y + 11], fill=(40, 40, 44))
        y += 52

    # The shadow: a soft-edged dark band over the left of the page, the shape a
    # hand or the phone itself casts.
    px = img.load()
    x0, x1 = SHADOW_X
    fall = 70.0
    for x in range(PAGE[0], PAGE[2]):
        if x <= x0:
            k = 0.42
        elif x >= x1:
            k = 1.0
        else:
            k = 0.42 + 0.58 * ((x - x0) / float(x1 - x0))
        for y in range(PAGE[1], PAGE[3]):
            r, g, b = px[x, y]
            px[x, y] = (int(r * k), int(g * k), int(b * k))
    # Round the band's right edge so the blur has a gradient to work on rather
    # than a cliff the box filter would just shift.
    for x in range(x1, min(x1 + int(fall), PAGE[2])):
        k = 1.0 - 0.58 * (1.0 - (x - x1) / fall)
        for y in range(PAGE[1], PAGE[3]):
            r, g, b = px[x, y]
            px[x, y] = (int(r * k), int(g * k), int(b * k))

    img.save(path, "JPEG", quality=94)
    return path


def make_full_frame_photo(path):
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (IMG_W, IMG_H), (240, 238, 232))
    d = ImageDraw.Draw(img)
    px = img.load()

    # Background below the sheet: a gradient, not one tone. A real floor is lit
    # unevenly, and that is what puts the frame's average in the middle rather
    # than at either end — which is what decides whether the detector reads the
    # sheet as the bright side or the floor as it.
    for y in range(FULL_PAGE_BOTTOM, IMG_H):
        t = (y - FULL_PAGE_BOTTOM) / float(IMG_H - FULL_PAGE_BOTTOM)
        v = 196 * (1 - t) + 38 * t
        # The shadow the sheet casts on the floor right under its edge. Without
        # it the floor's top is as bright as the paper and there is genuinely no
        # boundary there to find — a real limit of the method, not this case.
        if y < FULL_PAGE_BOTTOM + 40:
            v *= 0.18 + 0.82 * ((y - FULL_PAGE_BOTTOM) / 40.0)
        v = int(v)
        for x in range(IMG_W):
            px[x, y] = (v, int(v * 0.97), int(v * 0.92))

    # The corner of the sheet in shadow, joined to the outside of it.
    for y in range(200):
        for x in range(max(0, 160 - int(y * 0.8))):
            px[x, y] = (62, 60, 66)

    # Text, so the sheet is a document and not a blank rectangle. Dense enough
    # that the rims of the glyphs outnumber the sheet's own edge — which is the
    # whole point: that ratio is what broke the fit.
    y = 120
    for i in range(22):
        w = 640 if i % 6 else 380
        d.rectangle([150, y, 150 + w, y + 13], fill=(38, 38, 44))
        y += 34

    # The shading every close-up phone photo has along the edges facing away
    # from the light.
    for y in range(IMG_H):
        fy = 1.0 if y >= 55 else 0.42 + 0.58 * (y / 55.0)
        for x in range(IMG_W):
            fx = 1.0 if x >= 40 else 0.46 + 0.54 * (x / 40.0)
            f = fy * fx
            r, g, b = px[x, y]
            px[x, y] = (int(r * f), int(g * f), int(b * f))

    img.save(path, "JPEG", quality=94)
    return path


def make_receipt_photo(path):
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (IMG_W, IMG_H), (58, 60, 64))
    d = ImageDraw.Draw(img)
    d.rectangle(RECEIPT, fill=(250, 248, 242))

    # Thermal print: short dense lines at a tight pitch, which is what makes the
    # local mean sit well below the paper it is supposed to be estimating.
    y = RECEIPT[1] + 45
    i = 0
    while y < RECEIPT[3] - 60:
        w = 150 if i % 4 else 96
        d.rectangle([RECEIPT[0] + 20, y, RECEIPT[0] + 20 + w, y + 9], fill=(48, 48, 52))
        y += 26
        i += 1

    # The shadow: unbroken across the left of the strip, then a soft ramp back to
    # full light, so the box filter has a gradient to follow rather than a cliff
    # it would only shift.
    px = img.load()
    for x in range(RECEIPT[0], RECEIPT[2]):
        if x <= RECEIPT_FULL:
            k = 0.42
        elif x >= RECEIPT_CLEAR:
            k = 1.0
        else:
            k = 0.42 + 0.58 * ((x - RECEIPT_FULL) / float(RECEIPT_CLEAR - RECEIPT_FULL))
        for y in range(RECEIPT[1], RECEIPT[3]):
            r, g, b = px[x, y]
            px[x, y] = (int(r * k), int(g * k), int(b * k))

    img.save(path, "JPEG", quality=94)
    return path


def detector_without_guards():
    """js/20-detect.js as it was before the guards, for use as a falsifier.

    The checks below say the app now declines this frame. That is only worth
    something if the app used to do otherwise, and the only honest way to show
    it is to put the old code back in the page and ask. The cuts are literal
    source text, so an edit that renames or reflows one of them fails here
    loudly instead of leaving a check that quietly proves nothing.

    All of them come out together. A frame refused by the broad-peak guard is
    refused just as firmly as one caught by the edge-of-scan guard, so leaving
    either in place would make "the old detector did otherwise" false for
    whichever frames that one guard happens to catch.
    """
    return _cut_detect(GUARD_CUTS + [OLD_PICK_CUT])


# The guards, as literal source text: an edit that renames or reflows one of
# them fails loudly instead of leaving a check that quietly proves nothing.
GUARD_CUTS = [
    (r"\n    if \(Math\.abs\(bg - thr\) < delta && bgSd >= delta\) \{", "\n    if (false && Math.abs(bg - thr) < delta && bgSd >= delta) {"),
    (r"\n    if \(best === -LIMIT \|\| best === LIMIT\) return 0;\n", "\n"),
    (r"\n    if \(minScore > bestScore \* 0\.25\) return 0;\n", "\n"),
    (r"\n    var centre = best;\n", "\n"),
    (r"for \(a = centre - 1; a <= centre \+ 1", "for (a = best - 1; a <= best + 1"),
    # refineOnce: the frame's own border pixels go into the edge fits. Without
    # the tally no side can be inherited either, so the fit refuses exactly
    # where it used to.
    (r"\n      if \(onFrame\(p, w, h\)\) \{ onBorder\[best\]\+\+; continue; \}\n", "\n"),
    (r"        if \(\(buckets\[i\]\.length && !crossing\) \|\| !onBorder\[i\] \|\| \+\+border > 1\) return null;\n"
     r"        lines\.push\(lineThrough\(q\[i\], q\[\(i \+ 1\) % 4\]\)\);\n"
     r"        continue;\n", "        return null;\n"),
    # quadFromEdges: a hull pinned to the photo's corners is accepted as the page.
    (r"\n    if \(fromHull && !fitted\) \{\n"
     r"      for \(var k = 0; k < 4; k\+\+\) if \(onFrame\(q\[k\], w, h\)\) return null;\n"
     r"    \}\n", "\n"),
]

# And the second threshold, which is not a guard but a whole second candidate:
# before 1.7.0 the crop was the frame-split one and nothing could displace it.
# Cutting the pick is what makes the reconstruction the *old crop* rather than
# the old guards with a new crop underneath them — without it the falsifiers
# below would be handed the very crop they exist to show was not there.
OLD_PICK_CUT = (
    r"var pick = strict && scoreStrict > scoreLoose \+ SWITCH_MARGIN \? strict : loose;",
    r"var pick = loose;")

# The two halves of the 1.7.6 receipt work, each as the smallest edit that takes
# exactly one of them back out, so each can be used as a falsifier for the check
# it is the subject of.
#
# The first: a mixed-background side is asked whether the two probes differ at
# all rather than which of them is brighter. On pair61 the receipt's left edge
# has the paper on the darker side of it for part of its length, so the signed
# count collapses and the side was discarded -- which is why the photo came back
# as "no clear page edge found".
MIXED_COV_CUT = (
    r"\(L\[li\]\.far>=3 && R\[ri\]\.s>=15 && R\[ri\]\.covm>=0\.68\) \|\|\n"
    r"        \(R\[ri\]\.far>=3 && L\[li\]\.s>=15 && L\[li\]\.covm>=0\.68\)\);",
    r"(L[li].far>=3 && R[ri].s>=15 && R[ri].cov>=0.68) ||\n"
    r"        (R[ri].far>=3 && L[li].s>=15 && L[li].cov>=0.68));")
# The second: the left-side refine also accepts a *shear repair* -- a pick whose
# two left corners disagree by most of a tenth of the width, where the area must
# grow because un-shearing re-adds the wedge the shear had cut, so the area and
# whole-quad gates of the small-nudge path cannot judge it. pair62 is that photo.
SHEAR_CUT = (
    r"var sheared=moveOK && othersOK &&",
    r"var sheared=false && moveOK && othersOK &&")

# 1.7.6 briefly added a third displacer -- the independent edge opinion allowed
# to be the answer outright. It is not here, and there is no cut for it, because
# it was measured and dropped: over the whole corpus the pick outscores the
# opinion on every photo but one, and on that one (pair62) the opinion's geometry
# cuts the receipt's last lines. The two cuts above are the whole of what stands
# between the current detector and the old guards.


def _cut_detect(cuts):
    src = open(os.path.join(ROOT, "js", "20-detect.js"), encoding="utf-8").read()
    for pattern, to in cuts:
        src, n = re.subn(pattern, to, src)
        if n != 1:
            raise AssertionError("20-detect.js no longer contains %r (%d matches)"
                                 % (pattern, n))
    return src


# How much of the screen the editor gives the page, and where the buttons are.
#
# Every one of these is a number in a stylesheet, so no other suite in this
# project can see any of it: smoke.js has no layout, commit_flow.js has no
# viewport, and dom_check.js only asks whether an id exists. The editor is a
# fixed column — topbar, stage, panel, footer — where the stage is whatever the
# others leave, so "how big is the page" is decided entirely by the cap on the
# panel below it. That is the number the user reported as a quarter of the
# screen and could not reach the buttons past.
LAYOUT_JS = """() => {
    const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, left: b.left, right: b.right,
                 w: b.width, h: b.height };
    };
    const vh = window.innerHeight, vw = window.innerWidth;
    const fits = (b) => !!b && b.top >= -0.5 && b.bottom <= vh + 0.5
                          && b.left >= -0.5 && b.right <= vw + 0.5;
    const view = document.querySelector('.view.is-active');
    const stage = box('#stage'), pv = box('#preview'), magic = box('#btn-magic');
    const panel = document.getElementById('panel'), pbox = box('#panel');
    // A closed `<details>` keeps its subtree *laid out but unpainted* in
    // Chromium: real rects, and nothing in scrollHeight. Those are not controls
    // anyone can see, so they are not controls this asks about — the question
    // here is whether the editor's visible face fits, not whether a drawer's
    // contents do. The drawer is a `[hidden]` div now and takes its subtree all
    // the way out of layout, so the two cases are caught differently: no rects
    // at all, or rects inside a closed `<details>`.
    const ctrls = Array.prototype.filter.call(
        panel.querySelectorAll('button, input[type=range]'),
        function (e) { return e.getClientRects().length
                          && !e.closest('details:not([open])'); });
    const named = function (e) {
        return e.id || String(e.className).split(' ')[0] || e.tagName.toLowerCase();
    };
    // Every control the user can see, asked twice: inside the screen, and inside
    // the box that would have clipped it if the panel still scrolled.
    const outsidePanel = [], offScreen = [];
    ctrls.forEach(function (e) {
        const b = e.getBoundingClientRect();
        if (b.top < pbox.top - 0.5 || b.bottom > pbox.bottom + 0.5) outsidePanel.push(named(e));
        if (!fits(b)) offScreen.push(named(e));
        if (e.scrollWidth > e.clientWidth + 1) outsidePanel.push(named(e) + '(text)');
    });
    // The three one-tap buttons share one 300px row on the smallest phone and
    // `.btn` sets `white-space: nowrap`, so a label too long for its slot spills
    // *over its neighbour* rather than wrapping or growing the row. Neither
    // `fits()` nor the panel sweep above would notice: the row is still inside
    // the screen and these buttons are not in the panel. Two separate failures,
    // so two checks — the label may be wider than the box it was given, and the
    // box may be pushed past the row it is in.
    //
    // The label is measured with a Range over the button's contents, and not
    // with `scrollWidth`. That was the first attempt and it passed a row that
    // visibly spills: scrollable overflow does not include the inline-start
    // direction, and `.btn` centres its content, so a too-long label spills
    // equally both ways and the half that `scrollWidth` can see is nothing.
    // A Range reports where the text is *painted*, which is the question.
    const autoRow = document.querySelector('.bottombar--edit .bar-row');
    const rbox = autoRow.getBoundingClientRect(), rowSpill = [];
    Array.prototype.forEach.call(autoRow.children, function (e) {
        const b = e.getBoundingClientRect();
        if (b.left < rbox.left - 0.5 || b.right > rbox.right + 0.5) rowSpill.push(named(e) + '(box)');
        const r = document.createRange();
        r.selectNodeContents(e);
        const t = r.getBoundingClientRect();
        if (t.width > 0 && (t.left < b.left - 0.5 || t.right > b.right + 0.5)) {
            rowSpill.push(named(e) + '(label ' + Math.round(t.width) + 'px in '
                          + Math.round(b.width) + 'px)');
        }
    });
    // A row whose contents outgrow it does not spill sideways and it does not
    // shrink -- it wraps onto a second line, which on the smallest phone is
    // height taken straight off the stage. The tone row is the tight one: a
    // label, three chips and the Custom button on one 300px line; the crop row
    // beside it carries a slider that must keep usable travel.
    //
    // Both are measured at their *worst* labels rather than at whatever the page
    // happens to be showing. The Sharpen chip grows its label as it is tapped,
    // and the label slot is taken over by the mode name on a page Auto all
    // picked Receipt for -- so a row that fits at rest and re-wraps on the third
    // tap, or on the one page a mode matters most, moves the stage under the
    // user's finger.
    //
    // `prep` forces those worst labels and returns the undo. An absent row
    // answers `absent` rather than throwing: this same probe runs on the replay
    // page, where the two rows are precisely what is not there, and on the real
    // page the structure checks have already required them.
    // "Wrapped" has to be asked of the row *and* of each child, because a flex
    // child that runs out of room at 320px does not grow -- it wraps inside
    // itself, and it becomes the tallest thing in the row rather than exceeding
    // it. Comparing the row's height to its tallest child therefore reads a
    // wrapped `#mode-chips` as one line and reports nothing, which is how the
    // fifth mode chip took 27.6px off the stage with every check still green.
    // The stage-share floor caught it and nothing else did.
    const wrappedIn = el => {
        const kids = Array.prototype.slice.call(el.children);
        if (kids.length < 2) return false;
        const top = Math.max.apply(null, kids.map(k => k.getBoundingClientRect().height));
        return el.getBoundingClientRect().height > top + 3;
    };
    const rowFit = (id, prep) => {
        const row = document.getElementById(id);
        if (!row) return { absent: true };
        const undo = prep && prep();
        const rb = row.getBoundingClientRect();
        const kids = Array.prototype.slice.call(row.children);
        const tallest = Math.max.apply(null, kids.map(k =>
            k.getBoundingClientRect().height));
        const spill = kids.filter(k => {
            const b = k.getBoundingClientRect();
            return b.left < rb.left - 0.5 || b.right > rb.right + 0.5;
        }).map(k => named(k));
        const fine = document.getElementById('in-fine');
        const out = { w: Math.round(rb.width), h: Math.round(rb.height),
                      tallest: Math.round(tallest),
                      wrapped: rb.height > tallest + 3, spill: spill,
                      // Named, so a failure says which child wrapped rather
                      // than only that the row is taller than it should be.
                      subWrap: kids.filter(wrappedIn).map(named),
                      need: Math.round(kids.reduce((s, k) =>
                          s + k.getBoundingClientRect().width, 0)),
                      // The slider is the only control in these rows that can
                      // give ground, and it is useless if it gives too much:
                      // Left and Right are 90-degree steps, so on a page a
                      // degree or two out this is the only control that can fix
                      // it.
                      slider: fine ? Math.round(fine.getBoundingClientRect().width) : 0 };
        if (undo) undo();
        return out;
    };
    const worstToneLabels = () => {
        const sharp = document.getElementById('chip-sharpen');
        if (!sharp) return null;
        const was = sharp.textContent;
        sharp.textContent = 'Sharpen 3';
        // `#mode-name` used to be forced to "Black & white" here, because a
        // page in Receipt had no chip and the mode's name took the label's
        // place. Receipt has a chip again, and it and B/W are the only two long
        // names -- so `syncEditorChrome` can no longer populate this slot at
        // all, and `named` is always ''. Forcing it measured a state the app
        // cannot reach: it pushed the row to 51px and, once the guard below
        // learned to see a wrapped child, failed the check on its own fixture.
        //
        // It is left forced-off rather than deleted because the slot is a
        // safety net, not dead markup: if a mode ever loses its chip the name
        // has somewhere to go. The price of using it is measured and recorded
        // in PROJECT_CONTEXT.md -- with the label occupied the tone row needs
        // ~26px more than it has at 320px and wraps.
        return () => {
            sharp.textContent = was;
        };
    };

    return {
        vh: vh, vw: vw,
        auto: fits(box('#btn-auto')), all: fits(box('#btn-all')),
        magic: fits(magic), save: fits(box('#btn-save')),
        rowSpill: rowSpill,
        pager: fits(box('#btn-prev')) && fits(box('#btn-next')),
        magicBottom: Math.round(magic.bottom),
        stageFrac: stage.h / vh,
        previewFits: !!pv && pv.top >= stage.top - 0.5 && pv.bottom <= stage.bottom + 0.5
                     && pv.left >= stage.left - 0.5 && pv.right <= stage.right + 0.5,
        previewBox: pv ? Math.round(pv.w) + 'x' + Math.round(pv.h) + ' in '
                         + Math.round(stage.w) + 'x' + Math.round(stage.h) : 'none',
        viewFits: view.scrollHeight <= view.clientHeight + 1,
        viewH: view.clientHeight, contentH: view.scrollHeight,
        // The user's requirement, in one number: "i do not want to have to
        // scroll up and down". If this is positive the panel has a fold.
        panelScroll: panel.scrollHeight - panel.clientHeight,
        ctrlCount: ctrls.length, outsidePanel: outsidePanel, offScreen: offScreen,
        // An element scrolled out of an `overflow: auto` parent still reports a
        // perfectly ordinary rect — it is clipped, not moved — so `fits()`
        // above says "on screen" for a control the user cannot see. This asks
        // the only question that matters for the modes: is the row painted
        // *inside the panel*, which is the box that clips it.
        chipsShown: (() => {
            const c = box('#mode-chips'), p = box('#panel');
            return !!c && c.top >= p.top - 0.5 && c.bottom <= p.bottom + 0.5;
        })(),
        toneRow: rowFit('tone-row', worstToneLabels),
        cropRow: rowFit('crop-row'),
        // Pinned means *outside the scrolling region*, not merely on screen
        // today: what the panel scrolls to is exactly what moves.
        pinned: !panel.contains(document.getElementById('btn-auto'))
                && !panel.contains(document.getElementById('btn-all'))
                && !panel.contains(document.getElementById('btn-magic')),
        // The eight crop handles, whole. On the smallest phone the stage is short
        // and the handles are the one thing on it that is drawn near its edge, so
        // this is where a letterbox that forgets the dots' radius shows up: the
        // stage clips the layer, and a dot centred on the clip line is a
        // half-disc over a dead pixel. See `HANDLE_PAD` in js/50-ui.js. The side
        // handles sit on the same two x's and two y's as the corners, so they are
        // held to the same bound rather than a looser one.
        handles: (() => {
            const dots = document.querySelectorAll('.crop-handle .crop-dot');
            if (dots.length !== 8) return { count: dots.length };
            const out = [];
            for (let i = 0; i < 8; i++) {
                const b = dots[i].getBoundingClientRect();
                out.push({ whole: b.left >= stage.left - 0.5 && b.right <= stage.right + 0.5
                                  && b.top >= stage.top - 0.5 && b.bottom <= stage.bottom + 0.5,
                           overlapsFooter: b.bottom > magic.top + 0.5,
                           cx: Math.round(b.left + b.width / 2),
                           cy: Math.round(b.top + b.height / 2) });
            }
            return { count: 8, dots: out };
        })()
    };
}"""

# The editor as it stood before this change: the same pinned footer, but the
# panel under it was capped at 26vh and scrolled — Reset tone had a row of its
# own, rotating and Reset crop were two rows rather than one, the crop hint was a
# paragraph under them, and every button was 40px. Restored here so the checks
# below can be shown to be about a change rather than about a phone.
LEGACY_CSS = """
  :root { --tap: 40px; }
  .topbar { padding: calc(var(--safe-t) + 8px) 12px 8px; }
  .btn { font-size: 13.5px; padding: 0 13px; border-radius: 11px; gap: 6px; }
  .icon-btn--sm { width: 34px; height: 34px; font-size: 16px; }
  .stage { flex: 1 1 auto; min-height: 110px; margin: 6px 12px; }
  .panel { padding: 6px 12px 4px; max-height: min(26vh, 210px); }
  .panel-row { gap: 7px; margin-bottom: 7px; }
  .group + .group { margin-top: 2px; padding-top: 9px; }
  .group-title { margin: 0 0 7px; font-size: 10.5px; }
  .hint { margin: 4px 0 2px; font-size: 11.5px; line-height: 1.35; }
  .slider-row { margin: 0 0 7px; }
  .panel .slider-row:last-child { margin-bottom: 7px; }
  .slider-label { font-size: 12px; margin-bottom: 3px; }
  input[type="range"] { height: 22px; }
  .chips { gap: 6px; margin-bottom: 8px; }
  .chip { font-size: 12.5px; padding: 6px 12px; }
  .tune { padding-top: 6px; }
  .tune > summary { font-size: 12.5px; padding: 5px 0 8px; }
  .bottombar { gap: 7px; padding: 8px 12px calc(var(--safe-b) + 10px); }
"""

# Undo the compaction. What the two rows are now was four rows, two headings, a
# paragraph of guidance and a fifth chip; the panel is rebuilt as it stood rather
# than nudged back towards it, because the change is a rearrangement and a
# rearrangement is not something you can reverse one element at a time. Only the
# real controls are carried across — the same chips, sliders and buttons, so the
# measurement is of the same things in a different order and not of a stand-in.
LEGACY_DOM = """() => {
    const $ = (id) => document.getElementById(id);
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const row = (...kids) => {
      const r = el('div', 'panel-row');
      kids.forEach(k => r.appendChild(k));
      return r;
    };

    // Everything the two groups are made of, taken off the live panel before it
    // is cleared. These are the same nodes the new layout uses -- same ids,
    // same listeners -- so what is measured below is a rearrangement of the real
    // controls and not a mock-up of them.
    const chips = $('mode-chips'), tune = $('tune');
    const rotL = $('btn-rot-l'), rotR = $('btn-rot-r'), fine = $('in-fine');
    const valFine = $('val-fine'), undo = $('btn-undo-all');
    const sliders = Array.prototype.slice.call(tune.querySelectorAll('.slider-row'));
    const resetAdj = $('btn-reset-adj');
    // The Custom button was not in this arrangement -- the drawer opened from
    // the summary, and there was no button to open it with. Off before the panel
    // is cleared, while it is still reachable by id.
    $('chip-custom').remove();

    // The Original chip was a real chip in this arrangement: the neutral default
    // had a button of its own, which is one of the things that went.
    const orig = el('button', 'chip', 'Original');
    orig.dataset.mode = 'original';
    chips.insertBefore(orig, chips.firstElementChild);

    // Fine tuning was a <details> whose summary sat under the chips, so its
    // contents are back inside one; Reset tone was a row of its own above it.
    const det = el('details', 'tune');
    det.appendChild(el('summary', null, 'Fine tuning'));
    sliders.forEach(s => det.appendChild(s));

    const clean = el('div', 'group');
    clean.appendChild(el('h3', 'group-title', 'Clean & tone'));
    clean.appendChild(row(chips));          // the Custom button rides along
    clean.appendChild(row(resetAdj));
    clean.appendChild(det);

    // ...and on the crop side, rotating and resetting were two rows, the slider
    // had a label above it instead of sharing its line, and the guidance was a
    // paragraph under the lot. The reset button carried the shorter label
    // "Reset crop" then, and its width is part of what the row measured.
    undo.textContent = 'Reset crop';
    rotL.textContent = '\\u27F2 Rotate left';
    rotR.textContent = '\\u27F3 Rotate right';
    const angLab = el('span', 'slider-label');
    angLab.appendChild(document.createTextNode('Fine angle '));
    angLab.appendChild(valFine);
    const ang = el('div', 'panel-row slider-row');
    ang.appendChild(angLab);
    ang.appendChild(fine);

    const crop = el('div', 'group');
    crop.appendChild(el('h3', 'group-title', 'Crop & straighten'));
    crop.appendChild(row(rotL, rotR));
    crop.appendChild(ang);
    crop.appendChild(row(undo));
    crop.appendChild(el('p', 'hint',
      'If Auto detect misses the page, rotate in 90\\u00B0 steps and try again, '
      + 'or set Fine angle by hand. Reset crop goes back to the whole photo.'));

    const panel = $('panel');
    while (panel.firstChild) panel.removeChild(panel.firstChild);
    panel.appendChild(clean);
    panel.appendChild(crop);
}"""


def make_mixed_border_photo(path):
    """The reported failure: a pale receipt held over a surface with no one tone.

    Left of the frame is the hand holding it, right is a mottled pale counter.
    The receipt straddles the join. Nothing here is exotic — it is what a phone
    in one hand pointed at a slip of paper produces — but the frame's border has
    no dominant material, which is what the detector reads to decide which side
    the paper is on. Its border mean lands on the Otsu split and its border
    spread spans both sides, so the answer it used to give was not wrong so much
    as unfounded: it cropped the shadowed hand, reporting "Edges found".
    """
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (IMG_W, IMG_H))
    d = ImageDraw.Draw(img)

    # The hand, left: mid-tones that climb to the split, so the dark class is
    # large enough to be mistaken for a page.
    for y in range(IMG_H):
        for x in range(MIX_JOIN):
            t = x / float(MIX_JOIN)
            v = 118 + 46 * t
            # Knuckle creases, so the hand is textured rather than a ramp.
            if (y % 210) < 26:
                v *= 0.86
            px = int(v)
            img.putpixel((x, y), (px, int(px * 0.98), int(px * 0.96)))

    # The counter, right: pale, mottled, lit unevenly.
    for y in range(IMG_H):
        for x in range(MIX_JOIN, IMG_W):
            t = (x - MIX_JOIN) / float(IMG_W - MIX_JOIN)
            s = math.sin(x * 0.013) * math.cos(y * 0.007)
            v = 204 + 26 * t + 5 * s
            px = int(v)
            img.putpixel((x, y), (px, int(px * 0.99), int(px * 0.95)))

    # The receipt: a pale strip crossing the join.
    d.rectangle(MIX_RECEIPT, fill=(248, 246, 240))
    y = MIX_RECEIPT[1] + 50
    i = 0
    while y < MIX_RECEIPT[3] - 60:
        w = 140 if i % 4 else 88
        d.rectangle([MIX_RECEIPT[0] + 22, y, MIX_RECEIPT[0] + 22 + w, y + 9],
                    fill=(46, 46, 50))
        y += 27
        i += 1

    # The shadow the hand casts across the receipt, and the falloff where the
    # counter catches the light.
    px = img.load()
    for x in range(MIX_RECEIPT[0], MIX_RECEIPT[2]):
        if x <= MIX_JOIN:
            k = 0.72
        else:
            k = 0.72 + 0.28 * min(1.0, (x - MIX_JOIN) / 90.0)
        for y in range(MIX_RECEIPT[1], MIX_RECEIPT[3]):
            r, g, b = px[x, y]
            px[x, y] = (int(r * k), int(g * k), int(b * k))

    img.save(path, "JPEG", quality=94)
    return path


# ---------------------------------------------------------------- harness

class Report:
    def __init__(self):
        self.passed = 0
        self.failed = 0

    def check(self, name, ok, detail=""):
        if ok:
            self.passed += 1
            print("  ok   " + name)
        else:
            self.failed += 1
            print("  FAIL " + name + ("  -- " + str(detail) if detail else ""))


def js_round(v):
    """JavaScript's Math.round: half away from zero, not Python's banker's."""
    return math.floor(v + 0.5) if v >= 0 else math.ceil(v - 0.5)


def diagonal_crossing(corners, fine, oc):
    """Where the middle of the finished page lands in the photo.

    A projective map sends straight lines to straight lines, so the centre of the
    output rectangle is the photo point where the crop quad's two diagonals
    cross. That is worth having as an independent answer: the drag tests aim a
    corner at the middle of the displayed page and compare, which checks the
    whole chain (screen point -> normalised output -> homography -> un-rotate the
    fine angle) against something computed without any of it.

    Written the way `JS.cropMapper` reads its own inputs: corners are normalised
    over the oriented canvas, the fine angle rotates about that canvas's centre,
    and the answer comes back un-rotated and re-normalised.
    """
    w, h = oc
    rad = math.radians(fine)
    cx, cy = w / 2.0, h / 2.0

    def rot(x, y, r):
        c, s = math.cos(r), math.sin(r)
        dx, dy = x - cx, y - cy
        return (cx + dx * c - dy * s, cy + dx * s + dy * c)

    q = [rot(c[0] * w, c[1] * h, rad) for c in corners]

    def line(a, b):
        return (b[1] - a[1], a[0] - b[0], a[1] * b[0] - a[0] * b[1])

    l1, l2 = line(q[0], q[2]), line(q[1], q[3])
    den = l1[0] * l2[1] - l2[0] * l1[1]
    x = (l1[1] * l2[2] - l2[1] * l1[2]) / den
    y = (l1[2] * l2[0] - l2[2] * l1[0]) / den
    bx, by = rot(x, y, -rad)
    return (bx / w, by / h)


def main():
    from playwright.sync_api import sync_playwright

    os.makedirs(TMP, exist_ok=True)
    photo = make_photo(os.path.join(TMP, "e2e_doc.jpg"))
    full_photo = make_full_frame_photo(os.path.join(TMP, "e2e_full_frame.jpg"))
    receipt_photo = make_receipt_photo(os.path.join(TMP, "e2e_receipt.jpg"))
    mixed_photo = make_mixed_border_photo(os.path.join(TMP, "e2e_mixed_border.jpg"))
    rep = Report()

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 390, "height": 844},
                                device_scale_factor=2, has_touch=True)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append("console." + m.type + ": " + m.text)
                if m.type == "error" else None)

        page.goto(PAGE_URL)
        page.wait_for_function("!!window.JS && !!JS.app")

        print("\nthe version, on the first screen")
        # The user's ask: "so I know which version am I running". What makes this
        # worth a check rather than an eyeball is that the number is *only* in
        # JS.VERSION — the markup ships an empty span — so the test is really
        # asserting the boot wiring still runs and still reads the constant.
        # A hard-coded "1.0.0" in index.html would pass a text comparison and
        # fail this one.
        ver = page.evaluate("JS.$('app-version').textContent")
        want = page.evaluate("'v' + JS.VERSION")
        print("        home topbar shows %r (JS.VERSION = %s)" % (ver, page.evaluate("JS.VERSION")))
        rep.check("the home screen shows the version from JS.VERSION", ver == want,
                  "%r vs %r" % (ver, want))
        # And it is only in one place. The markup's span must ship empty, or the
        # next bump leaves the screen showing whatever was typed into the HTML
        # and every check above stays green while the number is wrong.
        import re
        src = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
        span = re.search(r'<span id="app-version"[^>]*>(.*?)</span>', src, re.S)
        rep.check("index.html keeps no copy of the number to go stale",
                  span is not None and span.group(1).strip() == "",
                  repr(span.group(1)) if span else "span not found")
        rep.check("it is on screen at the first screen, not only in a sheet",
                  page.evaluate("""() => { const e = JS.$('app-version');
                      const r = e.getBoundingClientRect();
                      return r.width > 0 && r.height > 0 && r.top < window.innerHeight; }"""))

        print("\npanel layout")
        # ---- one panel holding both halves of the job -------------------
        for gone in ("tab-crop", "tab-adjust", "panel-crop", "panel-adjust"):
            rep.check("the old tab #%s is gone" % gone,
                      page.evaluate("!document.getElementById('%s')" % gone))
        rep.check("there is a single #panel", page.evaluate("!!document.getElementById('panel')"))
        # The two headings the panel used to carry are gone with the rows they
        # headed: each row now names itself on its own line, which is where the
        # height came from. Tone before crop, and the order is not cosmetic — the
        # panel is capped, so whatever is first is what is on screen, and the
        # mode is what the pinned Auto clean acts on.
        rep.check("the old two-line headings are gone",
                  not page.evaluate("document.querySelectorAll('.group-title').length"))
        labels = page.eval_on_selector_all(
            "#panel > .ctl-row > .ctl-label", "els => els.map(e => e.textContent.trim())")
        rep.check("both halves are labelled on their own lines, tone first",
                  labels == ["Tone:", "Crop:"], labels)
        rows = page.eval_on_selector_all("#panel > .ctl-row", "els => els.map(e => e.id)")
        rep.check("and they are two rows, with only the drawer after them",
                  rows == ["tone-row", "crop-row"]
                  and page.evaluate("Array.from(JS.$('panel').children)"
                                    ".map(e => e.id)")
                  == ["tone-row", "tune", "crop-row"],
                  "%s in %s" % (rows, page.evaluate(
                      "Array.from(JS.$('panel').children).map(e => e.id)")))

        # ---- the Greyscale chip is gone, the Receipt chip is back ------------
        # Receipt lost its chip for a while, on the grounds that Auto all read
        # the page's shape and picked it. Auto all no longer picks anything, so
        # without a chip the mode would be unreachable and it is back. What the
        # user asked to be rid of was never Receipt; it was the guessing.
        #
        # Greyscale had no other route into the app at all -- JS.suggestMode
        # never returned it -- which is why it could go outright, with Saturation
        # at -100 still reaching the same look by hand.
        chips = page.eval_on_selector_all(
            "#mode-chips .chip[data-mode]", "els => els.map(e => e.dataset.mode)")
        rep.check("the Receipt chip is back",
                  "receipt" in chips, chips)
        rep.check("the Greyscale chip is gone", "gray" not in chips, chips)
        # Original goes the same way, and for the same reason: it is what every
        # page starts as, so a button to select it is a button to do nothing.
        # Undo all is the way back to the imported photo and it always was.
        rep.check("the Original chip is gone -- the default needs no button",
                  "original" not in chips, chips)
        # Every mode that has a chip can be reached and every mode is listed
        # here, so no mode is reachable only by a button guessing at it.
        rep.check("the three named modes are the chips, in order",
                  chips == ["auto", "receipt", "bw"], chips)
        rep.check("and they are every mode the pipeline will render",
                  page.evaluate(
                      "Object.keys(JS.MODE_DEFAULTS).filter(m => m !== 'original')"
                      ".sort().join() === ['auto','bw','receipt'].sort().join()"),
                  page.evaluate("Object.keys(JS.MODE_DEFAULTS)"))
        rep.check("the Receipt mode is reachable from its chip alone",
                  page.evaluate("JS.MODE_DEFAULTS.receipt && JS.MODE_LABELS.receipt"),
                  page.evaluate("[!!JS.MODE_DEFAULTS.receipt, JS.MODE_LABELS.receipt]"))
        rep.check("and Greyscale is gone from the pipeline as well",
                  page.evaluate("!JS.MODE_DEFAULTS.gray && !JS.MODE_LABELS.gray"),
                  page.evaluate("[!!JS.MODE_DEFAULTS.gray, !!JS.MODE_LABELS.gray]"))
        rep.check("Saturation at -100 is still the way to reach that look",
                  page.evaluate("JS.MODE_DEFAULTS.auto.sat === 6 && "
                                "JS.applySaturation !== undefined"))

        # ---- and the Sharpen chip has that slot -------------------------
        # It is deliberately not a mode: no `data-mode`, so the row's own loops
        # cannot mistake it for one, and the loop that reads the chips above
        # does not see it. It carries the step in its label instead.
        rep.check("the Sharpen chip is in the mode chips",
                  page.eval_on_selector("#chip-sharpen", "e => e.parentElement.id")
                  == "mode-chips")
        rep.check("the Sharpen chip is not a mode",
                  page.evaluate("!JS.$('chip-sharpen').dataset.mode"))
        rep.check("it starts reading plainly and unlit, not as a step",
                  page.eval_on_selector("#chip-sharpen",
                                        "e => [e.textContent, e.getAttribute('aria-pressed')]")
                  == ["Sharpen", "false"],
                  page.eval_on_selector("#chip-sharpen",
                                        "e => [e.textContent, e.getAttribute('aria-pressed')]"))

        # ---- Custom is the drawer's handle, and it is on the tone row ----
        # It replaced the "Fine tuning" `<details>` summary, which is why the
        # drawer is a plain div toggled by this button: a `<details>` lays its
        # closed contents out and does not paint them, and this row cannot afford
        # to be measured against eight sliders nobody can see. The button carries
        # `aria-expanded` and `aria-controls` so the state is announced, and the
        # drawer starts shut.
        rep.check("Custom is the last thing on the tone row",
                  page.eval_on_selector("#chip-custom", "e => e.parentElement.id")
                  == "tone-row"
                  and page.eval_on_selector("#tone-row", "e => e.lastElementChild.id")
                  == "chip-custom")
        rep.check("the drawer is a plain div with no <details> in the panel",
                  page.evaluate("!document.querySelector('#panel details')"))
        rep.check("it starts shut, and says so",
                  page.evaluate("JS.$('tune').hidden")
                  and page.eval_on_selector("#chip-custom",
                                            "e => e.getAttribute('aria-expanded')") == "false"
                  and page.eval_on_selector("#chip-custom",
                                            "e => e.getAttribute('aria-controls')") == "tune")
        rep.check("and the eight sliders really are in it",
                  page.eval_on_selector_all(
                      "#tune input[type=range]",
                      "els => els.length") == 8,
                  page.eval_on_selector_all("#tune input[type=range]", "els => els.length"))

        # ---- the second view and the corner drag are gone ---------------
        for gone in ("src-inset", "inset-src", "inset-quad", "btn-inset", "btn-compare"):
            rep.check("#%s is gone" % gone,
                      page.evaluate("!document.getElementById('%s')" % gone))
        rep.check("there is no canvas in the stage but the preview",
                  page.eval_on_selector_all(
                      "#stage canvas", "els => els.map(e => e.id)") == ["preview"],
                  page.eval_on_selector_all("#stage canvas", "els => els.map(e => e.id)"))
        # What is left in the stage must not get between a finger and the page.
        # The hint floats over the preview, so it has to be transparent to
        # pointers.
        rep.check("the hint does not swallow touches meant for the page",
                  page.evaluate("getComputedStyle(JS.$('stage-hint')).pointerEvents") == "none")
        # The page and its handles move together under one transform, so they are
        # one element now: `#stage-zoom` holds the canvas and the crop layer, and
        # the hint stays outside it — a hint that zoomed with the page would grow
        # with it, and it is a message about the editor, not about the photo.
        rep.check("the stage holds the zoom box and the hint, and nothing else",
                  page.eval_on_selector_all("#stage > *", "els => els.map(e => e.id)")
                  == ["stage-zoom", "stage-hint"],
                  page.eval_on_selector_all("#stage > *", "els => els.map(e => e.id)"))
        rep.check("the page and its handles are inside it, together",
                  page.eval_on_selector_all("#stage-zoom > *", "els => els.map(e => e.id)")
                  == ["preview", "crop-layer"],
                  page.eval_on_selector_all("#stage-zoom > *", "els => els.map(e => e.id)"))
        # One transform on the parent is what keeps a handle on its corner. Two
        # elements scaled by two styles would drift apart exactly at the corners,
        # which is the one place they have to agree.
        rep.check("the zoom is one transform on the box, not one per child",
                  page.evaluate("getComputedStyle(JS.$('stage-zoom')).transformOrigin")
                  == "0px 0px"
                  and page.evaluate(
                      "[JS.$('preview'), JS.$('crop-layer')].every("
                      "e => getComputedStyle(e).transform === 'none')"))
        # The progress overlay used to be the fourth thing in here, which is why
        # a fifteen-photo import showed no sign of life: it starts on the home
        # screen, and the editor's stage is not on screen then. It now covers the
        # app, so it is not inside either view.
        rep.check("the progress overlay covers the app rather than the editor stage",
                  page.evaluate("JS.$('busy').hidden && !JS.$('busy').closest('.view')"))

        # ---- add a photo, exactly as the picker would -------------------
        page.set_input_files("#file-gallery", photo)
        page.wait_for_function("JS.app.pages.length === 1", timeout=15000)
        page.wait_for_function("document.querySelectorAll('#page-grid .thumb').length === 1")
        page.evaluate("JS.openEditor(0)")
        page.wait_for_function("JS.app.view === 'edit'")

        rep.check("the crop button and the mode chips are on screen together",
                  page.is_visible("#btn-auto") and page.is_visible("#mode-chips"),
                  "btn-auto=%s mode-chips=%s" % (page.is_visible("#btn-auto"),
                                                 page.is_visible("#mode-chips")))

        print("\nthe whole editor is on one screen, and nothing scrolls")
        # The user's requirement in their words: "put all the buttons / slider on
        # 1 single page including the picture. i do not want to have to scroll up
        # and down". Measurably that is two things — the panel is not scrollable,
        # and every control the user can see is inside the box that used to clip
        # it. `is_visible` above only means "has a box", which is true of a
        # button 400px below the fold; these measure the real viewport.
        #
        # 320x568 is the tightest phone still worth supporting; 375x667 is the
        # one the user is on. The floor on the page is what the user asked for in
        # their own words — "now it is like 50% of the screen on my phone but I
        # want it to be 70%" — and it is met by merging the panel's two labelled
        # groups into two rows and the footer's two rows into one, not by
        # shrinking anything: the buttons, the slider and the four handles are all
        # still here, and none of them is below the tap floor. 320x568 lands a
        # tenth of a point under 70 because the topbar is a fixed 47px on a 568px
        # screen; every size above it clears the bar with room.
        for w, h, floor in ((320, 568, 0.69), (375, 667, 0.72), (360, 740, 0.75),
                            (390, 844, 0.78), (430, 932, 0.80)):
            page.set_viewport_size({"width": w, "height": h})
            page.wait_for_timeout(150)
            m = page.evaluate(LAYOUT_JS)
            tag = "%dx%d" % (w, h)
            rep.check("%s: the panel does not scroll" % tag,
                      m["panelScroll"] <= 1, "%dpx of scroll" % m["panelScroll"])
            rep.check("%s: every control is painted inside the panel" % tag,
                      not m["outsidePanel"],
                      "%d measured, outside: %s" % (m["ctrlCount"], m["outsidePanel"]))
            rep.check("%s: every control is inside the screen" % tag,
                      not m["offScreen"], "off screen: %s" % m["offScreen"])
            rep.check("%s: Auto crop, Auto all, Auto clean and Done are all in the viewport" % tag,
                      m["auto"] and m["all"] and m["magic"] and m["save"] and m["pager"],
                      "crop %s all %s clean %s save %s pager %s"
                      % (m["auto"], m["all"], m["magic"], m["save"], m["pager"]))
            rep.check("%s: the three one-tap buttons fit their row" % tag,
                      not m["rowSpill"], "spilling: %s" % m["rowSpill"])
            # The floor that stops "no scrolling" being bought by shrinking the
            # page to nothing.
            rep.check("%s: the page is at least %d%% of the screen" % (tag, floor * 100),
                      m["stageFrac"] >= floor, "%.1f%%" % (m["stageFrac"] * 100))
            rep.check("%s: the preview sits inside the stage" % tag,
                      m["previewFits"], m["previewBox"])
            # Eight dots, each one whole and none of them down in the footer. The
            # handles are the only thing the stage draws at its own edge, so this
            # is the size at which a letterbox that ignores them shows.
            rep.check("%s: all eight crop handles are drawn whole on the page" % tag,
                      m["handles"]["count"] == 8
                      and all(d["whole"] for d in m["handles"]["dots"]),
                      "%s" % m["handles"])
            rep.check("%s: no crop handle reaches the footer" % tag,
                      m["handles"]["count"] == 8
                      and not any(d["overlapsFooter"] for d in m["handles"]["dots"]),
                      "handles %s against the footer at %d"
                      % ([d["cy"] for d in m["handles"].get("dots", [])], m["magicBottom"]))
            rep.check("%s: the footer is not pushed off the bottom" % tag,
                      m["viewFits"], "%d of %d" % (m["contentH"], m["viewH"]))
            rep.check("%s: all three one-tap buttons are pinned outside the panel's scroll" % tag,
                      m["pinned"], "pinned=%s" % m["pinned"])
            # The mode is the one input Auto clean has. A pinned button that
            # will not say which of four things it is about to do is worse than
            # one you have to scroll to.
            rep.check("%s: the mode Auto clean will apply is on screen too" % tag,
                      m["chipsShown"], "chipsShown=%s" % m["chipsShown"])
            # The two rows that replaced the panel's four, at their worst
            # labels. A wrapped row is a second line of height taken straight
            # off the page, and it moves under the user's finger the moment a
            # chip's own label grows. `subWrap` is the same question asked of
            # each child, which is the one that catches the chip row: five mode
            # chips at 320px wrap *inside* `#mode-chips`, so the row never grew
            # past its tallest child and only the stage floor noticed.
            rep.check("%s: the tone row fits on one line at its longest labels" % tag,
                      not m["toneRow"]["wrapped"] and not m["toneRow"]["spill"]
                      and not m["toneRow"]["subWrap"],
                      "h %d (tallest %d), need %d, spilling %s, wrapped inside %s"
                      % (m["toneRow"]["h"], m["toneRow"]["tallest"],
                         m["toneRow"]["need"], m["toneRow"]["spill"],
                         m["toneRow"]["subWrap"]))
            rep.check("%s: the crop row fits on one line too" % tag,
                      not m["cropRow"]["wrapped"] and not m["cropRow"]["subWrap"],
                      "h %d, slider %dpx, wrapped inside %s"
                      % (m["cropRow"]["w"], m["cropRow"]["slider"],
                         m["cropRow"]["subWrap"]))
            # Left and Right are 90-degree steps, so on a page a degree or two
            # out this slider is the only control that can fix it: it has to
            # keep enough travel to be aimed with a finger.
            rep.check("%s: the fine angle slider keeps usable travel" % tag,
                      m["cropRow"]["slider"] >= 60, "%dpx" % m["cropRow"]["slider"])
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(150)

        # The one control that is deliberately not on the one screen. Eight
        # sliders are ~340px on their own and no phone has that to spare, so the
        # drawer is a scroll by construction — but the footer must stay put and
        # the panel must shrink rather than push Done off the bottom.
        #
        # Opened by tapping the button, not by setting a property: the drawer is
        # a `[hidden]` div and the button is what toggles it, so this is also the
        # only way the check would notice the two coming apart.
        page.click("#chip-custom")
        page.wait_for_timeout(150)
        rep.check("tapping Custom opens the drawer and lights it",
                  page.evaluate("!JS.$('tune').hidden")
                  and page.eval_on_selector("#chip-custom",
                                            "e => e.classList.contains('is-active')")
                  and page.eval_on_selector("#chip-custom",
                                            "e => e.getAttribute('aria-expanded')") == "true")
        m = page.evaluate(LAYOUT_JS)
        rep.check("with the Custom drawer open the footer stays pinned",
                  m["viewFits"] and m["save"] and m["magic"] and m["all"],
                  "%d of %d" % (m["contentH"], m["viewH"]))
        rep.check("and the drawer is the only thing that scrolls",
                  m["panelScroll"] > 0, "%dpx of scroll" % m["panelScroll"])
        # Even with the drawer open the page must not be pushed off the screen:
        # the sliders are being aimed at the picture, so the picture has to stay.
        rep.check("with the drawer open the page still keeps its floor",
                  m["stageFrac"] >= 0.30, "%.1f%%" % (m["stageFrac"] * 100))
        page.click("#chip-custom")
        page.wait_for_timeout(150)
        rep.check("closing the drawer puts the whole editor back on one screen",
                  page.evaluate(LAYOUT_JS)["panelScroll"] <= 1
                  and page.evaluate("JS.$('tune').hidden"))

        print("\nand the same checks on the arrangement the user reported")
        old = browser.new_page(viewport={"width": 375, "height": 667}, device_scale_factor=2)
        old.goto(PAGE_URL)
        old.wait_for_function("!!window.JS && !!JS.app")
        old.set_input_files("#file-gallery", photo)
        old.wait_for_function("JS.app.pages.length === 1", timeout=15000)
        old.evaluate("JS.openEditor(0)")
        old.wait_for_function("JS.app.view == 'edit'")
        old.add_style_tag(content=LEGACY_CSS)
        old.evaluate(LEGACY_DOM)
        old.wait_for_timeout(200)
        m = old.evaluate(LAYOUT_JS)
        rep.check("the replay really is the old editor: five rows under two headings,"
                  " a drawer and a paragraph of guidance",
                  old.eval_on_selector_all("#panel .panel-row", "els => els.length") == 5
                  and old.eval_on_selector_all("#panel .group-title",
                                               "els => els.length") == 2
                  and old.eval_on_selector_all("#panel .hint", "els => els.length") == 1
                  and old.evaluate("!!document.querySelector('#panel details')")
                  and old.evaluate("!document.getElementById('tune')"),
                  "%s rows, %s headings, %s hints" % (
                      old.eval_on_selector_all("#panel .panel-row", "els => els.length"),
                      old.eval_on_selector_all("#panel .group-title", "els => els.length"),
                      old.eval_on_selector_all("#panel .hint", "els => els.length")))
        # These two are the loop's own predicates, run here and required to come
        # out the other way — so the checks above are known to be about a change
        # rather than about a phone.
        rep.check("there the panel-scroll check fails: %dpx of scroll"
                  % m["panelScroll"], m["panelScroll"] > 1)
        rep.check("and so does the every-control-inside-the-panel check, on the "
                  "rotate buttons and the fine angle",
                  bool(m["outsidePanel"]) and "btn-rot-l" in m["outsidePanel"]
                  and "in-fine" in m["outsidePanel"], "outside: %s" % m["outsidePanel"])
        # Stated rather than glossed, and it is the whole reason the user asked
        # for the merge. This arrangement shows the page at 55% AND spends it on
        # a panel that scrolls and clips: the cap below exists to stop the panel
        # pushing the footer off, so every pixel past the cap is a control under
        # a fold. The two lines above give 74% with everything on screen, so the
        # height is not the trade any more — the fold is what was traded away.
        #
        # The floor is 0.46 rather than 0.55 because the rebuilt arrangement is
        # an approximation of the build the user reported, not a rebuild of it:
        # the real one measured 49.0% at this size. What this check is for is
        # that the replay stays a *fair* comparison — a replay that quietly got
        # taller would make the change look bigger than it is, and a replay that
        # collapsed would make it look smaller.
        rep.check("where the page was %.0f%% against the 74%% it is now — and the "
                  "difference is a panel that scrolled and clipped its controls"
                  % (m["stageFrac"] * 100), m["stageFrac"] >= 0.46,
                  "%.1f%%" % (m["stageFrac"] * 100))
        old.close()

        print("\nthe stage shows the finished page")
        # Crop a wide band out of the 3:4 portrait and read the resulting aspect
        # back off the DOM. The expected value is derived here from the corner
        # geometry and the oriented buffer size, not assumed — the preview
        # cannot pass this by being self-consistent.
        oc0 = page.evaluate("""() => {
            const oc = JS.orientedCanvas(JS.activePage(), JS.PREVIEW_MAX);
            return {w: oc.width, h: oc.height};
        }""")
        cx0, cx1, cy0, cy1 = 0.15, 0.85, 0.30, 0.70
        want_ow = js_round((cx1 - cx0) * oc0["w"])          # axis-aligned: no perspective
        want_oh = js_round((cy1 - cy0) * oc0["h"])
        want_aspect = want_ow / float(want_oh)

        page.evaluate("""(c) => {
            const p = JS.activePage();
            p.corners = [{x:c[0],y:c[2]},{x:c[1],y:c[2]},{x:c[1],y:c[3]},{x:c[0],y:c[3]}];
            JS.invalidate(p);
            JS.renderPreview(true);
        }""", [cx0, cx1, cy0, cy1])
        page.wait_for_timeout(120)
        prev = page.eval_on_selector("#preview", "el => { const r = el.getBoundingClientRect(); return {w: r.width, h: r.height}; }")
        got_aspect = prev["w"] / prev["h"]
        rep.check("the stage shows the cropped page, not the whole photo",
                  abs(got_aspect - want_aspect) < 0.03 and abs(got_aspect - IMG_W / IMG_H) > 0.3,
                  "preview aspect %.3f, cropped %.3f, source %.3f"
                  % (got_aspect, want_aspect, IMG_W / IMG_H))

        # Undo all puts the whole photo back, and the stage has to follow it.
        # Everything it claims to undo is set first, through the real controls,
        # so the check is about a page that had all of it rather than one that
        # had a crop and nothing else.
        print("\nundo all")
        page.click(".chip[data-mode='bw']")
        page.click("#btn-rot-r")
        page.eval_on_selector("#in-fine", """el => {
            el.value = -7.3;
            el.dispatchEvent(new Event('input', {bubbles: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
        }""")
        page.eval_on_selector("#in-bright", """el => {
            el.value = 42;
            el.dispatchEvent(new Event('input', {bubbles: true}));
        }""")
        page.wait_for_timeout(200)

        dirty = page.evaluate("""() => {
            const p = JS.activePage();
            return {coarse: p.coarse, fine: p.fine, mode: p.mode,
                    corners: !!p.corners, bright: p.adj.bright};
        }""")
        rep.check("the page really was rotated, cropped, re-moded and brightened",
                  dirty["coarse"] == 90 and abs(dirty["fine"] + 7.3) < 0.01
                  and dirty["mode"] == "bw" and dirty["corners"]
                  and dirty["bright"] == 42, dirty)

        page.click("#btn-undo-all")
        page.wait_for_timeout(200)
        back = page.evaluate("""() => {
            const p = JS.activePage();
            const a = p.adj, keys = Object.keys(a);
            return {coarse: p.coarse, fine: p.fine, corners: p.corners, mode: p.mode,
                    touched: p.touched, adjKeys: keys.length,
                    nonZero: keys.filter(k => a[k] !== 0),
                    hint: JS.$('stage-hint').textContent};
        }""")
        rep.check("Undo all takes the rotation back too",
                  back["coarse"] == 0, "coarse %s" % back["coarse"])
        rep.check("and the fine angle", abs(back["fine"]) < 0.01,
                  "fine %.2f" % back["fine"])
        rep.check("and the crop", back["corners"] is None, back["corners"])
        rep.check("and the mode, back to the photo as imported rather than the "
                  "auto clean a fresh import gets",
                  back["mode"] == "original", back["mode"])
        rep.check("and every one of the eight tone keys, none dropped",
                  back["adjKeys"] == 8 and not back["nonZero"],
                  "%d keys, non-zero: %s" % (back["adjKeys"], back["nonZero"]))
        rep.check("it counts as untouched again", back["touched"] is False,
                  back["touched"])
        rep.check("and it says so", "original" in back["hint"].lower(), back["hint"])

        prev_r = page.eval_on_selector("#preview", "el => { const r = el.getBoundingClientRect(); return {w: r.width, h: r.height}; }")
        rep.check("Undo all goes back to the whole photo on the stage",
                  abs(prev_r["w"] / prev_r["h"] - IMG_W / IMG_H) < 0.03,
                  "aspect %.3f want %.3f" % (prev_r["w"] / prev_r["h"], IMG_W / IMG_H))

        # ---- the Sharpen chip, tapping it four times --------------------
        # The user's words: "click once, low, click second time, med sharpen,
        # and click 3rd time, high sharpen, and click forth time, undo". So the
        # cycle is the feature, and the fourth tap has to be a real undo -- back
        # to the sharpness the *mode* asks for, not to zero, or switching modes
        # after sharpening would silently flatten the mode's own default.
        print("\nthe sharpen chip: four taps and back")
        SHARP_JS = """() => {
            const p = JS.activePage(), chip = JS.$('chip-sharpen');
            return { mode: p.mode, sharp: p.adj.sharp, level: JS.sharpenLevel(p),
                     label: chip.textContent, lit: chip.classList.contains('is-active'),
                     pressed: chip.getAttribute('aria-pressed'),
                     hint: JS.$('stage-hint').textContent };
        }"""
        seen = []
        for tap in range(1, 5):
            page.click("#chip-sharpen")
            page.wait_for_timeout(120)
            st = page.evaluate(SHARP_JS)
            seen.append((tap, st))
            print("        tap %d -> %-12r level %d  sharp %3d  lit %-5s  hint %r"
                  % (tap, st["label"], st["level"], st["sharp"], st["lit"], st["hint"]))

        labels = [s["label"] for _, s in seen]
        rep.check("four taps read off the three steps and then the plain name",
                  labels == ["Sharpen 1", "Sharpen 2", "Sharpen 3",
                             "Sharpen"], labels)
        rep.check("and the sharpness climbs with them",
                  [s["sharp"] for _, s in seen] ==
                  list(page.evaluate("JS.SHARP_LEVELS")) + [0],
                  [s["sharp"] for _, s in seen])
        rep.check("the chip lights for every step and goes out at the end",
                  [s["lit"] for _, s in seen] == [True, True, True, False]
                  and [s["pressed"] for _, s in seen] == ["true", "true", "true", "false"],
                  [s["lit"] for _, s in seen])
        rep.check("each tap says which step it landed on",
                  seen[0][1]["hint"] == "Sharpen 1"
                  and seen[3][1]["hint"] == "Sharpen",
                  [s["hint"] for _, s in seen])
        # The page was Undo-all'd just above, so mode is Original, whose own
        # sharpness is zero. That makes the fourth tap indistinguishable from
        # "reset to nothing" -- so the same cycle is run in Auto colour, where
        # the mode's own sharpness is not zero and the difference shows.
        page.click(".chip[data-mode='auto']")
        page.wait_for_timeout(150)
        page.click("#chip-sharpen")
        page.wait_for_timeout(120)
        rep.check("sharpening works from a mode that already sharpens",
                  page.evaluate("JS.activePage().adj.sharp") ==
                  page.evaluate("JS.SHARP_LEVELS[0]"),
                  page.evaluate("JS.activePage().adj.sharp"))
        for _ in range(3):
            page.click("#chip-sharpen")
            page.wait_for_timeout(120)
        auto_done = page.evaluate(SHARP_JS)
        rep.check("and the fourth tap puts back what Auto colour asked for, "
                  "which is not zero",
                  auto_done["level"] == 0
                  and auto_done["sharp"] == page.evaluate("JS.MODE_DEFAULTS.auto.sharp")
                  and auto_done["sharp"] > 0, auto_done)
        # It shares a row with the mode chips, so it must survive a mode change:
        # "sharpen, then pick Black & white" is the obvious order to do it in.
        page.click("#chip-sharpen")
        page.wait_for_timeout(120)
        page.click(".chip[data-mode='bw']")
        page.wait_for_timeout(150)
        carried = page.evaluate(SHARP_JS)
        rep.check("the step you set survives a change of mode",
                  carried["mode"] == "bw"
                  and carried["sharp"] == page.evaluate("JS.SHARP_LEVELS[0]"), carried)
        # Tapping it must not be a mode change. That is the whole reason it
        # carries no `data-mode`: a page can be Black & white *and* sharpened,
        # and the chips beside it are single-select.
        # The page arrives here on Black & white carrying step 1 from the mode
        # change above, so this asserts the step advances without the mode
        # moving -- which is what "not a mode" has to mean in practice.
        was_mode = page.evaluate("JS.activePage().mode")
        was_level = page.evaluate("JS.sharpenLevel(JS.activePage())")
        was_sharp = page.evaluate("JS.activePage().adj.sharp")
        page.click("#chip-sharpen")
        page.wait_for_timeout(120)
        now = page.evaluate("""() => {
            const p = JS.activePage();
            return { mode: p.mode, level: JS.sharpenLevel(p), sharp: p.adj.sharp };
        }""")
        rep.check("tapping Sharpen advances the step and leaves the mode alone",
                  now["mode"] == was_mode and now["level"] == was_level + 1
                  and now["sharp"] == page.evaluate("JS.SHARP_LEVELS[%d]"
                                                    % (was_level + 1 - 1)),
                  "%s/step %d/sharp %d -> %s/step %d/sharp %d"
                  % (was_mode, was_level, was_sharp, now["mode"], now["level"],
                     now["sharp"]))
        # And it is a real edit, so it has to clear the committed badge. The
        # badge is a state-key comparison, so this fails if `sharp` is not in
        # the key -- which is the only way it could silently go stale.
        page.evaluate("() => { const p = JS.activePage(); "
                      "p._bakedKey = JS.stateKey(p); }")
        rep.check("a page just committed off the back of it reads as committed",
                  page.evaluate("JS.isCommitted(JS.activePage())") is True)
        page.click("#chip-sharpen")
        page.wait_for_timeout(120)
        rep.check("and sharpening again clears the badge",
                  page.evaluate("JS.isCommitted(JS.activePage())") is False)
        page.click("#btn-undo-all")
        page.wait_for_timeout(150)
        rep.check("Undo all takes the sharpening back off with everything else",
                  page.evaluate("JS.activePage().adj.sharp") == 0
                  and page.evaluate("JS.sharpenLevel(JS.activePage())") == 0)

        print("\nthe manual crop: eight handles, corners and side midpoints")
        # Where the eight handles are, and where the preview box is, in one go —
        # every drag below is aimed in these coordinates rather than at numbers
        # written down here, so the checks hold at any viewport size.
        CROP_JS = """() => {
            const box = el => { const r = el.getBoundingClientRect();
                return {x: r.left, y: r.top, w: r.width, h: r.height}; };
            const hs = Array.prototype.map.call(
                document.querySelectorAll('.crop-handle'), h => {
                    const r = h.getBoundingClientRect();
                    return {cx: r.left + r.width / 2, cy: r.top + r.height / 2,
                            hit: r.width, dot: h.querySelector('.crop-dot').getBoundingClientRect().width};
                });
            const p = JS.activePage();
            return {on: JS.$('crop-layer').classList.contains('is-on'),
                    prev: box(JS.$('preview')), stage: box(JS.$('stage')), hs: hs,
                    corners: p.corners ? p.corners.map(c => [c.x, c.y]) : null,
                    pin: JS.cropPin, touched: p.touched, committed: JS.isCommitted(p)};
        }"""
        crop = page.evaluate(CROP_JS)
        # The same table as `HANDLES` in js/50-ui.js, written out here rather than
        # read from the page: a check that asks the code where it thinks the
        # handles go would agree with the code however wrong both were. Corners
        # and side midpoints both sit on the preview box, so one fraction pair per
        # handle covers all eight.
        HANDLE_AT = [(0, 0), (0.5, 0), (1, 0), (1, 0.5),
                     (1, 1), (0.5, 1), (0, 1), (0, 0.5)]
        rep.check("the handles are on the corners and side midpoints of the page",
                  crop["on"] and len(crop["hs"]) == 8
                  and all(abs(crop["hs"][i]["cx"] - (crop["prev"]["x"] + fx * crop["prev"]["w"])) < 1.5
                          and abs(crop["hs"][i]["cy"] - (crop["prev"]["y"] + fy * crop["prev"]["h"])) < 1.5
                          for i, (fx, fy) in enumerate(HANDLE_AT)),
                  "preview %s handles %s" % (crop["prev"], [(round(h["cx"]), round(h["cy"])) for h in crop["hs"]]))
        # Aiming at 17px with a thumb does not work, so the thing that gets
        # touched is much bigger than the thing that gets drawn.
        rep.check("the thing that gets touched is much bigger than the dot",
                  crop["hs"][0]["hit"] > 40 and crop["hs"][0]["dot"] < 22,
                  "hit %.0fpx, dot %.0fpx" % (crop["hs"][0]["hit"], crop["hs"][0]["dot"]))
        # The whole dot, not just its centre. The stage clips the layer, so a box
        # letterboxed to the stage's edges would draw four half-discs and leave the
        # outer handles with a dead pixel at the point that gets aimed at — which
        # is invisible until a drag near the edge silently does nothing. See
        # `HANDLE_PAD` in `js/50-ui.js`.
        rep.check("every handle is drawn whole inside the stage",
                  all(crop["stage"]["x"] <= h["cx"] - h["dot"] / 2
                      and h["cx"] + h["dot"] / 2 <= crop["stage"]["x"] + crop["stage"]["w"]
                      and crop["stage"]["y"] <= h["cy"] - h["dot"] / 2
                      and h["cy"] + h["dot"] / 2 <= crop["stage"]["y"] + crop["stage"]["h"]
                      for h in crop["hs"]),
                  "stage %s, handle 0 dot %.0f at %.0f,%.0f"
                  % (crop["stage"], crop["hs"][0]["dot"],
                     crop["hs"][0]["cx"], crop["hs"][0]["cy"]))
        rep.check("and the corner it marks is the corner of the photo",
                  abs(crop["prev"]["x"] + crop["prev"]["w"] - crop["hs"][2]["cx"]) < 1.5
                  and abs(crop["prev"]["y"] + crop["prev"]["h"] - crop["hs"][4]["cy"]) < 1.5,
                  "box right %.1f bottom %.1f against handles %.1f,%.1f"
                  % (crop["prev"]["x"] + crop["prev"]["w"],
                     crop["prev"]["y"] + crop["prev"]["h"],
                     crop["hs"][2]["cx"], crop["hs"][4]["cy"]))

        # Every drag below is a test of the *mapping* — where a finger's screen
        # position lands on the photo — and it is aimed and measured in the
        # preview box's own coordinates. Taking hold of a handle also zooms onto
        # it now (`JS.CORNER_ZOOM`), which doubles the box on screen and so
        # changes the numbers these drags were written against without changing
        # anything they are about. The zoom is turned off here and tested on its
        # own further down, which is the only way both claims get made properly.
        page.evaluate("JS.CORNER_ZOOM = 1")
        # The uncropped page is the case where the answer is known without any
        # homography at all: the map from the page back to the photo is the
        # identity, so the corner must land on the point on screen the finger
        # went to, to the pixel.
        pv = crop["prev"]
        dx, dy = 40.0, 70.0
        h0 = crop["hs"][0]
        # THE PICTURE ITSELF, held as bytes. The client's specification is that dragging a
        # handle moves the DOT and lets go to move the CROP: "when i click onto, say circle
        # at the top right and drag it, the app should let me position the white dot onto
        # the desired corner of the photo where i dragged the white dot to be. and when i
        # let go, it should then crop that edge/corner to that new white dot position."
        #
        # Nothing about the box can establish that. v1.12.0 held the box still - `cropPin`
        # was working - and re-warped the photograph INSIDE it on every move, because
        # `moveCropDrag` wrote `page.corners`, invalidated and re-rendered each time. So
        # the check is on the rendered canvas: byte-identical after eight moves means the
        # photograph did not move under the finger, and different after the release means
        # the crop is what caught up. The snapshot is taken AFTER the grab has rendered the
        # frozen frame, so the comparison starts from the frame the finger is actually on.
        page.evaluate("window.__shot = () => JS.$('preview').toDataURL()")
        page.mouse.move(h0["cx"], h0["cy"])
        page.mouse.down()
        page.wait_for_timeout(250)
        page.evaluate("window.__shot0 = window.__shot()")
        page.mouse.move(h0["cx"] + dx, h0["cy"] + dy, steps=8)
        page.wait_for_timeout(200)
        during = page.evaluate(CROP_JS)
        held = page.evaluate("window.__shot() === window.__shot0")
        page.mouse.up()
        page.wait_for_timeout(250)
        after = page.evaluate(CROP_JS)
        moved = page.evaluate("window.__shot() !== window.__shot0")
        want_x, want_y = dx / pv["w"], dy / pv["h"]
        rep.check("dragging a corner puts it where the finger went",
                  abs(after["corners"][0][0] - want_x) < 0.002
                  and abs(after["corners"][0][1] - want_y) < 0.002,
                  "corner %.5f,%.5f want %.5f,%.5f"
                  % (after["corners"][0][0], after["corners"][0][1], want_x, want_y))
        rep.check("the photograph does not move while the finger is down",
                  held, "the rendered page changed during the drag")
        # And the half of the specification that was already true, kept true: "the app
        # should let me position the white dot onto the desired corner of the photo where
        # i dragged the white dot to be" — the dot is ON the finger, not on the crop.
        rep.check("the dot under the finger travels with it",
                  abs(during["hs"][0]["cx"] - (h0["cx"] + dx)) < 1.5
                  and abs(during["hs"][0]["cy"] - (h0["cy"] + dy)) < 1.5,
                  "dot %.1f,%.1f, finger %.1f,%.1f"
                  % (during["hs"][0]["cx"], during["hs"][0]["cy"],
                     h0["cx"] + dx, h0["cy"] + dy))
        rep.check("and the crop is not written until the finger comes up",
                  during["corners"] == crop["corners"],
                  "quad during %s against %s before the drag"
                  % (during["corners"], crop["corners"]))
        rep.check("letting go is what crops it", moved,
                  "the rendered page is unchanged after the release")
        # The handles ride the corners of the box, so a box that resized itself
        # mid-drag would move the finger's own target. The pin is what stops it,
        # and it has to be up only for the length of the drag.
        rep.check("the frame holds its shape while the handle is being dragged",
                  during["pin"] > 0
                  and abs(during["prev"]["w"] - pv["w"]) < 2
                  and abs(during["prev"]["h"] - pv["h"]) < 2,
                  "pin %s, box %.1fx%.1f during against %.1fx%.1f before"
                  % (during["pin"], during["prev"]["w"], during["prev"]["h"], pv["w"], pv["h"]))
        rep.check("and is released when the finger comes up", after["pin"] == 0,
                  after["pin"])
        rep.check("the page counts as edited", after["touched"] is True, after["touched"])

        # A side handle moves its two corners together — the whole point of it,
        # since a side Auto crop got wrong is one drag instead of two corners that
        # have to be made to agree.
        #
        # It is driven on a quad set in from the edges, not on the whole photo:
        # a side that already spans the frame cannot slide sideways, and the check
        # would read as a failure of the drag rather than of the clamp. The quad
        # below maps the page to the photo as `photo = 0.1 + 0.8 * page`, so where
        # each corner must land follows from that and from nothing else.
        inset = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
        page.evaluate("""(a) => {
            const p = JS.activePage();
            p.corners = a.map(c => ({x: c[0], y: c[1]}));
            p.fine = 0;
            JS.invalidate(p);
            JS.renderPreview(true);
        }""", inset)
        page.wait_for_timeout(250)
        side = page.evaluate(CROP_JS)
        pv2 = side["prev"]
        # Index 1 is the top side, between the top-left and top-right corners.
        h1 = side["hs"][1]
        sdx, sdy = 30.0, 40.0
        page.mouse.move(h1["cx"], h1["cy"])
        page.mouse.down()
        page.wait_for_timeout(200)
        page.evaluate("window.__shot0 = window.__shot()")
        page.mouse.move(h1["cx"] + sdx, h1["cy"] + sdy, steps=8)
        page.wait_for_timeout(150)
        held_side = page.evaluate("window.__shot() === window.__shot0")
        page.mouse.up()
        page.wait_for_timeout(250)
        sd = page.evaluate(CROP_JS)["corners"]
        # A side is the odd branch of the same code, so the same two claims are made on
        # it: the picture is held while the finger travels, and what moves on release is
        # the crop. (The dots moving is what `draggedPts` does on both branches.)
        rep.check("a side drag holds the photograph still while the finger travels",
                  held_side, "the rendered page changed during the side drag")
        want_du, want_dv = 0.8 * sdx / pv2["w"], 0.8 * sdy / pv2["h"]
        rep.check("dragging a side moves both of its corners by the finger's own offset",
                  abs(sd[0][0] - (0.1 + want_du)) < 0.003
                  and abs(sd[0][1] - (0.1 + want_dv)) < 0.003
                  and abs(sd[1][0] - (0.9 + want_du)) < 0.003
                  and abs(sd[1][1] - (0.1 + want_dv)) < 0.003,
                  "corners %s want TL %.4f,%.4f TR %.4f,%.4f"
                  % ([[round(v, 4) for v in c] for c in sd], 0.1 + want_du, 0.1 + want_dv,
                     0.9 + want_du, 0.1 + want_dv))
        rep.check("and the side it did not touch has not moved",
                  abs(sd[2][0] - 0.9) < 0.003 and abs(sd[2][1] - 0.9) < 0.003
                  and abs(sd[3][0] - 0.1) < 0.003 and abs(sd[3][1] - 0.9) < 0.003,
                  "BR %s BL %s" % ([round(v, 4) for v in sd[2]], [round(v, 4) for v in sd[3]]))
        # The two corners must stay the same distance apart, whatever the drag did
        # in between. A side that read its corners back from the page rather than
        # from where the drag began would be handed the offset once per move and
        # the pair would stretch — which is the failure this check is for.
        rep.check("and the side is rigid, not stretched by the moves in between",
                  abs((sd[1][0] - sd[0][0]) - 0.8) < 0.003
                  and abs(sd[1][1] - sd[0][1]) < 0.003,
                  "side from %s to %s" % ([round(v, 4) for v in sd[0]],
                                          [round(v, 4) for v in sd[1]]))

        # The offset a side drag produces is not the finger's own: the side runs
        # along an edge, so a side already on that edge has to stop there rather
        # than push its far corner off the photo and have the whole move refused.
        # On the whole photo — every corner on the frame — down is the only way
        # the top side can go, and it has to go that way.
        page.evaluate("JS.undoAll()")
        page.wait_for_timeout(200)
        edge = page.evaluate(CROP_JS)
        pv3 = edge["prev"]
        h1 = edge["hs"][1]
        page.mouse.move(h1["cx"], h1["cy"])
        page.mouse.down()
        page.mouse.move(h1["cx"] + 30, h1["cy"] + 40, steps=8)
        page.wait_for_timeout(150)
        page.mouse.up()
        page.wait_for_timeout(250)
        se = page.evaluate(CROP_JS)["corners"]
        rep.check("a side already on the edge of the photo still moves along it",
                  se is not None
                  and abs(se[0][0]) < 0.003 and abs(se[1][0] - 1) < 0.003
                  and abs(se[0][1] - 40 / pv3["h"]) < 0.003
                  and abs(se[1][1] - se[0][1]) < 0.003,
                  "corners %s" % ([[round(v, 4) for v in c] for c in se] if se else None))

        # A page that is both cropped and turned a little, which is where the
        # whole chain has to be right at once. Two claims, and they are separate
        # on purpose: the map itself, and then a drag driven through it.
        #
        # The map first, with no handle involved. A projective map carries straight
        # lines to straight lines, so the middle of the finished page is the photo
        # point where the crop quad's diagonals cross — an answer computed from the
        # four corners alone, with no homography anywhere in it. Getting the
        # homography's direction wrong, or forgetting to take the fine angle back
        # out of it, moves that point.
        warp = [[0.20, 0.10], [0.85, 0.05], [0.90, 0.80], [0.15, 0.95]]

        def set_warp(fine):
            page.evaluate("""(a) => {
                const p = JS.activePage();
                p.corners = a.q.map(c => ({x: c[0], y: c[1]}));
                p.fine = a.fine;
                JS.invalidate(p);
                JS.renderPreview(true);
            }""", {"q": warp, "fine": fine})
            page.wait_for_timeout(200)

        def oriented_dims():
            return page.evaluate("""() => {
                const oc = JS.orientedCanvas(JS.activePage(), JS.PREVIEW_MAX);
                return [oc.width, oc.height];
            }""")

        crossing = None
        for fine_deg in (0.0, 8.0):
            set_warp(fine_deg)
            oc = oriented_dims()
            got = page.evaluate("""() => {
                const m = JS.cropMapper(JS.activePage())(0.5, 0.5);
                return [m.x, m.y];
            }""")
            want = diagonal_crossing(warp, fine_deg, oc)
            rep.check("the map puts the middle of the page on the photo point "
                      "where the crop's diagonals cross (%g deg)" % fine_deg,
                      abs(got[0] - want[0]) < 0.002 and abs(got[1] - want[1]) < 0.002,
                      "map %.5f,%.5f  crossing %.5f,%.5f"
                      % (got[0], got[1], want[0], want[1]))
            if fine_deg == 8.0:
                crossing = want
        rep.check("and the crossing is not simply the average of two corners, so "
                  "the check above has something to catch",
                  abs(crossing[0] - (warp[0][0] + warp[2][0]) / 2) > 0.005
                  or abs(crossing[1] - (warp[0][1] + warp[2][1]) / 2) > 0.005,
                  "crossing %s against the corner average %s"
                  % ([round(v, 4) for v in crossing],
                     [round((warp[0][k] + warp[2][k]) / 2, 4) for k in (0, 1)]))

        # Now a drag on that page, aimed at the middle of it — and it stops short,
        # which is the correct answer rather than a miss. The middle *is* the
        # crossing, and the crossing lies on the line between the dragged corner's
        # two neighbours: a corner sitting there makes the quad a triangle with a
        # dent in it, and `JS.quadOk` refuses the step. So the claim is that the
        # corner walked the map's path and stopped on the right side of that line,
        # which a map pointing the wrong way, or an affine one, would not do.
        set_warp(8.0)
        oc8 = oriented_dims()
        cw = page.evaluate(CROP_JS)
        pvw = cw["prev"]
        page.mouse.move(cw["hs"][2]["cx"], cw["hs"][2]["cy"])
        page.mouse.down()
        page.mouse.move(pvw["x"] + pvw["w"] / 2, pvw["y"] + pvw["h"] / 2, steps=10)
        page.mouse.up()
        page.wait_for_timeout(250)
        cw2 = page.evaluate(CROP_JS)
        q1 = cw2["corners"][1]

        def dist(a, b):
            return math.hypot(a[0] - b[0], a[1] - b[1])

        rep.check("a drag on a warped page walks the corner down the map's own path",
                  dist(q1, crossing) < 0.25
                  and dist(q1, crossing) < dist(warp[1], crossing) * 0.5,
                  "corner 1 %s, crossing %s, started %s"
                  % ([round(v, 4) for v in q1], [round(v, 4) for v in crossing],
                     [round(v, 4) for v in warp[1]]))

        # Distance to the line through the two neighbours, in the corners' own
        # frame — convexity is judged before the fine angle is applied, so the line
        # is the un-turned one.
        def fold_dist(quad, k):
            a, b = quad[(k + 3) % 4], quad[(k + 1) % 4]
            side = ((b[0] - a[0]) * (quad[k][1] - a[1])
                    - (b[1] - a[1]) * (quad[k][0] - a[0]))
            return abs(side) / math.hypot(b[0] - a[0], b[1] - a[1])

        rep.check("and stops before the fold line rather than crossing it",
                  fold_dist(cw2["corners"], 1) < fold_dist(warp, 1) * 0.35,
                  "%.5f from the fold line, was %.5f"
                  % (fold_dist(cw2["corners"], 1), fold_dist(warp, 1)))
        rep.check("the drag reached the picture, not only the state",
                  abs(cw2["prev"]["w"] / cw2["prev"]["h"]
                      - cw["prev"]["w"] / cw["prev"]["h"]) > 0.02,
                  "box %.3f -> %.3f" % (cw["prev"]["w"] / cw["prev"]["h"],
                                        cw2["prev"]["w"] / cw2["prev"]["h"]))

        # And once more on the quad that drag left behind, so this one is measured
        # against a shape the first drag changed. The middle of the page is the
        # crossing of the *new* diagonals, and it has moved because the quad did.
        quad_now = cw2["corners"]
        cross2 = diagonal_crossing(quad_now, 8.0, oc8)
        cw3 = page.evaluate(CROP_JS)
        pvw = cw3["prev"]
        page.mouse.move(cw3["hs"][0]["cx"], cw3["hs"][0]["cy"])
        page.mouse.down()
        page.mouse.move(pvw["x"] + pvw["w"] / 2, pvw["y"] + pvw["h"] / 2, steps=10)
        page.mouse.up()
        page.wait_for_timeout(250)
        cw4 = page.evaluate(CROP_JS)
        q0 = cw4["corners"][0]
        rep.check("the map is solved again for the quad a drag left behind",
                  dist(q0, cross2) < 0.3 and dist(q0, cross2) < dist(quad_now[0], cross2) * 0.7
                  and fold_dist(cw4["corners"], 0) < fold_dist(quad_now, 0) * 0.35,
                  "corner 0 %s, crossing %s, started %s (fold %.3f from %.3f)"
                  % ([round(v, 4) for v in q0], [round(v, 4) for v in cross2],
                     [round(v, 4) for v in quad_now[0]],
                     fold_dist(cw4["corners"], 0), fold_dist(quad_now, 0)))

        # A drag that would fold the quad over itself is refused rather than
        # rendered: the corner stops at the last place it was legal. The fold line
        # is the diagonal from corner 1 to corner 3, so the statement is that the
        # corner never crossed it — and that it did move, or the drag was ignored
        # rather than refused.
        page.evaluate("""() => {
            const p = JS.activePage();
            p.corners = [{x:.2,y:.2},{x:.8,y:.2},{x:.8,y:.8},{x:.2,y:.8}];
            p.fine = 0;
            JS.invalidate(p);
            JS.renderPreview(true);
        }""")
        page.wait_for_timeout(200)
        cf = page.evaluate(CROP_JS)
        pvf = cf["prev"]
        page.mouse.move(cf["hs"][0]["cx"], cf["hs"][0]["cy"])
        page.mouse.down()
        # Straight at the far corner of the triangle the other three make.
        page.mouse.move(pvf["x"] + pvf["w"] * 0.6, pvf["y"] + pvf["h"] * 0.6, steps=8)
        page.mouse.up()
        page.wait_for_timeout(250)
        cf2 = page.evaluate(CROP_JS)
        quad = cf2["corners"]
        turns = []
        for i in range(4):
            a, b, c = quad[i], quad[(i + 1) % 4], quad[(i + 2) % 4]
            turns.append((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]))
        rep.check("a drag that would fold the page over itself is refused",
                  all(t > 0 for t in turns) or all(t < 0 for t in turns),
                  "quad %s turns %s" % ([[round(v, 3) for v in q] for q in quad],
                                        [round(t, 4) for t in turns]))
        rep.check("the corner moved but never crossed the fold",
                  quad[0][0] > 0.3 and quad[0][0] + quad[0][1] <= 1.0 + 1e-6,
                  "corner 0 %s, fold is x+y=1" % ([round(v, 4) for v in quad[0]]))

        # A page that had been committed stops being committed once its crop is
        # dragged by hand — the same state key that drives the grid badge.
        page.evaluate("JS.commitPage(JS.activePage())")
        page.wait_for_timeout(400)
        # Commit does not re-render on its own — the Done button does that on its
        # way out — so the box under the handles is still the pre-commit one until
        # something renders. The drag would then be measured against geometry that
        # is no longer on screen.
        page.evaluate("JS.renderPreview(true)")
        page.wait_for_timeout(200)
        rep.check("the page is committed before the drag",
                  page.evaluate("JS.isCommitted(JS.activePage())"))
        rep.check("and committing put the whole photo back in frame",
                  page.evaluate("JS.activePage().corners === null"))
        cc = page.evaluate(CROP_JS)
        page.mouse.move(cc["hs"][4]["cx"], cc["hs"][4]["cy"])
        page.mouse.down()
        page.mouse.move(cc["hs"][4]["cx"] - 30, cc["hs"][4]["cy"] - 40, steps=6)
        page.mouse.up()
        page.wait_for_timeout(300)
        rep.check("a hand-dragged crop un-commits it, so the grid badge clears",
                  not page.evaluate("JS.isCommitted(JS.activePage())"))

        # Undo all takes the crop with it, and the handles go back to the corners
        # of the whole photo.
        page.click("#btn-undo-all")
        page.wait_for_timeout(250)
        cu = page.evaluate(CROP_JS)
        rep.check("Undo all takes the hand-dragged crop back too", cu["corners"] is None,
                  cu["corners"])
        rep.check("and the handles are back on the corners of the whole photo",
                  abs((cu["hs"][0]["cx"] - cu["prev"]["x"])) < 1.5
                  and abs((cu["hs"][0]["cy"] - cu["prev"]["y"])) < 1.5)
        rep.check("the handles are gone when the editor is not the view",
                  page.evaluate("""() => {
                      JS.setView('home');
                      const off = !JS.$('crop-layer').classList.contains('is-on');
                      JS.openEditor(0);
                      return off && JS.$('crop-layer').classList.contains('is-on');
                  }"""))

        print("\nzooming in on the page")
        # The user's words: "allow the picture to be zoom in and out when i pinch
        # as sometimes I want to see if the words are clear or legible or not,
        # and zoom into the corner when i move the corner dot manually to crop".
        #
        # Two gestures, and they are tested through the app's own event path
        # rather than by calling the view functions — `pointerdown` on the stage
        # for the pan, on a handle for the grab — because the wiring is half of
        # what could be wrong. `JS.getView` is the only thing read back.
        page.evaluate("JS.CORNER_ZOOM = 2")
        page.goto(PAGE_URL)
        page.wait_for_function("!!window.JS && !!JS.app")
        page.set_input_files("#file-gallery", photo)
        page.wait_for_function("JS.app.pages.length === 1", timeout=15000)
        page.evaluate("JS.openEditor(0)")
        page.wait_for_function("JS.app.view === 'edit'")
        page.wait_for_timeout(300)

        cz = page.evaluate(CROP_JS)
        rep.check("a page opens fitted, with no zoom to undo",
                  page.evaluate("JS.getView()") == {"z": 1, "tx": 0, "ty": 0},
                  page.evaluate("JS.getView()"))

        def view():
            return page.evaluate("JS.getView()")

        # A one-finger drag on the page at fit zoom must do nothing at all. There
        # is no scrollbar and no reset button, so an unzoomed page that could be
        # nudged off-centre would be a page the user cannot get back — and the
        # first thing a thumb does on a photo is try to move it.
        v0 = view()
        page.mouse.move(cz["prev"]["x"] + cz["prev"]["w"] / 2,
                        cz["prev"]["y"] + cz["prev"]["h"] / 2)
        page.mouse.down()
        page.mouse.move(cz["prev"]["x"] + cz["prev"]["w"] / 2 + 70,
                        cz["prev"]["y"] + cz["prev"]["h"] / 2 + 50, steps=6)
        page.mouse.up()
        page.wait_for_timeout(200)
        rep.check("a drag on an unzoomed page moves nothing",
                  view() == v0, "%s -> %s" % (v0, view()))

        # Grabbing a handle zooms onto that corner, and the corner must stay
        # under the finger: a dot that jumps out from under the thumb that took
        # it, and then travels at a speed the finger is not moving at, is worse
        # than not zooming at all. Checked at all four, because the clamp that
        # keeps the page on screen is the thing that could move them.
        for k, name in ((0, "top-left"), (2, "top-right"), (4, "bottom-right"),
                        (6, "bottom-left")):
            page.evaluate("JS.undoAll()")       # also resets the view
            page.wait_for_timeout(150)
            c = page.evaluate(CROP_JS)
            h = c["hs"][k]
            page.mouse.move(h["cx"], h["cy"])
            page.mouse.down()
            page.wait_for_timeout(60)
            v = view()
            # Where the corner it is holding is drawn now, against where the
            # finger is holding it. `hs` is in client coordinates and so is the
            # handle's own centre, so the two are directly comparable.
            drawn = page.evaluate("""(p) => {
                const s = JS.viewToScreen(JS.getView(), p.x, p.y);
                const r = JS.$('stage').getBoundingClientRect();
                return { x: s.x + r.left + JS.$('stage').clientLeft, y: s.y + r.top };
            }""", {"x": h["cx"] - c["stage"]["x"] - 1, "y": h["cy"] - c["stage"]["y"] - 1})
            rep.check("grabbing the %s handle zooms onto it" % name,
                      abs(v["z"] - 2) < 0.001, "z %.3f" % v["z"])
            rep.check("and the %s corner stays under the finger" % name,
                      abs(drawn["x"] - h["cx"]) < 2 and abs(drawn["y"] - h["cy"]) < 2,
                      "corner at %.1f,%.1f against the finger at %.1f,%.1f"
                      % (drawn["x"], drawn["y"], h["cx"], h["cy"]))
            page.mouse.up()
            page.wait_for_timeout(200)
            rep.check("letting go of the %s handle puts the view back" % name,
                      view() == {"z": 1, "tx": 0, "ty": 0}, view())

        # And while it is zoomed, the dot still tracks the finger one-for-one on
        # screen: 40px of finger is 40px of dot, which is 40/(w*z) of the page.
        # A drag that forgot to divide by the zoom would move the corner twice
        # as far as the finger, which is exactly the bug this is here for.
        page.evaluate("JS.undoAll()")
        page.wait_for_timeout(150)
        c = page.evaluate(CROP_JS)
        h = c["hs"][0]
        page.mouse.move(h["cx"], h["cy"])
        page.mouse.down()
        page.wait_for_timeout(60)
        z = view()["z"]
        # Read *after* the grab, because the grab is what zooms: the box the
        # finger is now dragging across is the preview's own rect as the view
        # scales it, `w * z`, and measuring against the unzoomed width is how
        # this check first failed — the corner looked half a page short of the
        # finger when it was exactly under it.
        zoomed_w = page.evaluate("JS.$('preview').getBoundingClientRect().width")
        page.mouse.move(h["cx"] + 40, h["cy"] + 60, steps=8)
        page.wait_for_timeout(120)
        # While the finger is down the crop has not moved — that is the whole point of the
        # two-phase drag — so the reading that is compared with the finger is the one taken
        # after the release. What is read here is the opposite claim: the drag left the
        # photograph alone until the finger came up.
        during_zoom = page.evaluate("JS.getCorners(JS.activePage())[0]")
        page.mouse.up()
        page.wait_for_timeout(200)
        moved = page.evaluate("JS.getCorners(JS.activePage())[0]")
        rep.check("and the drag does not move the corner until the finger comes up",
                  during_zoom["x"] == 0 and during_zoom["y"] == 0,
                  "corner %s during the drag" % (during_zoom,))
        want_u = 40.0 / zoomed_w
        want_v = 60.0 / (zoomed_w * c["prev"]["h"] / c["prev"]["w"])
        rep.check("a drag while zoomed still tracks the finger one-for-one",
                  abs(moved["x"] - want_u) < 0.002 and abs(moved["y"] - want_v) < 0.002,
                  "corner %.5f,%.5f want %.5f,%.5f (zoom %.1f, box %.0f)"
                  % (moved["x"], moved["y"], want_u, want_v, z, zoomed_w))
        rep.check("and the crop it made is real, not just a moved dot",
                  page.evaluate("JS.activePage().corners !== null"))

        # The pinch itself. Two fingers on the stage, driven through the app's
        # own handlers with synthetic pointer events — which is enough here, and
        # is not enough for a handle, because a handle takes pointer capture and
        # a synthetic event cannot. The claim is the one that makes a pinch feel
        # attached to the hand: the point between the fingers does not move.
        #
        # The two fingers are opened and their midpoint moved at the same time,
        # because that is what a real pinch does.
        page.evaluate("JS.undoAll()")
        page.wait_for_timeout(150)
        c = page.evaluate(CROP_JS)
        sx, sy = c["stage"]["x"], c["stage"]["y"]
        sw, sh = c["stage"]["w"], c["stage"]["h"]
        mid = (sx + sw / 2, sy + sh / 2)
        held = page.evaluate("""(p) => JS.viewToStage(JS.getView(), p.x, p.y)""",
                             {"x": sw / 2, "y": sh / 2})
        page.evaluate("""(a) => {
            const st = JS.$('stage');
            const fire = (type, pts, target) => {
                pts.forEach(p => (target || window).dispatchEvent(
                    new PointerEvent(type, {pointerId: p.id, clientX: p.x,
                                            clientY: p.y, bubbles: true})));
            };
            fire('pointerdown', [{id: 1, x: a.mx - 30, y: a.my},
                                 {id: 2, x: a.mx + 30, y: a.my}], st);
            window.__pinch = () => {
                for (let i = 1; i <= 6; i++) {
                    const half = 30 + 45 * i / 6, dy = 20 * i / 6;
                    fire('pointermove', [{id: 1, x: a.mx - half, y: a.my + dy},
                                         {id: 2, x: a.mx + half, y: a.my + dy}]);
                }
                fire('pointerup', [{id: 1, x: a.mx, y: a.my},
                                   {id: 2, x: a.mx, y: a.my}]);
            };
        }""", {"mx": mid[0], "my": mid[1]})
        page.evaluate("window.__pinch()")
        page.wait_for_timeout(250)
        v = view()
        rep.check("a two-finger pinch zooms the page in", v["z"] > 2.4,
                  "z %.3f" % v["z"])
        # Where the finger-midpoint was holding the page at the start is where it
        # must still be holding it: the pinch opened about its own centre and
        # then carried that centre down the screen, so the page point under the
        # fingers is the same one, shifted by exactly the drift.
        now = page.evaluate("""(p) => JS.viewToStage(JS.getView(), p.x, p.y)""",
                            {"x": sw / 2, "y": sh / 2 + 20})
        rep.check("and holds the page under the fingers while it does",
                  abs(now["x"] - held["x"]) < 1.5 and abs(now["y"] - held["y"]) < 1.5,
                  "page point %.1f,%.1f was %.1f,%.1f" % (now["x"], now["y"],
                                                          held["x"], held["y"]))

        # Undo all is the way back from a zoom as well as from a crop: a page
        # left magnified with no visible control to un-magnify it would be a page
        # the user has to guess at.
        page.evaluate("JS.undoAll()")
        page.wait_for_timeout(200)
        rep.check("Undo all puts the view back to fitted",
                  view() == {"z": 1, "tx": 0, "ty": 0}, view())

        # Done above released the original on purpose — that is what committing
        # means, and Undo all cannot bring back pixels it no longer has. The
        # sections below measure the imported photo's own geometry, so this one is
        # finished with; start a clean page rather than hand them a committed one.
        page.goto(PAGE_URL)
        page.wait_for_function("!!window.JS && !!JS.app")
        page.set_input_files("#file-gallery", photo)
        page.wait_for_function("JS.app.pages.length === 1", timeout=15000)
        page.evaluate("JS.openEditor(0)")
        page.wait_for_function("JS.app.view === 'edit'")
        page.wait_for_timeout(300)
        rep.check("a fresh page starts with the whole photo and no crop",
                  page.evaluate("""() => {
                      const p = JS.activePage();
                      return p.corners === null && p.fine === 0 && p.coarse === 0;
                  }"""))

        print("\nrotate")
        # The rotate buttons are the only way to straighten a page auto-detect
        # cannot find, so they need their own check — and this is where a real
        # bug lived: turning the corners without re-indexing the quad left the
        # output frame unturned, so the state advanced (coarse 0 -> 90) and the
        # picture on screen did not move. Nothing caught it because no test
        # pressed the button.
        def aspect():
            r = page.eval_on_selector(
                "#preview", "el => { const b = el.getBoundingClientRect(); return {w: b.width, h: b.height}; }")
            return r["w"] / r["h"]

        src_aspect = IMG_W / float(IMG_H)
        rep.check("upright to begin with", abs(aspect() - src_aspect) < 0.03,
                  "aspect %.3f want %.3f" % (aspect(), src_aspect))

        page.click("#btn-rot-r")
        page.wait_for_timeout(200)
        turned = aspect()
        rep.check("rotate right turns the page and its frame together",
                  abs(turned - 1.0 / src_aspect) < 0.03 and abs(turned - src_aspect) > 0.3,
                  "aspect %.3f -> %.3f, expected %.3f"
                  % (src_aspect, turned, 1.0 / src_aspect))

        page.click("#btn-rot-l")
        page.wait_for_timeout(200)
        rep.check("rotate left turns it back",
                  abs(aspect() - src_aspect) < 0.03,
                  "aspect %.3f want %.3f" % (aspect(), src_aspect))

        print("\nshadow removal (continuous tone)")
        # Crop to the page so nothing but paper is measured.
        page.evaluate("""() => {
            const p = JS.activePage();
            p.corners = [
                {x: %f, y: %f}, {x: %f, y: %f},
                {x: %f, y: %f}, {x: %f, y: %f}
            ];
            p.mode = 'auto';
            JS.invalidate(p);
        }""" % (PAGE[0] / IMG_W, PAGE[1] / IMG_H, PAGE[2] / IMG_W, PAGE[1] / IMG_H,
                PAGE[2] / IMG_W, PAGE[3] / IMG_H, PAGE[0] / IMG_W, PAGE[3] / IMG_H))

        def halves(flat):
            return page.evaluate("""(flat) => {
                const p = JS.activePage();
                p.adj.flat = flat;
                JS.invalidate(p);
                JS.renderPreview(true);
                const el = JS.$('preview');
                const g = JS.ctx2d(el, true);
                const d = g.getImageData(0, 0, el.width, el.height).data;
                // Mean luminance of the left quarter and the right quarter,
                // over the middle half of the rows so the edges do not skew it.
                const band = (x0, x1) => {
                    let s = 0, n = 0;
                    for (let y = (el.height * 0.25) | 0; y < el.height * 0.75; y++) {
                        for (let x = x0; x < x1; x++) {
                            const o = (y * el.width + x) * 4;
                            s += (d[o] * 299 + d[o+1] * 587 + d[o+2] * 114) / 1000;
                            n++;
                        }
                    }
                    return s / n;
                };
                return { shadow: band(0, (el.width * 0.2) | 0),
                         lit:    band((el.width * 0.8) | 0, el.width) };
            }""", flat)

        off = halves(0)
        on = halves(90)
        print("        without removal: shadow %.1f  lit %.1f  (gap %.1f)"
              % (off["shadow"], off["lit"], off["lit"] - off["shadow"]))
        print("        with removal:    shadow %.1f  lit %.1f  (gap %.1f)"
              % (on["shadow"], on["lit"], on["lit"] - on["shadow"]))

        rep.check("the page really is shadowed to begin with: %s" % round(off["lit"] - off["shadow"]),
                  off["lit"] - off["shadow"] > 40, off)
        rep.check("shadow removal lifts the shadowed paper",
                  on["shadow"] - off["shadow"] > 45, "%.1f -> %.1f" % (off["shadow"], on["shadow"]))
        rep.check("it closes the gap between the two halves",
                  (on["lit"] - on["shadow"]) < (off["lit"] - off["shadow"]) * 0.45,
                  "gap %.1f -> %.1f" % (off["lit"] - off["shadow"], on["lit"] - on["shadow"]))
        rep.check("the already-lit paper is not dragged down with it",
                  abs(on["lit"] - off["lit"]) < 30, "%.1f -> %.1f" % (off["lit"], on["lit"]))

        print("\nAuto clean removes the shadow, on a receipt")
        # The section above sets `flat` by hand, so it stayed green the entire
        # time a shadow people could actually see was surviving: it measures the
        # flattening maths, not the button. The button applies the Auto colour
        # preset, and that preset asked for flat=45 — a blend less than half
        # applied, which leaves 54% of a shadow's depth on the paper. Nothing
        # pressed #btn-magic and looked at what came out of it.
        page.goto(PAGE_URL)
        page.wait_for_function("!!window.JS && !!JS.app")
        page.set_input_files("#file-gallery", receipt_photo)
        page.wait_for_function("JS.app.pages.length === 1", timeout=15000)
        page.evaluate("JS.openEditor(0)")
        page.wait_for_function("JS.app.view === 'edit'")

        # Crop to the strip, so both measured bands are paper. A fresh page has
        # no corners, and measuring the full frame would sample the desk.
        page.evaluate("""() => {
            const p = JS.activePage();
            p.corners = [
                {x: %f, y: %f}, {x: %f, y: %f},
                {x: %f, y: %f}, {x: %f, y: %f}
            ];
            p.mode = 'auto';
            JS.invalidate(p);
        }""" % (RECEIPT[0] / IMG_W, RECEIPT[1] / IMG_H, RECEIPT[2] / IMG_W, RECEIPT[1] / IMG_H,
                RECEIPT[2] / IMG_W, RECEIPT[3] / IMG_H, RECEIPT[0] / IMG_W, RECEIPT[3] / IMG_H))

        # Reports both the mean and the paper level. The mean is printed for
        # context, but nothing is asserted on it -- see SHADOW_GAP_MAX above.
        GAP_JS = """() => {
            const el = JS.$('preview');
            const g = JS.ctx2d(el, true);
            const d = g.getImageData(0, 0, el.width, el.height).data;
            const band = (x0, x1) => {
                const vals = [];
                let s = 0;
                for (let y = (el.height * 0.25) | 0; y < el.height * 0.75; y++) {
                    for (let x = x0; x < x1; x++) {
                        const o = (y * el.width + x) * 4;
                        const v = (d[o] * 299 + d[o+1] * 587 + d[o+2] * 114) / 1000;
                        vals.push(v); s += v;
                    }
                }
                vals.sort((a, b) => a - b);
                return { mean: s / vals.length,
                         paper: vals[Math.floor(vals.length * 0.9)] };
            };
            return { shadow: band(0, (el.width * 0.2) | 0),
                     lit:    band((el.width * 0.8) | 0, el.width) };
        }"""

        # With removal switched off first, so the fixture is shown to carry a
        # shadow rather than assumed to.
        page.evaluate("""() => {
            const p = JS.activePage();
            p.adj.flat = 0;
            JS.invalidate(p);
            JS.renderPreview(true);
        }""")
        bare = page.evaluate(GAP_JS)
        bare_gap = bare["lit"]["paper"] - bare["shadow"]["paper"]

        page.click("#btn-magic")
        page.wait_for_timeout(300)
        mode = page.evaluate("JS.activePage().mode")
        flat = page.evaluate("JS.activePage().adj.flat")
        clean = page.evaluate(GAP_JS)
        clean_gap = clean["lit"]["paper"] - clean["shadow"]["paper"]

        print("        Auto clean chose mode %s, flat %s" % (mode, flat))
        print("        no removal:  paper %.1f vs %.1f  (gap %.1f)   mean %.1f vs %.1f"
              % (bare["shadow"]["paper"], bare["lit"]["paper"], bare_gap,
                 bare["shadow"]["mean"], bare["lit"]["mean"]))
        print("        Auto clean:  paper %.1f vs %.1f  (gap %.1f)   mean %.1f vs %.1f"
              % (clean["shadow"]["paper"], clean["lit"]["paper"], clean_gap,
                 clean["shadow"]["mean"], clean["lit"]["mean"]))

        rep.check("the receipt really is shadowed to begin with",
                  bare_gap > 40, "paper gap %.1f" % bare_gap)
        rep.check("Auto clean stays in the continuous-tone mode it was reported in",
                  mode == "auto", "mode %s" % mode)
        rep.check("Auto clean lifts the paper on the shadowed side to match the lit side",
                  clean_gap < SHADOW_GAP_MAX,
                  "paper gap %.1f, want < %d" % (clean_gap, SHADOW_GAP_MAX))

        print("\nauto detect on a page that runs off the frame")
        # The reported case, and the gap that let it ship: every other test here
        # sets p.corners by hand, so nothing pressed #btn-auto and looked at
        # where it landed. Start clean, because the checks above have been
        # moving this page around.
        #
        # What this pins is the *behaviour* — a sheet that fills the frame keeps
        # its width and its top and loses only the floor — which is what the
        # user asked for and what the crop has to do whatever the detector does
        # inside. It is not the regression guard for the detector bug: on this
        # photo the old boundaryPixels happened to be corrected downstream, so
        # this section passes either way. The guard for that lives in smoke.js,
        # where the boundary points themselves are counted.
        page.goto(PAGE_URL)
        page.wait_for_function("!!window.JS && !!JS.app")
        page.set_input_files("#file-gallery", full_photo)
        page.wait_for_function("JS.app.pages.length === 1", timeout=15000)
        page.evaluate("JS.openEditor(0)")
        page.wait_for_function("JS.app.view === 'edit'")

        page.click("#btn-auto")
        moved = True
        try:
            # corners is null until the detect lands, one yielded frame in, so
            # the poll has to survive that rather than throw on it.
            page.wait_for_function(
                "() => { const p = JS.activePage();"
                " return !!p && !!p.corners && Math.abs(p.corners[2].y - 1) > 0.02; }",
                timeout=20000)
        except Exception as exc:
            moved = False
            print("        wait failed: %s" % str(exc).split("\n")[0])
        rep.check("Auto detect finds an edge and moves the crop at all", moved)

        page.wait_for_timeout(200)
        q = page.evaluate("JS.activePage().corners")
        left, right = q[0]["x"], q[1]["x"]
        top, bottom = q[0]["y"], q[2]["y"]
        area = (right - left) * (bottom - top)
        print("        crop x %.3f..%.3f  y %.3f..%.3f  (area %.2f, page ends at %.3f)"
              % (left, right, top, bottom, area, FULL_PAGE_FRAC))

        # The sheet runs off three sides of the frame, so there is nothing to
        # find there and the crop must leave them where they are. The one edge
        # that exists is the bottom, at 900/1200 of the frame.
        rep.check("the full width of the sheet is kept",
                  left < 0.05 and right > 0.95, "x %.3f..%.3f" % (left, right))
        rep.check("the top edge is kept",
                  top < 0.05, "y %.3f" % top)
        rep.check("the floor is cropped off the bottom",
                  0.70 < bottom < 0.80, "y %.3f want %.3f" % (bottom, FULL_PAGE_FRAC))
        # The bug's signature was a quad around the paragraph margins, roughly
        # 0.70 wide by 0.55 tall. Any crop that keeps the sheet is far larger.
        rep.check("the crop is the sheet, not the block of text",
                  area > 0.65, "area %.2f" % area)
        fine = page.evaluate("JS.activePage().fine")
        rep.check("an already-upright page is not rotated",
                  abs(fine) < 2.0, "fine %.2f deg" % fine)

        # And the pixels agree: the bottom of what is on screen is paper, not
        # floor. The corner assertions could all pass on a preview that never
        # got re-rendered.
        bands = page.evaluate("""() => {
            const el = JS.$('preview');
            const g = JS.ctx2d(el, true);
            const d = g.getImageData(0, 0, el.width, el.height).data;
            const rows = (y0, y1) => {
                let s = 0, n = 0;
                for (let y = y0; y < y1; y++) for (let x = 0; x < el.width; x++) {
                    const o = (y * el.width + x) * 4;
                    s += (d[o] * 299 + d[o+1] * 587 + d[o+2] * 114) / 1000;
                    n++;
                }
                return s / n;
            };
            return { bottom: rows(Math.max(0, el.height - Math.round(el.height * 0.05)), el.height),
                     middle: rows((el.height * 0.45) | 0, (el.height * 0.55) | 0) };
        }""")
        print("        rendered luminance: middle %.1f  bottom strip %.1f"
              % (bands["middle"], bands["bottom"]))
        rep.check("the rendered preview ends on paper, not on the floor",
                  bands["bottom"] > bands["middle"] * 0.6 and bands["bottom"] > 120,
                  bands)

        print("\nauto all: the crop and the clean in one tap, on a receipt")
        # A button nothing had ever pressed. `JS.autoAll` was written into the
        # pipeline and no listener called it, so this is its first run.
        #
        # A receipt is the page this used to read the shape for: the strip is
        # 220x1060 of the frame, 4.8:1 against the old 2.1 cutoff, and the only
        # shape that ever reached `receipt`. Auto all no longer consults the
        # shape at all, so this is now the page that proves it does not — the
        # strip is left in Auto colour like any other, and Receipt is reached
        # from its chip or not at all.
        page.goto(PAGE_URL)
        page.wait_for_function("!!window.JS && !!JS.app")
        page.set_input_files("#file-gallery", receipt_photo)
        page.wait_for_function("JS.app.pages.length === 1", timeout=15000)
        page.evaluate("JS.openEditor(0)")
        page.wait_for_function("JS.app.view === 'edit'")
        page.wait_for_timeout(200)

        STATE = """() => { const p = JS.activePage();
            return { mode: p.mode, corners: p.corners, touched: p.touched,
                     flat: p.adj.flat, thr: p.adj.thr, sharp: p.adj.sharp,
                     contrast: p.adj.contrast, sat: p.adj.sat, wb: p.adj.wb }; }"""

        # Flatten the tone before pressing, so that "it cleaned" is a claim this
        # can falsify. `JS.createPage` takes a page's opening flat and sharpness
        # *from* the Auto colour preset, so on an untouched page Auto all would
        # leave them exactly where it found them and the check below could not
        # tell cleaning apart from doing nothing at all.
        page.evaluate("""() => { const p = JS.activePage();
            p.adj.flat = 0; p.adj.thr = 0; p.adj.sharp = 0;
            p.adj.contrast = 0; p.adj.sat = 0; p.adj.wb = 0;
            JS.invalidate(p); }""")

        before = page.evaluate(STATE)
        before_ar = page.evaluate(
            "() => { const el = JS.$('preview'); return el.width / el.height; }")
        print("        before: mode %s corners %s tone %s/%s/%s/%s/%s"
              % (before["mode"], before["corners"], before["flat"], before["thr"],
                 before["sharp"], before["contrast"], before["sat"]))
        rep.check("a fresh page is uncropped, in Auto colour, with its tone flattened",
                  before["corners"] is None and before["mode"] == "auto" and
                  before["flat"] == 0 and before["sharp"] == 0,
                  "mode %s corners %s flat %s"
                  % (before["mode"], before["corners"], before["flat"]))

        page.click("#btn-all")
        # Waiting on the finished state rather than on the click: the crop is
        # yielded a frame in, the mode is set after it, and the render follows
        # both. A button that cropped but never cleaned would satisfy a wait on
        # `touched` alone.
        try:
            page.wait_for_function(
                "() => { const p = JS.activePage();"
                " return !!p && p.touched && !!p.corners && p.adj.flat > 0; }",
                timeout=20000)
            landed = True
        except Exception as exc:
            landed = False
            print("        wait failed: %s" % str(exc).split("\n")[0])
        rep.check("Auto all lands a crop and a clean", landed)

        page.wait_for_function("document.getElementById('busy').hidden", timeout=10000)
        after = page.evaluate(STATE)
        rep.check("Auto all preserves the selected tone mode",
                  after["mode"] == before["mode"],
                  "before %s after %s" % (before["mode"], after["mode"]))
        q = after["corners"]
        if q:
            print("        after:  mode %s thr %s sharp %s  crop x %.3f..%.3f y %.3f..%.3f"
                  % (after["mode"], after["thr"], after["sharp"],
                     q[0]["x"], q[1]["x"], q[0]["y"], q[2]["y"]))
        else:
            print("        after:  mode %s corners %s" % (after["mode"], q))

        # The crop half. The strip is 220/900 of the frame wide and runs from
        # 90/1200 to 1150/1200 tall, so a crop that found it is far narrower
        # than the frame and taller than 80% of it. The tolerance is loose on
        # purpose: this is about the crop happening and being the strip, not
        # about the detector's sub-pixel edges, which smoke.js measures.
        rep.check("Auto all crops the receipt out of the frame",
                  q and (q[1]["x"] - q[0]["x"]) < 0.45 and (q[2]["y"] - q[0]["y"]) > 0.80,
                  "x %.3f..%.3f y %.3f..%.3f" % (q[0]["x"], q[1]["x"],
                                                 q[0]["y"], q[2]["y"]) if q else "no corners")

        # The clean half. Two separate claims, and they are now the opposite of
        # what they were: the mode is *not* chosen from the page's shape, and
        # the tone is the preset of whatever mode was already in force.
        rep.check("Auto all leaves the mode alone, even on a 4.8:1 page it used "
                  "to switch to Receipt",
                  after["mode"] == "auto", "mode %s" % after["mode"])
        rep.check("and Auto all changes cleanup controls only, not colour/tone controls",
                  page.evaluate("""() => {
                      const p = JS.activePage(), d = JS.MODE_DEFAULTS[p.mode];
                      return p.adj.flat === d.flat && p.adj.thr === d.thr &&
                             p.adj.sharp === d.sharp &&
                             p.adj.contrast === 0 && p.adj.sat === 0 && p.adj.wb === 0;
                  }"""),
                  "cleanup %s/%s/%s colour %s/%s/%s"
                  % (after["flat"], after["thr"], after["sharp"],
                     after["contrast"], after["sat"], after["wb"]))

        # The crop has to reach the pixels, not stop at `page.corners`. The
        # preview canvas *is* the page — `fitBox` sizes it to the image — so a
        # crop that rendered is a canvas of a different shape, and the two
        # shapes here are not close: the frame is 900x1200 (0.75) and the strip
        # comes out ~120x1004 (0.12).
        AR = "() => { const el = JS.$('preview'); return el.width / el.height; }"
        after_ar = page.evaluate(AR)
        print("        preview aspect: frame %.3f -> strip %.3f" % (before_ar, after_ar))
        rep.check("the crop reaches the rendered pixels, not just the state",
                  before_ar > 0.5 and after_ar < 0.25,
                  "%.3f -> %.3f" % (before_ar, after_ar))

        # The hint is the only place the crop half is reported. It used to name
        # the mode as well, which was the only way to say what Auto all had
        # switched the page to; now that it switches nothing and every mode has
        # a lit chip above it, naming the mode here would be repeating the row.
        # Read before the mode is changed below, which is the last thing on this
        # page that touches anything Auto all did.
        hint = page.evaluate("JS.$('stage-hint').textContent")
        print("        hint: %r" % hint)
        rep.check("Auto all reports the crop half and the tilt",
                  "Cropped" in hint and "tilt" in hint, hint)
        rep.check("and does not repeat the mode the lit chip is already naming",
                  "Auto colour" not in hint and "Receipt" not in hint, hint)

        # ---- does Auto clean do anything Auto all did not? ----------------
        # The user's report: Auto all leaves shadows, Auto clean then clears
        # them, so does Auto clean compound? It cannot — autoEnhance assigns
        # absolute per-mode values and is idempotent, and autoAll calls it — but
        # "it cannot" is a claim about code, and these are the measurements that
        # make it a claim about the app. Since 1.6.0 Auto all leaves the mode
        # alone, so this compares the two buttons on the one mode where they
        # could still differ for a real reason: whether the crop changed what
        # there was to clean.
        CHROME = """() => {
            const p = JS.activePage();
            const chips = Array.prototype.map.call(JS.$('mode-chips').children,
                c => c.dataset.mode + (c.classList.contains('is-active') ? '*' : ''));
            const el = JS.$('preview');
            const g = JS.ctx2d(el, true);
            const d = g.getImageData(0, 0, el.width, el.height).data;
            let h = 2166136261;
            for (let i = 0; i < d.length; i += 4) {
                h ^= d[i]; h = Math.imul(h, 16777619);
                h ^= d[i+1]; h = Math.imul(h, 16777619);
                h ^= d[i+2]; h = Math.imul(h, 16777619);
            }
            return { key: JS.stateKey(p), mode: p.mode, chips: chips.join(' '),
                     name: JS.$('mode-name').textContent,
                     px: el.width + 'x' + el.height + ':' + (h >>> 0).toString(16) }; }"""
        all_state = page.evaluate(CHROME)
        print("        after Auto all:   %s | chips %r | title %r"
              % (all_state["mode"], all_state["chips"], all_state["name"]))
        rep.check("Auto all left the strip in Auto colour", all_state["mode"] == "auto",
                  all_state["mode"])
        # Receipt used to be the one mode with no chip, so the panel had to name
        # it. It has a chip again, which means every mode a page can be in has
        # one lit — so there is nothing left for the panel to name, and it says
        # so by staying empty rather than repeating the chip.
        rep.check("the Auto colour chip is lit, so the row already says the mode",
                  "auto*" in all_state["chips"], all_state["chips"])
        rep.check("and the panel names nothing, because a lit chip is saying it",
                  all_state["name"] == "", repr(all_state["name"]))

        page.click("#btn-magic")
        page.wait_for_timeout(400)
        clean_state = page.evaluate(CHROME)
        print("        after Auto clean: %s | chips %r | title %r"
              % (clean_state["mode"], clean_state["chips"], clean_state["name"]))
        rep.check("Auto clean lands in the same state Auto all left",
                  clean_state["key"] == all_state["key"],
                  "%s vs %s" % (all_state["key"][:60], clean_state["key"][:60]))
        rep.check("and renders the same pixels, so it cannot be cleaning more",
                  clean_state["px"] == all_state["px"],
                  "%s vs %s" % (all_state["px"], clean_state["px"]))
        rep.check("and the panel still names nothing after it",
                  clean_state["name"] == "", repr(clean_state["name"]))

        page.click("#btn-magic")
        page.wait_for_timeout(400)
        again = page.evaluate(CHROME)
        rep.check("a second Auto clean is a no-op, so it does not compound",
                  again["key"] == clean_state["key"] and again["px"] == clean_state["px"],
                  again["px"])

        # The one place the buttons genuinely disagreed, now closed: a page in
        # Original has no mode to re-apply, so Auto clean has to choose one, and
        # it used to choose Auto colour outright while Auto all read the shape.
        page.evaluate("JS.setMode('original')")
        page.wait_for_timeout(300)
        page.click("#btn-magic")
        page.wait_for_timeout(400)
        from_orig = page.evaluate(CHROME)
        print("        Auto clean from Original: %s" % from_orig["mode"])
        rep.check("Auto clean preserves Original instead of choosing a tone",
                  from_orig["mode"] == "original", from_orig["mode"])
        page.evaluate("JS.setMode('receipt')")
        page.wait_for_timeout(300)

        # And the mode reaches the pixels too. `receipt` is not `auto` with a
        # different label: it renders through the threshold path — flatten,
        # threshold, despeckle — where Auto colour keeps continuous tone. What
        # separates them is the *shape* of the histogram, not its mean: both
        # render this crop at ~207 with 17% ink, because the crop is mostly bare
        # paper and the "ink" is the fixture's print either way. So this counts
        # the mid-greys the threshold discards, and asserts the direction only.
        # The margin is real but thin — 2.8% of pixels against 3.6% — and the
        # comparison is against Auto colour on the *same crop*, which is the
        # only way to hold everything else still.
        LUM = """() => {
            const el = JS.$('preview');
            const g = JS.ctx2d(el, true);
            const d = g.getImageData(0, 0, el.width, el.height).data;
            let mid = 0, n = 0;
            for (let i = 0; i < d.length; i += 4) {
                const y = (d[i] * 299 + d[i+1] * 587 + d[i+2] * 114) / 1000;
                if (y > 64 && y < 192) mid++;
                n++;
            }
            return mid / n;
        }"""
        receipt_mid = page.evaluate(LUM)
        page.evaluate("JS.setMode('auto')")
        page.wait_for_timeout(300)
        auto_mid = page.evaluate(LUM)
        print("        mid-tone fraction: receipt %.4f  auto %.4f" % (receipt_mid, auto_mid))
        rep.check("the Receipt mode renders through the threshold path, not as tone",
                  receipt_mid < auto_mid - 0.002,
                  "receipt %.4f vs auto %.4f" % (receipt_mid, auto_mid))

        # ---- tapping a lit chip again takes that mode back off ------------
        # The user's words: "when i click auto color again, it must undo only
        # auto color. same for b/w button." So the chip remembers the tone that
        # was there the instant before it was tapped and puts that back, and it
        # carries nothing else with it — the crop, the straightening and the
        # sharpening are the same before and after.
        ADJ = """() => {
            const p = JS.activePage();
            return {mode: p.mode, tap: p.modeTap,
                    back: p.modeBack ? p.modeBack.mode : null,
                    adj: [p.adj.flat, p.adj.thr, p.adj.contrast, p.adj.wb, p.adj.sat],
                    sharp: p.adj.sharp,
                    corners: p.corners ? p.corners.map(c => [+c.x.toFixed(6), +c.y.toFixed(6)]) : null,
                    fine: +p.fine.toFixed(6), coarse: p.coarse}; }"""
        # Start explicitly in Receipt. Auto clean is no longer allowed to choose
        # any tone mode, so this chip-toggle test establishes its own baseline.
        page.evaluate("() => { JS.setMode('receipt'); const p = JS.activePage(); p.modeTap = ''; p.modeBack = null; }")
        page.wait_for_timeout(350)
        base = page.evaluate(ADJ)
        base_px = page.evaluate(CHROME)
        rep.check("the page is in Receipt, which no chip can put it back to",
                  base["mode"] == "receipt" and base["tap"] == "" and base["back"] is None,
                  "%s tap %r back %r" % (base["mode"], base["tap"], base["back"]))

        page.click('#mode-chips .chip[data-mode="auto"]')
        page.wait_for_timeout(300)
        lit = page.evaluate(ADJ)
        rep.check("tapping Auto colour switches the mode and remembers what it left",
                  lit["mode"] == "auto" and lit["tap"] == "auto" and lit["back"] == "receipt",
                  "%s tap %r back %r" % (lit["mode"], lit["tap"], lit["back"]))

        page.click('#mode-chips .chip[data-mode="auto"]')
        page.wait_for_timeout(300)
        off = page.evaluate(ADJ)
        off_px = page.evaluate(CHROME)
        rep.check("tapping Auto colour again puts Receipt back, with its own values",
                  off["mode"] == "receipt" and off["adj"] == base["adj"],
                  "%s %s against %s" % (off["mode"], off["adj"], base["adj"]))
        rep.check("and it is back to the pixels it had, not merely to the numbers",
                  off_px["px"] == base_px["px"],
                  "%s against %s" % (off_px["px"], base_px["px"]))
        rep.check("the chip is no longer a chip that can be undone",
                  off["tap"] == "" and off["back"] is None,
                  "tap %r back %r" % (off["tap"], off["back"]))
        rep.check("and nothing but the tone moved: same crop, same angle, same sharpness",
                  off["corners"] == base["corners"] and off["fine"] == base["fine"]
                  and off["coarse"] == base["coarse"] and off["sharp"] == base["sharp"],
                  "corners %s/%s fine %s/%s coarse %s/%s sharp %s/%s"
                  % (off["corners"], base["corners"], off["fine"], base["fine"],
                     off["coarse"], base["coarse"], off["sharp"], base["sharp"]))

        # The same for B/W, and from the same starting point, because the two
        # chips share one code path and a bug in it would show on both.
        page.click('#mode-chips .chip[data-mode="bw"]')
        page.wait_for_timeout(300)
        bw_on = page.evaluate(ADJ)
        page.click('#mode-chips .chip[data-mode="bw"]')
        page.wait_for_timeout(300)
        bw_off = page.evaluate(ADJ)
        rep.check("B/W undoes itself the same way",
                  bw_on["mode"] == "bw" and bw_off["mode"] == "receipt"
                  and bw_off["adj"] == base["adj"],
                  "%s (%s) -> %s %s" % (bw_on["mode"], bw_on["back"],
                                        bw_off["mode"], bw_off["adj"]))

        # A chip tapped *after* another chip is not an undo: the second chip is
        # the one the finger is on, and going back two steps from it would put
        # the page somewhere the user never asked for.
        page.click('#mode-chips .chip[data-mode="auto"]')
        page.wait_for_timeout(250)
        page.click('#mode-chips .chip[data-mode="bw"]')
        page.wait_for_timeout(250)
        two = page.evaluate(ADJ)
        rep.check("moving between the two chips is not an undo of either",
                  two["mode"] == "bw" and two["tap"] == "bw" and two["back"] == "auto",
                  "%s tap %r back %r" % (two["mode"], two["tap"], two["back"]))

        # Undo all is the other way to take a mode off, and it has to leave no
        # memory behind: the next tap on a chip is a first tap.
        page.click("#btn-undo-all")
        page.wait_for_timeout(300)
        page.click('#mode-chips .chip[data-mode="auto"]')
        page.wait_for_timeout(300)
        page.click('#mode-chips .chip[data-mode="auto"]')
        page.wait_for_timeout(300)
        after_undo = page.evaluate(ADJ)
        rep.check("after Undo all a chip tap goes back to the imported photo, not to "
                  "a mode Undo all already took off",
                  after_undo["mode"] == "original" and after_undo["adj"]
                  == page.evaluate("[JS.MODE_DEFAULTS.original.flat, JS.MODE_DEFAULTS.original.thr,"
                                   " JS.MODE_DEFAULTS.original.contrast, JS.MODE_DEFAULTS.original.wb,"
                                   " JS.MODE_DEFAULTS.original.sat]"),
                  "%s %s" % (after_undo["mode"], after_undo["adj"]))

        print("\ncleaning a faint page without breaking its letters")
        # The request, in the user's words: "auto clean must use ML to clean, not
        # hard algo. why? sometimes the words get broken after cleaning when it
        # is a bit thin or blurry".
        #
        # Broken has a meaning that can be measured, given something to measure
        # against. A page of print is drawn, and drawn again faint and soft — the
        # report's own words. The crisp drawing, thresholded cleanly, is what the
        # print *is*: its ink marks are the truth. Then every mark is asked how
        # many separate blobs of the cleaned page fall inside it. One is a whole
        # letter; two or more is a letter in pieces, which is the complaint.
        #
        # Both thresholds are run on the same faint page, so the only thing that
        # differs between the two numbers is the rule being tested.
        Faint = """(a) => {
          const w = 900, h = 620;
          const c = JS.makeCanvas(w, h, false);
          const g = JS.ctx2d(c, false);
          g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
          g.fillStyle = '#111';
          g.font = '22px Georgia, serif';
          ['Invoice 4471-B   ComfortDelGro Taxi',
           'Fare            12.40',
           'Booking fee      2.30',
           'Peak surcharge   3.00',
           'Total           17.70',
           'Thank you for travelling with us'
          ].forEach((t2, i) => g.fillText(t2, 60, 90 + i * 46));
          const crisp = JS.toGray(g.getImageData(0, 0, w, h).data, w, h);
          if (!a.soft) return { crisp: Array.from(crisp) };
          // The photograph: every stroke blurred into a ramp, then the page
          // lifted towards white so the ink is thin.
          const r = 2, out = new Uint8Array(w * h);
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              let s = 0, n = 0;
              for (let dy = -r; dy <= r; dy++) {
                const yy = y + dy; if (yy < 0 || yy >= h) continue;
                for (let dx = -r; dx <= r; dx++) {
                  const xx = x + dx; if (xx < 0 || xx >= w) continue;
                  s += crisp[yy * w + xx]; n++;
                }
              }
              const v = s / n * 0.45 + 255 * 0.55;
              out[y * w + x] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
            }
          }
          return { crisp: Array.from(crisp), soft: Array.from(out) };
        }"""
        # Truth marks and recovered blobs, and how many recovered blobs sit
        # inside each truth mark with enough pixels to be a piece of it.
        Marks = """(a) => {
          const {truth, got, w, h} = a;
          const label = (bw) => {
            const lab = new Int32Array(w * h).fill(-1);
            const stack = new Int32Array(w * h);
            const sizes = [];
            for (let i = 0; i < w * h; i++) {
              if (bw[i] !== 0 || lab[i] >= 0) continue;
              const id = sizes.length;
              let sp = 0;
              stack[sp++] = i; lab[i] = id;
              let n = 0;
              while (sp > 0) {
                const p = stack[--sp]; n++;
                const px = p % w, py = (p - px) / w;
                for (let dy = -1; dy <= 1; dy++) {
                  const yy = py + dy; if (yy < 0 || yy >= h) continue;
                  for (let dx = -1; dx <= 1; dx++) {
                    const xx = px + dx; if (xx < 0 || xx >= w) continue;
                    const q = yy * w + xx;
                    if (lab[q] < 0 && bw[q] === 0) { lab[q] = id; stack[sp++] = q; }
                  }
                }
              }
              sizes.push(n);
            }
            return {lab: lab, sizes: sizes};
          };
          const T = label(truth), G = label(got);
          const inside = new Int32Array(G.sizes.length);
          for (let i = 0; i < w * h; i++) {
            if (G.lab[i] >= 0 && T.lab[i] >= 0) inside[G.lab[i]]++;
          }
          const owned = T.sizes.map(() => new Set());
          for (let i = 0; i < w * h; i++) {
            if (G.lab[i] < 0 || T.lab[i] < 0) continue;
            if (inside[G.lab[i]] >= 5) owned[T.lab[i]].add(G.lab[i]);
          }
          let marks = 0, whole = 0, pieces = 0;
          for (let k = 0; k < T.sizes.length; k++) {
            if (T.sizes[k] < 20) continue;
            marks++;
            const n = owned[k].size;
            if (n === 1) whole++; else if (n > 1) pieces++;
          }
          return {marks: marks, whole: whole, pieces: pieces};
        }"""
        page.goto(PAGE_URL)
        page.wait_for_function("!!window.JS && !!JS.app")
        synth = page.evaluate(Faint, {"soft": False})
        faint = page.evaluate(Faint, {"soft": True})
        truth = page.evaluate("""(a) => {
            const g = new Uint8Array(a);
            const t = JS.otsu(g);
            for (let i = 0; i < g.length; i++) g[i] = g[i] <= t ? 0 : 255;
            return Array.from(g);
        }""", synth["crisp"])

        def marks(kind, t):
            got = page.evaluate("""(a) => Array.from(a.kind === 'sauvola'
                ? JS.sauvolaThreshold(a.gray, a.w, a.h, a.radius, a.t, 0, 55)
                : JS.adaptiveThreshold(a.gray, a.w, a.h, a.radius, a.t, 0, 55))""",
                                {"gray": faint["soft"], "w": 900, "h": 620,
                                 "kind": kind, "radius": 20, "t": t})
            return page.evaluate(Marks, {"truth": truth, "got": got,
                                         "w": 900, "h": 620})

        old = marks("bradley", 0.09)
        new = marks("sauvola", 0.09)
        print("        %d marks of print on the page" % old["marks"])
        print("        blurry page, local-mean rule:    %d whole, %d in pieces"
              % (old["whole"], old["pieces"]))
        print("        blurry page, local-contrast rule: %d whole, %d in pieces"
              % (new["whole"], new["pieces"]))
        rep.check("the fixture really is a page of print", old["marks"] > 80,
                  "%d marks" % old["marks"])
        rep.check("the old rule breaks a real share of the letters on faint print",
                  old["pieces"] > 8, "%d in pieces" % old["pieces"])
        rep.check("the new rule cleans the same page with fewer broken letters",
                  new["pieces"] < old["pieces"] and new["whole"] > old["whole"],
                  "%d pieces / %d whole against %d / %d"
                  % (new["pieces"], new["whole"], old["pieces"], old["whole"]))

        # ...and that the app is actually using it. The three checks above
        # compare the two rules *as functions*, so on their own they stay green
        # if the pipeline goes back to the old one — which is exactly the
        # regression they exist to prevent. So the shipped path is asked which
        # one it reaches for: a real page is rendered through JS.renderPage with
        # both thresholds instrumented, and the local-contrast one has to be the
        # one that ran. Verified by mutation: swapping the call site in
        # js/30-pipeline.js back to JS.adaptiveThreshold turns this red and
        # leaves the three above green.
        page.goto(PAGE_URL)
        page.wait_for_function("!!window.JS && !!JS.app")
        page.set_input_files("#file-gallery",
                             os.path.join(FIXTURES, "pair1_reported.jpg"))
        page.wait_for_function("JS.app.pages.length === 1", timeout=15000)
        page.evaluate("JS.openEditor(0)")
        page.wait_for_timeout(300)
        used = page.evaluate("""() => {
            const seen = {sauvola: 0, bradley: 0};
            const s = JS.sauvolaThreshold, a = JS.adaptiveThreshold;
            JS.sauvolaThreshold = function () {
              seen.sauvola++; return s.apply(null, arguments);
            };
            JS.adaptiveThreshold = function () {
              seen.bradley++; return a.apply(null, arguments);
            };
            try {
              const p = JS.activePage();
              p.mode = 'receipt'; p.corners = null; p.fine = 0;
              JS.autoEnhance(p);
              JS.renderPage(p, 900);
            } finally {
              JS.sauvolaThreshold = s; JS.adaptiveThreshold = a;
            }
            return seen;
        }""")
        rep.check("the render asks for the local-contrast rule, not the old one",
                  used["sauvola"] > 0 and used["bradley"] == 0, str(used))

        print("\nreading a batch in counts itself off")
        # The request, in the user's words: "while uploading the photos, it can
        # take a while. hence show a running number of progress like uploading 3
        # of 15". Reading a batch in is the long job that prompted it, so this
        # watches the overlay through a five-photo import and asks that every
        # count appeared *while the overlay was up*. A counter that is only
        # correct after the overlay is hidden is the bug, not the fix — and the
        # overlay being inside the editor's stage, where this job cannot be seen
        # at all, was the bug.
        page.goto(PAGE_URL)
        page.wait_for_function("!!window.JS && !!JS.app")
        page.evaluate("""() => {
            window.__busySeen = [];
            const text = JS.$('busy-text'), box = JS.$('busy');
            const note = () => window.__busySeen.push(
                [text.textContent, !!box.hidden, JS.app.view]);
            new MutationObserver(note).observe(
                text, {childList: true, characterData: true, subtree: true});
            note();
        }""")
        batch = [os.path.join(FIXTURES, n) for n in
                 ("pair1_reported.jpg", "pair2_reported.jpg", "pair3_reported.jpg",
                  "pair4_reported.jpg", "set21_reported.jpg")]
        page.set_input_files("#file-gallery", batch)
        page.wait_for_function("JS.app.pages.length === 5", timeout=60000)
        seen = page.evaluate("window.__busySeen")
        while_up = [t for t, hidden, _ in seen if not hidden]
        print("        overlay text while up: %r" % (while_up,))
        rep.check("every photo in the batch is counted off while the overlay is up",
                  all(any(("Loading %d of 5" % k) in t for t in while_up)
                      for k in range(1, 6)), seen)
        rep.check("and it is the home screen that is being covered, which is where "
                  "the import runs",
                  any(view == "home" for _, hidden, view in seen if not hidden), seen)
        rep.check("the overlay is gone once the batch is in",
                  page.evaluate("JS.$('busy').hidden"))

        print("\nthe four photos the tilt bug was reported with")
        # The report: Auto crop turned pages that were already square to the
        # camera, by up to ten degrees, and the result was worse than leaving them
        # alone. These are the four. Each was sent as a screenshot with the page
        # uncropped, so what is imported here is the photo pulled back out of that
        # screenshot — a preview render, cleaner than the file the camera wrote.
        # The content is the same, and content is all the tilt search reads.
        #
        # What the four have in common is a scoring curve that never collapses.
        # Dense text, a cast shadow and busy content leave the projection with
        # variance at every angle, so the angle that won carried no evidence of
        # alignment: a page with real line structure bottoms out at a few percent
        # of its peak fifteen degrees off, and these four sit at half their height
        # or more. Auto crop declines that shape now.
        def auto_on(path):
            page.goto(PAGE_URL)
            page.wait_for_function("!!window.JS && !!JS.app")
            page.set_input_files("#file-gallery", path)
            page.wait_for_function("JS.app.pages.length === 1", timeout=15000)
            page.evaluate("JS.openEditor(0)")
            page.wait_for_function("JS.app.view === 'edit'")
            page.click("#btn-auto")
            page.wait_for_timeout(700)
            return page.evaluate("""() => {
                const p = JS.activePage();
                let area = 0;
                if (p.corners) {
                    area = Math.abs(JS.quadArea(p.corners));
                }
                // Which of the two candidates the crop came from, so a pin can
                // say "this photo keeps the frame-split crop" rather than only
                // what the crop happened to be. Recomputes the detector on the
                // same frame the app just used; a few milliseconds.
                const oc = JS.orientedCanvas(p, JS.PREVIEW_MAX);
                const sc = Math.min(1, 420 / Math.max(oc.width, oc.height));
                const w = Math.max(24, Math.round(oc.width * sc));
                const h = Math.max(24, Math.round(oc.height * sc));
                const small = JS.makeCanvas(w, h, true);
                JS.ctx2d(small, true).drawImage(oc, 0, 0, w, h);
                const gray = JS.toGray(
                    JS.ctx2d(small, true).getImageData(0, 0, w, h).data, w, h);
                const c = JS.quadCandidates(gray, w, h);
                const q = JS.quadFromGray(gray, w, h);
                // Which candidate the crop *is*, by identity with the one the
                // detector returned — not by re-running the comparison that
                // chose it. Re-running it here would hard-code the margin into
                // the test, and then setting the margin to zero would leave the
                // test green while the crop changed underneath it. That is not
                // hypothetical: it is how this line was first written.
                let source = null;
                if (c && q) {
                    source = (c.strictQuad && c.quad === c.strictQuad)
                             ? 'paper' : 'split';
                }
                return {fine: p.fine, coarse: p.coarse, area: area, source: source,
                        hint: JS.$('stage-hint').textContent};
            }""")

        fines, areas, sources = {}, {}, {}
        for n in (1, 2, 3, 4):
            st = auto_on(os.path.join(FIXTURES, "pair%d_reported.jpg" % n))
            fines[n] = st["fine"]
            areas[n] = st["area"]
            sources[n] = st["source"]
            print("        pair%d: fine %+.2f  crop area %.2f  from %s  %r"
                  % (n, st["fine"], st["area"], st["source"], st["hint"]))
        # Which candidate the crop came from, per photo, because the margin that
        # decides it is a number and numbers drift. pair1 is the one this build
        # changed — its old crop's bottom edge sliced two lines off the receipt.
        # pair2 and pair4 are the two where the paper-mode candidate scores
        # higher and must still not take the crop: 26.8 against 21.4, and 34.4
        # against 32.4. Set the margin to zero and this check fails, which is the
        # only thing standing between "the prior is respected" and a claim.
        rep.check("the crop comes from the candidate it should, photo by photo",
                  sources == {1: "paper", 2: "split", 3: None, 4: "split"},
                  "sources %s" % sources)
        rep.check("no tilt is invented on any of the four reported photos",
                  all(abs(v) < 0.01 for v in fines.values()),
                  "fines %s" % {k: round(v, 2) for k, v in fines.items()})
        # The tilt guard is about the angle, so what it must not also do is refuse
        # the crop — and on the three of these whose silhouette is sound it does
        # not: a crop survives, at a plausible area, with the tilt at zero.
        rep.check("refusing the tilt is not also refusing the crop where the "
                  "silhouette is sound",
                  all(0.02 < areas[n] < 0.999 for n in (1, 2, 4)),
                  "areas %s" % {k: round(v, 3) for k, v in areas.items()})
        # pair3 is declined, and that is a different guard doing its job. The slip
        # lies on a bright table that shares its tone, so the mask runs the two
        # together and the only four edges the detector can fit are the table's;
        # cropping to those is what stretched the slip. Asserting a crop here
        # would be asserting that the edge guards do not work.
        rep.check("pair3, whose mask is the table rather than the slip, is "
                  "declined by the edge guards instead",
                  areas[3] == 0, "area %.3f" % areas[3])
        auto_on(os.path.join(FIXTURES, "pair3_reported.jpg"))
        page.add_script_tag(content=detector_without_guards())
        page.click("#btn-auto")
        page.wait_for_timeout(700)
        old3 = page.evaluate("""() => {
            const p = JS.activePage();
            return {area: p.corners ? Math.abs(JS.quadArea(p.corners)) : 0};
        }""")
        print("        pair3 with the pre-guard detector: crop area %.3f" % old3["area"])
        rep.check("the edge guards are what decline it: the old detector crops "
                  "pair3 to the table", old3["area"] > 0.02, old3)

        # The falsifier, so the checks above are known to be about the guard
        # rather than about four frames that were always left alone: put the
        # detector back the way it was and ask it the same question. pair2 is the
        # one the report was loudest about — a receipt standing upright on a
        # counter — and it is the worst of the four, at over ten degrees.
        auto_on(os.path.join(FIXTURES, "pair2_reported.jpg"))
        page.add_script_tag(content=detector_without_guards())
        page.click("#btn-auto")
        page.wait_for_timeout(700)
        old = page.evaluate("() => { const p = JS.activePage();"
                            " return { fine: p.fine, hint: JS.$('stage-hint').textContent }; }")
        print("        pair2 with the pre-guard detector: fine %+.2f  %r"
              % (old["fine"], old["hint"]))
        rep.check("the guard is what refuses pair2: the old detector tilts it by "
                  "ten degrees, the reported failure",
                  old["fine"] < -8.0, "fine %.2f" % old["fine"])

        print("\nthe taxi receipt the crop was cutting through")
        # The photo this build exists for. A receipt on a dark surface with a
        # shadow beside it: the frame-wide split lands at a level where the
        # receipt's right edge and the shadow are the same tone, so the fitted
        # right side ran diagonally across the paper and took the amounts column
        # with it. The paper-mode candidate tracks the receipt instead.
        #
        # What is pinned is the thing that was actually wrong. The old crop's
        # right side ran to x=236 of a 236-wide working frame — the frame's own
        # edge — because that is where the shadow's boundary was. A right side
        # that is not the frame's edge is the failure being absent, and it is the
        # one number that separates the two candidates on this photo (the old
        # one's right corners are both at the edge; the new one's are at 197 and
        # 182). The falsifier puts the old crop back and asks the same question.
        RIGHT_JS = """() => {
            const p = JS.activePage();
            const oc = JS.orientedCanvas(p, JS.PREVIEW_MAX);
            const s = Math.min(1, 420 / Math.max(oc.width, oc.height));
            const w = Math.max(24, Math.round(oc.width * s));
            const h = Math.max(24, Math.round(oc.height * s));
            const small = JS.makeCanvas(w, h, true);
            JS.ctx2d(small, true).drawImage(oc, 0, 0, w, h);
            const gray = JS.toGray(JS.ctx2d(small, true).getImageData(0, 0, w, h).data, w, h);
            const c = JS.quadCandidates(gray, w, h);
            const q = JS.quadFromGray(gray, w, h);
            const right = q ? Math.max(q[1].x, q[2].x) / w : null;
            return {right: right, area: q ? JS.quadArea(q) / (w * h) : null,
                    w: w, hint: JS.$('stage-hint').textContent,
                    looseRight: c && c.looseQuad
                      ? Math.max(c.looseQuad[1].x, c.looseQuad[2].x) / w : null,
                    scoreLoose: c && c.scoreLoose,
                    scoreStrict: c && (c.scoreStrict === -Infinity ? null : c.scoreStrict)};
        }"""
        st = auto_on(os.path.join(FIXTURES, "ori1_reported.jpg"))
        page.goto(PAGE_URL)
        page.wait_for_function("!!window.JS && !!JS.app")
        page.set_input_files("#file-gallery",
                             os.path.join(FIXTURES, "ori1_reported.jpg"))
        page.wait_for_function("JS.app.pages.length === 1", timeout=30000)
        page.evaluate("JS.openEditor(0)")
        page.wait_for_function("JS.app.view === 'edit'")
        page.wait_for_timeout(250)
        now = page.evaluate(RIGHT_JS)
        print("        crop area %.3f  right side %.3f of the frame  scores %s vs %s"
              % (now["area"], now["right"], now["scoreLoose"], now["scoreStrict"]))
        rep.check("the taxi receipt is cropped to the receipt, not through it",
                  now["right"] is not None and now["right"] < 0.95,
                  "right side %.3f of the frame" % (now["right"] or -1))
        rep.check("and the crop is a receipt-sized part of the frame, not the frame",
                  0.15 < now["area"] < 0.85, "area %.3f" % now["area"])
        # The falsifier: the same frame, the same question, the crop this build
        # replaced. Without it, "the right side is inside the frame" is a claim
        # about a photo rather than about a change.
        page.add_script_tag(content=detector_without_guards())
        old_side = page.evaluate(RIGHT_JS)
        print("        with the pre-guard detector: right side %s"
              % (None if old_side["right"] is None
                 else round(old_side["right"], 3)))
        rep.check("the old crop's right side runs to the frame edge, which is the "
                  "reported failure",
                  old_side["right"] is not None and old_side["right"] > 0.95,
                  "right side %.3f" % (old_side["right"] or -1))

        print("\nthe two photos from the 1.7.6 report")
        # Both are taxi receipts on a pale hand. The report was one line each:
        # "still cannot detect the edges" with a job log, and "found wrong corner
        # and sheared the image wrong". They are two different failures and they
        # are fixed by two different changes, so they are pinned separately, each
        # against its own falsifier.
        #
        # What the numbers below are, and are not. The crop's left corners are
        # x of the top-left and the bottom-left; on a receipt those should be the
        # same number, because the paper's left edge is straight, so the gap
        # between them is how sheared the crop is -- 0.1195 of the width before
        # this build, 0.0000 after. Everything here is read off the page the app
        # actually produced, after the button a user presses.
        def corners_of():
            return page.evaluate("""() => {
                const p = JS.activePage();
                return p.corners
                  ? p.corners.map(c => [+c.x.toFixed(4), +c.y.toFixed(4)]) : null;
            }""")

        def load(path):
            """A fresh import, with no crop on the page yet.

            Auto crop only assigns corners when it finds a quad; it does not
            clear them when it declines. So a falsifier that runs after a
            successful crop and expects a refusal would read the *previous*
            run's corners and call them this one's -- which is what the first
            version of the pair61 check below did.
            """
            page.goto(PAGE_URL)
            page.wait_for_function("!!window.JS && !!JS.app")
            page.set_input_files("#file-gallery", path)
            page.wait_for_function("JS.app.pages.length === 1", timeout=15000)
            page.evaluate("JS.openEditor(0)")
            page.wait_for_function("JS.app.view === 'edit'")

        st61 = auto_on(os.path.join(FIXTURES, "pair61_reported.jpg"))
        c61 = corners_of()
        print("        pair61: crop area %.3f  corners %s  %r"
              % (st61["area"], c61, st61["hint"]))
        rep.check("pair61 is cropped rather than refused as having no page edge",
                  c61 is not None and 0.10 < st61["area"] < 0.95,
                  "area %.3f corners %s" % (st61["area"], c61))
        # And the falsifier: with the signed coverage back the photo is refused
        # again, which is the report it came in with. Loaded fresh, because a
        # refusal leaves no corners behind to read.
        load(os.path.join(FIXTURES, "pair61_reported.jpg"))
        page.add_script_tag(content=_cut_detect([MIXED_COV_CUT]))
        page.click("#btn-auto")
        page.wait_for_timeout(700)
        old61 = corners_of()
        hint61 = page.evaluate("JS.$('stage-hint').textContent")
        print("        with only signed coverage: %s  %r" % (old61, hint61))
        rep.check("the mixed-side coverage change is what crops pair61: with the "
                  "signed test back it has no page edge",
                  old61 is None, old61)
        rep.check("and it reports the same symptom it was reported with",
                  "no clear page edge" in hint61.lower(), hint61)

        st62 = auto_on(os.path.join(FIXTURES, "pair62_reported.jpg"))
        c62 = corners_of()
        d_l = abs(c62[0][0] - c62[3][0])
        print("        pair62: crop area %.3f  left corners %.4f / %.4f  shear %.4f"
              % (st62["area"], c62[0][0], c62[3][0], d_l))
        rep.check("pair62's crop has a plumb left side, not a sheared one",
                  d_l < 0.02, "left corners %.4f / %.4f" % (c62[0][0], c62[3][0]))
        rep.check("and it is a receipt-sized part of the frame, with the bottom "
                  "still in the crop",
                  0.55 < st62["area"] < 0.85 and c62[3][1] > 0.9,
                  "area %.3f bottom-left y %.4f" % (st62["area"], c62[3][1]))
        # The safety property of the repair, and the reason it can be narrow: the
        # three sides it does not edit are left where they were. A refine that
        # also moved the right side would be re-fitting the page, not fixing one
        # side of it.
        load(os.path.join(FIXTURES, "pair62_reported.jpg"))
        page.add_script_tag(content=_cut_detect([SHEAR_CUT]))
        page.click("#btn-auto")
        page.wait_for_timeout(700)
        old62 = corners_of()
        print("        with the shear repair cut: left corners %.4f / %.4f  shear %.4f"
              % (old62[0][0], old62[3][0], abs(old62[0][0] - old62[3][0])))
        rep.check("the shear repair is what un-shears pair62: without it the crop "
                  "is sheared by most of a tenth of the width",
                  abs(old62[0][0] - old62[3][0]) > 0.08,
                  "left corners %.4f / %.4f" % (old62[0][0], old62[3][0]))
        rep.check("only the left side moves: the right side is where the nudge "
                  "path would have left it",
                  abs(old62[1][0] - c62[1][0]) < 0.005 and abs(old62[2][0] - c62[2][0]) < 0.005,
                  "right corners %s then %s" % ([old62[1][0], old62[2][0]],
                                                [c62[1][0], c62[2][0]]))

        print("\nthe second batch: seven photos, four of them stretched")
        # The follow-up report — "the auto crop is so bad, worse than before, some
        # are stretched wrongly" — with the seven photographs it was made against.
        # All seven are one failure mode: the page and what it lies on share a
        # tone, so the mask runs them together and the boundary handed to the
        # fitter is the *photo's* border where the blob was cut. Fitting a line to
        # that run is trivial (zero residual, exactly 90 degrees) and it beats the
        # page's real edge, which is tilted and only partly in frame. Hence the
        # crop, and hence the stretch: a quad pinned to the frame rectifies into a
        # sheared page.
        #
        # Which of the seven can be cropped is decided by whether anything else in
        # the frame survived as a real edge, and that is not something a test can
        # assert from the outside — it is the measurement this session made. So
        # this pins the outcomes: three are declined because on those three the
        # mask has nothing left but the frame, and that is the fix, not a
        # shortfall (dragging the corners is the way through, and they are always
        # visible now). The falsifier below shows the same files were all cropped
        # before, so these checks can fail.
        SETS = [("set21", 0), ("set22", 1), ("set23", 0), ("set24", 1),
                ("set25", 1), ("set27", 0), ("set28", 1)]
        set_areas, set_fines, set_sources = {}, {}, {}
        for name, _ in SETS:
            st = auto_on(os.path.join(FIXTURES, "%s_reported.jpg" % name))
            set_areas[name] = st["area"]
            set_fines[name] = st["fine"]
            set_sources[name] = st["source"]
            print("        %s: fine %+.2f  crop area %.3f  from %-5s  %r"
                  % (name, st["fine"], st["area"], st["source"], st["hint"]))
        # set24 and set25 are the two of the seven whose paper is bright enough
        # for a paper-mode candidate to exist at all — a saturated receipt is the
        # case that made the prominence test reject the brightest thing in the
        # frame, so this is where that boundary is pinned. set22 and set28 have
        # no such candidate and must keep the frame-split crop; clamping the
        # right shoulder back into bin 255 takes set25's away and fails this.
        rep.check("the paper-mode candidate is found where the paper is saturated "
                  "and nowhere else",
                  set_sources == {"set21": None, "set22": "split", "set23": None,
                                  "set24": "paper", "set25": "paper",
                                  "set27": None, "set28": "split"},
                  "sources %s" % set_sources)
        # Six of the seven hold at exactly zero. set24 does not, and that is the
        # crop rather than a new tilt: the tilt is measured on the *rectified*
        # image, so the paper-mode threshold giving set24 a near-vertical right
        # edge — its third corner goes from 0.56 to 0.81 of paper — leaves the
        # orientation something real to read where the old crop left it nothing.
        # Forcing the loose crop back puts it at exactly 0.00 with the photo and
        # the code unchanged otherwise; tests/tmp/tilt_cause_probe.py does
        # exactly that. Four tenths of a degree is the estimator working on a
        # better image, and the -10.2 degrees this whole section exists to refuse
        # is twenty-five times it.
        rep.check("no tilt is invented on any of the seven either",
                  all(abs(set_fines[n]) < 0.01 for n in set_fines if n != "set24"),
                  "fines %s" % {k: round(v, 2) for k, v in set_fines.items()})
        rep.check("set24 reads a residual tilt off its better crop, not an "
                  "invented one",
                  abs(set_fines["set24"]) < 1.0,
                  "fine %.2f deg" % set_fines["set24"])
        for name, wants in SETS:
            rep.check("%s is %s" % (name, "cropped" if wants else "declined rather "
                                    "than stretched"),
                      (set_areas[name] > 0.02) == bool(wants),
                      "area %.3f" % set_areas[name])
        # The falsifier for the declines. Same files, guards cut: every one of them
        # comes back with a crop, so "declined" is the guards doing it and not the
        # photos being uncroppable.
        for name, wants in SETS:
            if wants:
                continue
            auto_on(os.path.join(FIXTURES, "%s_reported.jpg" % name))
            page.add_script_tag(content=detector_without_guards())
            page.click("#btn-auto")
            page.wait_for_timeout(700)
            old = page.evaluate("""() => {
                const p = JS.activePage();
                return {area: p.corners ? Math.abs(JS.quadArea(p.corners)) : 0};
            }""")
            print("        %s with the pre-guard detector: crop area %.3f"
                  % (name, old["area"]))
            rep.check("the edge guards are what decline %s: the old detector "
                      "crops it" % name, old["area"] > 0.02, old)

        print("\nauto detect on a frame it cannot read")
        # The reported failure. On this photo the detector has nothing sound to
        # go on: the border is the hand on one side and the counter on the other,
        # so its mean sits on the Otsu split and its spread spans both classes.
        # It used to answer anyway and crop the shadowed hand, covering 44% of
        # the frame with the receipt outside it — and report "Edges found",
        # which is what made the failure so confusing. Declining is the fix, and
        # the wording of that decline is part of it.
        page.goto(PAGE_URL)
        page.wait_for_function("!!window.JS && !!JS.app")
        page.set_input_files("#file-gallery", mixed_photo)
        page.wait_for_function("JS.app.pages.length === 1", timeout=15000)
        page.evaluate("JS.openEditor(0)")
        page.wait_for_function("JS.app.view === 'edit'")

        # Establish the premise rather than assuming it: this frame really is
        # one the background reference cannot be read from.
        stats = page.evaluate("""() => {
            const p = JS.activePage();
            const oc = JS.orientedCanvas(p, JS.PREVIEW_MAX);
            const s = Math.min(1, 420 / Math.max(oc.width, oc.height));
            const w = Math.max(24, Math.round(oc.width * s));
            const h = Math.max(24, Math.round(oc.height * s));
            const small = JS.makeCanvas(w, h, true);
            JS.ctx2d(small, true).drawImage(oc, 0, 0, w, h);
            const gray = JS.toGray(JS.ctx2d(small, true).getImageData(0, 0, w, h).data, w, h);
            const b = [];
            for (let x = 0; x < w; x++) b.push(gray[x], gray[(h-1)*w+x]);
            for (let y = 0; y < h; y++) b.push(gray[y*w], gray[y*w+w-1]);
            let m = 0; for (const v of b) m += v; m /= b.length;
            let sv = 0; for (const v of b) sv += (v - m) * (v - m);
            const thr = JS.otsu(gray);
            return { bg: m, thr: thr, sd: Math.sqrt(sv / b.length) };
        }""")
        margin = abs(stats["bg"] - stats["thr"])
        print("        border %.1f, otsu %.1f (margin %.1f), border spread %.1f"
              % (stats["bg"], stats["thr"], margin, stats["sd"]))
        rep.check("the fixture's border really does straddle the split",
                  margin < 16 and stats["sd"] >= 16, stats)

        page.click("#btn-auto")
        page.wait_for_timeout(600)
        found_hint = page.inner_text("#stage-hint")
        fresh = page.evaluate("() => { const p = JS.activePage();"
                              " return { corners: p.corners, fine: p.fine }; }")
        print("        hint: %r  corners %s  fine %.2f"
              % (found_hint, fresh["corners"], fresh["fine"]))

        rep.check("the mixed-border receipt is recovered rather than refused",
                  "Edges found" in found_hint and fresh["corners"] is not None,
                  "%s / %s" % (found_hint, fresh["corners"]))
        if fresh["corners"]:
            xs = [p["x"] for p in fresh["corners"]]
            ys = [p["y"] for p in fresh["corners"]]
            rep.check("the recovery lands on the receipt strip, not the hand",
                      min(xs) > 0.20 and max(xs) < 0.80 and
                      min(ys) < 0.20 and max(ys) > 0.80,
                      "x %.3f..%.3f y %.3f..%.3f"
                      % (min(xs), max(xs), min(ys), max(ys)))
        rep.check("and the recovery invents no large rotation",
                  abs(fresh["fine"]) < 2.0,
                  "fine %.2f deg" % fresh["fine"])

        # The falsifier. Put the pre-guard detector back into the page and ask it
        # the same question, so the checks above are known to be about a change
        # rather than about a frame that was always refused. This is the reported
        # photo's exact signature: a crop of the shadowed hand, and a -15.00
        # degree rotation — a full-scale tilt, at the clamp, out of a frame with
        # nothing in it to level.
        QUAD_JS = """() => {
            const p = JS.app.pages[0];
            const oc = JS.orientedCanvas(p, JS.PREVIEW_MAX);
            const s = Math.min(1, 420 / Math.max(oc.width, oc.height));
            const w = Math.max(24, Math.round(oc.width * s));
            const h = Math.max(24, Math.round(oc.height * s));
            const small = JS.makeCanvas(w, h, true);
            JS.ctx2d(small, true).drawImage(oc, 0, 0, w, h);
            const gray = JS.toGray(JS.ctx2d(small, true).getImageData(0, 0, w, h).data, w, h);
            const q = JS.quadFromGray(gray, w, h);
            return { quad: q ? q.map(pt => [pt.x / w, pt.y / h]) : null,
                     area: q ? JS.quadArea(q) / (w * h) : null,
                     skew: JS.skewFromGray(gray, w, h) };
        }"""
        page.add_script_tag(content=detector_without_guards())
        old = page.evaluate(QUAD_JS)
        print("        with the pre-guard detector: quad area %s, skew %.2f"
              % (None if old["area"] is None else round(old["area"], 3), old["skew"]))

        rep.check("the guard is what refuses it: the old detector crops this frame",
                  old["quad"] is not None, old["quad"])
        if old["quad"]:
            cx = sum(pt[0] for pt in old["quad"]) / 4
            rep.check("and crops the shaded left of the frame, not the receipt",
                      cx < 0.35, "centre x %.2f" % cx)
        rep.check("the old detector also invents a full-scale rotation",
                  abs(old["skew"]) > 10, "skew %.2f deg" % old["skew"])

        print("\nnothing left over from the removed controls")
        # The section above swapped a source file out from under this page, so
        # start it clean rather than checking globals in a patched runtime.
        page.goto(PAGE_URL)
        page.wait_for_function("!!window.JS && !!JS.app")
        # A stale global or a dead listener is exactly what a UI removal leaves
        # behind, and neither shows up as a page error.
        rep.check("no compare state is left on the app",
                  page.evaluate("!('comparing' in JS.app) && !('insetOpen' in JS.app)"),
                  page.evaluate("Object.keys(JS.app)"))
        rep.check("the crop helpers that served the inset are gone",
                  page.evaluate("!JS.normToBox && !JS.boxToNorm && !JS.drawInset && !JS.setInsetOpen"))
        rep.check("fitBox survived, it still letterboxes the preview",
                  page.evaluate("typeof JS.fitBox === 'function'"))

        print("\nthe export sheet says how big the file will be")

        # The sheet had no browser coverage at all before this section: it was
        # built, wired and never opened by a test. These checks open it the way a
        # user does and compare what it claims against a real export of the same
        # pages at the same settings, because an estimate that is never put next
        # to a real encode is not evidence of anything.

        def load_pages(paths):
            page.goto(PAGE_URL)
            page.wait_for_function("!!window.JS && !!JS.app")
            page.set_input_files("#file-gallery", paths)
            page.wait_for_function("JS.app.pages.length === %d" % len(paths),
                                   timeout=30000)

        def open_sheet(fmt=None, quality=None, maxdim=None):
            """Open the sheet, set it up, and read back the estimate it shows.

            The sheet has to be open before its chips can be tapped, so it is
            opened through the real button first — which also means the open
            path is exercised every time. Controls are then applied the way the
            wiring listens for them, and their debounced estimate is allowed to
            land before the interceptor is armed, so the number that comes back
            belongs to the settings as they now stand and not to an earlier set.
            """
            # Closed through the backdrop, which is the user's own path out and
            # the one that has to abandon an estimate still in flight.
            if page.is_visible("#sheet-export"):
                page.eval_on_selector("#sheet-export .sheet-backdrop", "el => el.click()")
                page.wait_for_selector("#sheet-export", state="hidden")
            page.click("#btn-export")
            page.wait_for_selector("#sheet-export:not([hidden])")
            if fmt:
                page.click('#fmt-chips [data-fmt="%s"]' % fmt)
            for sel, val in (("#in-quality", quality), ("#in-maxdim", maxdim)):
                if val is not None:
                    page.eval_on_selector(
                        sel,
                        "(el, v) => { el.value = String(v);"
                        " el.dispatchEvent(new Event('input', {bubbles: true})); }",
                        str(val))
            page.wait_for_timeout(500)

            # JS.fmtBytes is how the number reaches the line, so intercepting it
            # captures the exact byte count rather than parsing "1.5 MB" back out
            # of the text.
            page.evaluate("""() => {
                if (!window.__fmtBytesOrig) {
                    window.__fmtBytesOrig = JS.fmtBytes;
                    JS.fmtBytes = function (n) {
                        window.__est = n;
                        return window.__fmtBytesOrig.apply(null, arguments);
                    };
                }
                window.__est = null;
            }""")
            # Same call the sheet's own open path makes, so this measures the
            # real thing rather than a re-implementation of it.
            page.evaluate("JS.refreshExportSummary(true)")
            page.wait_for_function("window.__est !== null", timeout=30000)
            return page.evaluate("window.__est")

        def real_export(fmt, quality, maxdim):
            return page.evaluate("""async (o) => {
                const files = await JS.buildExport(JS.app.pages,
                    {format: o.fmt, quality: o.q, maxDim: o.m});
                let n = 0;
                for (const f of files) n += f.size;
                return n;
            }""", {"fmt": fmt, "q": quality, "m": maxdim})

        one = [os.path.join(FIXTURES, "set25_reported.jpg")]

        # One page, so the sample is the whole set and the estimate is not an
        # estimate: it is the export, encoded once to measure and once to ship.
        for fmt, q, m in (("pdf", 0.90, 2400), ("jpeg", 0.90, 2400),
                          ("jpeg", 0.55, 1200), ("png", 0.90, 2400)):
            load_pages(one)
            est = open_sheet(fmt=fmt, quality=int(round(q * 100)), maxdim=m)
            real = real_export(fmt, q, m)
            err = (est - real) / real
            print("        1 page %-4s q%-3d %dpx: estimate %d  real %d  %+.2f%%"
                  % (fmt, round(q * 100), m, est, real, err * 100))
            rep.check("a one-page %s export is estimated to within 1%% of the "
                      "file it actually produces" % fmt,
                      abs(err) < 0.01, "estimate %d, real %d" % (est, real))

        # Three pages: still at the cap, so still every page encoded for real.
        three = [os.path.join(FIXTURES, f) for f in
                 ("set25_reported.jpg", "set24_reported.jpg", "pair4_reported.jpg")]
        load_pages(three)
        est = open_sheet(fmt="pdf", quality=90, maxdim=2400)
        real = real_export("pdf", 0.90, 2400)
        err = (est - real) / real
        print("        3 pages pdf q90 2400px: estimate %d  real %d  %+.2f%%"
              % (est, real, err * 100))
        rep.check("a three-page export is estimated to within 1% too — the whole "
                  "set is sampled, because three is the cap",
                  abs(err) < 0.01, "estimate %d, real %d" % (est, real))

        # Past the cap the set is no longer sampled whole, which is the only
        # place the estimate is a real estimate, so it is the only place a
        # tolerance is needed. Four fixtures spanning what is available: one
        # dense thermal receipt among three photographed pages.
        #
        # This checks that the figure is right for a mixed set. It does *not*
        # check that the sample is spread rather than taken off the front — the
        # fixtures are all close enough in density that both samplers land
        # within a couple of percent of each other on this set, so the gate
        # cannot tell them apart. That property is pinned in tests/smoke.js
        # instead, where it was verified by mutation.
        four = [os.path.join(FIXTURES, f) for f in
                ("pair1_reported.jpg", "set22_reported.jpg",
                 "set24_reported.jpg", "pair4_reported.jpg")]
        load_pages(four)
        est = open_sheet(fmt="pdf", quality=90, maxdim=2400)
        real = real_export("pdf", 0.90, 2400)
        err = (est - real) / real
        print("        4 pages pdf q90 2400px: estimate %d  real %d  %+.1f%%"
              % (est, real, err * 100))
        rep.check("a set past the cap is estimated within the tolerance the "
                  "sampling spread was measured to give",
                  abs(err) < 0.20, "estimate %d, real %d (%+.1f%%)"
                  % (est, real, err * 100))

        # The container. A PDF of the same pages must come out above the loose
        # JPEGs by the per-page overhead and no more — this is what pins
        # JS.pdfOverhead to the writer instead of to a remembered constant.
        load_pages(three)
        as_pdf = open_sheet(fmt="pdf", quality=90, maxdim=2400)
        load_pages(three)
        as_jpeg = open_sheet(fmt="jpeg", quality=90, maxdim=2400)
        per = (as_pdf - as_jpeg) / 3
        print("        pdf - jpeg over 3 pages: %d bytes, %.0f per page"
              % (as_pdf - as_jpeg, per))
        rep.check("packing the pages into a PDF costs a few hundred bytes each",
                  300 < per < 800, "%.0f per page" % per)

        # The controls' own wiring, with no help from this test.
        #
        # open_sheet() calls JS.refreshExportSummary itself, so that every
        # accuracy check above is measured against a fresh number. That also
        # means an accuracy check cannot notice a control that has stopped
        # refreshing anything — the test would refresh it anyway. Verified by
        # mutation: deleting the refresh from the quality handler leaves every
        # check above green. So these drive the real controls and wait for the
        # estimate to arrive on its own, and they are the only checks that can
        # catch the wiring.
        def arm():
            """Intercept JS.fmtBytes and clear the last number it was given."""
            page.evaluate("""() => {
                if (!window.__fmtBytesOrig) {
                    window.__fmtBytesOrig = JS.fmtBytes;
                    JS.fmtBytes = function (n) {
                        window.__est = n;
                        return window.__fmtBytesOrig.apply(null, arguments);
                    };
                }
                window.__est = null;
            }""")

        def wait_est(label, timeout=20000):
            try:
                page.wait_for_function("window.__est !== null", timeout=timeout)
            except Exception:
                return None
            return page.evaluate("window.__est")

        def drive(sel, val):
            page.eval_on_selector(
                sel, "(el, v) => { el.value = String(v);"
                     " el.dispatchEvent(new Event('input', {bubbles: true})); }", str(val))

        load_pages(one)
        arm()
        page.click("#btn-export")                 # the open path, unaided
        page.wait_for_selector("#sheet-export:not([hidden])")
        opened = wait_est("open")
        print("        opening the sheet measured %s" % opened)
        rep.check("opening the sheet measures a size without being asked twice",
                  opened is not None, opened)

        arm()
        drive("#in-quality", 40)
        q_low = wait_est("quality")
        arm()
        drive("#in-quality", 100)
        q_high = wait_est("quality")
        print("        quality 40 -> %s, quality 100 -> %s" % (q_low, q_high))
        rep.check("the quality slider refreshes the size line by itself",
                  q_low is not None and q_high is not None and q_high > q_low,
                  "q40 %s, q100 %s" % (q_low, q_high))

        arm()
        page.click('#fmt-chips [data-fmt="png"]')
        as_png = wait_est("format")
        print("        png -> %s (jpeg was %s)" % (as_png, q_high))
        rep.check("the format chip refreshes it too",
                  as_png is not None and q_high is not None and as_png > q_high,
                  "png %s, jpeg %s" % (as_png, q_high))

        arm()
        drive("#in-maxdim", 800)
        m_small = wait_est("maxdim")
        print("        800px -> %s" % m_small)
        rep.check("and the max-long-edge slider refreshes it",
                  m_small is not None and as_png is not None and m_small < as_png,
                  "800px %s, 2400px %s" % (m_small, as_png))

        # The two sliders again, this time measuring the ratio against the real
        # export rather than only checking the direction.
        load_pages(one)
        low = open_sheet(fmt="jpeg", quality=40, maxdim=2400)
        high = open_sheet(fmt="jpeg", quality=100, maxdim=2400)
        print("        quality 40 -> %d, quality 100 -> %d" % (low, high))
        rep.check("the quality slider moves the estimate", high > low * 1.3,
                  "q40 %d, q100 %d" % (low, high))

        # The max-long-edge slider. Its ratio is sub-linear on purpose — bytes
        # grow with pixels at an exponent well under 1 — so checking that the
        # number merely went up would pass for almost any behaviour. What is
        # checked instead is that the estimate moves by the same factor the real
        # export does, which is the property the slider is supposed to have.
        small = open_sheet(fmt="jpeg", quality=90, maxdim=800)
        small_real = real_export("jpeg", 0.90, 800)
        large = open_sheet(fmt="jpeg", quality=90, maxdim=2400)
        large_real = real_export("jpeg", 0.90, 2400)
        est_ratio = large / small
        real_ratio = large_real / small_real
        print("        800px -> %d (real %d), 2400px -> %d (real %d)"
              % (small, small_real, large, large_real))
        print("        estimate x%.3f, real x%.3f" % (est_ratio, real_ratio))
        rep.check("the max-long-edge slider moves the estimate",
                  est_ratio > 1.15, "x%.3f" % est_ratio)
        rep.check("and it moves it by the factor the export really moves by",
                  abs(est_ratio / real_ratio - 1) < 0.02,
                  "estimate x%.3f vs real x%.3f" % (est_ratio, real_ratio))

        # Above WORK_MAX the slider is a dead control: photos are capped at
        # 2400px at ingest and `rectify` never upscales, so 2500 and 4000 are
        # byte-identical files. The decision was to leave the slider where it is
        # and let the number tell the truth rather than the slider do so, and
        # that decision is only honest while the estimate reports a plateau. If
        # a later change let the estimate keep growing past the cap it would be
        # describing a file the exporter cannot produce.
        capped = open_sheet(fmt="jpeg", quality=90, maxdim=2400)
        past = open_sheet(fmt="jpeg", quality=90, maxdim=4000)
        past_real = real_export("jpeg", 0.90, 4000)
        print("        2400px -> %d, 4000px -> %d (real %d)"
              % (capped, past, past_real))
        rep.check("past the 2400px cap the estimate stops growing, because the "
                  "export does", past == capped, "%d vs %d" % (past, capped))
        rep.check("and the export really is the same file either way",
                  past_real == real_export("jpeg", 0.90, 2400),
                  "%d vs %d" % (past_real, capped))

        # The line itself, not just the number handed to it.
        load_pages(three)
        open_sheet(fmt="pdf", quality=90, maxdim=2400)
        line = page.inner_text("#export-summary")
        print("        %r" % line)
        rep.check("the sheet reads as a page count, a format and a size",
                  "3 pages" in line and "PDF" in line and "≈" in line, line)
        rep.check("and it is no longer still saying it is measuring",
                  "measuring" not in line, line)

        print("\nno errors")
        real = [e for e in errors if "favicon" not in e.lower()]
        rep.check("the page raised nothing while all that ran", not real, real[:4])

        browser.close()

    print("\n%d passed, %d failed\n" % (rep.passed, rep.failed))
    return 1 if rep.failed else 0


if __name__ == "__main__":
    sys.exit(main())
