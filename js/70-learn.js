/* js/70-learn.js — "Learn": collect a failed or corrected crop and send it to the PC.
 *
 * This is the transport half of mailbox #28. It is deliberately free of DOM code so that
 * the exact same file that ships to the phone can be executed and tested on the PC.
 *
 * WHAT IT SENDS, AND WHY BOTH IMAGES
 * ----------------------------------
 * A bundle is two JPEGs plus a manifest:
 *   before.jpg   the work-resolution image, ALREADY REDACTED (see the brush, js/75-learn-ui.js)
 *   after.jpg    the same image with the corrected quad applied, ALREADY REDACTED
 * The before-image is the one the detector failed on, so it is the training signal; sending
 * only the corrected result would teach nothing about the failure. Both must carry the same
 * redaction, stored in SOURCE-IMAGE coordinates, or an unredacted name/IC rides along in the
 * before-image and the whole feature is a lie.
 *
 * WHY THE BYTES GO ON A BRANCH AND NOT IN THE ISSUE
 * -------------------------------------------------
 * GitHub's REST API cannot attach files to an issue body. So the images ride on the orphan
 * branch `learn-inbox` and issue #28 carries metadata only.
 *
 * RETENTION
 * ---------
 * The app never deletes. The PC reader verifies each sha256, posts an ACK on #28, then
 * rewrites the branch to a bare commit - a real history rewrite, since a plain `git rm`
 * would leave the photographs recoverable in history forever. GitHub's own backups may
 * outlive that rewrite, which is why the wording shown to the user says "removed" and never
 * "destroyed".
 *
 * NO ORIGINAL FILENAME IS EVER SENT. Filenames leak identity by themselves.
 *
 * THE TOKEN
 * ---------
 * The client's own fine-grained PAT, typed in once, stored in this device's localStorage
 * only. It is NEVER placed in the source, because this app is served from public GitHub
 * Pages and anything in the JS is readable from page source - a token there would let
 * anyone read the intake, i.e. the world reading pathology reports.
 */
(function (global) {
  'use strict';

  var JS = global.JS = global.JS || {};

  var REPO = 'choochatgpt/ask-ai-relay';
  var ISSUE = 28;
  var BRANCH = 'learn-inbox';
  var API = 'https://api.github.com';
  var EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  var TOKEN_KEY = 'jscanner.learn.token';
  var MAX_IMAGE_BYTES = 8 * 1024 * 1024;

  /* ---------------------------------------------------------------- token */

  function getToken() {
    try { return global.localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function setToken(t) {
    try { global.localStorage.setItem(TOKEN_KEY, String(t || '').trim()); return true; }
    catch (e) { return false; }
  }
  function clearToken() {
    try { global.localStorage.removeItem(TOKEN_KEY); return true; } catch (e) { return false; }
  }
  function hasToken() { return getToken().length > 0; }

  /* ------------------------------------------------------------- base64 */
  /* Hand-rolled so this file runs unchanged in the browser AND in Node, where btoa does
   * not exist. A shim would mean the tested code is not the shipped code. */

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function b64(bytes) {
    var out = '', i;
    for (i = 0; i + 2 < bytes.length; i += 3) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    var rem = bytes.length - i;
    if (rem === 1) {
      var a = bytes[i] << 16;
      out += B64[(a >> 18) & 63] + B64[(a >> 12) & 63] + '==';
    } else if (rem === 2) {
      var b = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += B64[(b >> 18) & 63] + B64[(b >> 12) & 63] + B64[(b >> 6) & 63] + '=';
    }
    return out;
  }

  function utf8(str) {
    var s = unescape(encodeURIComponent(str)), i, out = new Uint8Array(s.length);
    for (i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  /* -------------------------------------------------------------- digest */

  function sha256hex(bytes) {
    // crypto.subtle needs a secure context: GitHub Pages is https, and Node has it too.
    return global.crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
      var v = new Uint8Array(buf), out = '', i;
      for (i = 0; i < v.length; i++) out += (v[i] < 16 ? '0' : '') + v[i].toString(16);
      return out;
    });
  }

  /* ----------------------------------------------------------------- api */

  function api(method, path, body, tok) {
    var headers = {
      'Authorization': 'Bearer ' + (tok || getToken()),
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    var init = { method: method, headers: headers };
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    return global.fetch(API + path, init).then(function (r) {
      if (r.status === 204) return { status: 204, data: null };
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = { raw: t.slice(0, 400) }; }
        return { status: r.status, data: data };
      });
    });
  }

  function bundleId() {
    var a = new Uint8Array(8);
    global.crypto.getRandomValues(a);
    var s = '', i;
    for (i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
    return 'b' + s;
  }

  /* ------------------------------------------------------------- branch */

  function bareCommit(message, tok) {
    // A parentless commit holding no submission data. Empty trees cannot be BUILT through
    // the API ({"tree": []} returns 422), so git's canonical empty-tree object is
    // referenced by SHA instead.
    return api('POST', '/repos/' + REPO + '/git/commits',
      { message: message, tree: EMPTY_TREE, parents: [] }, tok
    ).then(function (r) {
      if (r.status !== 201) throw new Error('bare commit failed (' + r.status + ')');
      return r.data.sha;
    });
  }

  function ensureBranch(tok) {
    return api('GET', '/repos/' + REPO + '/git/ref/heads/' + BRANCH, null, tok)
      .then(function (r) {
        if (r.status === 200) return r.data.object.sha;
        if (r.status !== 404) throw new Error('cannot read branch (' + r.status + ')');
        return bareCommit('learn-inbox: initialise bare intake branch', tok)
          .then(function (sha) {
            return api('POST', '/repos/' + REPO + '/git/refs',
              { ref: 'refs/heads/' + BRANCH, sha: sha }, tok)
              .then(function (c) {
                if (c.status !== 201) throw new Error('cannot create branch (' + c.status + ')');
                return sha;
              });
          });
      });
  }

  /* -------------------------------------------------------------- submit */

  /* Build the manifest. `meta` carries what the app knows about its own state - the label is
   * INFERRED from that state, never asked for:
   *   refused   -> auto crop failed and was not corrected
   *   corrected -> auto crop succeeded and the user moved the corners
   *   refused_then_corrected -> failed, then corrected by hand   <- the valuable pair
   */
  function buildManifest(meta, images) {
    return {
      schema: 'jscan.learn.bundle/1',
      bundle_id: meta.bundleId,
      app_version: (JS.VERSION || 'unknown'),
      created_utc: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      state: meta.state,
      tone: meta.tone || null,
      quad_auto: meta.quadAuto || null,
      quad_user: meta.quadUser || null,
      redacted: !!meta.redacted,
      redaction: meta.redaction || null,
      images: images
    };
  }

  /* submit({before, after, meta}) -> Promise<{bundleId, commit, bytes}>
   *   before / after : Uint8Array of the ALREADY-REDACTED JPEG bytes
   *   meta           : { state, tone, quadAuto, quadUser, redacted, redaction }
   */
  function submit(bundle) {
    var tok = getToken();
    if (!tok) return Promise.reject(new Error('NO_TOKEN'));

    var before = bundle.before, after = bundle.after;
    if (!before || !after) return Promise.reject(new Error('MISSING_IMAGE'));
    if (before.length > MAX_IMAGE_BYTES || after.length > MAX_IMAGE_BYTES) {
      return Promise.reject(new Error('IMAGE_TOO_LARGE'));
    }

    // Accept a caller-supplied id so the UI can show it while sending and then pass the SAME
    // id to checkAck(). Generating it internally only made it unknowable to the caller, which
    // an integration test caught.
    var id = bundle.bundleId || bundleId();
    var files = { 'before.jpg': before, 'after.jpg': after };
    var manifest;

    return Promise.all([sha256hex(before), sha256hex(after)]).then(function (hashes) {
      var images = {
        'before.jpg': { sha256: hashes[0], bytes: before.length },
        'after.jpg': { sha256: hashes[1], bytes: after.length }
      };
      manifest = buildManifest({
        bundleId: id,
        state: bundle.meta.state,
        tone: bundle.meta.tone,
        quadAuto: bundle.meta.quadAuto,
        quadUser: bundle.meta.quadUser,
        redacted: bundle.meta.redacted,
        redaction: bundle.meta.redaction
      }, images);
      files['manifest.json'] = utf8(JSON.stringify(manifest, null, 2));
      return ensureBranch(tok);
    }).then(function (parent) {
      // Upload every file as a blob.
      var names = Object.keys(files);
      return Promise.all(names.map(function (n) {
        return api('POST', '/repos/' + REPO + '/git/blobs',
          { content: b64(files[n]), encoding: 'base64' }, tok
        ).then(function (r) {
          if (r.status !== 201) throw new Error('blob ' + n + ' failed (' + r.status + ')');
          return { path: id + '/' + n, mode: '100644', type: 'blob', sha: r.data.sha };
        });
      })).then(function (entries) { return { parent: parent, entries: entries }; });
    }).then(function (ctx) {
      // MERGE with what is already on the branch. Omitting base_tree makes the new tree
      // REPLACE the branch's whole contents, silently dropping any earlier submission -
      // a bug that was found and fixed on the PC side during testing.
      return api('GET', '/repos/' + REPO + '/git/commits/' + ctx.parent, null, tok)
        .then(function (r) {
          if (r.status !== 200) throw new Error('cannot read parent (' + r.status + ')');
          var body = { tree: ctx.entries };
          var tree = r.data.tree.sha;
          if (tree !== EMPTY_TREE) body.base_tree = tree;
          return api('POST', '/repos/' + REPO + '/git/trees', body, tok)
            .then(function (t) {
              if (t.status !== 201) throw new Error('tree failed (' + t.status + ')');
              return { parent: ctx.parent, tree: t.data.sha };
            });
        });
    }).then(function (ctx) {
      return api('POST', '/repos/' + REPO + '/git/commits',
        { message: 'learn-intake: bundle ' + id, tree: ctx.tree, parents: [ctx.parent] }, tok
      ).then(function (c) {
        if (c.status !== 201) throw new Error('commit failed (' + c.status + ')');
        return c.data.sha;
      });
    }).then(function (commit) {
      return api('PATCH', '/repos/' + REPO + '/git/refs/heads/' + BRANCH,
        { sha: commit }, tok
      ).then(function (r) {
        if (r.status !== 200) throw new Error('ref update failed (' + r.status + ')');
        return {
          bundleId: id,
          commit: commit.slice(0, 12),
          bytes: files['before.jpg'].length + files['after.jpg'].length +
                 files['manifest.json'].length,
          note: 'Sent. The PC verifies it, acknowledges on issue #' + ISSUE +
                ', then removes it from GitHub.'
        };
      });
    });
  }

  /* Check whether the PC has acknowledged a bundle. The ACK is the client-visible receipt:
   * it answers "did it work?" without any timer, which is why a short TTL was the wrong
   * mechanism for retention. */
  function checkAck(id) {
    var tok = getToken();
    if (!tok) return Promise.reject(new Error('NO_TOKEN'));
    return api('GET', '/repos/' + REPO + '/issues/' + ISSUE + '/comments?per_page=100', null, tok)
      .then(function (r) {
        if (r.status !== 200) throw new Error('cannot read #' + ISSUE + ' (' + r.status + ')');
        var hit = (r.data || []).filter(function (c) {
          return typeof c.body === 'string' && c.body.indexOf('`' + id + '`') !== -1;
        });
        return { acknowledged: hit.length > 0, id: id };
      });
  }

  JS.learn = {
    REPO: REPO, ISSUE: ISSUE, BRANCH: BRANCH, TOKEN_KEY: TOKEN_KEY,
    EMPTY_TREE: EMPTY_TREE, MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
    getToken: getToken, setToken: setToken, clearToken: clearToken, hasToken: hasToken,
    bundleId: bundleId, buildManifest: buildManifest, b64: b64, utf8: utf8,
    sha256hex: sha256hex, api: api,
    ensureBranch: ensureBranch, submit: submit, checkAck: checkAck
  };
})(typeof window !== 'undefined' ? window : globalThis);
