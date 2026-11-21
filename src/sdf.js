/* Spectra — src/sdf.js
 * window.SpectraSDF : source (SVG text | image Blob | text) -> signed distance field.
 *
 * Pipeline
 *   main thread : sanitise / rasterise the source with antialiasing, centred, longest half-extent
 *                 = 0.78 of the field. Vector sources (SVG, text) are rendered for real at
 *                 R = k*size (k = 4 by default, R clamped to [2048, 4096]); raster images are
 *                 processed at their own resolution (no information is gained by upsampling).
 *   worker      : anti-aliased exact EDT, result at `size` x `size` in logo units.
 *
 * EDT (single pass for inside + outside)
 *   1. every boundary pixel becomes a "site" carrying a sub-pixel edge point and an outward normal:
 *        vector sources -> Gustavson & Strand area-coverage edge model (3x3 gradient + coverage)
 *        raster images  -> 0.5 iso-line of a lightly blurred coverage, secant-refined on the
 *                          bilinear interpolant (robust to JPEG ringing / chroma blocks)
 *   2. exact Felzenszwalb-Huttenlocher EDT (binary column scans + parabola lower envelope per
 *      row) finds the nearest site of the raster samples bracketing each output pixel centre;
 *   3. each output sample is the exact distance from the output pixel centre to the nearest of
 *      the short tangent edge segments of the candidate sites (own + 8 neighbours' winners),
 *      sign from coverage. Exact for locally straight edges -> sub-pixel smooth zero crossing,
 *      |grad d| = 1, no stair-stepping. (This is the value a k x k box average of a full-res
 *      field converges to, without its O(R^2) cost.)
 *   4. raster images: Catmull-Rom (C1) resample of the source-resolution field to `size`.
 *   5. optional 3x3 smoothing blended in only where |d| > 1.5 output px (zero crossing untouched).
 */
(function (global) {
  'use strict';

  /* =====================================================================================
   * Worker core — fully self-contained (stringified into a Blob worker). Returns the
   * computeField function when called outside a worker (main-thread fallback).
   * ===================================================================================== */
  function spectraSdfWorkerMain() {
    'use strict';
    var SQ2 = Math.SQRT2;
    var HALF_SEG = 0.75; // half-length (raster px) of the edge segment attached to each site

    // large scratch buffers are pooled across jobs (avoids 10s of MB of garbage -> GC pauses)
    var pool = {};
    function buf(name, Ctor, len) {
      var b = pool[name];
      if (!b || b.length !== len) { b = pool[name] = new Ctor(len); }
      return b;
    }

    function now() {
      return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    }

    // Gustavson & Strand: distance from pixel centre to the edge, given the (unnormalised)
    // coverage gradient and the area coverage a in [0,1]. Positive when the centre is outside.
    function edgeDf(gx, gy, a) {
      if (gx === 0 || gy === 0) return 0.5 - a;
      var gl = Math.sqrt(gx * gx + gy * gy);
      gx = Math.abs(gx / gl); gy = Math.abs(gy / gl);
      if (gx < gy) { var t = gx; gx = gy; gy = t; }
      var a1 = 0.5 * gy / gx;
      if (a < a1) return 0.5 * (gx + gy) - Math.sqrt(2 * gx * gy * a);
      if (a < 1 - a1) return (0.5 - a) * gx;
      return -0.5 * (gx + gy) + Math.sqrt(2 * gx * gy * (1 - a));
    }

    /**
     * cov  : Uint8Array R*R coverage (255 = inside), row 0 = top
     * R    : raster size (integer multiple of size)
     * size : output size
     * opts : { smooth: bool }
     *
     * Cost is O(R^2) only for a cheap word-skipping boundary scan; the EDT proper runs on the
     * 2*size raster rows that bracket output pixel centres (O(size*R)), and every output sample
     * is an exact distance evaluated at the output pixel centre against the nearest edge segments.
     */
    function computeField(cov, R, size, opts) {
      opts = opts || {};
      var t0 = now();
      var k = R / size;
      if (k !== Math.floor(k) || k < 1) throw new Error('SpectraSDF: raster must be an integer multiple of size');
      var N = R * R, x, y, i, row, a, j, s;

      // guarantee an empty 1px frame (the shape never gets there; keeps neighbour reads in range)
      for (x = 0; x < R; x++) { cov[x] = 0; cov[N - R + x] = 0; }
      for (y = 0; y < R; y++) { cov[y * R] = 0; cov[y * R + R - 1] = 0; }

      if (opts.edgeModel === 'iso') { blur3(cov, R); blur3(cov, R); }

      // ---- 1. boundary sites (row-major order) ------------------------------------------
      var cap = 1 << 16, list = new Int32Array(cap), n = 0;
      var rowStart = new Int32Array(R + 1);
      var u32 = (R & 3) === 0 && (cov.byteOffset & 3) === 0 ? new Uint32Array(cov.buffer, cov.byteOffset, N >> 2) : null;
      var W4 = R >> 2;
      for (y = 1; y < R - 1; y++) {
        row = y * R;
        rowStart[y] = n;
        x = 1;
        while (x < R - 1) {
          if (u32 && (x & 3) === 0 && x + 4 < R) {
            var wi = (row >> 2) + (x >> 2), c = u32[wi];
            if ((c === 0 || c === 0xFFFFFFFF) && u32[wi - W4] === c && u32[wi + W4] === c) {
              var cb = c & 255;
              if (cov[row + x - 1] === cb && cov[row + x + 4] === cb) { x += 4; continue; }
            }
          }
          i = row + x;
          a = cov[i];
          if (a === 0) {
            if (!(cov[i - 1] === 255 || cov[i + 1] === 255 || cov[i - R] === 255 || cov[i + R] === 255)) { x++; continue; }
          } else if (a === 255) {
            if (!(cov[i - 1] === 0 || cov[i + 1] === 0 || cov[i - R] === 0 || cov[i + R] === 0)) { x++; continue; }
          }
          if (n === cap) { var nl = new Int32Array(cap * 2); nl.set(list); list = nl; cap *= 2; }
          list[n++] = i;
          x++;
        }
      }
      rowStart[R - 1] = n; rowStart[R] = n; rowStart[0] = 0;
      if (n === 0) throw new Error('SpectraSDF: the source contains no visible shape');

      // ---- 2. site geometry: sub-pixel edge point + outward normal (+ bbox) -------------
      var ex = new Float32Array(n), ey = new Float32Array(n);
      var nx = new Float32Array(n), ny = new Float32Array(n), hl = new Float32Array(n);
      var qx = new Int32Array(n), qy = new Int32Array(n);
      var colMax = new Uint8Array(R), rowMax = new Uint8Array(R);
      var iso = opts.edgeModel === 'iso', m2 = 0;
      for (var jl = 0; jl < n; jl++) {
        i = list[jl];
        y = (i / R) | 0; x = i - y * R;
        a = cov[i];
        if (a > colMax[x]) colMax[x] = a;
        if (a > rowMax[y]) rowMax[y] = a;
        if (iso) {
          // noisy / soft-ramp sources: first-order (Newton) estimate of the 0.5 iso-line from the
          // central-difference gradient; only pixels within 1 px of the iso-line become sites,
          // so ringing / grain away from the iso-line is ignored
          var cgx = (cov[i + 1] - cov[i - 1]) * 0.5, cgy = (cov[i + R] - cov[i - R]) * 0.5;
          var cgl = Math.sqrt(cgx * cgx + cgy * cgy);
          if (cgl < 6) continue;                     // < ~0.024 coverage / px : noise
          var dq = (a - 127.5) / cgl;                // px from the iso-line, >0 inside
          if (dq > 1 || dq < -1) continue;
          j = m2++;
          qx[j] = x; qy[j] = y;
          var iux = cgx / cgl, iuy = cgy / cgl;
          // refine along the gradient direction with secant steps on the bilinear interpolant
          var ePx = x - iux * dq, ePy = y - iuy * dq;
          for (var it = 0; it < 3; it++) {
            var a0 = bilin(cov, R, ePx, ePy);
            var sl = bilin(cov, R, ePx + 0.5 * iux, ePy + 0.5 * iuy) - bilin(cov, R, ePx - 0.5 * iux, ePy - 0.5 * iuy);
            if (sl < 3) break;
            var st = (a0 - 127.5) / sl;
            if (st > 0.5) st = 0.5; else if (st < -0.5) st = -0.5;
            ePx -= iux * st; ePy -= iuy * st;
            if (st < 0.002 && st > -0.002) break;
          }
          ex[j] = ePx; ey[j] = ePy;
          nx[j] = -iux; ny[j] = -iuy; hl[j] = HALF_SEG;
          continue;
        }
        j = m2++;
        qx[j] = x; qy[j] = y;
        var gx = (cov[i - R + 1] + SQ2 * cov[i + 1] + cov[i + R + 1]) - (cov[i - R - 1] + SQ2 * cov[i - 1] + cov[i + R - 1]);
        var gy = (cov[i + R - 1] + SQ2 * cov[i + R] + cov[i + R + 1]) - (cov[i - R - 1] + SQ2 * cov[i - R] + cov[i - R + 1]);
        var gl = Math.sqrt(gx * gx + gy * gy);
        if (gl < 1e-3) { // degenerate: a point at the pixel centre
          ex[j] = x; ey[j] = y; nx[j] = 1; ny[j] = 0; hl[j] = 0;
        } else {
          var ux = gx / gl, uy = gy / gl;          // inward (towards higher coverage)
          var df = edgeDf(gx, gy, a / 255);        // >0 : centre outside
          ex[j] = x + ux * df; ey[j] = y + uy * df;
          nx[j] = -ux; ny[j] = -uy; hl[j] = HALF_SEG;
        }
      }
      list = null;
      if (m2 !== n) { // compacted (iso model): rebuild the per-row index
        n = m2;
        if (n === 0) throw new Error('SpectraSDF: the source contains no visible shape');
        rowStart.fill(0);
        for (j = 0; j < n; j++) rowStart[qy[j] + 1]++;
        for (y = 0; y < R; y++) rowStart[y + 1] += rowStart[y];
      }
      var bx0 = -1, bx1 = -1, by0 = -1, by1 = -1;
      for (x = 0; x < R; x++) if (colMax[x]) { if (bx0 < 0) bx0 = x; bx1 = x; }
      for (y = 0; y < R; y++) if (rowMax[y]) { if (by0 < 0) by0 = y; by1 = y; }
      var half = R / 2;
      var left = bx0 + 1 - colMax[bx0] / 255, right = bx1 + colMax[bx1] / 255;
      var top = by0 + 1 - rowMax[by0] / 255, bottom = by1 + rowMax[by1] / 255;
      if (iso) { // blurred coverage: take the bbox of the iso-line points instead
        left = top = Infinity; right = bottom = -Infinity;
        for (j = 0; j < n; j++) {
          if (ex[j] < left) left = ex[j]; if (ex[j] > right) right = ex[j];
          if (ey[j] < top) top = ey[j]; if (ey[j] > bottom) bottom = ey[j];
        }
        left += 0.5; right += 0.5; top += 0.5; bottom += 0.5;
      }
      var extent = [(right - left) / 2 / half, (bottom - top) / 2 / half];
      var centre = [((left + right) / 2 - half) / half, ((top + bottom) / 2 - half) / half];
      var t1 = now();

      // ---- 3. output sample positions and the raster rows / columns bracketing them ------
      // output pixel j has its centre at raster pixel-centre coordinate k*j + (k-1)/2
      var off = (k - 1) / 2, fl = Math.floor(off), ce = Math.ceil(off);
      var nxs = fl === ce ? 1 : 2;                     // samples per axis per output pixel
      var rowsPer = 1;                               // one bracketing row suffices (neighbour refinement below)
      var refineR = (opts.refinePx > 0 ? opts.refinePx : 1e9) * k; // neighbour refinement radius (raster px)
      var flr = rowsPer === 1 ? ce : fl;
      var slotOfRow = new Int32Array(R); slotOfRow.fill(-1);
      var nSlots = 0;
      for (i = 0; i < size; i++) {
        slotOfRow[k * i + flr] = nSlots++;
        if (rowsPer === 2) slotOfRow[k * i + ce] = nSlots++;
      }
      var qxPos = new Int32Array(size * nxs);           // queried raster columns, increasing
      for (j = 0; j < size; j++) { qxPos[j * nxs] = k * j + fl; if (nxs === 2) qxPos[j * nxs + 1] = k * j + ce; }
      var nq = size * nxs;

      // ---- 4. column pass (forward/backward scans over site rows only) -----------------
      var fwd = buf('fwd', Int32Array, nSlots * R);
      var last = new Int32Array(R); last.fill(-1);
      for (y = 0; y < R; y++) {
        for (s = rowStart[y]; s < rowStart[y + 1]; s++) last[qx[s]] = s;
        var sl = slotOfRow[y];
        if (sl >= 0) fwd.set(last, sl * R);
      }
      var t2 = now();

      // ---- 5. backward scan + per-row parabola lower envelope (Felzenszwalb-Huttenlocher)
      var win = buf('win', Int32Array, nSlots * nq);
      var v = new Int32Array(R), gq = new Float64Array(R), z = new Float64Array(R + 1);
      var colBest = new Int32Array(R);
      var INF = Infinity;
      last.fill(-1);
      for (y = R - 1; y >= 0; y--) {
        for (s = rowStart[y]; s < rowStart[y + 1]; s++) last[qx[s]] = s;
        var slot = slotOfRow[y];
        if (slot < 0) continue;
        var fo = slot * R, kk = -1, sx, r, gxv, dyy, b, f;
        for (x = 0; x < R; x++) {
          f = fwd[fo + x]; b = last[x];
          if (f < 0) s = b; else if (b < 0) s = f; else s = (qy[b] - y) < (y - qy[f]) ? b : f;
          colBest[x] = s;
          if (s < 0) continue;
          dyy = y - qy[s];
          gxv = dyy * dyy + x * x;
          if (kk < 0) { kk = 0; v[0] = x; gq[0] = gxv; z[0] = -INF; z[1] = INF; continue; }
          for (;;) {
            r = v[kk];
            sx = (gxv - gq[kk]) / (2 * (x - r));
            if (sx <= z[kk]) kk--; else break;   // z[0] = -inf -> stops at kk = 0
          }
          kk++; v[kk] = x; gq[kk] = gxv; z[kk] = sx; z[kk + 1] = INF;
        }
        var wo = slot * nq, jj = 0;
        for (var q = 0; q < nq; q++) {
          var xq = qxPos[q];
          while (z[jj + 1] < xq) jj++;
          win[wo + q] = colBest[v[jj]];
        }
      }
      var t3 = now();

      // ---- 6. exact evaluation at output pixel centres --------------------------------
      // candidates: the nearest-site winners of the raster samples around this output pixel
      // and of its 8 neighbours (cheap propagation that fixes grid-vs-subpixel nearest flips)
      var out = new Float32Array(size * size);
      var inv = 1 / half;
      var cs = new Int32Array(64);
      for (i = 0; i < size; i++) {
        var py = k * i + off, ry = Math.round(py);
        var ia = i > 0 ? i - 1 : 0, ib = i < size - 1 ? i + 1 : size - 1;
        var sA = slotOfRow[k * ia + ce] * nq, sB = slotOfRow[k * i + flr] * nq, sC = slotOfRow[k * i + ce] * nq, sD = slotOfRow[k * ib + ce] * nq;
        for (j = 0; j < size; j++) {
          var px = k * j + off, rx = Math.round(px);
          var ja = (j > 0 ? j - 1 : 0) * nxs + nxs - 1, jb = j * nxs, jc = j * nxs + nxs - 1, jd = (j < size - 1 ? j + 1 : size - 1) * nxs + nxs - 1;
          var nc = 0;
          // centre block first (the winners at this sample), then - near the edge only - the
          // winners of the 8 neighbouring samples
          cs[nc++] = win[sC + jc]; cs[nc++] = win[sC + jb]; cs[nc++] = win[sB + jc]; cs[nc++] = win[sB + jb];
          var bestM = INF, bestDl = 0, ci = 0, e0 = -1, e1 = -1, e2 = -1;
          for (var pass = 0; pass < 2; pass++) {
            for (; ci < nc; ci++) {
              var cand = cs[ci];
              if (cand === e0 || cand === e1 || cand === e2) continue; // cheap de-duplication
              e2 = e1; e1 = e0; e0 = cand;
              var dxp = px - ex[cand], dyp = py - ey[cand], nxc = nx[cand], nyc = ny[cand];
              var dl = dxp * nxc + dyp * nyc;
              var tt = Math.abs(dxp * nyc - dyp * nxc) - hl[cand];
              var m = tt > 0 ? Math.sqrt(dl * dl + tt * tt) : (dl < 0 ? -dl : dl);
              if (m < bestM) { bestM = m; bestDl = dl; }
            }
            if (pass === 1 || bestM > refineR) break;
            cs[nc++] = win[sA + ja]; cs[nc++] = win[sA + jc]; cs[nc++] = win[sA + jd];
            cs[nc++] = win[sC + ja]; cs[nc++] = win[sC + jd];
            cs[nc++] = win[sD + ja]; cs[nc++] = win[sD + jc]; cs[nc++] = win[sD + jd];
          }
          var cv = cov[ry * R + rx];
          // a fully covered / empty raster pixel contains the sample point -> unambiguous sign
          var neg = cv === 255 ? true : cv === 0 ? false : bestDl < 0;
          out[i * size + j] = (neg ? -bestM : bestM) * inv;
        }
      }
      var t4 = now();

      // ---- 7. optional gentle smoothing away from the edge ------------------------------
      if (opts.smooth !== false) out = smoothAwayFromEdge(out, size);
      var mn = 0, M = size * size;
      for (i = 0; i < M; i++) if (out[i] < mn) mn = out[i];
      var t5 = now();
      return {
        data: out,
        maxInset: -mn,
        extent: extent,
        centre: centre,
        sites: n,
        debugSites: opts.debugSites ? { ex: ex, ey: ey, nx: nx, ny: ny, hl: hl, k: k, R: R } : undefined,
        timings: { sites: t1 - t0, columns: t2 - t1, rows: t3 - t2, evaluate: t4 - t3, finish: t5 - t4, total: t5 - t0 }
      };
    }

    function bilin(c, R, x, y) {
      var x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * R + x0;
      var a = c[i] + (c[i + 1] - c[i]) * fx, b = c[i + R] + (c[i + R + 1] - c[i + R]) * fx;
      return a + (b - a) * fy;
    }

    // in-place 3x3 binomial blur of a Uint8 raster (separable, rounded)
    function blur3(c, R) {
      var tmp = new Uint16Array(R * R), x, y, i;
      for (y = 0; y < R; y++) for (x = 1; x < R - 1; x++) { i = y * R + x; tmp[i] = c[i - 1] + 2 * c[i] + c[i + 1]; }
      for (y = 1; y < R - 1; y++) for (x = 1; x < R - 1; x++) { i = y * R + x; c[i] = (tmp[i - R] + 2 * tmp[i] + tmp[i + R] + 8) >> 4; }
    }

    // 3x3 binomial blur blended in only where |d| > 1.5 output px (fully beyond 3 px), so the
    // zero crossing and the bevel band are untouched; it only softens medial-axis creases.
    function smoothAwayFromEdge(d, size) {
      var o = new Float32Array(d.length);
      var px = 2 / size, lo = 1.5 * px, hi = 3.0 * px;
      for (var y = 0; y < size; y++) {
        var y0 = y > 0 ? y - 1 : 0, y1 = y < size - 1 ? y + 1 : size - 1;
        for (var x = 0; x < size; x++) {
          var i = y * size + x, c = d[i], ac = c < 0 ? -c : c;
          if (ac <= lo) { o[i] = c; continue; }
          var x0 = x > 0 ? x - 1 : 0, x1 = x < size - 1 ? x + 1 : size - 1;
          var r0 = y0 * size, r1 = y * size, r2 = y1 * size;
          var bl = (d[r0 + x0] + 2 * d[r0 + x] + d[r0 + x1] +
            2 * d[r1 + x0] + 4 * c + 2 * d[r1 + x1] +
            d[r2 + x0] + 2 * d[r2 + x] + d[r2 + x1]) / 16;
          var t = (ac - lo) / (hi - lo); if (t > 1) t = 1;
          t = t * t * (3 - 2 * t);
          o[i] = c + (bl - c) * t;
        }
      }
      return o;
    }

    // RGBA (canvas ImageData bytes) -> coverage (alpha channel)
    function alphaFromRGBA(rgba) {
      var n = rgba.byteLength >> 2;
      var u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
      var cov = buf('cov', Uint8Array, n);
      for (var i = 0; i < n; i++) cov[i] = u32[i] >>> 24; // little-endian RGBA -> A
      return cov;
    }
    function run(msg) {
      var cov = msg.cov ? new Uint8Array(msg.cov) : alphaFromRGBA(new Uint8Array(msg.rgba));
      var o = msg.opts || {};
      if (!o.domain) return computeField(cov, msg.R, msg.size, o);
      // raster-image path: field at source resolution, then Catmull-Rom resample to `size`
      var t0 = now(), D = o.domain, S = D.S, size = msg.size;
      var res = computeField(cov, S, S, { smooth: false, edgeModel: o.edgeModel });
      var src = res.data, toLogo = (S / 2) / D.unit;
      var out = new Float32Array(size * size);
      var ix = new Int32Array(size * 4), wx = new Float64Array(size * 4);
      for (var j = 0; j < size; j++) {
        var X = D.cx + ((j + 0.5) / size * 2 - 1) * D.unit - 0.5, X0 = Math.floor(X), t = X - X0;
        crWeights(t, wx, j * 4);
        for (var q = 0; q < 4; q++) { var xi = X0 - 1 + q; ix[j * 4 + q] = xi < 0 ? 0 : xi > S - 1 ? S - 1 : xi; }
      }
      var wy = new Float64Array(4), mn = 0;
      for (var i = 0; i < size; i++) {
        var Y = D.cy + ((i + 0.5) / size * 2 - 1) * D.unit - 0.5, Y0 = Math.floor(Y);
        crWeights(Y - Y0, wy, 0);
        var r0 = Math.min(Math.max(Y0 - 1, 0), S - 1) * S, r1 = Math.min(Math.max(Y0, 0), S - 1) * S;
        var r2 = Math.min(Math.max(Y0 + 1, 0), S - 1) * S, r3 = Math.min(Math.max(Y0 + 2, 0), S - 1) * S;
        for (j = 0; j < size; j++) {
          var b = j * 4, acc = 0;
          for (q = 0; q < 4; q++) {
            var xx = ix[b + q];
            acc += wx[b + q] * (wy[0] * src[r0 + xx] + wy[1] * src[r1 + xx] + wy[2] * src[r2 + xx] + wy[3] * src[r3 + xx]);
          }
          acc *= toLogo;
          out[i * size + j] = acc;
        }
      }
      if (o.smooth !== false) out = smoothAwayFromEdge(out, size);
      for (i = 0; i < out.length; i++) if (out[i] < mn) mn = out[i];
      var cpx = res.centre[0] * (S / 2) + S / 2, cpy = res.centre[1] * (S / 2) + S / 2;
      var tt = res.timings; tt.resample = now() - t0 - tt.total; tt.total = now() - t0;
      return {
        data: out, maxInset: -mn, sites: res.sites, timings: tt,
        extent: [res.extent[0] * toLogo, res.extent[1] * toLogo],
        centre: [(cpx - D.cx) / D.unit, (cpy - D.cy) / D.unit]
      };
    }
    function crWeights(t, w, o) { // Catmull-Rom (C1, reproduces linear functions exactly)
      var t2 = t * t, t3 = t2 * t;
      w[o] = -0.5 * t3 + t2 - 0.5 * t;
      w[o + 1] = 1.5 * t3 - 2.5 * t2 + 1;
      w[o + 2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
      w[o + 3] = 0.5 * t3 - 0.5 * t2;
    }

    var isWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;
    if (isWorker) {
      self.onmessage = function (e) {
        var msg = e.data;
        if (!msg || msg.cmd !== 'edt') return;
        try {
          var res = run(msg);
          self.postMessage({ id: msg.id, ok: true, res: res }, [res.data.buffer]);
        } catch (err) {
          self.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
        }
      };
      self.postMessage({ ready: true });
    }
    return run;
  }

  /* =====================================================================================
   * Main thread
   * ===================================================================================== */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var XLINK_NS = 'http://www.w3.org/1999/xlink';
  var FILL_HALF = 0.78; // longest half-extent of the shape in logo units

  function now() { return (global.performance && performance.now) ? performance.now() : Date.now(); }

  // ---------- worker management ----------
  var localCompute = null;
  function computeLocal(msg) {
    if (!localCompute) localCompute = spectraSdfWorkerMain();
    return localCompute(msg);
  }

  var W = { promise: null, worker: null, jobs: new Map(), nextId: 1, broken: false };
  function getWorker() {
    if (W.broken || typeof Worker === 'undefined' || typeof Blob === 'undefined') return Promise.resolve(null);
    if (W.promise) return W.promise;
    W.promise = new Promise(function (resolve) {
      var w = null, url = null, settled = false, timer = 0;
      function fail() {
        if (settled) return;
        settled = true; W.broken = true;
        clearTimeout(timer);
        try { if (w) w.terminate(); } catch (e) { /* ignore */ }
        try { if (url) URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
        resolve(null);
      }
      try {
        var src = '(' + spectraSdfWorkerMain.toString() + ')();';
        url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        w = new Worker(url);
      } catch (e) { fail(); return; }
      timer = setTimeout(fail, 5000);
      w.onerror = function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        if (!settled) { fail(); return; }
        // runtime failure after start: fail pending jobs (they fall back to main thread)
        W.broken = true;
        var jobs = W.jobs; W.jobs = new Map();
        jobs.forEach(function (job) { job.reject(new Error('worker crashed')); });
      };
      w.onmessage = function (ev) {
        var m = ev.data;
        if (m && m.ready) {
          if (!settled) {
            settled = true; clearTimeout(timer);
            try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
            W.worker = w; resolve(w);
          }
          return;
        }
        var job = m && W.jobs.get(m.id);
        if (!job) return;
        W.jobs.delete(m.id);
        if (m.ok) job.resolve(m.res); else job.reject(new Error(m.error));
      };
    });
    return W.promise;
  }

  // ras = { rgba: Uint8ClampedArray (R*R*4) | cov: Uint8Array (R*R) }
  function runEDT(ras, R, size, opts) {
    var msg = { cmd: 'edt', R: R, size: size, opts: opts };
    var buf;
    if (ras.cov) { msg.cov = buf = ras.cov.buffer; } else { msg.rgba = buf = ras.rgba.buffer; }
    return getWorker().then(function (w) {
      if (!w) return computeLocal(msg);
      // the worker answered its ready ping, so transferring (not copying) the raster is safe
      return new Promise(function (resolve, reject) {
        msg.id = W.nextId++;
        W.jobs.set(msg.id, { resolve: resolve, reject: reject });
        w.postMessage(msg, [buf]);
      });
    });
  }

  // ---------- canvas helpers ----------
  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    return { c: c, ctx: ctx };
  }
  function releaseCanvas(cv) { cv.c.width = 0; cv.c.height = 0; }

  function rgbaOf(ctx, w, h) { return ctx.getImageData(0, 0, w, h).data; }
  function alphaOf(ctx, w, h) {
    var img = ctx.getImageData(0, 0, w, h);
    var u32 = new Uint32Array(img.data.buffer);
    var n = w * h, out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = u32[i] >>> 24; // little-endian RGBA -> A
    return out;
  }

  // bbox of coverage > thr with fractional edge refinement (pixel x spans [x, x+1])
  function covBBox(cov, w, h, thr) {
    thr = thr || 0;
    var colMax = new Uint8Array(w), rowMax = new Uint8Array(h);
    for (var y = 0; y < h; y++) {
      var row = y * w, rm = 0;
      for (var x = 0; x < w; x++) {
        var a = cov[row + x];
        if (a > thr) { if (a > rm) rm = a; if (a > colMax[x]) colMax[x] = a; }
      }
      rowMax[y] = rm;
    }
    var x0 = -1, x1 = -1, y0 = -1, y1 = -1, i;
    for (i = 0; i < w; i++) if (colMax[i]) { if (x0 < 0) x0 = i; x1 = i; }
    for (i = 0; i < h; i++) if (rowMax[i]) { if (y0 < 0) y0 = i; y1 = i; }
    if (x0 < 0 || y0 < 0) return null;
    return {
      x0: x0 + 1 - colMax[x0] / 255, x1: x1 + colMax[x1] / 255,
      y0: y0 + 1 - rowMax[y0] / 255, y1: y1 + rowMax[y1] / 255
    };
  }

  function loadImageFromSvgText(svgText) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
      var img = new Image();
      img.onload = function () {
        var done = function () { URL.revokeObjectURL(url); resolve(img); };
        if (img.decode) img.decode().then(done, done); else done();
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('SpectraSDF: the SVG could not be rendered')); };
      img.src = url;
    });
  }

  // ---------- SVG sanitising ----------
  var REMOVE_TAGS = {
    script: 1, foreignObject: 1, iframe: 1, object: 1, embed: 1, audio: 1, video: 1, canvas: 1,
    animate: 1, animateMotion: 1, animateTransform: 1, animateColor: 1, set: 1, discard: 1, 'handler': 1
  };
  var SKIP_TAGS = { // subtrees whose paint must not be touched
    mask: 1, clipPath: 1, pattern: 1, linearGradient: 1, radialGradient: 1, filter: 1,
    metadata: 1, title: 1, desc: 1, style: 1, meshgradient: 1, hatch: 1
  };
  var DEFS_TAGS = { defs: 1, symbol: 1, marker: 1 }; // only override explicitly specified paint
  var SHAPE_TAGS = { path: 1, rect: 1, circle: 1, ellipse: 1, polygon: 1, polyline: 1, line: 1, text: 1, use: 1, image: 1 };

  function cleanCssUrls(s) {
    return String(s)
      .replace(/@import[^;]*;?/gi, '')
      .replace(/url\(\s*(['"]?)\s*(?:https?:|\/\/|file:|javascript:)[^)]*\)/gi, 'none');
  }

  function scrub(root) {
    var all = [root].concat(Array.prototype.slice.call(root.getElementsByTagName('*')));
    for (var e = 0; e < all.length; e++) {
      var el = all[e];
      if (REMOVE_TAGS[el.localName]) { if (el.parentNode) el.parentNode.removeChild(el); continue; }
      if (el.localName === 'style') { el.textContent = cleanCssUrls(el.textContent); }
      var attrs = Array.prototype.slice.call(el.attributes);
      for (var a = 0; a < attrs.length; a++) {
        var nm = attrs[a].name, val = attrs[a].value, low = nm.toLowerCase();
        if (low.indexOf('on') === 0) { el.removeAttribute(nm); continue; }
        if (low === 'href' || low === 'xlink:href' || /:href$/.test(low)) {
          var vt = val.trim();
          if (!(vt.charAt(0) === '#' || /^data:image\//i.test(vt))) el.removeAttributeNode(attrs[a]);
          continue;
        }
        if (low === 'style') el.setAttribute('style', cleanCssUrls(val));
      }
    }
  }

  function parseSvgRoot(text) {
    text = String(text).replace(/^﻿/, '').trim();
    var parser = new DOMParser();
    function tryXml(t) {
      var doc = parser.parseFromString(t, 'image/svg+xml');
      var r = doc.documentElement;
      if (!r || doc.getElementsByTagName('parsererror').length) return null;
      if (r.localName !== 'svg' || r.namespaceURI !== SVG_NS) return null;
      return r;
    }
    var root = tryXml(text);
    if (!root) {
      var t2 = text;
      if (!/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(t2)) t2 = t2.replace(/<svg\b/i, '<svg xmlns="' + SVG_NS + '"');
      if (/xlink:/.test(t2) && !/xmlns:xlink/.test(t2)) t2 = t2.replace(/<svg\b/i, '<svg xmlns:xlink="' + XLINK_NS + '"');
      root = tryXml(t2);
    }
    if (!root) { // forgiving HTML parser as last resort (entities, sloppy markup)
      var hd = parser.parseFromString(text, 'text/html');
      var s = hd.querySelector('svg');
      if (s && s.namespaceURI === SVG_NS) root = s;
    }
    if (!root) throw new Error('SpectraSDF: could not parse the SVG');
    return root;
  }

  var LEN_UNITS = { '': 1, px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, 'in': 96, em: 16, rem: 16, ex: 8 };
  function parseLen(v) {
    if (v == null) return NaN;
    var m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(String(v));
    if (!m) return NaN;
    var f = LEN_UNITS[m[2].toLowerCase()];
    return f ? parseFloat(m[1]) * f : NaN;
  }
  function parseViewBox(v) {
    if (!v) return null;
    var p = String(v).trim().split(/[\s,]+/).map(Number);
    if (p.length !== 4 || p.some(function (q) { return !isFinite(q); }) || p[2] <= 0 || p[3] <= 0) return null;
    return p;
  }

  function isNonePaint(v) {
    if (!v || v === 'none' || v === 'transparent') return true;
    var m = /^rgba\(([^)]*)\)$/.exec(v);
    if (m) { var parts = m[1].split(/[\s,\/]+/).filter(Boolean); return parseFloat(parts[3]) === 0; }
    return false;
  }

  // Inserts the SVG into an isolated shadow tree, resolves styles, forces a black silhouette and
  // returns serialisers for the measuring pass and the final pass.
  function prepareSVG(text) {
    var parsed = parseSvgRoot(text);
    scrub(parsed);
    var host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1;';
    var container = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var live = document.importNode(parsed, true);
    container.appendChild(live);
    (document.body || document.documentElement).appendChild(host);
    var notes = [];
    try {
      // remove root sizing styles that would fight the attributes
      ['width', 'height', 'max-width', 'max-height', 'min-width', 'min-height', 'transform', 'background', 'background-color']
        .forEach(function (p) { live.style.removeProperty(p); });

      // --- viewBox ---
      var vb = parseViewBox(live.getAttribute('viewBox'));
      if (!vb) {
        var w = parseLen(live.getAttribute('width')), h = parseLen(live.getAttribute('height'));
        if (w > 0 && h > 0) { vb = [0, 0, w, h]; notes.push('viewBox derived from width/height'); }
      }
      if (!vb) {
        live.setAttribute('width', '1000'); live.setAttribute('height', '1000');
        var bb = null;
        try { bb = live.getBBox(); } catch (e) { bb = null; }
        if (!bb || !(bb.width > 0 || bb.height > 0)) throw new Error('SpectraSDF: SVG has no size and no measurable content');
        var pad = 0.2 * Math.max(bb.width, bb.height) + 4;
        vb = [bb.x - pad, bb.y - pad, bb.width + 2 * pad, bb.height + 2 * pad];
        notes.push('viewBox derived from content bbox');
      }
      var fitS = 512 / Math.max(vb[2], vb[3]);
      live.setAttribute('viewBox', vb.join(' '));
      live.setAttribute('width', String(Math.max(1, vb[2] * fitS)));
      live.setAttribute('height', String(Math.max(1, vb[3] * fitS)));
      live.setAttribute('preserveAspectRatio', 'none');

      // --- read phase (all computed styles first, then write: avoids style-recalc thrash) ---
      var items = [];
      (function walk(el, mode) {
        var ln = el.localName;
        if (SKIP_TAGS[ln]) return;
        var m = mode || (DEFS_TAGS[ln] ? 'defs' : null);
        items.push({ el: el, mode: m, cs: null });
        for (var c = el.firstElementChild; c; c = c.nextElementSibling) walk(c, m);
      })(live, null);
      for (var q = 0; q < items.length; q++) {
        var cs = getComputedStyle(items[q].el);
        items[q].fill = cs.fill; items[q].stroke = cs.stroke;
        items[q].fo = parseFloat(cs.fillOpacity); items[q].so = parseFloat(cs.strokeOpacity);
        items[q].op = parseFloat(cs.opacity);
        items[q].sw = parseFloat(cs.strokeWidth);
        items[q].vis = cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
      }

      // --- background removal: first painted shape covering >= 99% of the viewBox ---
      var painted = items.filter(function (it) {
        return !it.mode && SHAPE_TAGS[it.el.localName] && it.vis && it.op > 0 &&
          ((!isNonePaint(it.fill) && it.fo > 0) || (!isNonePaint(it.stroke) && it.so > 0 && it.sw > 0) || it.el.localName === 'image' || it.el.localName === 'use');
      });
      if (painted.length > 1) {
        var first = painted[0], fl = first.el.localName;
        if ((fl === 'rect' || fl === 'path' || fl === 'polygon') && !isNonePaint(first.fill)) {
          try {
            var simple = fl === 'rect' || ((first.el.getAttribute('d') || first.el.getAttribute('points') || '').replace(/[^a-df-z]/gi, '').length <= 6);
            var bx = first.el.getBBox();
            var M = live.getScreenCTM().inverse().multiply(first.el.getScreenCTM());
            var xs = [], ys = [];
            [[bx.x, bx.y], [bx.x + bx.width, bx.y], [bx.x, bx.y + bx.height], [bx.x + bx.width, bx.y + bx.height]].forEach(function (p) {
              xs.push(M.a * p[0] + M.c * p[1] + M.e); ys.push(M.b * p[0] + M.d * p[1] + M.f);
            });
            var cx0 = Math.max(Math.min.apply(null, xs), vb[0]), cx1 = Math.min(Math.max.apply(null, xs), vb[0] + vb[2]);
            var cy0 = Math.max(Math.min.apply(null, ys), vb[1]), cy1 = Math.min(Math.max.apply(null, ys), vb[1] + vb[3]);
            if (simple && (cx1 - cx0) >= 0.99 * vb[2] && (cy1 - cy0) >= 0.99 * vb[3]) {
              first.el.parentNode.removeChild(first.el);
              first.removed = true;
              notes.push('removed full-viewBox background <' + fl + '>');
            }
          } catch (e) { /* geometry unavailable: keep */ }
        }
      }

      // --- write phase: solid black silhouette; fill="none"/stroke="none" stay unpainted ---
      for (q = 0; q < items.length; q++) {
        var it = items[q], el = it.el, st = el.style;
        if (it.removed) continue;
        var fillNone = isNonePaint(it.fill) || !(it.fo > 0);
        var strokeNone = isNonePaint(it.stroke) || !(it.so > 0);
        if (it.mode === 'defs') {
          var ownFill = el.hasAttribute('fill') || st.fill;
          var ownStroke = el.hasAttribute('stroke') || st.stroke;
          if (ownFill || fillNone) st.setProperty('fill', fillNone ? 'none' : '#000', 'important');
          if (ownStroke || strokeNone) st.setProperty('stroke', strokeNone ? 'none' : '#000', 'important');
        } else {
          st.setProperty('fill', fillNone ? 'none' : '#000', 'important');
          st.setProperty('stroke', strokeNone ? 'none' : '#000', 'important');
        }
        st.setProperty('fill-opacity', '1', 'important');
        st.setProperty('stroke-opacity', '1', 'important');
        if (it.op > 0) st.setProperty('opacity', '1', 'important');
        st.setProperty('filter', 'none', 'important');
        st.setProperty('mix-blend-mode', 'normal', 'important');
        st.setProperty('color', '#000', 'important');
      }

      live.setAttribute('overflow', 'hidden');
      live.style.setProperty('overflow', 'hidden', 'important');
      var ser = new XMLSerializer();

      // measuring pass: viewBox mapped exactly onto mw x mh pixels
      var measure = function (maxSide) {
        var s = maxSide / Math.max(vb[2], vb[3]);
        var mw = Math.max(1, Math.round(vb[2] * s)), mh = Math.max(1, Math.round(vb[3] * s));
        live.setAttribute('width', String(mw)); live.setAttribute('height', String(mh));
        live.setAttribute('preserveAspectRatio', 'none');
        live.removeAttribute('x'); live.removeAttribute('y');
        return { text: ser.serializeToString(live), w: mw, h: mh, sx: mw / vb[2], sy: mh / vb[3] };
      };
      var m1 = measure(1024);

      // final pass: original document nested (clipped to its viewBox) inside an outer viewBox
      live.setAttribute('x', String(vb[0])); live.setAttribute('y', String(vb[1]));
      live.setAttribute('width', String(vb[2])); live.setAttribute('height', String(vb[3]));
      var inner = ser.serializeToString(live);
      return { vb: vb, measure: m1, inner: inner, notes: notes };
    } finally {
      if (host.parentNode) host.parentNode.removeChild(host);
    }
  }

  async function rasterSVG(text, R) {
    var prep = prepareSVG(text);
    var m = prep.measure;
    // pass 1: measure the visible content bbox
    var img1 = await loadImageFromSvgText(m.text);
    var cv1 = makeCanvas(m.w, m.h);
    cv1.ctx.drawImage(img1, 0, 0, m.w, m.h);
    var cov1 = alphaOf(cv1.ctx, m.w, m.h);
    releaseCanvas(cv1);
    var bb = covBBox(cov1, m.w, m.h, 0);
    if (!bb) throw new Error('SpectraSDF: the SVG contains no visible shapes');
    var vb = prep.vb;
    var ux0 = vb[0] + bb.x0 / m.sx, ux1 = vb[0] + bb.x1 / m.sx;
    var uy0 = vb[1] + bb.y0 / m.sy, uy1 = vb[1] + bb.y1 / m.sy;
    var cx = (ux0 + ux1) / 2, cy = (uy0 + uy1) / 2;
    var halfU = Math.max(ux1 - ux0, uy1 - uy0) / 2 / FILL_HALF; // half-size of the field in user units
    // pass 2: render the content scaled & centred at full raster resolution (true vector render)
    var outer = '<svg xmlns="' + SVG_NS + '" xmlns:xlink="' + XLINK_NS + '" width="' + R + '" height="' + R +
      '" viewBox="' + (cx - halfU) + ' ' + (cy - halfU) + ' ' + (2 * halfU) + ' ' + (2 * halfU) +
      '" preserveAspectRatio="xMidYMid meet">' + prep.inner + '</svg>';
    var img2 = await loadImageFromSvgText(outer);
    var cv2 = makeCanvas(R, R);
    cv2.ctx.drawImage(img2, 0, 0, R, R);
    var rgba = rgbaOf(cv2.ctx, R, R);
    releaseCanvas(cv2);
    return { rgba: rgba, notes: prep.notes };
  }

  // ---------- text ----------
  async function rasterText(src, R) {
    var text = String(src.text == null ? '' : src.text);
    var lines = text.split(/\r?\n/).map(function (s) { return s.replace(/\s+$/, ''); });
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    while (lines.length && !lines[0].trim()) lines.shift();
    if (!lines.length) throw new Error('SpectraSDF: text is empty');
    var family = src.fontFamily || 'Inter, system-ui, sans-serif';
    var weight = src.fontWeight || 700;
    var style = src.fontStyle || 'normal';
    var font = function (px) { return style + ' ' + weight + ' ' + px + 'px ' + family; };
    var decodeMs = 0;
    if (document.fonts && document.fonts.load) {
      var tf = now();
      try {
        await Promise.race([document.fonts.load(font(100), lines.join(' ')), new Promise(function (r) { setTimeout(r, 2500); })]);
      } catch (e) { /* fall back to whatever is available */ }
      decodeMs = now() - tf;
    }
    var FS0 = 200;
    var cvm = makeCanvas(8, 8), cm = cvm.ctx;
    cm.font = font(FS0); cm.textAlign = 'center'; cm.textBaseline = 'alphabetic';
    if (src.letterSpacing != null && 'letterSpacing' in cm) cm.letterSpacing = (src.letterSpacing * FS0) + 'px';
    var lineH = FS0 * (src.lineHeight || 1.1);
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    lines.forEach(function (ln, idx) {
      var mt = cm.measureText(ln || ' ');
      var by = idx * lineH;
      x0 = Math.min(x0, -mt.actualBoundingBoxLeft); x1 = Math.max(x1, mt.actualBoundingBoxRight);
      y0 = Math.min(y0, by - mt.actualBoundingBoxAscent); y1 = Math.max(y1, by + mt.actualBoundingBoxDescent);
    });
    releaseCanvas(cvm);
    if (!(x1 > x0) || !(y1 > y0)) throw new Error('SpectraSDF: text has no visible glyphs');
    var s = (FILL_HALF * R / 2) / (Math.max(x1 - x0, y1 - y0) / 2);
    var bcx = (x0 + x1) / 2, bcy = (y0 + y1) / 2;
    var cv = makeCanvas(R, R), ctx = cv.ctx;
    ctx.font = font(FS0 * s); ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    if (src.letterSpacing != null && 'letterSpacing' in ctx) ctx.letterSpacing = (src.letterSpacing * FS0 * s) + 'px';
    ctx.fillStyle = '#000';
    lines.forEach(function (ln, idx) {
      ctx.fillText(ln, R / 2 + (0 - bcx) * s, R / 2 + (idx * lineH - bcy) * s);
    });
    var rgba = rgbaOf(ctx, R, R);
    releaseCanvas(cv);
    return { rgba: rgba, decodeMs: decodeMs, notes: [] };
  }

  // ---------- raster images ----------
  async function rasterImage(blob, R) {
    var td = now();
    var bmp = await createImageBitmap(blob);
    var decodeMs = now() - td;
    var W0 = bmp.width, H0 = bmp.height;
    if (!(W0 > 0 && H0 > 0)) throw new Error('SpectraSDF: empty image');
    var s0 = Math.min(1, 2048 / Math.max(W0, H0));
    var w = Math.max(1, Math.round(W0 * s0)), h = Math.max(1, Math.round(H0 * s0));
    var cva = makeCanvas(w, h);
    cva.ctx.imageSmoothingEnabled = true; cva.ctx.imageSmoothingQuality = 'high';
    cva.ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    var id = cva.ctx.getImageData(0, 0, w, h), px = id.data, n = w * h, i;
    var notes = [];
    var transparent = 0, opaque = 0;
    for (i = 0; i < n; i++) { var al = px[i * 4 + 3]; if (al < 250) transparent++; if (al > 128) opaque++; }
    var cov = new Uint8Array(n);
    var useAlpha = transparent > 0.002 * n && opaque > 0.001 * n;
    var lossyMime = /jpe?g|webp|avif/i.test(blob.type || '');
    if (useAlpha) {
      for (i = 0; i < n; i++) cov[i] = px[i * 4 + 3];
      notes.push('coverage from alpha');
    } else {
      // background = per-channel median of the border pixels
      var hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256), cnt = 0;
      var addPx = function (j) { hr[px[j * 4]]++; hg[px[j * 4 + 1]]++; hb[px[j * 4 + 2]]++; cnt++; };
      var bw = Math.max(1, Math.round(Math.min(w, h) * 0.01));
      for (var yy = 0; yy < h; yy++) for (var xx = 0; xx < w; xx++) {
        if (xx < bw || yy < bw || xx >= w - bw || yy >= h - bw) addPx(yy * w + xx);
      }
      var med = function (hh) { var acc = 0; for (var v = 0; v < 256; v++) { acc += hh[v]; if (acc * 2 >= cnt) return v; } return 255; };
      var br = med(hr), bg = med(hg), bb2 = med(hb);
      var dist = new Float32Array(n), maxD = 0;
      for (i = 0; i < n; i++) {
        var dr = px[i * 4] - br, dg = px[i * 4 + 1] - bg, db = px[i * 4 + 2] - bb2;
        var dd = Math.sqrt(dr * dr + dg * dg + db * db);
        dist[i] = dd; if (dd > maxD) maxD = dd;
      }
      if (maxD < 24) throw new Error('SpectraSDF: could not separate the shape from the background');
      if (lossyMime) {
        // JPEG & co. store chroma at half resolution: if luma alone separates the shape, use it
        var Ybg = 0.2126 * br + 0.7152 * bg + 0.0722 * bb2, distY = new Float32Array(n), ys = [], maxY = 0;
        for (i = 0; i < n; i++) {
          var dY = Math.abs(0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2] - Ybg);
          distY[i] = dY; if (dY > maxY) maxY = dY;
          if (dist[i] > 0.3 * maxD && (i & 7) === 0) ys.push(dY);
        }
        ys.sort(function (p, q) { return p - q; });
        if ((ys[(ys.length / 2) | 0] || 0) > 40) { dist = distY; maxD = maxY; notes.push('luma-only coverage (lossy chroma)'); }
      }
      // reference contrast C = median distance of clearly-foreground pixels
      var hist = new Uint32Array(444), fc = 0, thr = 0.3 * maxD;
      for (i = 0; i < n; i++) if (dist[i] > thr) { hist[dist[i] | 0]++; fc++; }
      var C = maxD, acc2 = 0;
      for (var v2 = 0; v2 < 444; v2++) { acc2 += hist[v2]; if (acc2 * 2 >= fc) { C = v2 + 0.5; break; } }
      // noise floor (JPEG etc.) = 99th percentile of the border's distance to the background colour
      var bd = [];
      for (var yb = 0; yb < h; yb++) for (var xb = 0; xb < w; xb++) {
        if (xb < bw || yb < bw || xb >= w - bw || yb >= h - bw) bd.push(dist[yb * w + xb]);
      }
      bd.sort(function (p, q) { return p - q; });
      var NF = Math.min(bd[(bd.length * 0.99) | 0] || 0, 0.2 * C);
      // linear in the blend factor (AA ramps stay area-coverage-like), noise floor removed symmetrically
      for (i = 0; i < n; i++) {
        var t = (dist[i] - NF) / (C - 2 * NF);
        cov[i] = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255);
      }
      var lum = 0.2126 * br + 0.7152 * bg + 0.0722 * bb2;
      notes.push('coverage from colour distance to background rgb(' + br + ',' + bg + ',' + bb2 + ') — ' + (lum > 128 ? 'dark-on-light' : 'light-on-dark'));
    }
    // safety: shape covering nearly everything means we picked the wrong polarity
    var inside = 0;
    for (i = 0; i < n; i++) if (cov[i] >= 128) inside++;
    if (inside > 0.92 * n) {
      for (i = 0; i < n; i++) cov[i] = 255 - cov[i];
      notes.push('coverage inverted (shape covered > 92% of the image)');
    }
    despeckle(cov, w, h);
    var bbx = covBBox(cov, w, h, 8);
    if (!bbx) throw new Error('SpectraSDF: the image contains no visible shape');
    // A raster has no more edge information than its own pixels: upsampling the coverage would bake
    // the source pixel grid into the edge (periodic ripples). Instead the exact AA-EDT runs at source
    // resolution on a square domain covering the whole field, and the (locally linear) distance is
    // resampled to the output with C1 Catmull-Rom interpolation -> straight edges stay straight.
    var halfSrc = Math.max(bbx.x1 - bbx.x0, bbx.y1 - bbx.y0) / 2 / FILL_HALF; // src px per logo unit
    var bcx = (bbx.x0 + bbx.x1) / 2, bcy = (bbx.y0 + bbx.y1) / 2;
    var S = Math.ceil(2 * halfSrc) + 6, s2 = 1;
    if (S > 2048) { S = 2048; s2 = (S - 6) / (2 * halfSrc); }
    S = Math.max(S, 64);
    var Sc = new Uint8Array(S * S), dx, dy;
    if (s2 === 1) { // exact copy at an integer offset (keeps the source AA ramps untouched)
      dx = Math.round(S / 2 - bcx); dy = Math.round(S / 2 - bcy);
      for (var yy2 = 0; yy2 < h; yy2++) {
        var ty = yy2 + dy; if (ty < 1 || ty >= S - 1) continue;
        for (var xx2 = 0; xx2 < w; xx2++) {
          var tx = xx2 + dx; if (tx < 1 || tx >= S - 1) continue;
          Sc[ty * S + tx] = cov[yy2 * w + xx2];
        }
      }
      releaseCanvas(cva);
    } else {        // large source: area-downsample onto the domain
      for (i = 0; i < n; i++) { px[i * 4] = 0; px[i * 4 + 1] = 0; px[i * 4 + 2] = 0; px[i * 4 + 3] = cov[i]; }
      cva.ctx.putImageData(id, 0, 0);
      dx = S / 2 - bcx * s2; dy = S / 2 - bcy * s2;
      var cv = makeCanvas(S, S), ctx = cv.ctx;
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.setTransform(s2, 0, 0, s2, dx, dy);
      ctx.drawImage(cva.c, 0, 0);
      releaseCanvas(cva);
      var a8 = alphaOf(ctx, S, S);
      releaseCanvas(cv);
      Sc = a8;
    }
    // Raster sources always use the iso-line edge model on a lightly blurred coverage: robust to
    // JPEG ringing / chroma blockiness and free of the staircase phase error of 1-px AA ramps at
    // source resolution (measured: |grad d| std in the edge band 0.019 vs 0.034 for the area model).
    return {
      edgeModel: 'iso',
      cov: Sc, decodeMs: decodeMs, notes: notes,
      domain: { S: S, cx: bcx * s2 + dx, cy: bcy * s2 + dy, unit: halfSrc * s2 }
    };
  }

  // Partial coverage is only meaningful on a real boundary: values not within 2 px (5x5) of a pixel
  // on the other side of 0.5 are compression / dithering noise and are snapped to 0 or 255
  // (otherwise each speck becomes a spurious edge site and dents the distance field).
  function despeckle(cov, w, h) {
    var n = w * h, i, x, y;
    var inside = new Uint8Array(n);
    for (i = 0; i < n; i++) inside[i] = cov[i] >= 128 ? 1 : 0;
    // count of inside pixels in the 5x5 window via a summed-area table
    var sat = new Int32Array((w + 1) * (h + 1)), W1 = w + 1;
    for (y = 0; y < h; y++) {
      var rs = 0;
      for (x = 0; x < w; x++) { rs += inside[y * w + x]; sat[(y + 1) * W1 + x + 1] = sat[y * W1 + x + 1] + rs; }
    }
    for (y = 0; y < h; y++) {
      var y0 = Math.max(0, y - 2), y1 = Math.min(h, y + 3);
      for (x = 0; x < w; x++) {
        i = y * w + x;
        var a = cov[i];
        if (a === 0 || a === 255) continue;
        var x0 = Math.max(0, x - 2), x1 = Math.min(w, x + 3);
        var cnt = sat[y1 * W1 + x1] - sat[y0 * W1 + x1] - sat[y1 * W1 + x0] + sat[y0 * W1 + x0];
        var area = (y1 - y0) * (x1 - x0);
        if (cnt === 0) cov[i] = 0; else if (cnt === area) cov[i] = 255;
      }
    }
  }

  // ---------- public API ----------
  function chooseRaster(size, opts) {
    var maxR = opts.maxRaster || 4096, minR = opts.minRaster || 2048;
    var k = opts.oversample ? Math.max(1, Math.round(opts.oversample)) : 4;
    if (!opts.oversample) {
      while (k > 1 && size * k > maxR) k--;
      while (size * k < minR) k++;
    }
    return { k: k, R: size * k };
  }

  function normaliseSource(source) {
    if (typeof source === 'string') return { type: 'svg', text: source };
    if (typeof Blob !== 'undefined' && source instanceof Blob) {
      if (/svg/i.test(source.type) || /\.svg$/i.test(source.name || '')) return { type: 'svg', blob: source };
      return { type: 'image', blob: source };
    }
    return source || {};
  }

  async function build(source, opts) {
    opts = opts || {};
    var src = normaliseSource(source);
    var size = Math.round(opts.size || 1024);
    if (!(size >= 32 && size <= 4096)) throw new Error('SpectraSDF: size must be in [32, 4096]');
    var rs = chooseRaster(size, opts), R = rs.R;
    var t0 = now();
    var r;
    if (src.type === 'svg') {
      var text = src.text != null ? src.text : await src.blob.text();
      r = await rasterSVG(text, R);
    } else if (src.type === 'text') {
      r = await rasterText(src, R);
    } else if (src.type === 'image') {
      if (!src.blob) throw new Error('SpectraSDF: image source needs a blob');
      r = await rasterImage(src.blob, R);
    } else {
      throw new Error('SpectraSDF: unknown source type ' + src.type);
    }
    var t1 = now();
    var res;
    if (r.domain) R = r.domain.S;
    try {
      res = await runEDT(r, R, size, { domain: r.domain, edgeModel: r.edgeModel, smooth: opts.smooth !== false, debugSites: !!opts.debugSites, refinePx: opts.refinePx });
    } catch (e) {
      if (/worker crashed/.test(String(e && e.message))) throw new Error('SpectraSDF: worker crashed (out of memory?) — try a smaller size');
      throw e;
    }
    var t2 = now();
    var ex = res.extent;
    return {
      size: size,
      data: res.data,
      extent: [ex[0], ex[1]],
      maxInset: res.maxInset,
      aspect: ex[0] / ex[1],
      sites: res.sites,           // number of boundary sites (diagnostic)
      debugSites: res.debugSites,
      centre: res.centre,         // measured bbox centre offset (≈ [0,0]), logo units, +y down
      raster: R,
      sourceType: src.type,
      notes: r.notes || [],
      timings: {
        decode: r.decodeMs || 0,
        raster: (t1 - t0) - (r.decodeMs || 0),
        edt: res.timings.total,
        edtDetail: res.timings,
        total: t2 - t0,
        totalExDecode: (t2 - t0) - (r.decodeMs || 0)
      }
    };
  }

  // bilinear sample (logo units), u,v in field pixel coords
  function sampleField(f, x, y) {
    var s = f.size, d = f.data;
    x = Math.min(Math.max(x, 0), s - 1); y = Math.min(Math.max(y, 0), s - 1);
    var x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, s - 1), y1 = Math.min(y0 + 1, s - 1);
    var fx = x - x0, fy = y - y0;
    var a = d[y0 * s + x0] + (d[y0 * s + x1] - d[y0 * s + x0]) * fx;
    var b = d[y1 * s + x0] + (d[y1 * s + x1] - d[y1 * s + x0]) * fx;
    return a + (b - a) * fy;
  }

  function toPreviewCanvas(field, px) {
    px = Math.max(16, Math.round(px || 256));
    var c = document.createElement('canvas');
    c.width = c.height = px;
    var ctx = c.getContext('2d');
    var img = ctx.createImageData(px, px), o = img.data;
    var s = field.size, inset = Math.max(field.maxInset || 0.05, 1e-3);
    var ps = 2 / px, STEP = 0.05;
    function sm(e0, e1, x) { var t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); }
    for (var j = 0; j < px; j++) {
      for (var i = 0; i < px; i++) {
        var d = sampleField(field, (i + 0.5) / px * s - 0.5, (j + 0.5) / px * s - 0.5);
        var r, g, b, t;
        if (d < 0) { // inside: deep blue -> cyan with depth
          t = Math.min(-d / inset, 1);
          r = 20 + 60 * t; g = 60 + 150 * t; b = 150 + 100 * t;
        } else {     // outside: warm amber fading to dark
          t = Math.min(d / 0.6, 1);
          var e = 1 - t;
          r = 30 + 200 * e * e; g = 16 + 110 * e * e * e; b = 10 + 30 * e * e * e;
        }
        var q = d / STEP, fr = Math.abs(q - Math.round(q)) * STEP;
        var iso = (1 - sm(0, ps * 0.9, fr)) * 0.28;
        var zero = 1 - sm(ps * 0.4, ps * 1.4, Math.abs(d));
        r += (255 - r) * iso; g += (255 - g) * iso; b += (255 - b) * iso;
        r += (255 - r) * zero; g += (255 - g) * zero; b += (255 - b) * zero;
        var k = (j * px + i) * 4;
        o[k] = r; o[k + 1] = g; o[k + 2] = b; o[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  global.SpectraSDF = {
    build: build,
    toPreviewCanvas: toPreviewCanvas,
    sample: sampleField,                 // (field, xPix, yPix) -> bilinear distance (logo units)
    _computeLocal: function (cov, R, size, opts) { return computeLocal({ cov: cov.buffer, R: R, size: size, opts: opts || {} }); },
    _workerAvailable: function () { return getWorker().then(function (w) { return !!w; }); }
  };
})(typeof window !== 'undefined' ? window : this);
