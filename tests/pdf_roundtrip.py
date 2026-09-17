"""Fixture generator and validator for tests/pdf_roundtrip.js.

    python tests/pdf_roundtrip.py make      # write the JPEG fixtures
    python tests/pdf_roundtrip.py verify    # open out.pdf with PyMuPDF
"""
import sys
import os

from PIL import Image, ImageDraw
import fitz  # PyMuPDF

TMP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tmp")

# Distinct, high-contrast content so a blank render is obvious.
SPECS = [
    ("page1.jpg", (800, 600), (250, 250, 250), (20, 20, 20), "PAGE ONE"),
    ("page2.jpg", (600, 800), (250, 250, 250), (150, 20, 20), "PAGE TWO"),
    ("page3.jpg", (1000, 400), (250, 250, 250), (20, 20, 150), "PAGE THREE"),
]


def make():
    os.makedirs(TMP, exist_ok=True)
    for name, size, bg, fg, label in SPECS:
        img = Image.new("RGB", size, bg)
        d = ImageDraw.Draw(img)
        w, h = size
        for i in range(6):
            y = int(h * (0.15 + i * 0.12))
            d.rectangle([int(w * 0.1), y, int(w * 0.9), y + 14], fill=fg)
        d.rectangle([0, 0, w - 1, h - 1], outline=fg, width=6)
        d.text((int(w * 0.12), int(h * 0.02)), label, fill=fg)
        img.save(os.path.join(TMP, name), "JPEG", quality=88)
        print(f"  made {name} {size}")


def verify():
    path = os.path.join(TMP, "out.pdf")
    if not os.path.exists(path):
        print("FAIL  out.pdf missing")
        return 1

    failures = []

    def check(name, cond, detail=""):
        if cond:
            print(f"  ok   {name}")
        else:
            print(f"  FAIL {name}  -- {detail}")
            failures.append(name)

    doc = fitz.open(path)
    check("reader opens the file", doc.is_pdf)
    check("page count is 3", doc.page_count == 3, f"got {doc.page_count}")

    for i, (_, size, _, _, _) in enumerate(SPECS):
        if i >= doc.page_count:
            break
        page = doc[i]
        r = page.rect
        check(
            f"page {i + 1} media box is {size[0]}x{size[1]}",
            abs(r.width - size[0]) < 1.5 and abs(r.height - size[1]) < 1.5,
            f"got {r.width:.0f}x{r.height:.0f}",
        )
        imgs = page.get_images(full=True)
        check(f"page {i + 1} carries one image", len(imgs) == 1, f"got {len(imgs)}")

        # Render it: a structurally valid page can still draw nothing.
        # Sample whole pixels — a byte stride that happens to be a multiple of
        # the channel count lands on one channel forever and misses dark
        # content that is only dark in the others.
        pix = page.get_pixmap(dpi=36)
        s, n = pix.samples, pix.n
        pixels = pix.width * pix.height
        step = max(1, pixels // 4000) * n
        dark = sum(
            1
            for i in range(0, len(s) - n + 1, step)
            if min(s[i : i + 3]) < 128
        )
        check(f"page {i + 1} renders non-blank content", dark > 40, f"dark samples={dark}")

    doc.close()
    print()
    if failures:
        print(f"{len(failures)} failed: {', '.join(failures)}")
        return 1
    print("pdf round-trip ok")
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "verify"
    sys.exit(make() or 0 if cmd == "make" else verify())
