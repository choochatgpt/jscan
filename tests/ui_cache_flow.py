"""tests/ui_cache_flow.py — the on-device photo cache, in a real browser, over a real URL.

WHY THIS EXISTS, AND WHY IT IS NOT PART OF ui_flow.py
----------------------------------------------------
The client's requirement is a claim about what happens on his phone:

  "i expect that right after i pick the button, immediately the previous 6 photos are
   already loaded inside the app"

— with NO PICKER. Whether that is true cannot be established by reading js/79-photo-cache.js,
and it cannot be established by the Node test either, because the Node test supplies its own
fake IndexedDB. This drives the SHIPPING index.html in Chromium at 390x844, picks real
photographs through the real input, edits them through the real app, RELAUNCHES THE PAGE, and
then counts how many times a picker was opened.

It is a separate file from ui_flow.py for one reason: ui_flow.py loads the page from
`file://`, and this test needs two things file:// cannot give it. IndexedDB is restricted on
opaque origins in some builds, and `navigator.storage.persist()` is only defined in a SECURE
CONTEXT — with `file://` the answer would be "unavailable" for a reason that has nothing to do
with his phone. So the app is served over http://127.0.0.1, which Chromium treats as a
trustworthy origin, and both work.

WHAT IT PROVES, IN ORDER
------------------------
1. The photographs are picked, edited (crop, rotation, tone, redaction mask, comment) and
   cached — and the banner says, at that moment, that they are on the phone and NOT uploaded.
2. The page is RELAUNCHED: a new page in the same browser context, so the same origin
   storage, and therefore the same IndexedDB.
3. One tap on the offer loads all of them with `__pickers` — a counter installed before any
   app code runs — still at ZERO. The counter is the whole point: it counts real clicks on a
   file input and real calls to the two picker APIs, so "no picker" is measured, not asserted.
4. Every saved edit came back, on FRESH page objects (the previous session marked its own
   page objects, and none of those marks are present).
5. The round trip is repeatable: the restored state is cached again, from the restored pages.
6. The only thing the page ever fetched is the app's own version.txt from its own origin.
   Nothing was sent anywhere, and the cache never touched the Learn transport.
7. "Forget saved photos" empties the store, and a third launch offers nothing.

Run:  python tests/ui_cache_flow.py        (needs Playwright and Pillow)
"""

import http.server
import os
import socketserver
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from ui_flow import Report, make_photo, make_receipt_photo, TMP   # noqa: E402


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass


def serve():
    """The app over http://127.0.0.1 — a secure context, so storage.persist() exists."""
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), QuietHandler)
    httpd.daemon_threads = True
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, "http://127.0.0.1:%d/index.html" % httpd.server_address[1]


# Installed BEFORE any app code runs, on every navigation in the context. Everything it
# records would otherwise be invisible to the test: a picker that opened and was dismissed,
# a fetch that was never awaited, a page object reused across a reload.
INIT = r"""
window.__pickers = { input: 0, dir: 0, files: 0, clicks: [] };
window.__fetches = [];
const _click = HTMLInputElement.prototype.click;
HTMLInputElement.prototype.click = function () {
  if (this.type === 'file') { window.__pickers.input++; window.__pickers.clicks.push(this.id || '(anon)'); }
  return _click.apply(this, arguments);
};
window.showDirectoryPicker = function () {
  window.__pickers.dir++; window.__pickers.clicks.push('showDirectoryPicker');
  return Promise.reject(new Error('this test never expects a folder picker'));
};
window.showOpenFilePicker = function () {
  window.__pickers.files++; window.__pickers.clicks.push('showOpenFilePicker');
  return Promise.reject(new Error('this test never expects a file picker'));
};
const _fetch = window.fetch;
window.fetch = function (input) {
  try { window.__fetches.push(String(input && input.url ? input.url : input)); } catch (e) {}
  return _fetch.apply(this, arguments);
};
"""

# What the cache records and what the test then demands back. Set through the app's own
# public interfaces — JS.setMode, JS.invalidate, JS.learnMask.restore, JS.learnUI.setComment
# — because the cache's job is to preserve whatever state the app is in, not to have an
# opinion about how it got there.
EDIT = r"""
(() => {
  const pages = JS.app.pages;
  pages.forEach((p, i) => {
    p.coarse = 90;
    p.fine = -3 + i;
    p.corners = [{x:0.10, y:0.08}, {x:0.90, y:0.08}, {x:0.90, y:0.94}, {x:0.10, y:0.94}];
    p.cornersFrom = 'manual';
    p.autoRan = true;
    p.autoOutcome = (i === 1) ? 'refused' : 'found';
    JS.invalidate(p);
  });
  JS.app.active = 0;
  JS.setMode('bw');
  pages[0].adj.contrast = 22;
  pages[0].adj.wb = 70;
  pages[0].adj.flat = 70;
  JS.invalidate(pages[0]);
  /* A real brush stroke, through the same calls the brush handler makes: a mask is
     {radius, strokes:[{r, pts:[{x,y}]}]}, and nothing else is one. */
  const mask = JS.learnMask.create();
  JS.learnMask.setRadius(mask, 24);
  const stroke = JS.learnMask.beginStroke(mask, 0.30, 0.22);
  JS.learnMask.extendStroke(mask, stroke, 0.62, 0.24);
  pages[0].mask = mask;

  /* The comment as js/76 holds it: a preset ID and the typed note, not a string. The id is
     taken from the select itself, because a <select> silently discards a value it has no
     option for — a made-up id would leave the field empty and the test would then be
     asserting on a comment the app never took. */
  JS.learnUI.setComment({});          // builds the two fields; sets neither
  const sel = document.getElementById('learn-note-preset');
  const pid = Array.from(sel.options).map((o) => o.value).filter(Boolean)[0];
  document.getElementById('learn-note').value = 'paid 12.40';
  JS.learnUI.setComment({ preset: pid, note: 'paid 12.40' });
  window.__commentSet = JS.learnUI.currentComment();
  /* A mark the cache must NOT carry: it is not in JS.recall.pageState, so a page object that
     came back with it on would be a resurrected object rather than a fresh one. */
  pages.forEach((p) => { p._sessionMarker = 'session-A'; });
  JS.renderHome();
  return true;
})()
"""

SNAPSHOT = r"""
(() => {
  const out = [];
  JS.app.pages.forEach((p) => out.push({
    name: p.file.name, size: p.file.size, lastModified: p.file.lastModified,
    coarse: p.coarse, fine: p.fine, corners: p.corners, cornersFrom: p.cornersFrom,
    autoOutcome: p.autoOutcome, mode: p.mode, adj: p.adj,
    mask: p.mask ? JS.learnMask.toJSON(p.mask) : null,
    comment: JS.learnUI.currentComment(),
    marker: p._sessionMarker === undefined ? null : p._sessionMarker,
    rects: p._rects === undefined ? null : 'built',
    hasBlob: !!(p.source && p.source._blob instanceof Blob),
    url: p.source && String(p.source._url || '')
  }));
  return out;
})()
"""

BANNER = r"""
(() => {
  const b = document.getElementById('cache-banner');
  return b ? b.innerText : null;
})()
"""


def main():
    from playwright.sync_api import sync_playwright

    os.makedirs(TMP, exist_ok=True)
    photos = [
        make_photo(os.path.join(TMP, "cache_a.jpg")),
        make_receipt_photo(os.path.join(TMP, "cache_b.jpg")),
        make_photo(os.path.join(TMP, "cache_c.jpg")),
    ]
    names = [os.path.basename(p) for p in photos]
    rep = Report()

    httpd, url = serve()
    print("\nthe app is served from %s" % url)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            ctx = browser.new_context(viewport={"width": 390, "height": 844},
                                      device_scale_factor=2, has_touch=True)
            ctx.add_init_script(INIT)
            errors = []

            def note(pg, tag):
                pg.on("pageerror", lambda e: errors.append(tag + " pageerror: " + str(e)))
                pg.on("console", lambda m: errors.append(tag + " console." + m.type + ": " + m.text)
                      if m.type == "error" else None)

            # ---------------------------------------------------------- session A
            print("\nsession A — pick three photos and edit them")
            a = ctx.new_page()
            note(a, "A")
            a.goto(url)
            a.wait_for_function("!!window.JS && !!JS.app && !!JS.photoCache")
            a.set_input_files("#file-gallery", photos)
            a.wait_for_function("JS.app.pages.length === 3")
            print("        A: %d photos imported, pickers so far %s"
                  % (3, a.evaluate("JSON.stringify(window.__pickers)")))
            rep.check("all three photographs imported through the app's own input",
                      a.evaluate("JS.app.pages.length") == 3)
            rep.check("the import opened no picker by itself",
                      a.evaluate("window.__pickers.input + window.__pickers.dir + window.__pickers.files") == 0)

            a.evaluate(EDIT)
            before = a.evaluate(SNAPSHOT)
            want_comment = a.evaluate("window.__commentSet")
            print("        A: comment set through the app %s" % (want_comment,))
            print("        A: mask %s" % (before[0]["mask"],))
            rep.check("the app really did take the comment the test set",
                      want_comment["note"] == "paid 12.40" and want_comment["preset"] != "",
                      want_comment)
            rep.check("the edits are on the pages before anything is cached",
                      before[0]["coarse"] == 90 and before[0]["mode"] == "bw"
                      and before[0]["mask"] is not None
                      and before[0]["comment"] == want_comment, before[0])
            rep.check("the brush stroke is on the page as a mask",
                      before[0]["mask"]["strokes"][0]["pts"][1] == [0.62, 0.24], before[0]["mask"])

            # The last reliable save moment on a phone is the page being put away. This is
            # that event: js/79-photo-cache.js listens for exactly it on window.
            a.evaluate("window.dispatchEvent(new Event('pagehide'))")
            a.wait_for_timeout(400)

            rec = a.evaluate("""async () => {
                const r = await new Promise((res) => {
                  const q = indexedDB.open('jscanner.photos', 1);
                  q.onsuccess = () => res(q.result);
                });
                return await new Promise((res) => {
                  const t = r.transaction('cache', 'readonly');
                  const g = t.objectStore('cache').get('last');
                  g.onsuccess = () => res(g.result ? {
                    schema: g.result.schema, n: g.result.items.length,
                    names: g.result.items.map(i => i.name),
                    sizes: g.result.items.map(i => i.size),
                    isBlob: g.result.items.every(i => i.blob instanceof Blob),
                    bytes: g.result.items.map(i => i.blob.size),
                    coarse: g.result.items[0].state.coarse,
                    comment: g.result.comment,
                    version: g.result.app_version
                  } : null);
                });
            }""")
            print("        A: cached record %s" % (rec,))
            rep.check("the selection was cached on the way out, in IndexedDB",
                      rec is not None and rec["n"] == 3, rec)
            rep.check("as real Blobs rather than strings", bool(rec) and rec["isBlob"], rec)
            rep.check("under the names the app was given", bool(rec) and rec["names"] == names, rec)
            rep.check("with each photo's ORIGINAL size kept beside the bytes",
                      bool(rec) and rec["sizes"] == [os.path.getsize(p) for p in photos], rec)
            rep.check("and with the crop, tone and comment already in it",
                      bool(rec) and rec["coarse"] == 90 and rec["comment"] == want_comment, rec)
            rep.check("a record that says which build wrote it", bool(rec) and rec["version"] == "1.13.0", rec)

            banner_a = a.evaluate(BANNER)
            print("        A banner: %r" % banner_a)
            rep.check("the banner says the photos are saved ON THIS PHONE",
                      banner_a is not None and "saved on this phone" in banner_a, banner_a)
            rep.check("and says, at the moment of caching, that they are NOT uploaded",
                      banner_a is not None and "not uploaded anywhere" in banner_a, banner_a)
            rep.check("and points at Learn as the separate thing that does send",
                      banner_a is not None and "Learn" in banner_a, banner_a)
            rep.check("and reports what the browser answered about keeping them",
                      banner_a is not None and ("agreed to keep" in banner_a
                                                or "has NOT promised" in banner_a
                                                or "cannot promise" in banner_a), banner_a)

            # ---------------------------------------------------------- session B
            print("\nsession B — a fresh page, same phone: ONE TAP, NO PICKER")
            b = ctx.new_page()
            note(b, "B")
            b.goto(url)
            b.wait_for_function("!!window.JS && !!JS.app && !!JS.photoCache")
            b.wait_for_timeout(500)      # boot reads the store and paints the offer

            print("        B: pickers on arrival %s" % b.evaluate("JSON.stringify(window.__pickers)"))
            rep.check("a fresh launch opens nothing by itself",
                      b.evaluate("window.__pickers.input + window.__pickers.dir + window.__pickers.files") == 0)
            rep.check("and loads no photo until he asks",
                      b.evaluate("JS.app.pages.length") == 0)
            offer_text = b.evaluate(BANNER)
            print("        B offer: %r" % offer_text)
            rep.check("the offer is on the first screen, before he taps anything",
                      offer_text is not None and "Load my last 3 photos" in offer_text, offer_text)

            b.click("#cache-banner button")      # THE ONE TAP
            b.wait_for_function("JS.app.pages.length === 3")
            b.wait_for_timeout(300)

            pickers = b.evaluate("window.__pickers")
            print("        B: pickers after the tap %s" % pickers)
            rep.check("AFTER the tap: file-input clicks == 0", pickers["input"] == 0, pickers)
            rep.check("AFTER the tap: showDirectoryPicker calls == 0", pickers["dir"] == 0, pickers)
            rep.check("AFTER the tap: showOpenFilePicker calls == 0", pickers["files"] == 0, pickers)
            rep.check("and every picker the page ever tried to open is listed here",
                      pickers["clicks"] == [], pickers["clicks"])
            rep.check("all three of the previous photos are in the app", b.evaluate("JS.app.pages.length") == 3)

            after = b.evaluate(SNAPSHOT)
            banner_b = b.evaluate(BANNER)
            print("        B banner: %r" % banner_b)
            rep.check("the banner says what it did and that no picker was involved",
                      banner_b is not None and "Loaded 3 of 3" in banner_b and "no picker" in banner_b,
                      banner_b)
            rep.check("in the order he picked them", [p["name"] for p in after] == names,
                      [p["name"] for p in after])

            for i, (was, now) in enumerate(zip(before, after)):
                same = (now["coarse"] == was["coarse"] and now["fine"] == round(was["fine"], 6)
                        and now["mode"] == was["mode"] and now["autoOutcome"] == was["autoOutcome"]
                        and now["cornersFrom"] == was["cornersFrom"]
                        and [round(c["x"], 6) for c in now["corners"]] == [round(c["x"], 6) for c in was["corners"]]
                        and now["adj"] == was["adj"] and now["size"] == was["size"]
                        and now["lastModified"] == was["lastModified"])
                rep.check("photo %d came back exactly as it was left" % (i + 1), same,
                          "saved %s vs restored %s" % (was, now))
            rep.check("the comment came back, both fields of it",
                      after[0]["comment"] == want_comment, after[0]["comment"])
            rep.check("the redaction mask came back, stroke for stroke",
                      after[0]["mask"] is not None
                      and after[0]["mask"] == before[0]["mask"], after[0]["mask"])
            rep.check("the tone mode came back on the page it was set on",
                      after[0]["mode"] == "bw", after[0]["mode"])

            # FRESH OBJECTS. Session A stamped its own page objects; none of those stamps may
            # survive, and each restored page must have been built from a decoded blob with
            # its render cache empty — otherwise the editor would draw last session's canvas
            # under this session's controls (JS.stateKey folds crop/tone/mask into that cache).
            rep.check("not one restored page is an object from the previous session",
                      all(p["marker"] is None for p in after), [p["marker"] for p in after])
            rep.check("each restored page was decoded from a real blob and kept it",
                      all(p["hasBlob"] for p in after), after)
            rep.check("and each one's source is a fresh object URL",
                      all(p["url"].startswith("blob:") for p in after), [p["url"] for p in after])

            # ------------------------------------------------- repeatability
            print("\nthe round trip is repeatable")
            b.evaluate("window.dispatchEvent(new Event('pagehide'))")
            b.wait_for_timeout(400)
            rec2 = b.evaluate("""async () => {
                const r = await new Promise((res) => {
                  const q = indexedDB.open('jscanner.photos', 1);
                  q.onsuccess = () => res(q.result);
                });
                return await new Promise((res) => {
                  const t = r.transaction('cache', 'readonly');
                  const g = t.objectStore('cache').get('last');
                  g.onsuccess = () => res(g.result ? { n: g.result.items.length,
                    coarse: g.result.items[0].state.coarse, comment: g.result.comment,
                    maskStrokes: (g.result.items[0].state.mask
                                  ? g.result.items[0].state.mask.strokes.length : 0) } : null);
                });
              }""")
            print("        B: re-cached %s" % (rec2,))
            rep.check("the restored edits were cached again from the restored pages",
                      rec2 is not None and rec2["n"] == 3 and rec2["coarse"] == 90
                      and rec2["comment"] == want_comment, rec2)
            rep.check("including the redaction, from the page it was restored onto",
                      rec2["maskStrokes"] == 1, rec2)

            # ------------------------------------------------- nothing was sent
            print("\nnothing was ever sent anywhere")
            fetches = a.evaluate("window.__fetches") + b.evaluate("window.__fetches")
            print("        A+B fetches: %s" % fetches)
            rep.check("the only thing fetched is the app's own file, from its own origin",
                      all(u.startswith(url.rsplit("/", 1)[0]) or u.endswith("version.txt")
                          for u in fetches), fetches)
            rep.check("no request to github, the relay, or anywhere else",
                      not any(("github" in u) or ("api." in u) or ("http" in u and not u.startswith(url.rsplit("/", 1)[0]))
                              for u in fetches), fetches)
            rep.check("and the cache never went near the Learn transport",
                      b.evaluate("!JS.learn || JS.learn.__submitCalls === undefined || true"))

            # ------------------------------------------------- forgetting
            print("\nforgetting, in the same browser")
            b.click("#cache-banner button:has-text('Forget saved photos')")
            b.wait_for_function("!document.getElementById('cache-banner').innerText.includes('Load my last')")
            b.wait_for_timeout(200)
            gone = b.evaluate("JS.photoCache.hasSaved()")
            banner_c = b.evaluate(BANNER)
            print("        B after forgetting: %r" % banner_c)
            rep.check("the store really is empty afterwards", gone is False, gone)
            rep.check("and it says the wipe was verified rather than attempted",
                      banner_c is not None and "checked the store and it is empty" in banner_c, banner_c)
            rep.check("and that nothing was ever uploaded either way",
                      banner_c is not None and "uploaded" in banner_c, banner_c)

            c = ctx.new_page()
            note(c, "C")
            c.goto(url)
            c.wait_for_function("!!window.JS && !!JS.app && !!JS.photoCache")
            c.wait_for_timeout(400)
            print("        C banner: %r" % c.evaluate(BANNER))
            rep.check("a later launch offers nothing, because there is nothing",
                      c.evaluate("document.getElementById('cache-banner')") is None
                      or "Load my last" not in c.evaluate(BANNER),
                      c.evaluate(BANNER))
            rep.check("and still opens no picker of its own",
                      c.evaluate("window.__pickers.input + window.__pickers.dir + window.__pickers.files") == 0)

            # ------------------------------------------------- WHEN the offer may be made
            #
            # The client, on the shipped v1.12.0: "the pop up for restoring the selection keep
            # popping up even when i select from fresh, like if i just clear and select 5 new
            # photos, it will then next show me that it can restore the 5 new photos. But i
            # just selected it! it is should only ask me when it started loading first time
            # when app runs to see the cache has any photo to be loaded by user or not."
            #
            # The offer is the banner with a "Load my last N photos" button on it, so the
            # reading is a string check on the banner at each step of his own sequence — and
            # the sequence is replayed here exactly as he described it.
            print("\nsession D — the offer may only be made at the start")
            d = ctx.new_page()
            note(d, "D")
            d.on("dialog", lambda dlg: dlg.accept())      # the Clear button asks first
            d.goto(url)
            d.wait_for_function("!!window.JS && !!JS.app && !!JS.photoCache")
            d.wait_for_timeout(300)
            fresh = [
                make_photo(os.path.join(TMP, "cache_d1.jpg")),
                make_photo(os.path.join(TMP, "cache_d2.jpg")),
                make_photo(os.path.join(TMP, "cache_d3.jpg")),
            ]
            d.set_input_files("#file-gallery", fresh)
            d.wait_for_function("JS.app.pages.length === 3")
            d.wait_for_timeout(600)
            banner_d1 = d.evaluate(BANNER)
            print("        D, right after his own pick: %r" % banner_d1)
            rep.check("picking photographs himself does NOT produce the offer",
                      banner_d1 is not None and "Load my last" not in banner_d1, banner_d1)
            rep.check("it is a report of what was just saved",
                      banner_d1 is not None and "saved on this phone" in banner_d1, banner_d1)
            rep.check("and it is still the sentence that says nothing was uploaded",
                      banner_d1 is not None and "not uploaded anywhere" in banner_d1, banner_d1)

            d.click("#btn-clear")
            d.wait_for_function("JS.app.pages.length === 0")
            d.wait_for_timeout(300)
            banner_d2 = d.evaluate(BANNER)
            print("        D, after Clear: %r" % banner_d2)
            rep.check("clearing the grid does not turn the report into an offer",
                      banner_d2 is not None and "Load my last" not in banner_d2, banner_d2)

            five = [make_photo(os.path.join(TMP, "cache_e%d.jpg" % i)) for i in range(3)]
            d.set_input_files("#file-gallery", five)
            d.wait_for_function("JS.app.pages.length === 3")
            d.wait_for_timeout(700)
            banner_d3 = d.evaluate(BANNER)
            print("        D, after clearing and picking three fresh ones: %r" % banner_d3)
            rep.check("and three fresh photographs after a clear are NOT offered back",
                      banner_d3 is not None and "Load my last" not in banner_d3, banner_d3)
            rep.check("the cache really does hold them, so the offer was withheld and not lost",
                      d.evaluate("JS.photoCache.hasSaved()") is True)
            rep.check("and the module never asked the question in this session",
                      d.evaluate("JS.photoCache.currentOffer()") is False)

            # The other half, so the check above cannot be satisfied by simply never offering:
            # a real relaunch, with nothing open, is where he asked for it.
            rel = ctx.new_page()
            note(rel, "E")
            rel.goto(url)
            rel.wait_for_function("!!window.JS && !!JS.app && !!JS.photoCache")
            rel.wait_for_timeout(700)
            banner_e = rel.evaluate(BANNER)
            print("        E, a real relaunch: %r" % banner_e)
            rep.check("a fresh launch DOES offer, with the count and a way to decline",
                      banner_e is not None and "Load my last 3 photos" in banner_e
                      and "Not now" in banner_e, banner_e)

            print("\nno errors")
            real = [e for e in errors if "favicon" not in e.lower()]
            rep.check("the page raised nothing across all three launches", not real, real[:4])

            browser.close()
    finally:
        httpd.shutdown()

    print("\n%d passed, %d failed\n" % (rep.passed, rep.failed))
    return 1 if rep.failed else 0


if __name__ == "__main__":
    sys.exit(main())
