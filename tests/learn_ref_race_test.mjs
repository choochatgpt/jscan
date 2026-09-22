/* tests/learn_ref_race_test.mjs — does the compare-and-swap retry actually save the submission?
 *
 * The client's phone said:  "Could not send: ref update failed (422)"
 * and the photograph was LOST.
 *
 * Cause, confirmed against the live API: the app PATCHes /git/refs/heads/learn-inbox with
 * {sha: commit} and NO `force`. GitHub refuses a ref update without `force` unless it is a
 * FAST FORWARD. The parent commit is read near the START of submit() (ensureBranch), before
 * two ~500KB blobs are uploaded — a long window on a phone. If the branch head advances
 * inside that window (a second in-flight submission, or the PC collecting and wiping), the
 * commit no longer descends from the head, the PATCH returns 422 "Update is not a fast
 * forward", and the submission is thrown away.
 *
 * The fix under test is `land(attempt)`: on a 422, pause, RE-READ the head, re-merge onto
 * whatever is there now with `base_tree` set to the new head's tree, build a new commit whose
 * parent is the new head, and PATCH again. `force:true` must never appear — that would
 * "fix" the 422 by overwriting the branch and silently discarding whichever submission won.
 *
 * This test runs the SHIPPING file js/70-learn.js unmodified, with a stubbed fetch that
 * serves canned responses and RECORDS every request. NO NETWORK IS TOUCHED. The race is
 * simulated faithfully: the stub advances the branch head to a NEW sha at the moment of the
 * first PATCH, so a retry that does not re-read the head will fail these assertions.
 *
 * NO REAL PHOTOGRAPH is used — the payload is a 1x1 JPEG, and none may be committed here.
 *
 * Usage:  node tests/learn_ref_race_test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

let failures = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ok   ' + msg); return true; }
  console.error('  FAIL ' + msg); failures++; return false;
}
function eq(a, b, msg) { return ok(a === b, msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

/* A 1x1 JPEG. Real JPEG bytes so the transport is exercised with the real shape, but
 * nothing that could be mistaken for, or leak, a client document. */
const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

/* ------------------------------------------------- browser APIs the file needs */
/* localStorage is the only browser API the shipping file needs that Node lacks. */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
/* crypto.subtle (sha256) + crypto.getRandomValues (bundleId). Node's own webcrypto.
 * Node >= 24 exposes globalThis.crypto as a getter-only property, so only define it when
 * it is actually absent rather than assigning over it. */
if (!globalThis.crypto || !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
}

/* ---------------------------------------------------------------- the stub */
const REF = 'refs/heads/learn-inbox';
const TREE_ORIG = 'tree-of-ORIGINAL-head';
const TREE_NEW = 'tree-of-OTHER-submission';

const log = [];            // every request, in order
let refGets = [];          // sha returned by each GET /git/ref/heads/learn-inbox
const patches = [];        // sha sent by each PATCH on the ref
const treeReqs = [];       // { hasBaseTree, base_tree, bodyText }
const commitsBySha = {};   // commit sha -> the parents it was created with
const blobShas = {};       // name -> sha, so we can prove blobs were reused
let commitSeq = 0, blobSeq = 0, treeSeq = 0;

/* Real GitHub object ids are 40 hex chars, and submit() reports commit.slice(0, 12).
 * Fake ids are padded to the same length so that slice is exercised honestly. */
function fakeSha(tag, n) { return (tag + n).padEnd(40, '0'); }

function json(status, data) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

/* `patchMode` decides what the ref PATCH does. Scenario 1 ('race') fails the first call and
 * succeeds on the second, advancing the head in between — the real race. Scenario 2
 * ('always422') fails every call, to prove the loop terminates. */
function makeFetch(state) {
  return function fetchStub(url, init) {
    const bodyText = init && typeof init.body === 'string' ? init.body : '';
    let body = null;
    try { body = bodyText ? JSON.parse(bodyText) : null; } catch (e) { body = null; }
    const p = String(url).replace('https://api.github.com', '');
    log.push({ method: init.method, path: p, body: bodyText });

    // GET the branch head — ensureBranch(). Record which sha was READ, because the whole
    // point of the fix is that the retry re-reads it.
    if (init.method === 'GET' && p === '/repos/choochatgpt/ask-ai-relay/git/ref/heads/learn-inbox') {
      refGets.push(state.head);
      return Promise.resolve(json(200, { object: { sha: state.head } }));
    }

    // POST a blob — 201 with a unique fake sha.
    if (init.method === 'POST' && p === '/repos/choochatgpt/ask-ai-relay/git/blobs') {
      const sha = fakeSha('blob', ++blobSeq);
      blobShas[sha] = (body && body.content || '').slice(0, 24);
      return Promise.resolve(json(201, { sha }));
    }

    // GET a commit — hands back the tree of that sha.
    const mCommit = p.match(/^\/repos\/choochatgpt\/ask-ai-relay\/git\/commits\/(.+)$/);
    if (init.method === 'GET' && mCommit) {
      const sha = mCommit[1];
      if (sha === state.head) return Promise.resolve(json(200, { sha, tree: { sha: state.headTree } }));
      if (sha === state.originalHead) return Promise.resolve(json(200, { sha, tree: { sha: TREE_ORIG } }));
      return Promise.resolve(json(404, { message: 'No commit found for SHA' }));
    }

    // POST a tree — record whether base_tree was present, which is what makes it a MERGE
    // rather than a wholesale REPLACE of the branch contents.
    if (init.method === 'POST' && p === '/repos/choochatgpt/ask-ai-relay/git/trees') {
      const hasBaseTree = !!(body && Object.prototype.hasOwnProperty.call(body, 'base_tree'));
      treeReqs.push({ hasBaseTree, base_tree: body ? body.base_tree : undefined, bodyText });
      return Promise.resolve(json(201, { sha: fakeSha('tree', ++treeSeq) }));
    }

    // POST a commit — record the parents it was built with, keyed by its sha, so the PATCH
    // assertions can prove which head it descends from.
    if (init.method === 'POST' && p === '/repos/choochatgpt/ask-ai-relay/git/commits') {
      const sha = fakeSha('commit', ++commitSeq);
      commitsBySha[sha] = (body && body.parents) || [];
      return Promise.resolve(json(201, { sha }));
    }

    // PATCH the ref — the operation that was failing on the client's phone.
    if (init.method === 'PATCH' && p === '/repos/choochatgpt/ask-ai-relay/git/refs/heads/learn-inbox') {
      const n = patches.length;                       // 0 for the first PATCH
      patches.push(body && body.sha);
      if (state.patchMode === 'race') {
        if (n === 0) {
          // The race, simulated at the exact moment it bites: another submission lands
          // while ours is in flight. Returning 422 here is what the client's phone saw.
          state.head = state.newHead;
          state.headTree = TREE_NEW;
          return Promise.resolve(json(422, { message: 'Update is not a fast forward' }));
        }
        state.head = body.sha;                        // our commit is now the head
        return Promise.resolve(json(200, { object: { sha: body.sha } }));
      }
      // 'always422': every attempt loses, so the loop must give up rather than spin.
      return Promise.resolve(json(422, { message: 'Update is not a fast forward' }));
    }

    return Promise.resolve(json(404, { message: 'unexpected ' + init.method + ' ' + p }));
  };
}

function freshState(patchMode) {
  return {
    patchMode,
    originalHead: 'COMMIT_ORIGINAL',
    newHead: 'COMMIT_FROM_OTHER_SUBMISSION',
    head: 'COMMIT_ORIGINAL',
    headTree: TREE_ORIG,
  };
}

/* Load the SHIPPING file. No transformation, no copy, no shim beyond localStorage/crypto. */
vm.runInThisContext(fs.readFileSync(path.join(REPO_ROOT, 'js', '70-learn.js'), 'utf8'));
if (!globalThis.JS || !globalThis.JS.learn) {
  console.error('FAIL: js/70-learn.js did not define JS.learn');
  process.exit(1);
}
const L = globalThis.JS.learn;
globalThis.JS.VERSION = '1.7.9';
console.log('loaded shipping js/70-learn.js -> JS.learn present');
console.log('  branch ' + L.BRANCH + '   repo ' + L.REPO + '   issue #' + L.ISSUE);
console.log('  no network: fetch is fully stubbed\n');

const bytes = new Uint8Array(Buffer.from(TINY_JPEG_B64, 'base64'));
L.setToken('stub-token-never-leaves-this-process');

function reset() { log.length = 0; refGets = []; patches.length = 0; treeReqs.length = 0; }

function bundle(id) {
  return {
    bundleId: id,
    before: bytes,
    after: bytes,
    meta: {
      state: 'refused_then_corrected',
      redacted: true,
      redaction: { tool: 'brush', strokes: 1, note: 'race test - 1x1 JPEG, no real data' },
      quadAuto: null,
      quadUser: [[0, 0], [1, 0], [1, 1], [0, 1]],
      tone: { mode: 'colour' },
    },
  };
}

/* ------------------------------------------- scenario 1: the race, then the win */
console.log('scenario 1 — the head advances under us; the retry must re-read it');
const s1 = freshState('race');
globalThis.fetch = makeFetch(s1);

const id1 = L.bundleId();
let res1 = null, err1 = null;
try { res1 = await L.submit(bundle(id1)); } catch (e) { err1 = e; }

ok(err1 === null && res1 !== null,
   'submit() RESOLVED — this is the client\'s bug, fixed. Before the fix this threw ' +
   '"ref update failed (422): Update is not a fast forward"; here it threw ' +
   (err1 ? '"' + err1.message + '"' : '(nothing)'));
eq(s1.head, patches[1],
   'the branch head ended on the commit the second (winning) PATCH sent, not the other submission');
ok(res1 && res1.commit === String(s1.head).slice(0, 12),
   'and submit() reported landing that same commit');

eq(patches.length, 2, 'the ref PATCH was called exactly twice (once refused, once accepted)');

const secondPatchSha = patches[1];
const secondParents = commitsBySha[secondPatchSha] || [];
eq(JSON.stringify(secondParents), JSON.stringify([s1.newHead]),
   'the SECOND PATCH used a commit whose parent is the NEW head, not the original one ' +
   '(parents were ' + JSON.stringify(secondParents) + ')');
ok(secondParents[0] !== s1.originalHead,
   'and it is genuinely not the stale head the blobs were uploaded against');

const secondTree = treeReqs[1];
ok(!!secondTree && secondTree.hasBaseTree === true,
   'the second tree request carried base_tree — it MERGED rather than replaced the branch');
eq(secondTree && secondTree.base_tree, TREE_NEW,
   'base_tree was the NEW head\'s tree, so the winner\'s files survive the retry');
ok(treeReqs.every((t) => t.hasBaseTree),
   'every tree request carried base_tree (' + treeReqs.length + ' tree request(s))');

ok(refGets.length >= 3, 'the head was re-read after the 422 (' + refGets.length + ' ref reads: ' +
   JSON.stringify(refGets) + ')');
eq(refGets[refGets.length - 1], s1.newHead, 'and the last read saw the new head');

/* `force:true` would "fix" the 422 by overwriting the branch, silently discarding whichever
 * submission won the race. Losing a photograph that way is worse than a retry. */
const forced = log.filter((r) => {
  if (/"force"/.test(r.body)) return true;
  if (!r.body) return false;
  try { return hasForceKey(JSON.parse(r.body)); } catch (e) { return false; }
});
function hasForceKey(o) {
  if (!o || typeof o !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(o, 'force')) return true;
  return Object.keys(o).some((k) => hasForceKey(o[k]));
}
eq(forced.length, 0, 'NO request body contained `force` (' + log.length +
   ' requests inspected, force:true would discard the winning submission)');

eq(res1 && res1.bundleId, id1, 'the returned result carries the expected bundleId');
ok(!!res1 && typeof res1.commit === 'string' && res1.commit.length === 12, 'and a 12-char commit id');
ok(!!res1 && typeof res1.bytes === 'number' && res1.bytes > 0, 'and a byte count');

/* --------------------------------- scenario 2: it must give up, not spin forever */
console.log('\nscenario 2 — every attempt loses; the loop must terminate');
reset();
const s2 = freshState('always422');
globalThis.fetch = makeFetch(s2);

let res2 = null, err2 = null;
try { res2 = await L.submit(bundle(L.bundleId())); } catch (e) { err2 = e; }

ok(err2 !== null && res2 === null, 'submit() REJECTS when the race can never be won');
ok(err2 && /422/.test(err2.message),
   'the error message contains 422 (got "' + (err2 ? err2.message : '') + '")');
eq(patches.length, 5,
   'the ref PATCH was attempted MAX_REF_ATTEMPTS + 1 times (4 retries then give up)');

console.log(failures ? '\nFAIL: ' + failures + ' assertion(s) failed' : '\nPASS — all assertions held');
process.exit(failures ? 1 : 0);
