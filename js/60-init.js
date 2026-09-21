/* ==========================================================================
   60-init.js — boot
   ========================================================================== */
'use strict';

(function (JS) {

  /* Ask the server which build it is serving and say so if it is not this one.
     Deliberately quiet about every failure: the app is a static, offline-capable
     page, and no marker, no network, or a marker that arrives as the wrong shape
     are all "nothing to report", never an error. `no-store` because a cached
     answer to this question is worse than no answer — it would say the build is
     current when the whole point is that it may not be. */
  function initVersion() {
    if (!window.fetch) return;
    fetch('version.txt', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (t) {
        var served = (t || '').trim().replace(/^v/, '');
        if (served && served !== JS.VERSION) JS.markStale(served);
      })
      .catch(function () { /* offline, or no marker: say nothing */ });
  }

  function boot() {
    JS.$('app-version').textContent = 'v' + JS.VERSION;
    // Guarded like the handler in JS.wire: a cached index.html from the build
    // before this element existed is a real pairing, not a hypothetical one.
    var ver = JS.$('edit-ver');
    if (ver) ver.textContent = 'v' + JS.VERSION;
    JS.wire();
    initVersion();

    // Desktop conveniences: drop or paste images straight in.
    ['dragenter', 'dragover'].forEach(function (t) {
      window.addEventListener(t, function (e) {
        if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      });
    });
    window.addEventListener('drop', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      JS.addFiles(e.dataTransfer.files);
    });
    window.addEventListener('paste', function (e) {
      if (!e.clipboardData || !e.clipboardData.files || !e.clipboardData.files.length) return;
      JS.addFiles(e.clipboardData.files);
    });

    // Keep the last-used export format across a reload.
    try {
      var saved = localStorage.getItem('jscanner.export');
      if (saved) {
        var o = JSON.parse(saved);
        if (o.fmt) JS.app.fmt = o.fmt;
        if (o.quality) JS.app.quality = o.quality;
        if (o.maxDim) JS.app.maxDim = o.maxDim;
      }
    } catch (err) { /* storage unavailable in private mode */ }

    // Reflect the restored settings in the export sheet.
    Array.prototype.forEach.call(JS.$('fmt-chips').children, function (c) {
      c.classList.toggle('is-active', c.dataset.fmt === JS.app.fmt);
    });
    JS.$('quality-row').style.display = JS.app.fmt === 'png' ? 'none' : '';
    JS.$('in-quality').value = String(Math.round(JS.app.quality * 100));
    JS.$('val-quality').textContent = Math.round(JS.app.quality * 100) + '%';
    JS.$('in-maxdim').value = String(JS.app.maxDim);
    JS.$('val-maxdim').textContent = JS.app.maxDim + ' px';
    JS.$('export-summary').textContent = JS.exportSummary();

    var persist = function () {
      try {
        localStorage.setItem('jscanner.export', JSON.stringify({
          fmt: JS.app.fmt, quality: JS.app.quality, maxDim: JS.app.maxDim
        }));
      } catch (err) { /* ignore */ }
    };
    window.addEventListener('pagehide', persist);
    window.addEventListener('beforeunload', persist);

    JS.setView('home');
    JS.renderHome();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(window.JS);
