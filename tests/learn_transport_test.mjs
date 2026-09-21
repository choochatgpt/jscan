/* tests/learn_transport_test.mjs — integration test for the Learn transport.
 *
 * Runs the SHIPPING file js/70-learn.js unmodified, in Node, against the real GitHub API,
 * and then hands off to the PC-side reader so that the loop is proven end to end:
 *
 *     app code uploads  ->  PC reader collects, verifies, ACKs, wipes
 *
 * The point of running the shipping file rather than a copy is that a shim-based test would
 * prove something about the shim. js/70-learn.js is therefore written to need no browser API
 * beyond localStorage, fetch and crypto.subtle, all of which Node provides except localStorage,
 * which is stubbed below.
 *
 * The payload is a 1x1 JPEG decoded from a literal. NO REAL PHOTOGRAPH is used, and none may
 * ever be committed here — the client's submissions include pathology reports.
 *
 * Requires: JSCAN_RELAY_TOKEN in the environment, and
 *           python <relay>/current/learn_intake_reader.py available.
 *
 * Usage:  node tests/learn_transport_test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

// A 1x1 JPEG. Real JPEG bytes so the pipeline is exercised with the real MIME shape,
// but nothing that could be mistaken for, or leak, a client document.
const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

function fail(msg) { console.error('FAIL: ' + msg); process.exit(1); }

if (!process.env.JSCAN_RELAY_TOKEN) {
  fail('JSCAN_RELAY_TOKEN is not set. The token is required and is never printed.');
}

// localStorage is the only browser API the shipping file needs that Node lacks.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// Load the SHIPPING file. No transformation, no copy, no shim beyond the above.
vm.runInThisContext(fs.readFileSync(path.join(REPO_ROOT, 'js', '70-learn.js'), 'utf8'));
if (!globalThis.JS || !globalThis.JS.learn) fail('js/70-learn.js did not define JS.learn');
const L = globalThis.JS.learn;
globalThis.JS.VERSION = '1.7.9';

console.log('loaded shipping js/70-learn.js -> JS.learn present');
console.log('  branch      : ' + L.BRANCH + '   repo: ' + L.REPO + '   issue #' + L.ISSUE);
console.log('  token stored: ' + L.setToken(process.env.JSCAN_RELAY_TOKEN) + '  hasToken: ' + L.hasToken());

const bytes = new Uint8Array(Buffer.from(TINY_JPEG_B64, 'base64'));
console.log('  payload     : ' + bytes.length + ' bytes of real JPEG (1x1, not a photograph)');

// Prove the hand-rolled base64 matches Node's own encoder, or the upload is silently corrupt.
const nodeB64 = Buffer.from(bytes).toString('base64');
if (L.b64(bytes) !== nodeB64) fail('b64() disagrees with Node Buffer — uploads would corrupt');
console.log('  b64() matches Node Buffer encoder: yes');

const manifestCheck = L.buildManifest(
  { bundleId: 'bTEST', state: 'refused_then_corrected', redacted: true },
  { 'before.jpg': { sha256: 'x', bytes: 1 } }
);
if (!manifestCheck.images || manifestCheck.schema !== 'jscan.learn.bundle/1') {
  fail('buildManifest shape is wrong');
}
console.log('  manifest schema: ' + manifestCheck.schema);

const id = L.bundleId();
console.log('\nuploading bundle ' + id + ' using the app\'s own code...');
const res = await L.submit({
  bundleId: id,
  before: bytes,
  after: bytes,
  meta: {
    state: 'refused_then_corrected',
    redacted: true,
    redaction: { tool: 'brush', strokes: 1, note: 'integration test - 1x1 JPEG, no real data' },
    quadAuto: null,
    quadUser: [[0, 0], [1, 0], [1, 1], [0, 1]],
    tone: { mode: 'colour' },
  },
});
console.log('  uploaded: bundle=' + res.bundleId + ' commit=' + res.commit + ' bytes=' + res.bytes);
if (res.bundleId !== id) fail('bundle id changed between generation and upload');

console.log('\nhanding off to the PC reader...');
const reader = process.env.JSCAN_READER || path.resolve(
  REPO_ROOT, '..', 'chat', 'ask-ai-relay', 'research',
  '2026-09-17-01-JScan_Maintenance', 'current', 'learn_intake_reader.py'
);
if (!fs.existsSync(reader)) fail('PC reader not found at ' + reader);
let polled;
try {
  polled = execFileSync('python', [reader, '--poll'], {
    encoding: 'utf8', env: process.env, cwd: path.dirname(reader),
  });
} catch (e) {
  console.error(e.stdout || '');
  fail('PC reader exited non-zero — the app uploaded something it could not verify');
}
const out = JSON.parse(polled);
console.log('  seen=' + out.seen + ' collected=' + out.collected.length +
            ' acked=' + out.acked + ' wiped=' + out.wiped);
if (out.problems && out.problems.length) fail('reader reported problems: ' + out.problems.join('; '));
const got = out.collected.find((c) => c.bundle_id === id);
if (!got) fail('the reader did not collect the bundle the app uploaded');
if (!out.acked) fail('the reader did not ACK');
if (!out.wiped) fail('the reader did not wipe — the photographs would stay on GitHub');

const before = got.files.find((f) => f.name === 'before.jpg');
if (!before || before.sha256 !== (await L.sha256hex(bytes))) {
  fail('sha256 of the collected before.jpg does not match what the app computed');
}

console.log('\nPASS');
console.log('  the app\'s own code uploaded a bundle');
console.log('  the PC reader verified its sha256, ACKed on issue #' + L.ISSUE + ', and wiped the branch');
console.log('  round-trip integrity confirmed against the app\'s own sha256');
console.log('\nNOTE: this leaves an ACK comment on issue #' + L.ISSUE + '.');
