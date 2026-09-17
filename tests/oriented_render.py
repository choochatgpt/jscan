"""End-to-end guard for the rotate-after-crop bug.

    python tests/oriented_render.py

The node tests cover `orientedLayout` as pure maths. This one actually
rasterises the composition the browser performs —

    translate(canvasW/2, canvasH/2); rotate(coarse); drawImage(source, ...)

— with a real image library, because the reported symptom ("rotate did not take
the cropped image into account", page reduced to a strip) was a *visual* fault
that pure arithmetic cannot fully rule out.

Two invariants, both derived from the canvas semantics rather than from the
current code:

  1. The source's black border must land exactly on the canvas border at every
     coarse angle. Overflowing content clips the border away and leaves the
     canvas edge showing page interior instead.
  2. A marker at a known place in the source must appear where the normalised
     rotation algebra (`rotateCoarse`) says it will.

Run with `legacy` to reproduce the pre-fix geometry; the checks must FAIL there,
which is what makes this a regression guard rather than decoration.
"""
import math
import os
import sys

from PIL import Image, ImageDraw

SRC_W, SRC_H = 1000, 2000
MAX_DIM = 900
FRAME = 8
BG = (245, 245, 245)
INK = (10, 10, 10)
MARKER = (0, 200, 0)

# Where the marker sits in the source, normalised.
MARK_AT = (0.25, 0.10)
MARK_PX = 60


# --------------------------------------------------------------- geometries

def layout(page, max_dim):
    """The fixed geometry: canvas takes the rotated dims, source keeps its own
    aspect ratio. Mirrors js/30-pipeline.js `orientedLayout`."""
    w, h, coarse = page["w"], page["h"], page["coarse"]
    swap = coarse in (90, 270)
    fw, fh = (h, w) if swap else (w, h)
    s = min(1.0, max_dim / max(fw, fh))
    dw, dh = w * s, h * s
    return {
        "canvasW": max(1, round(fw * s)),
        "canvasH": max(1, round(fh * s)),
        "drawX": -dw / 2,
        "drawY": -dh / 2,
        "drawW": dw,
        "drawH": dh,
    }


def legacy_layout(page, max_dim):
    """Pre-fix geometry: the source was stretched into the *swapped* canvas
    dimensions before the rotation, so its aspect ratio was destroyed."""
    w, h, coarse = page["w"], page["h"], page["coarse"]
    swap = coarse in (90, 270)
    fw, fh = (h, w) if swap else (w, h)
    s = min(1.0, max_dim / max(fw, fh))
    cw = max(1, round(fw * s))
    ch = max(1, round(fh * s))
    return {
        "canvasW": cw,
        "canvasH": ch,
        "drawX": -cw / 2,
        "drawY": -ch / 2,
        "drawW": cw,
        "drawH": ch,
    }


def render(src, page, max_dim, layout_fn):
    """Replicate the canvas composition with an explicit inverse-affine map.

    Canvas `rotate(t)` acts on y-down coordinates as R(t) = [[cos,-sin],
    [sin,cos]]. PIL's AFFINE wants the inverse (output pixel -> input pixel),
    so R(-t) is used, spelled out rather than borrowed from a rotate() call
    whose sign convention would be one more thing to get wrong.
    """
    L = layout_fn(page, max_dim)
    cw, ch = L["canvasW"], L["canvasH"]
    cx, cy = cw / 2.0, ch / 2.0

    t = math.radians(page["coarse"])
    cs, sn = math.cos(t), math.sin(t)
    sx = src.width / L["drawW"]
    sy = src.height / L["drawH"]

    a = cs * sx
    b = sn * sx
    c = (-cs * cx - sn * cy - L["drawX"]) * sx
    d = -sn * sy
    e = cs * sy
    f = (sn * cx - cs * cy - L["drawY"]) * sy

    return src.transform((cw, ch), Image.AFFINE, (a, b, c, d, e, f),
                         resample=Image.BILINEAR)


# ------------------------------------------------------------------ fixture

def make_source():
    img = Image.new("RGB", (SRC_W, SRC_H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, SRC_W - 1, SRC_H - 1], outline=INK, width=FRAME)
    mx, my = MARK_AT[0] * SRC_W, MARK_AT[1] * SRC_H
    d.rectangle([mx - MARK_PX / 2, my - MARK_PX / 2,
                 mx + MARK_PX / 2, my + MARK_PX / 2], fill=MARKER)
    return img


def marker_centroid(img):
    px = img.load()
    n = 0
    sx = sy = 0
    for y in range(img.height):
        for x in range(img.width):
            r, g, b = px[x, y]
            if g > 150 and r < 120 and b < 120:
                n += 1
                sx += x
                sy += y
    if not n:
        return None, 0
    return (sx / n, sy / n), n


def edge_is_inked(img):
    """Fraction of near-black pixels in the outer 2px band of each edge."""
    px = img.load()
    w, h = img.size
    dark = total = 0
    for y in range(h):
        for x in list(range(2)) + list(range(w - 2, w)):
            r, g, b = px[x, y]
            total += 1
            if r < 90 and g < 90 and b < 90:
                dark += 1
    for x in range(w):
        for y in list(range(2)) + list(range(h - 2, h)):
            r, g, b = px[x, y]
            total += 1
            if r < 90 and g < 90 and b < 90:
                dark += 1
    return dark / total if total else 0.0


# -------------------------------------------------------------------- checks

def run(layout_fn, label):
    """Returns the names of every check the given geometry fails."""
    src = make_source()
    failures = []

    def check(name, cond, detail=""):
        print(f"  {'ok  ' if cond else 'FAIL'} {name}" + (f"  -- {detail}" if detail else ""))
        if not cond:
            failures.append(name)

    print(f"\n{label}")

    for coarse in (0, 90, 180, 270):
        page = {"w": SRC_W, "h": SRC_H, "coarse": coarse}
        out = render(src, page, MAX_DIM, layout_fn)
        L = layout_fn(page, MAX_DIM)
        cw, ch = L["canvasW"], L["canvasH"]
        deg = f"{coarse}°"

        # 1. The source border must land on the canvas border.
        band = edge_is_inked(out)
        check(f"source border reaches every canvas edge @{deg}", band > 0.75,
              f"inked edge fraction {band:.2f}")

        # 2. The marker must land where the *normalised* crop algebra says.
        #
        # `rotateCoarse` works on normalised corners: one clockwise turn is
        # (x, y) -> (1 - y, x). That algebra is what keeps a user's crop glued
        # to the same feature of the photo, so it must agree with the pixels —
        # which is exactly what broke. Deriving the expectation from the
        # algebra (not from the layout) is what makes this discriminate.
        centroid, n = marker_centroid(out)
        nx, ny = MARK_AT
        for _ in range((coarse // 90) % 4):
            nx, ny = 1 - ny, nx
        want = (nx * cw, ny * ch)
        if centroid is None:
            check(f"marker survives the rotation @{deg}", False, "marker not found")
        else:
            err = math.dist(centroid, want)
            # A marker this size, resampled, should land well inside 1/4 of its
            # own width; the pre-fix geometry is out by ~200px here.
            check(f"marker lands where the crop maths says @{deg}", err < MARK_PX / 4,
                  f"at {centroid[0]:.0f},{centroid[1]:.0f} want "
                  f"{want[0]:.0f},{want[1]:.0f} (off by {err:.0f}px)")
            check(f"marker is not clipped @{deg}", n > 0.6 * (MARK_PX * MAX_DIM / SRC_H) ** 2,
                  f"{n} px visible")

    return failures


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "fixed"

    if mode == "legacy":
        # Sanity: the guard must reject the pre-fix geometry, otherwise it
        # proves nothing about the bug the user actually hit.
        bad = run(legacy_layout, "legacy (pre-fix) geometry")
        print()
        if bad:
            print(f"guard is live: the pre-fix geometry fails {len(bad)} checks")
            sys.exit(0)
        print("GUARD IS BLIND: the pre-fix geometry passes every check")
        sys.exit(1)

    bad = run(layout, "fixed geometry")
    print()
    if bad:
        print(f"{len(bad)} failed: {', '.join(bad)}")
        sys.exit(1)
    print("oriented render ok")
