/* ==========================================================================
   tests/pdf_roundtrip.js — build a real PDF from real JPEGs.

   Driven by tests/pdf_roundtrip.sh, which makes the fixtures with PIL and then
   validates the result with PyMuPDF. Structural self-consistency is not enough
   for a PDF: a reader has to actually open it.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, 'tmp');

const sandbox = {
  window: {}, document: { createElement: () => ({ getContext: () => null, style: {} }) },
  navigator: {}, TextEncoder,
  Uint8Array, Uint8ClampedArray, Float64Array, Int32Array, Uint32Array,
  Math, JSON, Object, Array, Number, String, Promise, console, setTimeout
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['00-utils.js', '40-export.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), sandbox, { filename: f });
}

// Must match SPECS in pdf_roundtrip.py.
const SPECS = [
  { name: 'page1.jpg', w: 800, h: 600 },
  { name: 'page2.jpg', w: 600, h: 800 },
  { name: 'page3.jpg', w: 1000, h: 400 }
];

const pages = SPECS.map(({ name, w, h }) => {
  const jpeg = new Uint8Array(fs.readFileSync(path.join(TMP, name)));
  return { jpeg, w, h, name };
});

const bytes = sandbox.JS._buildPDF(pages);
fs.writeFileSync(path.join(TMP, 'out.pdf'), Buffer.from(bytes));
console.log('wrote out.pdf (' + bytes.length + ' bytes, ' + pages.length + ' pages)');
