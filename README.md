# JScanner

A mobile-first HTML5 document and receipt scanner. Pick photos from the phone
gallery (or shoot them with the camera), straighten and crop the page, then
clean the tone so the text is sharp for a human reader **and** for OCR.

Everything runs on the device. There is no server, no upload, no account, and
no network access at all — the app works offline and no image ever leaves the
phone.

The running build is printed beside the name on the home screen. It comes from
`JS.VERSION` in `js/00-utils.js`, which is the only place it is written down:
the markup ships an empty span, so a bump is one edit and there is no second
copy to go stale. Bump it by hand and say what changed — the number is for
telling two builds apart, not for promising anything.

### What each build changed

- **1.7.2** - Auto crop adds a guarded edge-strip fallback for long receipts on mixed pale backgrounds. The normal detector remains the first path. Auto all remains Auto crop + Auto clean in the already-selected tone mode; it does not choose Auto colour.

- **1.7.1** — Maintenance release for the move to GitHub Pages. No scanner/detector algorithm change; the running build number is bumped so the GitHub-hosted release is easy to distinguish from 1.7.0.

- **1.7.0** — One reported photo, one change to the detector, and one thing
  measured and dropped. **A taxi receipt was cropped through its right side**,
  taking the amounts column with it: the detector's single threshold is a split
  across the whole frame, and on that photo the split fell at a level where the
  receipt's own right edge and the shadow beside it are the same tone, so the
  fitted right side ran diagonally across the paper. The detector now asks a
  **second question about the same frame — where is the paper's own brightness**
  — builds a second candidate from it, and scores the two against each other on
  inside/outside contrast and interior flatness. The paper's level is a *mode*
  in the histogram, not a tail: a reflection or a shadow is a ramp and puts a
  ramp there, which is why the test is prominence rather than mass. On the
  reported photo the second candidate scores 121.6 against 74.0 and its right
  side tracks the receipt instead of cutting across it; the same swap fixes
  `pair1` (its old crop's bottom edge sliced the last two lines off) and
  `set24`. Three other photos to hand keep the crop they had, three keep
  being declined, and the pale-on-pale refusal from 1.6.0 is untouched — a
  second candidate is only ever tried when the first one succeeds, so no frame
  that is refused today can start being cropped. A second candidate has to be
  worth **25 points** more before it displaces the shipped one, because the
  frame-split answer is the prior and swapping a crop that is already right is a
  regression; that margin is why `pair2` (26.8 against 21.4) and `pair4` keep
  theirs. **Corner settling was built and then dropped on measurement.** The
  plan was to let each corner walk onto the paper, which is the obvious way to
  answer a curled corner. On all twelve photographs to hand it moved *nothing*:
  the acceptance test samples 15%–85% along each side, so the corners are
  precisely the part of a side it never looks at, and the corner metric that
  would have justified it is itself unreliable (`set24`'s corner reads 100%
  paper over plain background). What it did do was change the answer on a
  mutation path, which is not a reason to ship it. **The curled corner on
  `Set30` could not be reproduced**, and the honest position is that it is
  unmeasured rather than fixed — the only copy to hand is a screenshot of the
  result, and rebuilding a source from it detects cleanly with every corner
  above 0.94. The original photo is what that one needs.
- **1.6.0** — Three requests, and the answer to the first one is a measurement.
  **The Export sheet now says what the file will weigh.** *"the default put is
  90% jpg or something like that, can we add the estimated final file size?"* —
  so the line reads `3 pages · PDF · up to 2400 px · ≈ 323 KB` and it is
  measured, not guessed: it renders **three pages of the actual set at the
  actual export size** and encodes them with the same encoder the export uses,
  then multiplies the mean. On a set of three or fewer that is exact, because
  every page was really encoded — a one-page PDF came back 0.01% off the file it
  then produced, a one-page JPEG and PNG 0.00%, a three-page PDF 0.00%, and a
  four-page PDF — the first set big enough to be sampled rather than counted —
  1.0%. It costs about 30 ms a page and it is never on the export path. Two designs were measured and dropped first: sampling at
  600px and extrapolating with a fitted exponent `bytes ∝ px^a` was **−34% to
  +72% wrong**, because a 600px downscale of a document has thrown away exactly
  the high-frequency detail that makes the 2400px original expensive; and
  weighting the samples by page area roughly **doubled** the p90 error, because
  a small dense page carries its density across every other page's area. The PDF
  container is measured the same way — the real writer is called on stub pages
  to size it — and the plan's guessed `242 + 455n` turned out to be wrong: it is
  about 239 + 462n, with a step where the object numbers reach two digits.
  **Auto all no longer picks the mode** — *"auto all is only auto crop and auto
  clean only"*. It crops, then cleans in whatever tone the page is already in,
  and the mode is yours. That made **the Receipt chip the only way into Receipt**
  (Auto all had been the route), so the chip is back. **And the fifth chip cost
  the stage 27.6px**, which is measured rather than estimated: the tone row has
  198.0px to lay chips in at 320px, five chips spelling the modes out in full
  need 231.0px and wrap to a 52.3px row, and the page drops from 70.0% of a
  320×568 screen to 65.1%. Spelling one of them the way the row already spells
  *B/W* for *Black & white* — the chip says **Colour** — with 2px of gap and 4px
  of side padding leaves 12.3px to spare. Slack is the point: a wrap is a cliff,
  so a combination that fitted by a pixel or two would be undone by the next
  font fallback. Finding that cost also found a hole in the test that was
  supposed to catch it — the row-fit guard compared a row's height with its
  tallest *child*, and a flex child that runs out of room wraps inside itself
  rather than growing, so `#mode-chips` read as one line while being two. The
  stage-share floor caught the regression and nothing else did; the guard now
  asks each child the same question, and reverting the chip's label fails it.
  **The third request got a measurement and no code**, which is what was agreed
  in advance. *"sometimes it is bec the background is a little similar colour
  tone as the document"* describes a real failure, and the cause is not the tone:
  measured on a synthetic pale-on-pale frame, the frame's light/dark split lands
  between the **ink** and the page rather than between the page and the counter —
  ink is 200 levels from the paper, the counter is 12 — so the mask selects the
  printing and the detector refuses. It refuses at every ink density and a 4×
  contrast stretch does not help. Separately, all four real photos *Auto crop*
  declines are refused while *fitting edges*, not at any tone guard, and their
  statistics are indistinguishable from the ones it accepts (`set23` declined at
  a 74.9% mask, `set22` accepted at 74.8%). So one fix would not answer both, and
  the honest release note is a documented limit rather than a change: the eight
  crop dots are the remedy. Details under *Crop* in the reference below.
- **1.5.0** — Four requests, and three of them changed what the editor does.
  **Tapping a lit mode chip takes that mode back off.** *Auto colour* and *B/W*
  remember the tone that was on the page the instant before they were tapped and
  put it back on the second tap — so Receipt → *Auto colour* → *Auto colour* ends
  in Receipt, with Receipt's own values, and the crop, the straightening and the
  sharpness never move. A chip tapped *after* another chip is not an undo, and
  *Undo all* clears the memory so the next tap is a first tap. **There are eight
  crop dots, not four**: a dot on each corner and one on the middle of each side,
  and the side dots move that whole side in one drag — which is the fit Auto crop
  is most likely to get wrong on a page lying on a shadow, and one drag instead
  of two corners that have to be made to agree. **Auto clean thresholds
  differently.** The old rule compared each pixel with the local *mean*; the new
  one (Sauvola) adds the local *contrast*, so a window a stroke runs through is
  judged more leniently and a flat one not at all. This is the fix for "the words
  get broken after cleaning when it is a bit thin or blurry": on a page of print
  made faint and soft, against the 99 marks the crisp page actually has, the old
  rule came back with 71 whole and 28 broken into pieces, the new one with 81 and
  18. It is never *stricter* than the old rule — it can only add ink — so nothing
  that used to be found can disappear. The **Auto crop tilt guard** from the last
  release also gained a second, narrower check: a refine pass that both explains
  markedly less of the page's edge and comes back further off square than the
  pass before it is refused, which is what stopped one reported photo coming back
  17° off square. One honest limit: that same photo still does, because its
  bottom edge has almost no usable boundary pixels in either pass — the eight
  dots are the remedy there.
- **1.4.0** — One request with four parts, all about the editor's two
  constraints pulling against each other: the page wants the screen and the
  controls have to stay on it. **The panel is now two labelled lines** —
  `Tone:` with *Auto colour* / *Sharpen* / *B/W* / *Custom*, and `Crop:` with
  *Left* / *Right* / the fine angle / *Undo all*. They replace two titled groups
  whose controls sat under their headings; measured on a 375×667 phone the
  groups were 194px and the lines are 65px, and **the page went from 49.0% of
  the screen to 74.4%** — 69.9% at 320×568, 76.9% at 360×740, 79.7% at 390×844,
  81.7% at 430×932. The footer's own 40px is in that too: two rows became one.
  Everything is still on screen; nothing was hidden to buy the
  height. **The ✨ is gone from the three auto buttons** and *Done* has moved up
  to join them, so the footer is one row of four instead of two rows of three,
  and the pager arrows went up to the topbar to sit around the page number they
  move — four buttons and two arrows do not fit on one 300px line, and the page
  position belongs with the page indicator. **The `Original` chip is gone**: it
  was a button for the state you are already in. **`Fine tuning` is now
  `Custom`**, a plain button in the tone row rather than a `<details>`, because a
  summary's drawer opens inside the summary and in a flex row that means inside
  the chip. *Left* / *Right* lost their `⟲`/`⟳` glyphs, which cost 13px each off
  the fine-angle slider — measured at 320px, 68px of travel without them and 39px
  with, and ±15° over 39px is a slider you cannot set. **The preview zooms**: pinch
  to magnify and check that small print is legible, drag with two fingers to move
  around, and **taking hold of a crop dot zooms 2× onto that corner** and returns
  to the view you had when you let go, so the dot can be landed on the printed
  corner rather than next to it. The zoom is one transform wrapped around the
  canvas *and* the handles together — two elements scaled by two styles drift
  apart at the corners, which is the one place they have to agree. A page springs
  back to fit when you change pages. One honest cost: the pan clamp holds the
  *image's centre* inside the box rather than insisting the image cover it, which
  is the looser rule — and it is looser on purpose, because the cover rule moves
  a grabbed corner 43px out from under the finger by construction. What the
  looseness permits is a strip of empty stage just above fit zoom, and over every
  pan the clamp allows the emptiest stage still shows 74.9% page against the
  72% the fitted view itself shows.
- **1.3.0** — Three things, all from the same report. **There is a Sharpen
  button**, in the mode row where Greyscale was, and it is the one control on
  that row that is not a way of looking at the page but a way of rescuing it:
  tap once for the lightest step, again for medium, again for the strongest, and
  a fourth time to put back what the mode asked for. Its label carries the step,
  and it sharpens without changing the mode, so it stacks on top of whichever of
  the four looks you have picked. **Greyscale is gone as a chip** — it was never
  more than Auto colour desaturated, and the Saturation slider still reaches
  exactly it at −100, so nothing became unreachable. **Auto colour no longer
  adds yellow.** It was not a saturation problem but a paper problem: the
  shadow-removal gain was being derived from a paper level that the warm cast
  had already pulled down, so a cream receipt was pushed further cream. The
  paper is now levelled against its own bright percentile *before* the shadow is
  divided out, which takes the cast off the page and leaves the ink where it
  was. Two costs worth stating: the sharpen's steps **diminish as they climb**
  (the mask clamps, so step 3 is not three times step 1), and sharpening a soft
  shadow's edge makes the false ink line that the B&W threshold draws there
  **more pronounced** — it is there with the sharpen off, and net ink still
  falls as you sharpen, but it is more visible. The build also fixes something
  that was wrong in 1.2.0 without being reported: the unsharp mask's radius was
  a fixed 3×3, so it was sharpening at the preview's scale and again, ~2.7×
  finer in document terms, at export — the saved page was getting 57% of the
  preview's sharpening. The radius is now sized from the buffer, and preview and
  export agree to 2%.
- **1.2.0** — Two fixes, both reported. **The import counter now actually shows.**
  It was already counting — "Loading 3 of 15…" — but the overlay it counts in sat
  inside the editor's stage, and every long job starts on the home screen, so a
  fifteen-photo import gave no sign of life at all. The overlay now covers the
  whole app. **Auto crop no longer shears the paper on a busy photo.** On the
  seven reported photos the mask merges the page with what it lies on, so the
  edge fitter was handed runs of pixels lying along the *photo's own border*,
  which fit perfectly and beat the page's real edge; rectifying a frame-pinned
  quad to a rectangle is what "stretched wrongly" was. Frame pixels are now kept
  out of the fit, and a quad may inherit the frame's edge for **at most one**
  side — the case where the page genuinely runs off the frame. This is a
  behaviour change: three of the seven now report *No clear page edge* and ask
  for a manual crop rather than returning a stretched page, which is the
  intended trade. Straightening is unaffected: `fine` is 0.00 on all seven, and
  the full-frame fixture still crops as it did.
- **1.1.0** — *Undo all* replaces *Reset crop* and puts a page back to the
  imported photo: crop, straighten, 90° rotation, tone and mode together, not
  just the crop. Manual crop arrives as four **corner handles** that are always
  on the preview and can be dragged at any time. *Auto crop* now refuses a score
  curve with no peak in it, which is the fix for four reported photos that came
  back visibly worse than doing nothing — it straightens real photos **less
  often** as a result, deliberately. Also fixes the handles being clipped by the
  stage on the first build that had them: a drag on the bottom-right dot silently
  did nothing.
- **1.0.0** — first build handed over.

## Running it

It is a static site with no build step. Serve the folder over HTTP:

```sh
cd C:/python/projects/jscanner
python -m http.server 8000
```

Then open `http://<your-computer-ip>:8000` on the phone (same Wi-Fi network).

Most of the app also works by opening `index.html` directly from the
filesystem, since it uses classic scripts rather than ES modules. Serving over
HTTP is still recommended — some browsers restrict `file://` behaviour.

To put it on a phone permanently, open it in the mobile browser and use
**Add to Home Screen**. It launches full-screen like a native app.

## Deploying

`dist/` is the folder that gets published. It is built, never edited:

```sh
node tools/build.mjs      # rebuild dist/
node tools/deploy.mjs     # rebuild, then publish to Netlify
```

**Drag `dist`, never the project root.** A manual deploy publishes exactly the
folder it is handed, and the root holds a `netlify.toml` whose `publish` rule
points at `dist` — so handing Netlify the root makes it go looking for a `dist`
that the drag never included, and it fails with *"deploy directory dist does not
exist"*. The root config is there for Git-connected and CLI builds, where
Netlify produces `dist/` itself by running `node tools/build.mjs`.

`tools/build.mjs` writes a second, headers-only `netlify.toml` **inside** `dist/`
so a drag-and-drop deploy still picks up the response headers. It carries no
`[build]` section on purpose: a publish path pointing at `dist` from within
`dist` describes a folder that does not exist, which is the failure above.

## What it does

Everything lives in **one panel, on one screen, with no scrolling**. Cropping and
cleaning are two halves of the same job, and behind tabs the result of one was
never visible while setting the other.

The preview always shows the **finished page** — the same pixels the export will
write. Nothing else is ever on it except the four crop dots.

The editor is a single fixed column: a topbar, the stage, that one panel, and a
footer. **The stage takes whatever the rest leaves**, so the panel is sized by
its own content and the page gets the remainder. That ordering is the point: a
browser that renders a row a few pixels taller costs the page a few pixels
rather than pushing a control under a fold. The panel's content is two lines,
65px, so on a 375×667 phone the page reads at **74.4%** of the screen and
nothing has been scrolled away to get there. It stays above 70% down to
360×740; at 320×568 it lands at 69.9%, because a 47px topbar on a 568px screen
is 8% of the height before anything else is paid for, and everything still fits
and nothing scrolls.

One control is deliberately not on that one screen. **Custom** opens a drawer
holding eight sliders and *Reset tone*, and those are ~340px on their own — more
than any phone has to spare. Closed, it is one chip in the tone row and the
editor fits. Open, the panel scrolls within itself while the page stays above it
and the footer stays put. Everything else the editor has is on screen at once.

Four buttons sit in the footer, on one row, and never move or scroll: *Auto
crop*, *Auto all*, *Auto clean* and *Done*. The first three are the same job at
three scopes — the crop alone, both at once, the tone alone — and all three carry
the same tint, because they differ in how much they do rather than in how much
they matter. They used to be two rows with *Done* below and the page arrows
flanking it; putting *Done* on the same line is where the 34px the page gained
came from. The arrows moved up to the topbar, around the "2 / 5" they move.

*Auto all* is the one-tap path: it finds the page, straightens it, and cleans it
in whichever tone the page is already in. **It does not choose the mode.** It
used to — it read the shape of what it had cropped, and a long narrow strip got
switched to *Receipt* — and that made the shape reading the only route into
Receipt, which is why Receipt had no chip for a while. Removing the guess put
the mode out of reach, so **the chip is back** and every mode a page can be in
now has one. What is left is the division the two buttons always wanted: *Auto
crop* finds the page, *Auto all* finds it and cleans it, and neither
second-guesses the tone. The tone row comes first because the mode is the one
input *Auto clean* has — a button that promised to clean the page while hiding
which way it would do it would be the worse of the two — and the crop row
follows it, because *Auto crop* is the normal path and rotating by hand is the
rescue for when it misses.

`JS.suggestMode` still exists and is still used, by *Auto clean* alone, and only
on a page in `original` — in practice a page that has been through *Undo all*.
A fresh page opens in Auto colour, so in normal use nothing guesses at all.

Both one-tap buttons therefore leave the mode where it is and apply that mode's
tone, so they always agree, and the only thing *Auto all* does that *Auto clean*
does not is the crop. They did not always: *Auto clean* used to fall back to
Auto colour outright, which on a receipt meant *Auto all* cleaned through the
threshold path and *Auto clean* through continuous tone — two different pictures
from two buttons that read as the same job.

**Tone:**

The row is one line: the label, then the chips.

| Mode | What it is for |
|---|---|
| Original | The default. No automatic tone. The manual sliders still apply |
| Auto colour | White balance + gentle contrast + unsharp mask, keeps colour |
| Black & white | Adaptive threshold — crispest for OCR |
| Receipt | Hard threshold and a tighter paper level, for a long narrow strip |

*Original* has no chip. It was one until 1.4.0, and it was a button for the
state the page is already in — the one control in the row that could not change
anything. The mode still exists and is still the default; it is reached by not
touching the row. *Receipt* lost its chip in 1.5.0, when *Auto all* read the
page's shape and selected it for anything over 2.1:1 — a chip would have been
the second way to do one thing. Removing the guess from *Auto all* in 1.6.0 made
the chip the *only* way in, so it is back, and it is the one row in this table
that has changed its mind twice.

**Sharpen** sits in that row without being a mode. It cycles
off → light → medium → strong → off on each tap, puts its step in its own label,
and leaves the mode alone, so it stacks on any of them; the fourth tap is a true
undo because it restores the value the *current* mode asked for rather than a
zero. It is there for the photo that is in focus everywhere except the text.
What it cannot do is invent detail: it steepens the edge the lens left, so a
photo blurred past the point where a stroke has any edge left will come back
with firmer smudges rather than legible ones, and the three steps narrow as they
climb because the mask clamps at the extremes. *Greyscale* used to have that
slot; the Saturation slider reaches it at −100.

**Custom** is the fourth chip and the only one that opens anything. It holds
brightness, contrast, colour strength, saturation, warmth, shadow removal, text
weight and sharpness, and ends with *Reset tone* — which belongs with the
sliders it resets, and which is only the fine-grained way back: *Auto clean* is
pinned, and `autoEnhance` zeroes brightness and warmth as part of applying the
mode's preset, so it is a strict superset of it.

*Auto clean* applies the recommended tuning for the current mode. It is a state
assignment, not a filter that accumulates: `autoEnhance` writes absolute values
per mode, so clicking it twice leaves the second click nothing to do, and
clicking it after *Auto all* re-applies what *Auto all* already applied. The
mode is shown by the lit chip in the row above it, and there is no longer any
other place a mode name appears: `#mode-name`, the label that used to sit to the
right of `Tone:` for a mode no chip could light, went unused when *Receipt* got
its chip back, because every mode a page can be in now has one. The slot is left
in the markup as a safety net — see *The tone row* in `css/app.css` for what
using it again would cost the stage.

**Crop:**

- *Auto crop* finds the sheet of paper, fits each of its four edges as a line
  through the boundary points well clear of the corners, and takes the corners
  as the intersections. It then warps the perspective out and measures the
  residual tilt of the text from the horizontal projection profile to level it.
  If detection fails it says so rather than guessing — rotate in 90° steps and
  try again, or fill the frame better and re-shoot. A sheet that already fills
  the frame is a normal case, not a failure: the sides it runs off are left
  where they are and only the edge that is actually visible moves.
- Detection reads the frame's border to learn what the background is, which it
  will only do when the border is both decisively on one side of the frame's
  light/dark split *and* a single material. A photo of a pale receipt held over
  a pale counter — hand down one side, marble down the other — is neither, and
  the detector declines it rather than cropping the hand, which is what it used
  to do. The tilt search likewise spans the slider's whole ±15° range: a tilt
  past that is refused rather than clipped to the edge of the search, and a
  frame with no text lines to level gets no rotation at all. A third kind of
  frame is refused too: where the score never collapses at any angle there is no
  alignment in it, so the winning angle is whichever way the drift leaned. See
  **Deskew** under *How the image pipeline works*.
- **A pale page on a pale background is declined, and it is not the tone that
  declines it.** Measured on a synthetic frame with the page 12 levels above the
  counter: the frame's light/dark split does not land between the page and the
  counter at all — it lands between the *ink* and the page, because ink is 200
  levels from the paper and the counter is 12. The mask then selects the
  printing instead of the sheet, and the detector refuses. It refuses at every
  ink density from a tenth of the page covered to nine tenths, and stretching
  the frame's contrast 4× about the background level does not rescue it, because
  the ink stretches with everything else. The same frame with the ink left out
  is found, mask 49%, split 237 — so the page-to-counter difference of 12 levels
  was never the problem. What would fix it is a second split *within* the light
  class to separate page from background; that is a detector change and has not
  been made. The eight crop dots are the remedy meanwhile.
- The four shipped photos that *Auto crop* declines all decline somewhere else
  again: their margins are 34–79 against deltas of 16–27 and their mask coverage
  is 49–78%, which is the same range as the photos it *accepts* — the declined
  `set23` covers 74.9% and the accepted `set22` covers 74.8%. They are refused
  after the mask, while fitting edges to its boundary. So no tone-normalising
  change would touch them, and any fix aimed at the pale-page case must be
  checked against all eleven photos for its effect on the seven that work.
- The crop is also **dragged by its corners**: four dots sit on the corners of
  the page in the editor, always there, no mode to enter. Pull one in and the
  page re-warps under your finger — the frame holds the shape it had for the
  length of the drag, so the picture moves inside it rather than the target
  moving away. **Taking hold of a dot zooms the preview 2× onto that corner**,
  which is what makes the dot landable on the printed corner rather than near
  it; letting go returns the view you had, and a view is not something you have
  to reset. This is the way out when *Auto crop* misses, which it now does more
  often by design (see the deskew note above).
- A corner cannot be dragged past the point where the crop stops being a convex
  quadrilateral — onto the line between its two neighbours the page would fold
  over itself along the diagonal, and past them it crosses over. The corner
  stops at the last position that was still a page. That is also why a corner
  cannot be dragged onto the middle of the page: the middle *is* that line.
- *Left* and *Right* rotate in 90° steps, and a fine-angle slider takes anything
  the auto pass missed. Both rotations and *Undo all* are one line with the
  label: they were three stacked rows, which on a 667px phone is 120px the page
  does not get. The buttons carry no `⟲`/`⟳` glyph, which is what the slider
  wanted — see the 1.4.0 note above for the measurement.
- *Undo all* puts a page back to the photo you imported: the crop, the fine
  angle, the 90° rotation and the whole tone block. It is the only control that
  undoes a rotation, so a page turned the wrong way has a way back that is not
  turning it three more times. *Reset tone*, under the sliders, does the look
  alone.

**Zooming the preview**

The preview is the finished page at fit, and that is the view it opens in. Pinch
it to magnify — up to 6×, past which the preview is being upscaled from fewer
pixels than it is drawn at and more would be a magnifying glass over mush rather
than a closer look at the words — and drag with two fingers to move around,
which is the only way to read a corner the fit view has made too small to judge.
A page springs back to fit when you change pages, so a zoom belongs to the page
you zoomed and does not follow you down the set.

The zoom is one transform on a wrapper around the canvas *and* the four crop
handles, not a CSS `scale()` on the canvas. Two elements scaled by two styles
drift apart by a fraction of a pixel at the corners, and the corners are exactly
where a handle has to agree with the picture: half a pixel off is a crop half a
pixel wrong.

Two rules keep it from becoming a trap. **There is no way to pan the page
entirely off the stage** — the image's own centre has to stay inside the box it
was fitted in, one clamp per axis — because there is no scrollbar and no reset
button, and a photo panned out of sight would leave a blank editor whose only
route home is a pinch nobody has a reason to try. And **a pan at fit zoom cannot
move anything**: at 1× the image is no larger than the box on either axis, so
both clamps are pinned to the one position `fitBox` already chose, and a stray
fingertip on an unzoomed preview does not nudge the page.

That clamp is deliberately the loose one. The tighter rule a photo viewer uses —
the image must *cover* the box — is what a grabbed corner cannot survive: for a
letterboxed page the corner sits `fit.x` in from the edge of the box, so
forbidding the empty strip means shifting the image out from under the finger by
exactly that, 43px on a 375px phone, and the dot being aimed at lands nowhere
near the thumb aiming at it. Holding all four corners **exactly** — which the
centre rule does, to the last bit — is worth more here than forbidding a strip
of empty stage. What the strip costs is small and only exists just above fit
zoom: over every pan the clamp allows, the emptiest stage still shows 74.9% page
against the 72% the fitted view itself shows, and past 1.33× the page covers the
stage completely.

**Done — finishing a page**

**Done** bakes the current result into the page: it renders at full working
resolution, makes that the page's image, and resets the crop, rotation, mode and
sliders, because their effect is now in the pixels. The original is discarded.

Afterwards the page *is* the cleaned image everywhere — the grid thumbnail, the
editor if you reopen it, and the exported file. A badge on the thumbnail shows
how the page was finished; edit anything and it clears itself, so you can always
tell which pages are still unfinished. **Back** leaves a page unfinished.

Committing twice in a row is free — the app notices nothing changed and skips
the re-encode rather than spending a generation of JPEG quality.

The photo in your gallery is never touched, so a committed page can always be
redone by adding the original again.

**Export**

Multi-page PDF, or individual JPEG/PNG files. Adjustable JPEG quality and a
max-long-edge cap. The sheet says what the result will weigh — `3 pages · PDF ·
up to 2400 px · ≈ 1.4 MB` — and the number is a **measurement, not a formula**:
it renders three pages of the actual set at the actual export size, encodes them
with the same encoder the export uses, and multiplies the mean. On a three-page
set that is exact, because every page was really encoded; the more pages there
are the more it leans on the ones it sampled, which is why the third of the set
it did not look at is the third it is least sure of. It costs about 30ms a page
and it never runs on the export path — a slow or failed estimate cannot break an
export, it just leaves the size off the line.

The quality slider re-encodes the sample as you drag it, so the number follows
the slider. The max-long-edge slider is honest about a limit the app has always
had: photos are capped at 2400px on the way in, nothing upscales, so above
2400px the number stops moving — because the file stops changing. On phones that
support it, the Web Share API sends the files straight to another app; otherwise
they download.

## How the image pipeline works

```
photo ──► decode + EXIF-correct + downscale ──► blob-backed <img>
                                                     │
                          ┌──────────────────────────┘
                          ▼
                   oriented canvas (coarse rotation)
                          │
                          ▼
                   rectify: de-skew + perspective warp (bilinear)
                          │
                          ▼
                   enhance: levels / threshold / unsharp
                          │
                          ▼
                   preview · thumbnail · export
```

A few decisions worth knowing about:

- **Boundary points** are the sheet's *outline*, not every page pixel that
  borders a non-page value. A page of text is mostly holes — each glyph is a gap
  in the bright region — so the rim of the printing can outnumber the rim of the
  paper several times over, and lines fitted to that land on the paragraph
  margins: a crop around the text rather than around the sheet. The two are told
  apart by reachability. The desk below the page is a non-page region you can
  walk to from the frame border; a glyph is one you cannot. A page pixel sitting
  on the frame itself counts as outline as well, because for a page shot to the
  edges of the frame that is the only evidence the side has at all.
- **Edge fitting** uses total least squares — the principal axis of the
  covariance — rather than a y-on-x regression, because a page edge runs in
  whatever direction the page is rotated to and a regression blows up as the
  edge approaches vertical. It is fitted to the line most of the side's points
  *agree* on rather than to their average, because one bucket can hold the page
  edge and the rim of a shadow lying across it at once, and least squares has no
  opinion about which of its inputs deserve to be there — it splits the
  difference between the edge and the damage and is then wrong about both. Both
  ends of each side are dropped before fitting: a point near a corner is on two
  sides at once and tilts both lines outwards. A side whose points no single
  line describes is rejected, and the whole refinement is abandoned, because a
  quad built from three measured edges and one guessed corner *looks* like an
  improvement while having moved a corner on no evidence.
- **Output size** is the *average* of each pair of opposite sides, not the
  longer one. Shot at an angle the near edge of a page genuinely measures longer
  than the far edge — that difference is the perspective, and it is what the
  warp exists to remove. Sizing to the longer edge would keep it as a permanent
  stretch.
- **Auto levels** stretches each channel to its 0.4–99.6 percentile, then
  blends that with a luminance-only stretch. That removes a tungsten or
  fluorescent colour cast without destroying genuinely coloured content such as
  a red stamp.
- **Shadow removal** estimates the local background with a large box blur
  (computed from a summed-area table) and divides it out, so a shadow across
  the page becomes uniform white instead of a dark band. It runs in **every**
  mode, not just black & white, and the gain is computed from luminance and
  applied to all three channels together — per-channel would flatten a shadowed
  red stamp to grey, because the red channel's own background is darker and
  would be scaled harder. The slider is a *blend* towards the flattened result
  rather than a switch, and the automatic presets are set high (85) because a
  half-strength blend leaves a third of the shadow behind. Judged by the paper
  level rather than by an average, which counts the ink as if it were shade: on
  a shadowed receipt, 45 leaves the paper at 193 against 255 on the lit side,
  while 85 puts both at 255.
- **Adaptive threshold** is Bradley–Roth: each pixel is compared with the mean
  of its neighbourhood. That copes with uneven lighting far better than one
  global threshold. It has one known artefact — the interior of any dark region
  wider than the window comes out white — so an absolute floor keeps solid
  logos, barcodes and heavy rules filled in.
- **Deskew** maximises the variance of the horizontal projection profile. Text
  lines produce a sharp peak when they are level, so the angle that maximises
  it is the angle that levels them. Which angle that is, though, is only worth
  acting on if the curve *has* a peak, and three kinds of frame are refused
  instead of straightened. A tilt at or past the ±15° the slider can express is
  one: an optimum sitting on the edge of the search is the search ending, not a
  peak. A frame with no text lines to level is another. The third is the one
  that took a report to find. On a page with real line structure, turning
  fifteen degrees off alignment collapses the score to a few percent of its
  height — so a curve whose own minimum is a large fraction of its maximum has
  no alignment in it, whatever its maximum happens to be, and the winning angle
  is only whichever way the drift leaned. Dense text under a cast shadow, and
  busy content, keep variance at every angle; measured on the four photos that
  prompted the guard, those curves bottom out at 0.49–0.75 of their height
  against 0.05–0.12 for curves that genuinely align, and a visually upright
  receipt was being rotated −10.2°. Refusing them means *Auto crop* straightens
  real photos less often than it used to. That is the intended trade: a page
  left slightly tilted is recoverable with the fine-angle slider or the corner
  handles, and an upright page rotated by ten degrees is not.
- **Memory**: sources are stored as blob-backed `<img>` elements rather than
  pinned canvases, corners are stored normalised (0..1), and derived canvases
  are cached three-per-page and released when leaving the editor. Three, because
  three sizes are live at once — the fast preview a slider drag redraws, the
  full-quality preview it redraws when the finger lifts, and the grid thumbnail
  — and at two the smallest is always the one evicted, so one of them pays a
  full re-warp every time it comes round. Without any of this a dozen pages
  exhausts a phone tab.

## Layout

```
index.html          markup for all screens
css/app.css         styling
js/00-utils.js      helpers, geometry, homography solver
js/10-imageops.js   pixel operations (Otsu, integral images, thresholding, tone)
js/20-detect.js     page-edge detection and deskew estimation
js/30-pipeline.js   page model, geometry warp, tone pipeline
js/40-export.js     JPEG/PNG encoding, PDF writer, download and share
js/50-ui.js         state, screens, preview, controls
js/60-init.js       boot
tests/              node + python checks (see below)
tests/fixtures/     the four photos the tilt bug was reported with
```

## Tests

```sh
node tests/smoke.js               # geometry, image ops, detection, deskew, crop mapping, commit, PDF bytes
node tests/commit_flow.js         # drives the real commitPage headless
node tests/dom_check.js           # every id/selector the JS uses exists in the HTML

# The real page in a real browser: layout, what the stage is showing, and
# shadow removal measured on Chromium's canvas (needs Playwright + Pillow).
python tests/ui_flow.py

# Rotate-after-crop: rasterises the real canvas composition (needs Pillow).
# The `legacy` run must FAIL -- it replays the pre-fix geometry, so it proves
# the checks can actually catch the bug.
python tests/oriented_render.py
python tests/oriented_render.py legacy

# PDF round-trip through a real reader (needs Pillow and PyMuPDF)
python tests/pdf_roundtrip.py make
node tests/pdf_roundtrip.js
python tests/pdf_roundtrip.py verify
```

`smoke.js` covers the parts with no DOM dependency, including the homography
solver, the Otsu boundary convention, the adaptive-threshold floor, the
three-points-per-side edge fit, corner ordering, the deskew sign convention, the
rotation algebra, the oriented layout and the crop mapping. The PDF is validated
by opening it with PyMuPDF and rendering each page, because a structurally
self-consistent PDF can still be unopenable.

It also checks **the view** — pinch, pan and the corner grab — as arithmetic on
four numbers, because that is all it is, and every one of those numbers has to be
checkable with no layout and no browser at all. Its corner checks are the ones
that matter: for each of the four corners it asserts that after grabbing it at 2×
the corner is still under the finger, and it asserts the same thing of a loop over
every zoom and every anchor the clamp allows. Both were mutation-tested against
the cover-the-box clamp — the tighter rule a photo viewer uses — which fails them
by exactly the letterbox margin, 43.5px across and 11px down on the box the check
uses. A second check requires that no allowed view can empty the stage, which is
what says the loose clamp is still a clamp; the measured worst case is 74.9% page,
which is *more* than the fitted view shows.

One section of it is worth calling out: *the outline, not the printing* counts
the boundary points on a synthetic sheet of text and requires them to be the
sheet's outline rather than the rims of its glyphs. That distinction is not
visible anywhere downstream — a fit handed a bad point set can still return a
plausible quad — so the count is taken where it is decided. Replaying the old
version of the function puts 3852 points where the outline is 496, and 3360 of
them inside the sheet; on the photograph that started this it was 3954 against
1200. Like `oriented_render.py legacy`, that section carries its own falsifier:
it re-runs the same checks against the old function and requires them to fail,
so the guard's ability to fail is a fact about the suite rather than a claim in
a document.

`ui_flow.py` exists because none of the others can see layout at all, and
because it is the only one that presses the buttons. It loads `index.html` from
`file://` exactly as the phone would, feeds it synthetic photographs through the
real file input, and drives the controls. It reads the stage's aspect back off
the DOM and compares it against the aspect the crop geometry implies, derived
independently — so the preview cannot pass by merely being self-consistent. It
measures the tone pipeline through Chromium's canvas rather than a hand-written
stub.

It also measures the editor's layout at five phone sizes, because every number
in that layout is a number in a stylesheet and no other suite here can see any
of it. The load-bearing checks are that **the panel does not scroll** — the
user's requirement, in one number — and that **every control the user can see is
painted inside the panel's box**, asked of each of them by name. Then that *Auto
crop*, *Auto all*, *Auto clean* and *Done* are inside the viewport rather than
merely present, that the four of them share their row without a label painting
over its neighbour, that **each of the two panel rows fits on one line at its
longest possible labels** — the tone row is measured with *Sharpen 3* and
`Black & white` forced in, which are the widest strings those two slots can ever
hold — that nothing is pushed off the bottom, that the mode *Auto clean* will
apply is on screen, that the fine-angle slider keeps at least 60px of travel for
a ±15° range to live in, and that the page gets at least 69% of the screen
(69.9% is what 320×568 actually reaches; the floor is one point under it).

Four of those need care worth knowing about. `is_visible` and a bounding rect
are both true of a control scrolled out of an `overflow: auto` parent — it is
clipped, not moved — so "on screen" has to be asked as *inside the box that
clips it*. A `scrollWidth` is no better for a *centred* overflow: scrollable
overflow excludes the inline-start direction, so a label too wide for its button
spills both ways and `scrollWidth` sees neither, which is how the first version
of the row check passed a row with a deliberately lengthened label. It measures
the painted label with a `Range` instead. And an unrendered control is still a
control to `querySelectorAll`: the drawer is toggled with `hidden`, which
`css/app.css` turns into `display: none`, so its subtree has **no layout at
all** — every rect is 0×0 and a naive measurement calls the sliders controls
zero pixels wide inside the panel's box, which is a pass. The checks filter on
`getClientRects().length` instead. (Before 1.4.0 the drawer was a `<details>`,
which Chromium lays out but does not paint, so the same sliders reported as real
rects 300px below the fold instead. Both ways of asking are wrong, in opposite
directions, and this is the second time this probe has had to be told what
"visible" means.)

The whole set is re-run against a replay of the previous arrangement — the two
titled groups, the five rows, the `Original` chip and the `<details>` drawer,
all rebuilt out of the live nodes — and the loop's own predicates are required
to come out the other way there: the panel scrolled, and the rotate buttons and
the fine-angle slider were clipped outside its box. That replay is also how the
size of this change is kept honest: it measures the page at **55%** against the
74% the two lines give — and it spends that 55% on a panel that scrolls — so the
height that was bought is a number in the suite rather than a claim in this file.
The suite's replay is a rebuild of the reported arrangement out of the live
nodes, not a copy of it, so it is close rather than exact: the real pre-change
build measured 49.0% at the same size, which is the figure the changelog quotes.
Where it measures a shadow it compares the **paper level** — the 90th
percentile of each half — rather than the mean, because the fixture's print does
not reach the edge of the paper and a mean reports ink coverage as though it
were shade. It presses *Auto crop* on a page that runs off three sides of the frame
and checks that the width and the top survive while the floor goes, and that
what is rendered ends on paper rather than on the floor. It then feeds it a photo
the detector cannot read — a pale receipt over a pale counter, hand on one side
and marble on the other — and checks it says so, leaves the crop alone and
rotates nothing; then puts the pre-guard detector back into the page and requires
that *it* crops the wrong part of the frame and invents a −15° tilt, so the
checks above are known to be about a change rather than about a frame that was
always refused. And it asserts that the rotate buttons change what is on screen,
which is exactly what nothing did before: both node suites were green while
**rotate did nothing visible**, because the maths underneath the button was
correct and the button was not wired to the result you could see.

That is the rule this project keeps re-learning: **every user-facing control
needs a test that presses it and looks at the result.**

`oriented_render.py` exists because pure arithmetic on the layout would have
happily agreed with the rotate-after-crop bug at 0° and 180°, where no dimension
swap happens. Only rasterising the composition catches the angles the user
actually hit.

The four photos the tilt bug was reported with are checked in as fixtures,
pulled back out of the screenshots they arrived as, and *Auto crop* is run on
each one: none of the four may be tilted, all four must still be cropped, and
the pre-guard detector put back into the page must reproduce the reported −10.2°
on the worst of them. The crop handles are dragged with real pointer events, and
the landing point is derived independently of the app's own map — a projective
map carries straight lines to straight lines, so the middle of the finished page
is where the crop quad's diagonals cross, and that is computed from the corners
alone. The handles are also measured at all five phone sizes for being drawn
*whole*: the stage clips them, so the letterbox reserves the dot's radius, and
without it all four come back half-cut at every size.

The zoom is driven with real multi-touch through CDP rather than synthesised
pointer events, because that is the only way the app's own path runs end to end —
a synthetic `pointerdown` cannot take pointer capture, and the crop drag takes
it. It pinches with two fingers and asserts the page point between them does not
move; it grabs each of the four corners and asserts the corner comes to rest
under the finger and that the view goes back to fit on release; it drags a corner
while zoomed and asserts the dot tracks the finger one-for-one on screen, which
is the thing that would silently break if the zoom and the crop mapping ever
disagreed about which coordinates they were in.

Each of these was checked against deliberately broken code before being
trusted — a test that has never failed is not yet evidence. An earlier round
included a mutation that swapped the axis of the *inset* handles of the since
removed comparison view: it passed every behavioural check, because a handle
painted in the wrong place is still grabbed in the right place, and only a pixel
sample of the overlay caught it. The removal of that whole feature is pinned the
same way, with checks that the state, the helpers and the DOM nodes are all
actually gone rather than merely unused. (The crop handles are a different set,
added later, and share none of it.)

## Known limits

- Auto-detection assumes the page is distinguishable from its background, and
  that the frame's *border* is a background at all. A white receipt on a white
  table will not be found, and neither will a sheet filling a frame whose border
  is a mixture with no dominant material — held between two hands, say, or shot
  across a table edge. Both are now refused rather than guessed at, and the
  fallback is the corner handles: drag the four dots onto the sheet by eye.
  Rotating in 90° steps and trying again, or re-shooting with more of the
  background in frame, are the other two.
- A page edge needs a *seam* to be found: the paper's own shadow on the surface
  below it, a tone difference, a fold. Where the floor right under the sheet is
  as bright as the sheet itself there is no boundary in the image, and the crop
  will run past the paper to wherever the two do part. That is a limit of
  looking at one photograph, not a tuning problem.
- Taxonomy of the "clean" modes is heuristic, not adaptive per document. If a
  page comes out too aggressive, drop the *text weight* slider or switch to
  Auto colour.
- The editor's panel fits on one screen at 65px of two rows, which is as small as
  it goes without giving up a control: 74.4% of a 375×667 phone is the page,
  against about 47% for the two titled groups this replaced. Below 360×740 the
  topbar's fixed 47px starts to show — at 320×568 the page is 69.9% — and on a
  screen shorter than that the panel and the footer would have to fight, which is
  what the panel's max-height cap is for. Nothing on the editor is under a fold
  except the Custom drawer.
- Each of the two rows is one line and has no slack in it. The tone row at 320px
  carries *Auto colour* / *Sharpen 3* / *B/W* / *Custom*, and `Black & white`
  appearing in the label slot beside `Tone:` is the widest that row ever gets;
  the crop row's *Left*, *Right* and *Undo all* leave the fine-angle slider 68px
  at that width, which is the floor for a ±15° control. A longer chip label, or a
  glyph back on a rotate button, needs the row measured rather than looked at —
  `ui_flow.py` measures both rows at five sizes, with the worst labels forced in.
- The four footer buttons share one row and it is full: at 320px each is 72px and
  *Auto clean* wants 62px. A fifth button there, or a reworded one, would paint
  over its neighbour instead of wrapping, because `.btn` is `white-space: nowrap`.
  That is what the pager arrows moving to the topbar bought, and the row has
  nothing left over.
- Order in that panel is still load-bearing — the tone row is above the crop row
  because *Auto clean* acts on the mode — even though nothing is under a fold any
  more, because it is also the reading order.
- The preview's zoom is a view, not a state: it is not saved with the page and it
  is not part of what makes a page "edited". Pinching to read a corner and
  tapping *Done* bakes the page exactly as it would have without the pinch.
- The deskew search covers the slider's whole ±15°. At or beyond that it
  returns 0 rather than a clipped guess: such an optimum sits on the edge of the
  search, where a page tilted 15° cannot be told from a frame with no text lines
  in it at all. Rotate in 90° steps first, or set the slider by hand.
- Nothing is persisted. Closing the tab loses the pages, so export before you
  leave. A before-unload prompt warns you.
