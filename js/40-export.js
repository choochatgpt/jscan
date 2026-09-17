/* ==========================================================================
   40-export.js — JPEG/PNG blobs, a minimal multi-page PDF writer, download
   and Web Share. No libraries: the PDF is assembled byte by byte.
   ========================================================================== */
'use strict';

(function (JS) {

  JS.canvasToBlob = function (canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        b ? resolve(b) : reject(new Error('Could not encode ' + type));
      }, type, quality);
    });
  };

  function blobToBytes(blob) {
    return blob.arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  JS.timestamp = function () {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
           p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  };

  /* --------------------------------------------------------------- PDF ---- */

  /**
   * Assemble a multi-page PDF where each page is one JPEG (DCTDecode).
   * Structure: 1 = Catalog, 2 = Pages, then per page: Page / Contents / Image.
   */
  function buildPDF(pages) {
    var enc = new TextEncoder();
    var parts = [], len = 0;
    var offsets = {};
    var n = pages.length;
    var totalObjs = 2 + 3 * n;

    function put(u8) { parts.push(u8); len += u8.length; }
    function puts(s) { put(enc.encode(s)); }
    function obj(num, body) {
      offsets[num] = len;
      puts(num + ' 0 obj\n' + body + '\nendobj\n');
    }

    // Header, with the conventional high-bit comment marking a binary file.
    put(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A]));
    put(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');

    var kids = [];
    for (var i = 0; i < n; i++) kids.push((3 + i * 3) + ' 0 R');
    obj(2, '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + n + ' >>');

    for (i = 0; i < n; i++) {
      var pageNum = 3 + i * 3;
      var contentNum = pageNum + 1;
      var imageNum = pageNum + 2;
      var pg = pages[i];
      var w = pg.w, h = pg.h;

      obj(pageNum,
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + w + ' ' + h + '] ' +
        '/Resources << /XObject << /Im0 ' + imageNum + ' 0 R >> >> ' +
        '/Contents ' + contentNum + ' 0 R >>');

      var content = 'q\n' + w + ' 0 0 ' + h + ' 0 0 cm\n/Im0 Do\nQ\n';
      var cbytes = enc.encode(content);
      obj(contentNum, '<< /Length ' + cbytes.length + ' >>\nstream\n' + content + 'endstream');

      // Binary stream, so it is written by hand rather than through obj().
      offsets[imageNum] = len;
      puts(imageNum + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + w +
           ' /Height ' + h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 ' +
           '/Filter /DCTDecode /Length ' + pg.jpeg.length + ' >>\nstream\n');
      put(pg.jpeg);
      puts('\nendstream\nendobj\n');
    }

    var xrefStart = len;
    puts('xref\n0 ' + (totalObjs + 1) + '\n');
    puts('0000000000 65535 f \r\n');
    for (var k = 1; k <= totalObjs; k++) {
      var off = offsets[k] || 0;
      var s = String(off);
      while (s.length < 10) s = '0' + s;
      puts(s + ' 00000 n \r\n');
    }
    puts('trailer\n<< /Size ' + (totalObjs + 1) + ' /Root 1 0 R >>\nstartxref\n' +
         xrefStart + '\n%%EOF\n');

    var out = new Uint8Array(len), pos = 0;
    for (var p = 0; p < parts.length; p++) { out.set(parts[p], pos); pos += parts[p].length; }
    return out;
  }

  // Exposed so the structure can be verified without a browser.
  JS._buildPDF = buildPDF;

  /* ------------------------------------------------------------ rendering - */

  /**
   * Render every page at export resolution and encode it.
   * `onProgress(done, total)` is called as each page finishes.
   */
  JS.renderAll = async function (pages, opts, onProgress) {
    var out = [];
    for (var i = 0; i < pages.length; i++) {
      var page = pages[i];
      var canvas = JS.renderPage(page, opts.maxDim);
      var type = opts.format === 'png' ? 'image/png' : 'image/jpeg';
      var blob = await JS.canvasToBlob(canvas, type, opts.quality);
      var entry = { blob: blob, w: canvas.width, h: canvas.height, name: page.name };
      if (opts.format === 'pdf') entry.jpeg = await blobToBytes(blob);
      out.push(entry);
      if (onProgress) onProgress(i + 1, pages.length);
      await JS.yieldToUI();
    }
    return out;
  };

  JS.buildExport = async function (pages, opts, onProgress) {
    var rendered = await JS.renderAll(pages, opts, onProgress);
    var stamp = JS.timestamp();

    if (opts.format === 'pdf') {
      var bytes = buildPDF(rendered);
      return [new File([bytes], 'jscanner-' + stamp + '.pdf', { type: 'application/pdf' })];
    }

    var ext = opts.format === 'png' ? 'png' : 'jpg';
    var mime = opts.format === 'png' ? 'image/png' : 'image/jpeg';
    var files = [];
    for (var i = 0; i < rendered.length; i++) {
      var base = (rendered[i].name || 'page').replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_');
      if (base.length > 40) base = base.slice(0, 40);
      var num = ('0' + (i + 1)).slice(-2);
      files.push(new File([rendered[i].blob], 'jscanner-' + stamp + '-' + num + '-' + base + '.' + ext,
        { type: mime }));
    }
    return files;
  };

  /* -------------------------------------------------------- size estimate - */

  /**
   * How many pages of the set to actually encode when estimating a size.
   *
   * Three, spread across the set. At this count or below the estimate is not an
   * estimate at all — it is the number the export will produce, because every
   * page was encoded for real. Most exports are one to three pages, so most of
   * the time the sheet shows an exact figure.
   *
   * Past three the figure becomes the mean of the sampled pages times the page
   * count, and the sample count is a straight trade against time. Measured here,
   * `renderPage` at the 2400px cap plus the encode:
   *
   *   photographed page, caps at 1005px      ~30 ms
   *   dense full-2400 page                  ~145 ms
   *
   * so three pages is 0.1–0.45 s. That is why the caller debounces the slider
   * and why this yields between pages.
   */
  JS.EST_PAGES = 3;

  /**
   * Which pages to encode: the ends and the ones spread evenly between them.
   *
   * Evenly spread rather than the first k, so a set that mixes a dense receipt
   * with photographed pages is sampled from both ends of that mix instead of
   * whichever end happens to be first.
   */
  function pickSample(n, k) {
    if (k >= n) {
      var all = [];
      for (var i = 0; i < n; i++) all.push(i);
      return all;
    }
    if (k <= 1) return [n >> 1];
    var out = [];
    for (var j = 0; j < k; j++) out.push(Math.round(j * (n - 1) / (k - 1)));
    // Rounding collides on short sets; dedupe without reordering.
    return out.filter(function (v, at) { return out.indexOf(v) === at; });
  }

  // Exposed so the spread can be checked without a browser, like _buildPDF.
  JS._pickSample = pickSample;

  /**
   * Bytes the PDF container adds on top of the JPEG streams.
   *
   * Measured, not fitted. An earlier version of this was a two-constant linear
   * fit — `242 + 455n` — and it was wrong in both constants and in shape: the
   * real cost is nearer `239 + 462n` and it steps up again when the object
   * numbers reach two digits, so no pair of constants holds across page counts.
   *
   * So the container is not modelled at all. `buildPDF` is handed the real page
   * dimensions with empty image streams and asked how big the result is, which
   * uses the shipped writer and therefore cannot drift away from it. The one
   * inaccuracy is the digit count of `/Length` and `startxref`: about 6 bytes
   * per page, against estimates that are wrong by whole percent.
   */
  JS.pdfOverhead = function (n, w, h) {
    if (!n) return 0;
    var stub = [];
    for (var i = 0; i < n; i++) stub.push({ w: w, h: h, jpeg: new Uint8Array(0) });
    return buildPDF(stub).length;
  };

  /**
   * Estimate the bytes the export will produce, by encoding a sample of it.
   *
   * The sample is encoded with the same encoder, at the same quality, at the
   * same output size the export itself will use — so there is no formula in the
   * path that could drift away from the product. What remains is only how
   * representative the sampled pages are of the ones not sampled.
   *
   * Sampling *at the export size* is the whole point, and it was measured
   * against the obvious alternative. Encoding a 600px sample and scaling it up
   * by a fitted exponent `bytes ∝ px^a` is much cheaper, and over six pages at
   * four qualities it was wrong by −34% to +72% at a 2400px export. The reason
   * is not a badly fitted exponent: how bytes grow with pixels depends on how
   * much detail the page carries, and a 600px downscale has already discarded
   * exactly that detail. Per-page exponents recovered from a second sample
   * ranged 0.59–0.99 and extrapolated worse still. Encoding at the export size
   * costs ~30 ms more per page and removes the question.
   *
   * Weighting the pages by area was also measured and also rejected: it roughly
   * doubles p90 and worst-case error, because a small dense page — a receipt
   * strip — then carries its own density across every other page's area.
   *
   * `isCancelled` is an optional predicate, polled between pages; when it turns
   * true this returns null and the caller keeps whatever it had.
   *
   * Returns `{bytes, pages, sampled}`, or null for an empty set or a cancelled
   * run.
   */
  JS.estimateExportBytes = async function (pages, opts, isCancelled) {
    var n = pages.length;
    if (!n) return null;

    var idx = pickSample(n, JS.EST_PAGES);
    var mime = opts.format === 'png' ? 'image/png' : 'image/jpeg';
    var sum = 0, w = 0, h = 0;

    for (var i = 0; i < idx.length; i++) {
      if (isCancelled && isCancelled()) return null;
      var canvas = JS.renderPage(pages[idx[i]], opts.maxDim);
      var blob = await JS.canvasToBlob(canvas, mime, opts.quality);
      sum += blob.size;
      w = canvas.width;
      h = canvas.height;
      await JS.yieldToUI();
    }
    if (isCancelled && isCancelled()) return null;

    var bytes = Math.round(sum / idx.length * n);
    // The container is sized from the JPEG streams it will carry, and every page
    // here is near enough the same shape for the dimension digits not to matter.
    if (opts.format === 'pdf') bytes += JS.pdfOverhead(n, w, h);
    return { bytes: bytes, pages: n, sampled: idx.length };
  };

  /* ------------------------------------------------------------ delivery - */

  JS.canShareFiles = function (files) {
    try {
      return !!(navigator.canShare && navigator.canShare({ files: files }));
    } catch (e) {
      return false;
    }
  };

  JS.shareFiles = async function (files) {
    await navigator.share({ files: files, title: 'JScanner export' });
  };

  JS.downloadFiles = async function (files) {
    for (var i = 0; i < files.length; i++) {
      var url = URL.createObjectURL(files[i]);
      var a = document.createElement('a');
      a.href = url;
      a.download = files[i].name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Give the browser a moment between saves so it does not drop them.
      await new Promise(function (r) { setTimeout(r, files.length > 1 ? 450 : 0); });
      setTimeout(function (u) { return function () { URL.revokeObjectURL(u); }; }(url), 20000);
    }
  };

})(window.JS);
