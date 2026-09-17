/* ==========================================================================
   20-detect.js — find the page edges and the tilt angle
   ========================================================================== */
'use strict';

(function (JS) {

  /* ------------------------------------------------------- connected blobs */

  /**
   * Largest 4-connected blob in a binary mask, by pixel count.
   * Iterative flood fill on an explicit stack — a recursive version blows the
   * call stack on a 200k-pixel sheet of paper.
   */
  function largestBlob(mask, w, h) {
    var seen = new Uint8Array(w * h);
    var stack = new Int32Array(w * h);
    var best = null, bestCount = 0;

    for (var start = 0; start < mask.length; start++) {
      if (!mask[start] || seen[start]) continue;
      var sp = 0, count = 0;
      stack[sp++] = start;
      seen[start] = 1;
      var minX = w, maxX = 0, minY = h, maxY = 0;
      var pixels = [];

      while (sp > 0) {
        var idx = stack[--sp];
        var x = idx % w, y = (idx - x) / w;
        count++;
        pixels.push(idx);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        if (x > 0     && mask[idx - 1] && !seen[idx - 1]) { seen[idx - 1] = 1; stack[sp++] = idx - 1; }
        if (x < w - 1 && mask[idx + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack[sp++] = idx + 1; }
        if (y > 0     && mask[idx - w] && !seen[idx - w]) { seen[idx - w] = 1; stack[sp++] = idx - w; }
        if (y < h - 1 && mask[idx + w] && !seen[idx + w]) { seen[idx + w] = 1; stack[sp++] = idx + w; }
      }

      if (count > bestCount) {
        bestCount = count;
        best = { count: count, pixels: pixels, minX: minX, maxX: maxX, minY: minY, maxY: maxY };
      }
    }
    return best;
  }

  /**
   * The blob's *outer* silhouette, and nothing else.
   *
   * Not "every pixel with a non-mask neighbour" — that is the outer edge plus
   * the rim of every hole inside the shape, and a page of text is mostly holes.
   * On a photographed report the printing is a few thousand glyphs, each one a
   * hole in the bright region, and their rims outnumber the page's own edge
   * several times over. Least squares then does the reasonable thing with the
   * points it is given and fits the *text block*: a tidy rectangle around the
   * paragraphs, with the paper's real edges nowhere in it. That is what
   * auto-crop used to return for a page that filled the frame — a quad at
   * 15%-85% of the width, cropping the page's own margin off.
   *
   * So a hole has to be told apart from the outside, and the difference is
   * reachability: the outside is the non-blob region you can walk to from the
   * frame border, and a hole is a non-blob region you cannot. Flooding the
   * background once marks every outside pixel, and then a blob pixel is on the
   * silhouette if it faces one. Interior structure is excluded by the same test
   * that keeps the real edge in.
   *
   * A blob pixel sitting on the frame itself counts as silhouette too: that is
   * as much of the shape as the photo contains, and for a page shot to the
   * edges of the frame it is the only evidence that side has. (The neighbour
   * tests are guarded by coordinate, not just by index — at x = 0 the pixel
   * before it is the end of the row above, and at y = 0 the pixel above it is
   * off the end of the buffer entirely.)
   *
   * Exported because this is where "the page" and "the printing on the page"
   * are told apart, and that distinction is not otherwise observable from
   * outside: the fit downstream can absorb a badly chosen point set and still
   * return a plausible quad. Only reads `blob.pixels`.
   */
  JS.boundaryPixels = function (blob, mask, w, h) {
    var outside = new Uint8Array(w * h);
    var stack = new Int32Array(w * h);
    var sp = 0;

    function seed(i) {
      if (!mask[i] && !outside[i]) { outside[i] = 1; stack[sp++] = i; }
    }
    var x, y;
    for (x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }

    while (sp > 0) {
      var idx = stack[--sp], px = idx % w;
      if (px > 0 && !mask[idx - 1] && !outside[idx - 1]) { outside[idx - 1] = 1; stack[sp++] = idx - 1; }
      if (px < w - 1 && !mask[idx + 1] && !outside[idx + 1]) { outside[idx + 1] = 1; stack[sp++] = idx + 1; }
      if (idx >= w && !mask[idx - w] && !outside[idx - w]) { outside[idx - w] = 1; stack[sp++] = idx - w; }
      if (idx < w * (h - 1) && !mask[idx + w] && !outside[idx + w]) { outside[idx + w] = 1; stack[sp++] = idx + w; }
    }

    var out = [];
    for (var i = 0; i < blob.pixels.length; i++) {
      var b = blob.pixels[i];
      x = b % w; y = (b - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
          (x > 0     && outside[b - 1]) ||
          (x < w - 1 && outside[b + 1]) ||
          (y > 0     && outside[b - w]) ||
          (y < h - 1 && outside[b + w])) {
        out.push({ x: x, y: y });
      }
    }
    return out;
  }

  /** Andrew's monotone chain convex hull. */
  function convexHull(pts) {
    if (pts.length < 3) return pts.slice();
    var p = pts.slice().sort(function (a, b) { return a.x - b.x || a.y - b.y; });
    function cross(o, a, b) {
      return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    }
    var lower = [], i;
    for (i = 0; i < p.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p[i]) <= 0) lower.pop();
      lower.push(p[i]);
    }
    var upper = [];
    for (i = p.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
      upper.push(p[i]);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  /**
   * Four corners of a convex hull via the classic extreme-point trick:
   * the corners of a convex quad maximise / minimise x+y and x-y.
   * Returns points ordered TL, TR, BR, BL.
   */
  function hullCorners(hull) {
    if (hull.length < 4) return null;
    var tl = hull[0], tr = hull[0], br = hull[0], bl = hull[0];
    var minSum = Infinity, maxSum = -Infinity, minDif = Infinity, maxDif = -Infinity;
    for (var i = 0; i < hull.length; i++) {
      var p = hull[i], s = p.x + p.y, d = p.x - p.y;
      if (s < minSum) { minSum = s; tl = p; }
      if (s > maxSum) { maxSum = s; br = p; }
      if (d > maxDif) { maxDif = d; tr = p; }
      if (d < minDif) { minDif = d; bl = p; }
    }
    var q = [{ x: tl.x, y: tl.y }, { x: tr.x, y: tr.y }, { x: br.x, y: br.y }, { x: bl.x, y: bl.y }];
    // Degenerate hull (collinear / duplicate corners) is worse than no answer.
    var ids = {}, uniq = 0;
    for (i = 0; i < 4; i++) {
      var k = q[i].x + ',' + q[i].y;
      if (!ids[k]) { ids[k] = 1; uniq++; }
    }
    if (uniq < 4) return null;
    return q;
  }

  /* ------------------------------------------------------- edge fitting */

  /** Perpendicular distance from `p` to the segment a-b. */
  function distToSegment(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) return JS.dist(p, a);
    var t = JS.clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
  }

  /**
   * Total-least-squares line through `pts`, as {a,b,c} with a*x + b*y + c = 0
   * and a²+b² = 1.
   *
   * The principal axis of the covariance, not a y-on-x regression: a page edge
   * runs in whatever direction the page happens to be rotated to, and a
   * regression would blow up as the edge approached vertical.
   */
  JS.fitLine = function (pts) {
    var n = pts.length, i;
    if (n < 2) return null;
    var cx = 0, cy = 0;
    for (i = 0; i < n; i++) { cx += pts[i].x; cy += pts[i].y; }
    cx /= n; cy /= n;

    var sxx = 0, sxy = 0, syy = 0;
    for (i = 0; i < n; i++) {
      var dx = pts[i].x - cx, dy = pts[i].y - cy;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    if (sxx + syy < 1e-9) return null;   // every sample is the same pixel
    var th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    var nx = -Math.sin(th), ny = Math.cos(th);
    return { a: nx, b: ny, c: -(nx * cx + ny * cy) };
  };

  /** How far `p` sits off a line in the (a,b,c) form. */
  function lineDist(line, p) {
    return Math.abs(line.a * p.x + line.b * p.y + line.c);
  }

  /** The points of `pts` that lie within `tol` of `line`. */
  function inliers(pts, line, tol) {
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      if (lineDist(line, pts[i]) <= tol) out.push(pts[i]);
    }
    return out;
  }

  /**
   * The line most of the points agree on.
   *
   * `fitLine` is only as good as the set it is handed, and a side's points are
   * "everything nearer this edge than the other three" — which can include the
   * rim of a shadow lying across a corner of the page, the near side of a fold,
   * or the slope of a torn edge. Least squares has no opinion about which of
   * its inputs deserve to be there. It splits the difference between the edge
   * and the damage, and is then wrong about both: two dozen bad points will
   * tilt a line that two hundred good ones are already lying on.
   *
   * So rather than averaging everything, find the largest set of points that
   * agree on a line and fit that. The candidates come from pairs — two points
   * define a line, and any pair drawn from the real edge proposes the real
   * edge, so a spread of pairs finds it with nothing random in it. The winner
   * is then refit on its own inliers, twice, because the line through two of
   * them is not yet the line through all of them and the first refit can pick
   * up points the pair's line fell just short of.
   *
   * `tol` is how far off a line an edge point may sit: a pixel or two at the
   * resolution the detector works at, which is fixed by design. Points beyond
   * it are not evidence about this edge.
   *
   * Reports the residual over the points that agreed, so the caller can tell a
   * straight edge from a bucket that no single line describes.
   */
  function robustLine(pts, tol) {
    var n = pts.length, i, k;
    if (n < 2) return null;

    var line = JS.fitLine(pts);
    if (!line) return null;

    if (n >= 4) {
      // Half the set apart, so the two points imply a stable direction, and a
      // stride so the candidates are spread over the whole side rather than
      // clustered on one end of it.
      var half = n >> 1;
      var stride = Math.max(1, Math.floor(n / 24));
      var best = null, bestCount = 0;
      for (i = 0; i < n; i += stride) {
        var cand = lineThrough(pts[i], pts[(i + half) % n]);
        if (!cand) continue;
        var count = 0;
        for (k = 0; k < n; k++) if (lineDist(cand, pts[k]) <= tol) count++;
        if (count > bestCount) { bestCount = count; best = cand; }
      }
      if (best) line = best;
    }

    var kept = inliers(pts, line, tol);
    for (var pass = 0; pass < 2; pass++) {
      if (kept.length < 3) break;
      var refit = JS.fitLine(kept);
      if (!refit) break;
      line = refit;
      kept = inliers(pts, line, tol);
    }
    // Nothing agreed on anything, so there is no line here to report — hand
    // back the raw fit and let its residual say so.
    if (kept.length < 3) kept = pts;

    var s = 0;
    for (i = 0; i < kept.length; i++) {
      var d = lineDist(line, kept[i]);
      s += d * d;
    }
    return { line: line, rms: Math.sqrt(s / kept.length), kept: kept.length };
  }

  /** The line through two points, in the same form as fitLine. */
  function lineThrough(p, r) {
    var a = p.y - r.y, b = r.x - p.x;
    var m = Math.hypot(a, b);
    if (m < 1e-9) return null;
    a /= m; b /= m;
    return { a: a, b: b, c: -(a * p.x + b * p.y) };
  }

  /** Where two lines cross, or null when they are parallel. */
  JS.lineIntersect = function (l1, l2) {
    if (!l1 || !l2) return null;
    var det = l1.a * l2.b - l2.a * l1.b;
    if (Math.abs(det) < 1e-9) return null;
    return {
      x: (l1.b * l2.c - l2.b * l1.c) / det,
      y: (l2.a * l1.c - l1.a * l2.c) / det
    };
  };

  /**
   * The points of one side that the fit is allowed to see: everything from
   * `band` to `1-band` of the way along a→b.
   *
   * Both ends are dropped. A point near a corner is genuinely on two sides at
   * once, and letting it into both fits tilts each line outwards, walking the
   * corner off the page a little more on every pass. A shadow blob stuck to a
   * corner is worse than that — it is real boundary, so it belongs to the side
   * by every measure, and the only thing that separates it from the edge is
   * that it is nowhere near the corner.
   *
   * Three points is the floor. Two define a line but say nothing about whether
   * the edge bends, and one — which is what a corner swallowed by a protrusion
   * leaves behind — is not evidence about that side at all.
   */
  function sideCore(pts, a, b, band) {
    if (!pts || pts.length < 3) return null;
    var dx = b.x - a.x, dy = b.y - a.y;
    var len2 = dx * dx + dy * dy;
    var scored = pts.map(function (p) {
      var t = len2 < 1e-9 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
      return { p: p, t: t };
    }).sort(function (u, v) { return u.t - v.t; });

    var core = scored.filter(function (s) { return s.t > band && s.t < 1 - band; });
    if (core.length < 3) core = scored;     // a short edge: the ends are all we have
    if (core.length < 3) return null;

    return core.map(function (s) { return s.p; });
  }

  /**
   * The largest angle, in degrees, by which any edge of `q` misses square.
   *
   * Not a test of whether the quad is *right*: a page photographed at an angle
   * has four edges that are all off square, and rectifying it is exactly what
   * puts the page straight in the output. It is a way of asking whether a second
   * refine pass has moved the quad further out than the one it is replacing —
   * see the comparison in `quadFromEdges`, which pairs it with `support` for
   * that reason and never uses it on its own.
   *
   * Edge 0 is the top and edge 1 the right, so even edges are compared against
   * horizontal and odd ones against vertical; the angle is folded into ±45°
   * first, which makes the answer independent of which way the quad is wound.
   */
  function quadSquareness(q) {
    var worst = 0;
    for (var i = 0; i < 4; i++) {
      var a = q[i], b = q[(i + 1) % 4];
      var want = (i % 2) ? 90 : 0;
      var ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      var d = ((ang - want) % 180 + 180) % 180;
      if (d > 90) d = 180 - d;
      if (d > worst) worst = d;
    }
    return worst;
  }

  /** Signed area of a quad — the sign carries its winding. */
  function winding(q) {
    var a = 0;
    for (var i = 0; i < 4; i++) {
      var p = q[i], r = q[(i + 1) % 4];
      a += p.x * r.y - r.x * p.y;
    }
    return a / 2;
  }

  /**
   * Is the refined quad still a plausible page, and still the same page?
   * A fit that has gone wrong tends to show up as a self-intersecting shape or
   * one that has snapped onto a different edge entirely.
   */
  function validQuad(q, rough, w, h) {
    var i, j;
    for (i = 0; i < 4; i++) {
      if (!isFinite(q[i].x) || !isFinite(q[i].y)) return false;
      if (q[i].x < -0.05 * w || q[i].x > 1.05 * w) return false;
      if (q[i].y < -0.05 * h || q[i].y > 1.05 * h) return false;
    }
    // Convex and wound the same way as the rough quad.
    var sgn = winding(q) > 0 ? 1 : -1;
    if (winding(rough) > 0 !== sgn > 0) return false;
    for (i = 0; i < 4; i++) {
      var a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      var cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (cross === 0 || (cross > 0 ? 1 : -1) !== sgn) return false;
    }
    // Same size, roughly — a fit that jumped to the page next door shows here.
    var area = Math.abs(winding(q)), ref = Math.abs(winding(rough));
    if (area < w * h * 0.05) return false;
    if (ref > 0 && (area < ref * 0.6 || area > ref * 1.6)) return false;
    // Each corner stayed with its own corner.
    for (i = 0; i < 4; i++) {
      var own = JS.dist(q[i], rough[i]);
      for (j = 0; j < 4; j++) {
        if (j !== i && JS.dist(q[i], rough[j]) < own) return false;
      }
    }
    return true;
  }

  /**
   * Is this boundary pixel sitting on the photo's own border?
   *
   * `boundaryPixels` hands over blob pixels that lie on the frame on purpose:
   * that is as much of the shape as the photo contains, and for the hull it is
   * the only evidence a cut-off side has. It is not evidence about the *page*,
   * though, and a run of them is the worst possible thing to fit a line to.
   * They are collinear by construction, so the fit comes back at zero residual
   * and beats the page's real edge — which is tilted, and only partly in frame,
   * and has to be extrapolated to reach the corner.
   *
   * Measured on the reported photos: of the sides that came back as the frame,
   * the fitted core was 100%, 100% and 66% frame pixels at rms 0.00 and exactly
   * 90.00 degrees; the sides that came back right held none at all. The band is
   * a hundredth of the canvas — a pixel or two at the resolution this runs at.
   */
  function onFrame(p, w, h) {
    var mx = Math.max(1, w * 0.01), my = Math.max(1, h * 0.01);
    return p.x <= mx || p.y <= my || p.x >= w - 1 - mx || p.y >= h - 1 - my;
  }

  /**
   * One pass: bucket the boundary onto the four sides, fit each, intersect.
   *
   * Returns null unless every side could be fitted or — for at most one side —
   * inherited from the rough quad. A candidate stitched together from three
   * fitted edges and one inherited is the dangerous kind: it looks like an
   * improvement, passes every geometric check, and yet has moved a corner on no
   * evidence at all. So a side is inherited only when the photo offered nothing
   * else there, and never two of them. Refusing to move anything without
   * evidence for every edge is what makes this function safe to run twice.
   *
   * Success comes back as `{ q, support }`: the quad, and how many of the page's
   * boundary pixels agreed with the line fitted to their side. `support` is what
   * `quadFromEdges` weighs one pass against another — every guard inside this
   * function asks whether a side's fit is *self-consistent*, and a handful of
   * points agreeing on a line is self-consistent however few of them there are.
   */
  function refineOnce(pts, q, w, h, band) {
    var buckets = [[], [], [], []], onBorder = [0, 0, 0, 0], i;
    for (i = 0; i < pts.length; i++) {
      var p = pts[i], best = 0, bestD = Infinity;
      for (var s = 0; s < 4; s++) {
        var d = distToSegment(p, q[s], q[(s + 1) % 4]);
        if (d < bestD) { bestD = d; best = s; }
      }
      // The photo's own edge, not the page's. Counted rather than kept, so the
      // fit can tell "no evidence here" from "nothing but the frame here".
      if (onFrame(p, w, h)) { onBorder[best]++; continue; }
      buckets[best].push(p);
    }

    var lines = [];
    var tol = JS.clamp(0.004 * Math.max(w, h), 1.25, 2.5);
    var border = 0, support = 0;
    for (i = 0; i < 4; i++) {
      // Fitted to every point on the side, not just three of them: three points
      // fix a line but a side's worth of points fixes its *angle*, and the
      // corner is an extrapolation well past the last of them.
      var core = sideCore(buckets[i], q[i], q[(i + 1) % 4], band);
      var fit = core ? robustLine(core, tol) : null;
      if (!fit) {
        // Every pixel offered for this side lay on the photo's border, so the
        // page runs off the frame here: the border is not evidence about the
        // page, but it is where the cut belongs. Keep the rough quad's edge. A
        // side that *did* have pixels in frame and still would not fit is a
        // different thing — its evidence contradicts itself — and stays a
        // refusal, as does a second inherited side, which would leave a quad
        // that is mostly the frame's outline and describes the photo, not the
        // page.
        if (buckets[i].length || !onBorder[i] || ++border > 1) return null;
        lines.push(lineThrough(q[i], q[(i + 1) % 4]));
        continue;
      }
      // And a side is a straight edge. If the line does not actually pass
      // through the points it was fitted to, the bucket is holding two
      // different structures at once — the page edge and the margin of the
      // printing, say — and a line through the middle of both is neither. That
      // is what a quad drawn around the paragraphs instead of the paper looks
      // like from here, and it is worth refusing a side over.
      if (fit.rms > Math.max(2, 0.01 * JS.dist(q[i], q[(i + 1) % 4]))) return null;
      support += fit.kept;
      var line = fit.line;
      lines.push(line);
    }

    var out = [];
    for (i = 0; i < 4; i++) {
      // Corner i is where the edge arriving at it meets the edge leaving it.
      var c = JS.lineIntersect(lines[(i + 3) % 4], lines[i]);
      if (!c) return null;
      out.push({ x: JS.clamp(c.x, 0, w), y: JS.clamp(c.y, 0, h) });
    }
    return validQuad(out, q, w, h) ? { q: out, support: support } : null;
  }

  /**
   * Refine a rough quad against the page's boundary pixels.
   *
   * The corners used to be read straight off four extreme hull points, so the
   * whole crop inherited whichever pixel happened to stick out furthest — and
   * worse, the points that extremise x+y and x−y are only the corners while the
   * silhouette *has* four corners. Fold a corner over, tear it, or let a shadow
   * blob join the page, and the extreme point slides onto the damage: the crop
   * loses that corner and everything near it is warped inward.
   *
   * Three things make the fitted version better than the point pick:
   *
   * - it fits the *boundary pixels*, not their hull. The hull of a jittered
   *   edge is its outward envelope — every point on it leans away from the page
   *   — so fitting to it biases each edge outwards. The boundary pixels fall on
   *   both sides of the true edge and fit it without a bias.
   * - fitting three samples rather than trusting one point means a stray pixel
   *   has to survive a least-squares fit before it moves anything.
   * - intersecting neighbouring fits recovers a corner the silhouette does not
   *   have, because the two lines cross beyond the damage. The hull cannot do
   *   this at all: a protrusion that swallows a corner removes that corner from
   *   the hull entirely, and no amount of work on the hull gets it back.
   *
   * Two passes, since the first fit can hand a point to a better side than the
   * rough quad did. The second pass also keeps well clear of the corners: a
   * shadow blob stuck to a corner is *boundary*, so it lands in a side's bucket
   * and can only be shaken off by refusing the points nearest that corner. The
   * first pass stays close to the ends because a side is short enough that
   * trimming both ends hard would leave too little to fit.
   *
   * Any pass that cannot support all four edges leaves the corners as they were.
   */
  JS.quadFromEdges = function (pts, w, h, rough) {
    if (!pts || pts.length < 8) return null;
    var q = rough || hullCorners(convexHull(pts));
    if (!q) return null;
    var fromHull = !rough, fitted = false;
    var bands = [0.12, 0.25];
    var support = 0;
    for (var iter = 0; iter < bands.length; iter++) {
      var next = refineOnce(pts, q, w, h, bands[iter]);
      if (!next) break;
      // Only a *later* pass is on trial. The first is what turns the hull's four
      // extreme points into four fitted edges, and on a clean page the corners
      // are wrong without it; a second pass has to earn its place.
      //
      // It does not, when it both explains less of the page's boundary than the
      // quad it is replacing and leaves that quad further from square. Measured
      // on the reported photos, that is the difference between a receipt coming
      // back level and coming back 17 degrees out: on `pair2` the first pass
      // returns a bottom edge 1.4 degrees off square with 621 boundary pixels
      // behind it, and the second returns one 17.4 degrees off with 354 — the
      // wider band reaches past the shadow the page is lying on and fits *that*
      // instead. The two halves of the test guard each other. A page genuinely
      // photographed at an angle is off square in both passes, so the second
      // half says nothing there; and a pass that finds more evidence is kept
      // whatever shape it reports, because more evidence is the whole point.
      if (iter > 0 && next.support < support * 0.9 &&
          quadSquareness(next.q) > quadSquareness(q) + 1.5) break;
      support = next.support;
      q = next.q;
      fitted = true;
    }
    // Corners read off the hull are evidence about the page only while the blob
    // lies inside the photo. Let the blob be cut by the frame and the point that
    // extremises x+y is the *photo's* corner: the hull's four corners describe
    // the frame, and rectifying them stretches whatever is inside it. With no
    // edge fitted for any side, nothing here says where the page is, so say so.
    if (fromHull && !fitted) {
      for (var k = 0; k < 4; k++) if (onFrame(q[k], w, h)) return null;
    }
    return q;
  };

  /**
   * Push the quad outwards from its centre by `frac` so we do not shave the
   * first millimetre of the page off, then clamp back inside the frame.
   */
  function expandQuad(q, frac, w, h) {
    var cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
    var cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
    return q.map(function (p) {
      return {
        x: JS.clamp(cx + (p.x - cx) * (1 + frac), 0, w),
        y: JS.clamp(cy + (p.y - cy) * (1 + frac), 0, h)
      };
    });
  }

  /* --------------------------------------- the page's tone, as a mode ---- */

  /**
   * The intensity the paper itself sits at, found as a *mode*, not a split.
   *
   * `JS.otsu` maximises between-class variance over the whole frame, and on a
   * receipt lying on a dark table that is a question about the *table*: most of
   * the pixels are dark, so the split lands in the middle of the dark-to-bright
   * ramp and everything brighter than the table joins the paper side. That
   * includes the specular reflection a glossy table throws back. In the reported
   * Ori1 photo the paper is at 230 and the reflection reaches 190, and one Otsu
   * split at 124 puts both on the paper side — so the reflection joins the blob,
   * the blob's right silhouette becomes the reflection's outline, and the fitted
   * right side runs across the middle of the receipt.
   *
   * Paper is not a tail, it is a peak. A large, flat, evenly lit surface puts a
   * real mode in the histogram; a reflection is a smooth ramp and puts a tail
   * there instead. So the paper's level is the brightest peak above the
   * background, and `modeValley` turns that into a threshold the reflection
   * cannot cross.
   *
   * The whole difficulty is in the word "peak", and the first version of this
   * got it wrong in a way worth recording. It asked whether the smoothed
   * histogram held enough mass in a window around `v` — but a window wide enough
   * to hold a real page's spread also holds a *ramp's*, so on any frame with a
   * gradient every station qualified and the function returned the top of the
   * ramp. A frame of two flat halves plus a bright slip has exactly that shape,
   * and it is the frame the polarity guard's falsifier uses: the strict mask
   * found the slip and the falsifier's claim — that the unguarded detector crops
   * the shaded half — quietly stopped being true.
   *
   * So mass is a floor, not the test. The test is *prominence*: a peak has to
   * stand above its own shoulders, `sm[v-24]` and `sm[v+24]`, by a real
   * fraction of its own height. On a flat surface that holds by construction; on
   * a ramp it cannot, because a ramp's density at `v` and at `v ± 24` is the
   * same number. Mass is still asked for, on the *raw* histogram over a narrow
   * window, so a lone sharp spike off a few hundred pixels cannot win by being
   * tall.
   *
   * A shoulder that runs off the end of the histogram is not a shoulder. The
   * first version of this clamped the right reference into the top bin,
   * `sm[255]`, which is *the peak itself* whenever the mode sits near the top —
   * so prominence came out at or below zero by construction, and the brightest
   * thing in the frame was the one candidate the test could never accept. That
   * is not an edge case: a white receipt in daylight is saturated at 255, and
   * that is the paper. It cost pair1 and set25 their second candidate, and on
   * pair1 the scan walked back down to a 4%-mass midtone peak at 121 with the
   * paper sitting at 249. Measured, on those two frames, as prominence out of
   * the peak's own height:
   *
   *     pair1   v=249, 28.2% of the frame   clamped  6%   unclamped 94%
   *     set25   v=249, 52.6% of the frame   clamped 20%   unclamped 89%
   *
   * Nothing above the top bin can be a shoulder, so there is nothing on that
   * side to fall away to; the side that exists decides. A ramp is still
   * refused, because a ramp's *lower* shoulder is its own height.
   *
   * Returns -1 when the frame has no such peak, which is the honest answer for a
   * frame whose bright pixels are all ramp — and the caller then keeps the
   * single-threshold answer it already had.
   */
  function brightMode(h, framePx, bg) {
    var sm = h.sm, hist = h.hist, v, j, mass, prom, best = -1;
    // A tenth of a percent of the frame in a 21-level window: a floor against
    // single-pixel highlights, not a claim about how big a page is. The
    // prominence test is what decides the shape.
    var need = framePx * 0.001;
    for (v = Math.max(24, Math.ceil(bg) + 8); v < 255; v++) {
      if (!(sm[v] >= sm[v - 1] && sm[v] > sm[v + 1])) continue;
      if (sm[v] <= 0) continue;
      prom = sm[v] - Math.max(sm[v - 24], v + 24 <= 255 ? sm[v + 24] : 0);
      if (prom < sm[v] * 0.25) continue;
      // Mass off the raw histogram, not the smoothed one, so the window is
      // really 21 levels wide and not 33.
      mass = 0;
      for (j = Math.max(0, v - 10); j <= Math.min(255, v + 10); j++) mass += hist[j];
      if (mass >= need && v > best) best = v;
    }
    return best;
  }

  /**
   * The frame's histogram, and the same histogram smoothed — both, because the
   * two functions below want different things from it. `brightMode` reads a peak
   * off the smoothed density and a floor off the raw counts; `modeValley` only
   * ever wants the smooth one, since a valley is a shape and the raw counts
   * inside one are noise.
   *
   * Smoothing matters before either: thermal print is ragged enough to split one
   * surface into several adjacent spikes, and a mode finder that sees three
   * peaks where there is one surface picks the tallest spike rather than the
   * surface.
   */
  function smoothHist(gray) {
    var hist = new Uint32Array(256), i, v, d, j, s;
    for (i = 0; i < gray.length; i++) hist[gray[i]]++;
    var sm = new Float64Array(256);
    for (v = 0; v < 256; v++) {
      s = 0;
      for (d = -6; d <= 6; d++) { j = v + d; if (j >= 0 && j < 256) s += hist[j]; }
      sm[v] = s / 13;
    }
    return { sm: sm, hist: hist };
  }

  /**
   * The dimmest level between the background and the paper's mode.
   *
   * The mode is the *middle* of the paper, not its edge: the surface scatters a
   * little and the frame's own optics blur the boundary, so thresholding at the
   * mode would shave the page. The valley between the background's ramp and the
   * paper's peak is where the paper actually begins — and it is the level a
   * reflection has to reach before it can be mistaken for paper.
   *
   * The search starts halfway up the gap on purpose. Below that is the
   * background's own shoulder, where the histogram is flat and its minimum is
   * noise rather than a valley.
   */
  function modeValley(sm, bg, mode) {
    var lo = Math.max(1, Math.round(bg + (mode - bg) * 0.5));
    var bestV = -1, bestS = Infinity, v;
    for (v = lo; v < mode; v++) {
      if (sm[v] < bestS) { bestS = sm[v]; bestV = v; }
    }
    return bestV;
  }

  /* ------------------------------------------- one candidate, one threshold */

  /** Nearest-neighbour sample, clamped, so edge probes never fall off the frame. */
  function sampleAt(gray, w, h, x, y) {
    var xi = Math.round(x), yi = Math.round(y);
    if (xi < 0) xi = 0; else if (xi >= w) xi = w - 1;
    if (yi < 0) yi = 0; else if (yi >= h) yi = h - 1;
    return gray[yi * w + xi];
  }

  /**
   * How far either side of a side's line the tone is read. At the detector's
   * 420px working width the frame's own blur is about 2px and a paper edge
   * scatters about 1px, so this clears both while staying well inside a page
   * that covers any useful part of the frame.
   */
  var SIDE_PROBE = 6;

  /**
   * What the tone does across one side of a quad, positive when the inside is
   * brighter. `nx`,`ny` is the outward normal, so `inside` is the sample on the
   * quad's own side of the line.
   */
  function sideStep(gray, w, h, a, b, nx, ny, t) {
    var px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
    return sampleAt(gray, w, h, px - nx * SIDE_PROBE, py - ny * SIDE_PROBE)
         - sampleAt(gray, w, h, px + nx * SIDE_PROBE, py + ny * SIDE_PROBE);
  }

  /** The outward normal of side `s`, and the quad's centroid to orient it by. */
  function sideFrame(quad, s) {
    var a = quad[s], b = quad[(s + 1) % 4];
    var dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    var nx = len ? dy / len : 0, ny = len ? -dx / len : 0;
    var cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
    var cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
    if (((a.x + b.x) / 2 - cx) * nx + ((a.y + b.y) / 2 - cy) * ny < 0) {
      nx = -nx; ny = -ny;
    }
    return { a: a, b: b, len: len, nx: nx, ny: ny };
  }

  /**
   * How much a candidate looks like "paper inside, not paper outside".
   *
   * Two numbers, neither of which the single-threshold version could express:
   *
   *   `edge`  the *worst* side's inside-minus-outside step, in levels. Worst
   *           rather than mean, because a crop is only right if it is right on
   *           all four sides — averaging lets three good sides carry one that
   *           runs across the middle of the page, which is exactly what the
   *           reported photo did.
   *   `frac`  the share of the interior that is at the paper's own level. This
   *           is what a reflection joining the blob cannot fake: it is bright,
   *           but it is not the paper's level, so it costs `frac` even though it
   *           can make an edge look convincing.
   *
   * `edge` is in levels and `frac` is a fraction; the weight puts them on one
   * scale so that a side in the wrong place dominates a modest uniformity
   * difference, and uniformity decides between candidates whose edges are both
   * plausible.
   */
  function scoreQuad(gray, w, h, quad, paper, bg) {
    var worst = Infinity, s, k;
    for (s = 0; s < 4; s++) {
      var f = sideFrame(quad, s);
      if (f.len < 8) return -Infinity;
      var sum = 0, n = 0;
      // The middle 70% of each side. The ends are excluded deliberately: a
      // rounded, curled or torn corner is not evidence about where the side is,
      // and it is the thing most likely to be wrong.
      for (k = 3; k <= 17; k++) {
        sum += sideStep(gray, w, h, f.a, f.b, f.nx, f.ny, k / 20);
        n++;
      }
      if (sum / n < worst) worst = sum / n;
    }
    return worst + SCORE_FRAC_W * interiorPaperFrac(gray, w, h, quad, paper, bg);
  }

  // Levels of edge quality that one unit of interior-uniformity is worth.
  // Small on purpose: it decides between candidates whose edges are both
  // plausible, and never rescues one whose side is in the wrong place.
  var SCORE_FRAC_W = 50;

  /** A point inside the quad, in the order TL, TR, BR, BL. */
  function quadPoint(q, u, v) {
    var tx = q[0].x + (q[1].x - q[0].x) * u, ty = q[0].y + (q[1].y - q[0].y) * u;
    var bx = q[3].x + (q[2].x - q[3].x) * u, by = q[3].y + (q[2].y - q[3].y) * u;
    return { x: tx + (bx - tx) * v, y: ty + (by - ty) * v };
  }

  /**
   * The share of a coarse grid inside the quad that is at the paper's level.
   *
   * The print on the page is much darker than the paper, so a dense receipt
   * scores well below 1 here; that is expected and it is the same for every
   * candidate, which is what makes the comparison meaningful. What it catches is
   * the *large* non-paper region: background between a fitted side and the real
   * edge, or a reflection filling the part of the quad the page does not.
   */
  function interiorPaperFrac(gray, w, h, quad, paper, bg) {
    // Scaled to the frame's own contrast, so a pale page on a pale counter is
    // not held to a tolerance it could never meet.
    var tol = Math.max(10, (paper - bg) * 0.2);
    var ok = 0, n = 0, iu, iv;
    for (iu = 1; iu <= 6; iu++) {
      for (iv = 1; iv <= 6; iv++) {
        var p = quadPoint(quad, iu / 7, iv / 7);
        n++;
        if (Math.abs(sampleAt(gray, w, h, p.x, p.y) - paper) <= tol) ok++;
      }
    }
    return ok / n;
  }

  /**
   * One candidate quad, from one threshold.
   *
   * `work` is the buffer being thresholded — the raw frame for the first
   * candidate, a blurred copy for the second, because blurring is what stops the
   * print on a receipt from punching holes in a mask built near the paper's own
   * level. `bg` and `delta` are the frame's background reference and its
   * separation bar, both measured once on the raw frame: they describe the
   * *frame*, not the threshold, so they are not recomputed per candidate.
   *
   * Returns null at any of the refusals the single-threshold version had, so a
   * candidate that cannot be found simply does not compete.
   */
  function candidateQuad(work, w, h, thr, bg, delta) {
    var bgIsLight = bg > thr;
    var mask = new Uint8Array(w * h), i, v;
    for (i = 0; i < mask.length; i++) {
      v = work[i];
      mask[i] = ((v > thr) !== bgIsLight) && Math.abs(v - bg) > delta ? 1 : 0;
    }
    var maskCount = 0;
    for (i = 0; i < mask.length; i++) maskCount += mask[i];
    if (maskCount / mask.length < 0.04) return null;

    var blob = largestBlob(mask, w, h);
    if (!blob || blob.count < mask.length * 0.04) return null;

    // Rough corners off the hull's extreme points, then fitted to the real
    // edges of the page rather than left on whichever pixel stuck out furthest.
    var quad = JS.quadFromEdges(JS.boundaryPixels(blob, mask, w, h), w, h);
    if (!quad) return null;

    // Reject a quad that covers almost nothing — usually a bright object that
    // is not the page.
    if (JS.quadArea(quad) < w * h * 0.08) return null;

    // The paper's own level: the upper quartile of the region that was chosen,
    // which is the paper rather than the print on it. Read off a histogram
    // rather than a sort, and off `work` so it is in the same units as the
    // threshold that selected it.
    var hist = new Uint32Array(256), seen = 0, acc = 0, paper = 255;
    for (i = 0; i < mask.length; i++) if (mask[i]) { hist[work[i]]++; seen++; }
    for (i = 255; i >= 0; i--) {
      acc += hist[i];
      if (acc >= seen * 0.25) { paper = i; break; }
    }
    // `light` is which side of `thr` the *background* sits on, and so which side
    // the mask looked at. Returned because a second threshold has to be checked
    // against this — see `quadCandidates`.
    return { quad: quad, paper: paper, light: bgIsLight };
  }

  /* ------------------------------------------------- corner settling ---- */

  /**
   * The span of each side over which it is still the page's edge.
   *
   * Not called by anything here — it is the *measurement* behind the corner
   * note above, the thing that showed no side ever stops being the page's edge
   * on any photo to hand, and it lives here rather than in a probe because the
   * probe cannot reach `sideFrame` and `sideStep`. It costs one unused function
   * and it keeps the question askable; `corner_probe.py` prints what it returns.
   */
  JS.sideSpans = function (gray, w, h, quad, paper, bg) {
    var bar = Math.max(8, (paper - bg) * 0.25);
    var N = 40, spans = [], s, k;
    for (s = 0; s < 4; s++) {
      var f = sideFrame(quad, s);
      var good = [];
      for (k = 0; k <= N; k++) {
        good.push(f.len >= 8 && sideStep(gray, w, h, f.a, f.b, f.nx, f.ny, k / N) >= bar);
      }
      // The longest run of good stations, tolerating two dropouts: a single
      // stray dark mark just outside the page reads as "no step here", and a
      // span that stopped at the first such mark would trim a good side for no
      // reason. The whole span when nothing is good, which moves nothing.
      var bestLo = 0, bestHi = -1, lo = -1, gap = 0;
      for (k = 0; k < good.length; k++) {
        if (good[k]) {
          if (lo < 0) lo = k;
          gap = 0;
          if (k - lo > bestHi - bestLo) { bestLo = lo; bestHi = k; }
        } else if (lo >= 0) {
          gap++;
          if (gap > 2) { lo = -1; gap = 0; }
        }
      }
      if (bestHi < bestLo) { bestLo = 0; bestHi = good.length - 1; }
      spans.push({ lo: Math.round(bestLo / N * 100) / 100,
                   hi: Math.round(bestHi / N * 100) / 100 });
    }
    return spans;
  };

  /**
   * Pull a corner back onto the paper when the two lines it sits on do not
   * describe the page that far out.
   *
   * A quad is four *lines* and its corners are where they cross, which is only
   * the page's corner if both sides really are the page's edge all the way
   * there. On a thermal receipt they are not. The top edge is torn and the right
   * edge is cut, and where they meet the paper is *rounded*, because a rolled
   * receipt curls forward. Measured on the reported Ori1/Set30 photo, a block
   * inside the chosen top-right corner was 86% background while the other three
   * corners were 14-16% — that corner sat roughly a tenth of the receipt's width
   * out in the table, and no better edge detection changes it, because the paper
   * genuinely is not quadrilateral there.
   *
   * So each side is asked how far along itself it is still the page's edge, and
   * a corner is moved to the midpoint of the nearest point inside *each* of the
   * two spans that claim it. Nothing moves when both sides are good the whole
   * way, which is the common case.
   *
   * The whole settled quad is then scored against the original and discarded if
   * it is not better, so this can only ever help.
   */
  /* --- corner settling: tried, measured, and deliberately not shipped ------
   *
   * A quad is four *lines* and its corners are where they cross, which is the
   * page's corner only if both sides really are the page's edge all the way
   * there. On a rolled thermal receipt they may not be: where the torn top edge
   * meets the cut right edge, the paper is rounded.
   *
   * The step for this was written and measured, and it is not here because the
   * measurement said not to ship it. Each side was asked how far along itself it
   * was still the page's edge, and a corner was pulled to the nearest point
   * inside both of the spans claiming it; the settled quad was then accepted
   * only if it scored better than the original, could not be inflated, and moved
   * no corner more than a fifth of the shortest side.
   *
   * On all twelve photographs to hand — the seven `set*` fixtures, the four
   * `pair*` ones, and ori1 and ori3 — it moved **nothing**. Not one corner, on
   * any of them. The reason is structural rather than a tuning miss: `scoreQuad`
   * reads the tone across each side over t = 0.15..0.85, and t = 0 and t = 1 are
   * exactly the corners, so a corner sitting out in the background is invisible
   * to the score — and the score is the acceptance test. Teaching it to see one
   * means adding a corner term, and the corner measurement that would justify
   * that term is itself unreliable: on set25 a block over plain background reads
   * as 100% paper, because a tolerance scaled off the frame's own contrast
   * cannot tell lit marble from paper.
   *
   * So the failure this was meant to fix could not be reproduced from the
   * evidence available — the set30 photo exists only as a preview recovered from
   * a screenshot, and its reconstruction detects cleanly. A step that never
   * fires is not a fix: it is a second code path reachable only by mutation,
   * which is exactly where it was seen changing a falsifier's answer. What
   * remains is the honest position, and `tests/tmp/corner_probe.py` measures it,
   * so the work can resume against a photograph that actually shows the case.
   */

  /* ------------------------------------------------------- page detection */

  /**
   * Locate the sheet of paper inside `srcCanvas`.
   * Returns a quad in `srcCanvas` coordinates, or null when no confident
   * candidate was found (caller should then keep the full frame).
   *
   * Strategy: downsample, split light/dark with Otsu using the border as the
   * background reference, keep the largest connected region on the paper side,
   * take its convex hull, and read the corners off the hull.
   */
  /**
   * The detection core, on a plain luminance buffer: background reference,
   * threshold, mask, and the candidates those produce.
   *
   * Returns `{quad, paper, bg, thr, thr2, mode, scoreLoose, scoreStrict}` — the
   * chosen quad plus everything that decided it — or null when the frame is
   * refused. `JS.quadFromGray` is the entry point that callers want; this is
   * separate so a probe can see the losing candidate and the two scores rather
   * than only the winner.
   */
  function quadCandidates(gray, w, h) {
    // Background reference from the frame border: its mean, and its spread.
    var bs = 0, bss = 0, bn = 0, x, y, t, u;
    for (x = 0; x < w; x++) {
      t = gray[x]; u = gray[(h - 1) * w + x];
      bs += t + u; bss += t * t + u * u; bn += 2;
    }
    for (y = 0; y < h; y++) {
      t = gray[y * w]; u = gray[y * w + w - 1];
      bs += t + u; bss += t * t + u * u; bn += 2;
    }
    var bg = bs / bn;
    var bgSd = Math.sqrt(Math.max(0, bss / bn - bg * bg));

    var thr = JS.otsu(gray);
    // Otsu returns the last bin of the dark class: v <= thr is dark.
    var delta = Math.max(16, Math.abs(bg - thr) * 0.35);

    // A background is only a background if two things hold: the border is
    // *decisively* on one side of the split, and the border is *one material*.
    // Both are needed, and each catches a case the other misses.
    //
    // The margin alone would refuse the easiest frame there is. On a bright
    // sheet against a uniform dark field, Otsu puts the threshold on the
    // background value itself — that class *is* the background — so the margin
    // is zero by construction, and that is the ideal, not ambiguity.
    //
    // The spread alone would refuse a page that fills the frame, where the
    // border is legitimately part page and part background and its spread is
    // the largest of any fixture. There the margin is large and the background
    // is established despite the mixture.
    //
    // Together they catch the reported photo: a pale receipt on pale marble
    // held by a hand. Its border is marble, knuckle and shadow, so its spread
    // is 64.8 and its mean lands 1.3 levels from the split — the border is a
    // mixture *and* the mixture straddles the threshold, so "which side is the
    // paper on?" has no answer. The mask then selects whichever class is
    // opposite the border mean, and on this frame the largest region of that
    // class is the shadowed hand: the crop came back as 14% of the frame with
    // the receipt entirely outside it, reported as "Edges found".
    //
    // Measured across the fixtures, `margin` then `border sd`:
    //
    //     receipt on a desk            82.0    0.0     keep
    //     page on a floor              85.0    0.0     keep
    //     page filling the frame       43.8   74.4     keep
    //     sheet on a dark field         0.0    0.0     keep
    //     receipt on marble, in hand    1.3   64.8     refuse
    //
    // The bar for both is `delta`, which is not arbitrary here: it is already
    // the least separation this function demands between a pixel and its
    // background. A border whose own pixels scatter by more than that makes
    // that test meaningless, and a border whose mean is nearer the split than
    // that has not established which side it is on.
    //
    // Refusing is the honest outcome, and the hint already knows how to report
    // it. The alternative is a confident crop of something that is not paper.
    if (Math.abs(bg - thr) < delta && bgSd >= delta) return null;

    var loose = candidateQuad(gray, w, h, thr, bg, delta);
    if (!loose) return null;

    // A second opinion, on the paper's own level rather than on the frame's
    // split — see `brightMode` for why those are different questions. It is only
    // ever *tried* when the first candidate succeeded: a frame whose only
    // answer is the strict mask is a frame where the loose mask found the wrong
    // object, and rescuing that case would be a new behaviour on every photo
    // that is refused today, which is not something this change is entitled to
    // decide. The refusals stay refusals.
    var hist = smoothHist(gray);
    var mode = brightMode(hist, gray.length, bg);
    var strict = null, thr2 = -1;
    if (mode > 0) {
      thr2 = modeValley(hist.sm, bg, mode);
      // Eight levels above the frame's split, or it is not a second opinion at
      // all — it is the same answer with rounding.
      if (thr2 > thr + 8) {
        // Thresholded on a blurred copy. At the paper's own level the print on
        // a receipt is far below the threshold, so the raw frame would give a
        // mask riddled with holes where the text is — and a mask with holes has
        // no usable outer silhouette, which is the only thing this wants from
        // it. Blurring pulls each stroke up to the paper around it.
        var br = Math.max(2, Math.round(Math.max(w, h) / 140));
        strict = candidateQuad(JS.blurGray(gray, w, h, br), w, h, thr2, bg, delta);

        // ...and the second threshold has to agree about which side of the
        // background the page is on.
        //
        // `candidateQuad` masks the class opposite `thr`, so a threshold that
        // moves far enough flips which class that is: the two candidates stop
        // being two estimates of one boundary and become two different answers
        // to "where is the paper?", the strict one being the background's own
        // neighbourhood. That is the polarity question the guard above exists
        // for, and a second threshold is perfectly capable of walking back into
        // it — the mode it is built on can be the top of the background's own
        // distribution rather than a level the background does not reach.
        //
        // Seen on smoke.js's mixed-tone frame: background 175.0, split 165,
        // mode 251. The loose mask took everything below 159 (the shaded hand);
        // the strict threshold at 215 flipped the background to "dark" and took
        // everything above 215 (the counter and the receipt). Two disjoint
        // objects, each confident, and the score preferred the second one —
        // which is precisely the reported crop-a-hand bug arriving by a new
        // route. No fixture reaches this; the polarity guard refuses that frame
        // before either candidate exists. It is a guard on the *new* path.
        if (strict && strict.light !== loose.light) strict = null;
      }
    }

    var scoreLoose = scoreQuad(gray, w, h, loose.quad, loose.paper, bg);
    var scoreStrict = strict ? scoreQuad(gray, w, h, strict.quad, strict.paper, bg)
                             : -Infinity;
    var pick = strict && scoreStrict > scoreLoose + SWITCH_MARGIN ? strict : loose;
    return {
      quad: pick.quad, paper: pick.paper, bg: bg,
      thr: thr, thr2: thr2, mode: mode,
      scoreLoose: scoreLoose, scoreStrict: scoreStrict,
      // Both candidates, not just the winner. "The crop changed" and "the crop
      // changed *because the other mask won*" are different findings, and the
      // loser is the only thing that tells them apart.
      looseQuad: loose.quad, strictQuad: strict ? strict.quad : null
    };
  };

  // How much better the strict candidate has to be before it displaces the
  // frame-split one. Measured rather than guessed: see tests/tmp/quad_probe.py,
  // which prints both scores for every fixture and every reported photo. The
  // margin exists because the loose candidate is the one the app has shipped and
  // is therefore the prior — swapping the crop on a photo that is already right
  // is a regression even when the new answer also looks reasonable.
  var SWITCH_MARGIN = 25;

  JS.quadCandidates = quadCandidates;

  /**
   * The detection core, on a plain luminance buffer.
   * Returns a quad in `gray` coordinates (TL, TR, BR, BL) or null.
   *
   * The finding is `quadCandidates`; this is the entry point, and it is thin on
   * purpose. Corner settling was the other half of this function for a while and
   * is gone — see the note above `JS.sideSpans` for why.
   */
  JS.quadFromGray = function (gray, w, h) {
    var c = quadCandidates(gray, w, h);
    return c ? c.quad : null;
  };

  JS.detectPageQuad = function (srcCanvas, workMax) {
    workMax = workMax || 420;
    var sw = srcCanvas.width, sh = srcCanvas.height;
    var s = Math.min(1, workMax / Math.max(sw, sh));
    var w = Math.max(24, Math.round(sw * s)), h = Math.max(24, Math.round(sh * s));

    var small = JS.makeCanvas(w, h, true);
    var g = JS.ctx2d(small, true);
    g.drawImage(srcCanvas, 0, 0, w, h);
    var gray = JS.toGray(g.getImageData(0, 0, w, h).data, w, h);

    var quad = JS.quadFromGray(gray, w, h);
    if (!quad) return null;

    // Back to full-resolution coordinates, with a small outward margin.
    var inv = 1 / s;
    quad = quad.map(function (p) { return { x: p.x * inv, y: p.y * inv }; });
    quad = expandQuad(quad, 0.012, sw, sh);

    // Bail out if the result is nearly the whole frame — no useful crop.
    if (JS.quadArea(quad) > sw * sh * 0.985) return null;
    return quad;
  };

  /* ------------------------------------------------------------- de-skew */

  /**
   * Estimate the residual tilt of the text, in degrees.
   *
   * Text lines produce a sharp peak in the horizontal projection profile when
   * they are level. So we rotate the ink and measure the profile variance,
   * coarse then fine, and take the angle that maximises it.
   *
   * The search spans the full range the Fine angle slider can express, so a
   * tilt this function declines to correct is one the slider cannot reach
   * either. It returns 0 both when the text is level and when the frame holds
   * no orientation to read — the caller has no way to tell those apart, and
   * rotating on a guess is worse than not rotating.
   *
   * Returns the angle by which the *image* should be rotated to level the text.
   */
  JS.estimateSkew = function (srcCanvas, workMax) {
    workMax = workMax || 320;
    var sw = srcCanvas.width, sh = srcCanvas.height;
    var s = Math.min(1, workMax / Math.max(sw, sh));
    var w = Math.max(32, Math.round(sw * s)), h = Math.max(32, Math.round(sh * s));

    var small = JS.makeCanvas(w, h, true);
    var g = JS.ctx2d(small, true);
    g.drawImage(srcCanvas, 0, 0, w, h);
    var gray = JS.toGray(g.getImageData(0, 0, w, h).data, w, h);
    return JS.skewFromGray(gray, w, h);
  };

  /** The estimation core, on a plain luminance buffer. */
  JS.skewFromGray = function (gray, w, h) {
    var thr = JS.otsu(gray);
    var ink = new Uint8Array(w * h);
    var inkCount = 0;
    for (var i = 0; i < ink.length; i++) {
      if (gray[i] <= thr) { ink[i] = 1; inkCount++; }
    }
    // Too little or far too much ink means the projection profile is noise.
    var frac = inkCount / ink.length;
    if (frac < 0.004 || frac > 0.55) return 0;

    var cx = w / 2, cy = h / 2;
    var rows = new Float64Array(h);

    function profileVariance(deg) {
      var rad = deg * Math.PI / 180;
      var cs = Math.cos(rad), sn = Math.sin(rad);
      rows.fill(0);
      for (var y = 0; y < h; y++) {
        var dy = y - cy;
        for (var x = 0; x < w; x++) {
          if (!ink[y * w + x]) continue;
          var dx = x - cx;
          // Rotate the point by +deg, then bin it by its new row.
          // (Rotation matrix [[c,-s],[s,c]] applied to (dx,dy).)
          var ry = (dx * sn + dy * cs + cy) | 0;
          if (ry >= 0 && ry < h) rows[ry]++;
        }
      }
      var mean = 0, k;
      for (k = 0; k < h; k++) mean += rows[k];
      mean /= h;
      var v = 0;
      for (k = 0; k < h; k++) { var d = rows[k] - mean; v += d * d; }
      return v;
    }

    // The coarse scan spans the whole range the slider can express. It used to
    // stop at 8, which put a page tilted 9 or 12 degrees beyond the search: the
    // score rose to the bound and the answer came back as 8, a correction that
    // leaves most of the tilt in place. Widening it is not a way to find more
    // tilts in noise, because the shape that matters is not the maximum but
    // *where* it sits.
    var LIMIT = 15;
    var best = 0, bestScore = -1, minScore = Infinity, a;
    for (a = -LIMIT; a <= LIMIT; a += 1) {
      var sc = profileVariance(a);
      if (sc > bestScore) { bestScore = sc; best = a; }
      if (sc < minScore) minScore = sc;
    }

    // A peak sitting on the edge of the scan is not a peak, it is the scan
    // ending. Measured on uniform noise the curve is monotone from the centre
    // out to +-15: the maximum walks to the bound however wide the search is
    // made. An optimum at the bound means either no orientation at all or a
    // tilt at or past the slider's limit, and neither is something this can
    // correct. Both get 0.
    if (best === -LIMIT || best === LIMIT) return 0;

    // The peak also has to *be* a peak. Where there is real line structure,
    // turning fifteen degrees off alignment collapses the score to a few
    // percent of its height — so a curve whose own minimum is a large fraction
    // of its maximum has no alignment in it, whatever its maximum happens to
    // be. The four photos this was measured against (dense receipts, a cast
    // shadow, busy content) keep variance at every angle: their curves bottom
    // out at 0.49-0.75 of their height, so the winning angle is only whichever
    // way the drift leaned, and an upright page came back at -10.2 degrees.
    // Curves that really align bottom out at 0.05-0.12. Refuse the broad ones:
    // leaving a page slightly tilted is recoverable with the Fine angle slider
    // or the corner handles, and rotating an upright page is not.
    if (minScore > bestScore * 0.25) return 0;

    // `best` moves inside this loop, so it cannot also be the loop's own limit:
    // `a <= best + 1` re-reads the bound every iteration and the scan chases
    // itself. On the failing photo that ran 63 iterations instead of 11 and
    // walked the answer out to 18.4 degrees, which the caller's clamp turned
    // into a flat -15.00 — a confident wild rotation invented from a profile
    // that had no peak in it. Pin the centre first.
    var centre = best;
    for (a = centre - 1; a <= centre + 1; a += 0.2) {
      var sc2 = profileVariance(a);
      if (sc2 > bestScore) { bestScore = sc2; best = a; }
    }

    // The profile peaks when the *rotated* text is level, so the correction is
    // the negative of the angle that produced the peak.
    var correction = -best;
    if (Math.abs(correction) < 0.15) correction = 0;
    return JS.clamp(correction, -15, 15);
  };

})(window.JS);
