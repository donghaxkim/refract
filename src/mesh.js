/* Refract — src/mesh.js
 * window.RefractMesh : turn the logo on screen into a real triangle mesh, and write GLB / STL files.
 *
 * Ground truth is the engine's CPU beam tracer (engine.beam, "identical to the shader's extrude()"):
 *   sdf(x,y,z) = roundedRect2D( d2(x,y), |z| ; half-height hz(x,y), corner radius r(x,y) )
 * where d2 = bilinear outline field (already corner-rounded by Roundness), hz = depth (domed by the
 * heavy field when inflated) and r = min(bevel, 0.98·hz). Its zero set is exactly
 *   · a top/bottom height field  z = ±H(x,y)  over the region d2 ≤ 0, with
 *       u = d2/r ≤ -1 : H = hz                               (flat or domed face)
 *       -1 < u ≤ 0   : H = hz - r + r·sqrt(1 - (1+u)²)       (quarter-circle round-over)
 *   · a vertical wall on the outline d2 = 0, between z = ±(hz - r).
 * So instead of marching a 3D grid (which bevels/ripples crisp edges), we mesh in 2D:
 *   1. sample u on a 2D grid aligned to the field texels;
 *   2. slice every grid triangle that straddles a profile level u_k = cos(θ_k) - 1 into convex
 *      band polygons (piecewise-linear isobands: crossings are shared per grid edge, so the result is
 *      conforming and every iso-ring is exact; crossings are root-found on the true bilinear field);
 *   3. merge crossing-free cells into quadtree blocks while the height stays planar within tolerance
 *      (flat faces collapse to a few big fans; T-junctions are avoided by fanning each block over
 *      every vertex on its perimeter);
 *   4. mirror the top sheet to the bottom (z-symmetry), and stitch them with one wall quad per
 *      outline segment.
 * The result is watertight, 2-manifold and consistently outward-wound by construction, rings are on
 * the exact surface, and holes (O, A, e, rings) fall out of the isoband topology.
 * Normals are the gradient of the same bicubic-smoothed field the shader shades with (normalAt), so
 * the mesh shades like the screen; the surface is C1 (no creases) except along thin-stroke ridges.
 * Zero dependencies. Meshing runs in a Blob worker (main-thread fallback).
 */
(function (global) {
  'use strict';

  /* =====================================================================================
   * Mesh core — self-contained (stringified into a worker). Returns buildMesh outside a worker.
   * ===================================================================================== */
  function refractMeshCore() {
    'use strict';
    var clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
    var now = function () { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); };

    /* Quadric-error half-edge collapse on the top height-field sheet. Vertices never move (every
     * survivor stays exactly on the surface); a collapse u->v is accepted only if u is not fixed, the
     * link condition holds, no triangle of u's star flips or degenerates in the xy projection (so the
     * sheet stays a valid height field -> manifold), and no face normal turns by more than 60°. */
    function simplifySheet(P, Tin, fixed, tol2, progress) {
      var nV = P.length / 3, nT = Tin.length / 3, i, t, k;
      var tri = new Int32Array(Tin), alive = new Uint8Array(nT).fill(1);
      var deg = new Int32Array(nV);
      for (i = 0; i < tri.length; i++) deg[tri[i]]++;
      var vt = new Array(nV);
      for (i = 0; i < nV; i++) vt[i] = [];
      for (t = 0; t < nT; t++) for (k = 0; k < 3; k++) vt[tri[3 * t + k]].push(t);
      var Qd = new Float64Array(nV * 10);
      for (t = 0; t < nT; t++) {
        var a = 3 * tri[3 * t], b = 3 * tri[3 * t + 1], c = 3 * tri[3 * t + 2];
        var ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
        var nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, nl = Math.hypot(nx, ny, nz);
        if (!(nl > 0)) continue;
        nx /= nl; ny /= nl; nz /= nl; var d = -(nx * P[a] + ny * P[a + 1] + nz * P[a + 2]);
        for (k = 0; k < 3; k++) {
          var o = 10 * tri[3 * t + k];
          Qd[o] += nx * nx; Qd[o + 1] += nx * ny; Qd[o + 2] += nx * nz; Qd[o + 3] += nx * d; Qd[o + 4] += ny * ny;
          Qd[o + 5] += ny * nz; Qd[o + 6] += ny * d; Qd[o + 7] += nz * nz; Qd[o + 8] += nz * d; Qd[o + 9] += d * d;
        }
      }
      function cost(u, v) {
        var a = 10 * u, b = 10 * v, x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
        var q0 = Qd[a] + Qd[b], q1 = Qd[a + 1] + Qd[b + 1], q2 = Qd[a + 2] + Qd[b + 2], q3 = Qd[a + 3] + Qd[b + 3], q4 = Qd[a + 4] + Qd[b + 4];
        var q5 = Qd[a + 5] + Qd[b + 5], q6 = Qd[a + 6] + Qd[b + 6], q7 = Qd[a + 7] + Qd[b + 7], q8 = Qd[a + 8] + Qd[b + 8], q9 = Qd[a + 9] + Qd[b + 9];
        return Math.max(0, q0 * x * x + 2 * q1 * x * y + 2 * q2 * x * z + 2 * q3 * x + q4 * y * y + 2 * q5 * y * z + 2 * q6 * y + q7 * z * z + 2 * q8 * z + q9);
      }
      // binary min-heap over parallel typed arrays
      var cap = 1 << 16, hc = new Float64Array(cap), hu = new Int32Array(cap), hv = new Int32Array(cap), hs = new Float64Array(cap), hn = 0;
      var ver = new Int32Array(nV);
      function grow() { cap *= 2; var a1 = new Float64Array(cap); a1.set(hc); hc = a1; var a2 = new Int32Array(cap); a2.set(hu); hu = a2; var a3 = new Int32Array(cap); a3.set(hv); hv = a3; var a4 = new Float64Array(cap); a4.set(hs); hs = a4; }
      function push(u, v) {
        if (fixed[u]) return;
        var cst = cost(u, v); if (cst > tol2) return;
        if (hn === cap) grow();
        var i2 = hn++, st = ver[u] * 4294967296 + ver[v];
        while (i2 > 0) { var p = (i2 - 1) >> 1; if (hc[p] <= cst) break; hc[i2] = hc[p]; hu[i2] = hu[p]; hv[i2] = hv[p]; hs[i2] = hs[p]; i2 = p; }
        hc[i2] = cst; hu[i2] = u; hv[i2] = v; hs[i2] = st;
      }
      var pu = 0, pvv = 0, ps = 0;
      function pop() {
        pu = hu[0]; pvv = hv[0]; ps = hs[0]; hn--;
        if (hn > 0) {
          var cst = hc[hn], u = hu[hn], v = hv[hn], st = hs[hn], i2 = 0;
          for (;;) { var l = 2 * i2 + 1; if (l >= hn) break; var r = l + 1, m = (r < hn && hc[r] < hc[l]) ? r : l; if (hc[m] >= cst) break; hc[i2] = hc[m]; hu[i2] = hu[m]; hv[i2] = hv[m]; hs[i2] = hs[m]; i2 = m; }
          hc[i2] = cst; hu[i2] = u; hv[i2] = v; hs[i2] = st;
        }
      }
      for (t = 0; t < nT; t++) for (k = 0; k < 3; k++) push(tri[3 * t + k], tri[3 * t + (k + 1) % 3]);
      var removed = new Uint8Array(nV), mark = new Int32Array(nV), stampM = 0;
      var COS_MAX = 0.5;
      function tryCollapse(u, v) {
        var su = vt[u], j, tt, cntUV = 0;
        // link condition: common neighbours of u and v == the apexes of the two triangles on edge uv
        stampM++;
        for (j = 0; j < su.length; j++) { tt = su[j]; if (!alive[tt]) continue; for (var q = 0; q < 3; q++) mark[tri[3 * tt + q]] = stampM; }
        var common = 0, sv = vt[v];
        stampM++; var sM = stampM;
        for (j = 0; j < sv.length; j++) { tt = sv[j]; if (!alive[tt]) continue; for (q = 0; q < 3; q++) { var w = tri[3 * tt + q]; if (mark[w] === sM - 1) { mark[w] = sM; if (w !== u && w !== v) common++; } } }
        for (j = 0; j < su.length; j++) { tt = su[j]; if (!alive[tt]) continue; if (tri[3 * tt] === v || tri[3 * tt + 1] === v || tri[3 * tt + 2] === v) cntUV++; }
        if (cntUV !== 2 || common !== 2) return false;
        var vx = P[3 * v], vy = P[3 * v + 1], vz = P[3 * v + 2];
        for (j = 0; j < su.length; j++) {
          tt = su[j]; if (!alive[tt]) continue;
          var A = tri[3 * tt], B = tri[3 * tt + 1], C = tri[3 * tt + 2];
          if (A === v || B === v || C === v) continue;
          var ax = P[3 * A], ay = P[3 * A + 1], az = P[3 * A + 2], bx = P[3 * B], by = P[3 * B + 1], bz = P[3 * B + 2], cx = P[3 * C], cy = P[3 * C + 1], cz = P[3 * C + 2];
          var onx = (by - ay) * (cz - az) - (bz - az) * (cy - ay), ony = (bz - az) * (cx - ax) - (bx - ax) * (cz - az), onz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
          if (A === u) { ax = vx; ay = vy; az = vz; } else if (B === u) { bx = vx; by = vy; bz = vz; } else { cx = vx; cy = vy; cz = vz; }
          var nnx = (by - ay) * (cz - az) - (bz - az) * (cy - ay), nny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az), nnz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
          // xy orientation must stay positive and non-degenerate (relative to edge lengths)
          var e2 = Math.max((bx - ax) * (bx - ax) + (by - ay) * (by - ay), (cx - ax) * (cx - ax) + (cy - ay) * (cy - ay), (cx - bx) * (cx - bx) + (cy - by) * (cy - by));
          if (nnz <= 1e-4 * e2) return false;
          var l1 = Math.hypot(onx, ony, onz), l2 = Math.hypot(nnx, nny, nnz);
          if (l1 > 0 && (onx * nnx + ony * nny + onz * nnz) < COS_MAX * l1 * l2) return false;
        }
        // commit
        for (j = 0; j < su.length; j++) {
          tt = su[j]; if (!alive[tt]) continue;
          if (tri[3 * tt] === v || tri[3 * tt + 1] === v || tri[3 * tt + 2] === v) { alive[tt] = 0; continue; }
          for (q = 0; q < 3; q++) if (tri[3 * tt + q] === u) tri[3 * tt + q] = v;
          sv.push(tt);
        }
        for (q = 0; q < 10; q++) Qd[10 * v + q] += Qd[10 * u + q];
        removed[u] = 1; vt[u] = [];
        // compact v's list
        var nl2 = []; for (j = 0; j < sv.length; j++) if (alive[sv[j]]) nl2.push(sv[j]); vt[v] = nl2;
        ver[v]++;
        for (j = 0; j < nl2.length; j++) { tt = nl2[j]; for (q = 0; q < 3; q++) { var w2 = tri[3 * tt + q]; if (w2 !== v) { ver[w2]++; } } }
        for (j = 0; j < nl2.length; j++) { tt = nl2[j]; for (q = 0; q < 3; q++) { var aa = tri[3 * tt + q], bb = tri[3 * tt + (q + 1) % 3]; push(aa, bb); } }
        return true;
      }
      var done = 0, total = nV;
      while (hn > 0) {
        pop(); var u0 = pu, v0 = pvv;
        if (removed[u0] || removed[v0] || ps !== ver[u0] * 4294967296 + ver[v0]) continue;
        if (tryCollapse(u0, v0) && (++done & 8191) === 0) progress(Math.min(1, done / total));
      }
      var out = [];
      for (t = 0; t < nT; t++) if (alive[t]) out.push(tri[3 * t], tri[3 * t + 1], tri[3 * t + 2]);
      return out;
    }

    function buildMesh(job, progress) {
      var t0 = now();
      progress = progress || function () {};
      var s = job.size, RF = job.R, GF = job.G, sh = job.shape, ext = job.extent;
      var depth = sh.depth, bevel = sh.bevel, inflate = sh.inflate || 0, inset = Math.max(sh.inset || 0.05, 1e-3);
      var Q = job.quality === 'high' ? { h: 2 / 1024, tolZ: 0.00025, tolP: 0.0004, tolQ: 0.00025, maxB: 32 } : { h: 2 / 512, tolZ: 0.0007, tolP: 0.001, tolQ: 0.0007, maxB: 32 };
      if (job.quality === 'draft') Q = { h: 2 / 256, tolZ: 0.002, tolP: 0.003, tolQ: 0.002, maxB: 16 };

      // ── the engine's field sampling (bilinear, clamp + outside extension) — mirrors Beam3D.f
      var DB = 0;
      function f(x, y) {
        var cx = clamp(x, -1, 1), cy = clamp(y, -1, 1);
        var fx = (cx * 0.5 + 0.5) * s - 0.5, fy = (0.5 - cy * 0.5) * s - 0.5;
        var ix = clamp(Math.floor(fx), 0, s - 2), iy = clamp(Math.floor(fy), 0, s - 2);
        var tx = clamp(fx - ix, 0, 1), ty = clamp(fy - iy, 0, 1), i0 = iy * s + ix;
        var o = Math.hypot(Math.max(Math.abs(x) - 1, 0), Math.max(Math.abs(y) - 1, 0));
        var a = (RF[i0] * (1 - tx) + RF[i0 + 1] * tx) * (1 - ty) + (RF[i0 + s] * (1 - tx) + RF[i0 + s + 1] * tx) * ty;
        var b = (GF[i0] * (1 - tx) + GF[i0 + 1] * tx) * (1 - ty) + (GF[i0 + s] * (1 - tx) + GF[i0 + s + 1] * tx) * ty;
        DB = b + o; return a + o;
      }
      function hzOf(db) {
        var hz = depth;
        if (inflate > 0) { var k = clamp(-db / inset, 0, 1); hz *= 1 + (0.3 + 0.7 * (1 - (1 - k) * (1 - k)) - 1) * inflate; }
        return hz;
      }
      var rOf = function (hz) { return Math.min(bevel, hz * 0.98); };
      var HZ_ = 0;
      function uAt(x, y) { var d2 = f(x, y); var hz = hzOf(DB); HZ_ = hz; return d2 / rOf(hz); }
      function zTop(u, hz) {
        var r = rOf(hz); if (u <= -1) return hz;
        var c = 1 + u; if (c >= 1) return hz - r;
        return hz - r + r * Math.sqrt(Math.max(0, 1 - c * c));
      }

      // ── profile levels: L[0] = 0 (outline / wall top) … L[K] = -1 (start of the face)
      var cosStep = 1 - Q.tolP / Math.max(bevel, 1e-4);
      var K = cosStep <= -1 ? 2 : Math.ceil((Math.PI / 2) / (2 * Math.acos(clamp(cosStep, -1, 1))));
      K = clamp(K, 2, 14);
      var L = new Float64Array(K + 1);
      for (var k = 0; k <= K; k++) L[k] = Math.cos(k * (Math.PI / 2) / K) - 1;
      L[0] = 0; L[K] = -1;
      function bandOf(u) { if (u > 0) return 0; for (var k = 1; k <= K; k++) if (u > L[k]) return k; return K + 1; }

      // ── grid aligned to field texel centres
      var tx = 2 / s, stride = Math.max(1, Math.round(Q.h / tx)), h = stride * tx;
      var maxB = Q.maxB;
      var margin = 0.03 + 3 * h;
      var Nx = Math.ceil(2 * (ext[0] + margin) / h), Ny = Math.ceil(2 * (ext[1] + margin) / h);
      Nx = Math.ceil(Nx / maxB) * maxB; Ny = Math.ceil(Ny / maxB) * maxB;
      var snap = function (v) { return (Math.round((v + 1) / tx - 0.5) + 0.5) * tx - 1; };
      var x0 = snap(-Nx * h / 2), y0 = snap(-Ny * h / 2);
      var NX = Nx + 1, NY = Ny + 1, NN = NX * NY;
      var U = new Float64Array(NN), HZ = new Float32Array(NN), Z = new Float32Array(NN);
      for (var j = 0; j < NY; j++) {
        var y = y0 + j * h;
        for (var i = 0; i < NX; i++) {
          var n = j * NX + i, u = uAt(x0 + i * h, y);
          for (var kk = 0; kk <= K; kk++) if (Math.abs(u - L[kk]) < 1e-9) u = L[kk] + 1e-9; // keep nodes off levels
          U[n] = u; HZ[n] = HZ_; Z[n] = zTop(u, HZ_);
        }
        if ((j & 63) === 0) progress(0.4 * j / NY);
      }
      var tNodes = now();

      // ── cell classification + quadtree merge
      var BN = new Int8Array(NN); for (var q = 0; q < NN; q++) BN[q] = bandOf(U[q]);
      var CB = new Int8Array(Nx * Ny); // band if uniform, -1 if mixed
      var anyInside = false;
      for (j = 0; j < Ny; j++) for (i = 0; i < Nx; i++) {
        var a0 = j * NX + i, b0 = BN[a0];
        CB[j * Nx + i] = (BN[a0 + 1] === b0 && BN[a0 + NX] === b0 && BN[a0 + NX + 1] === b0) ? b0 : -1;
        if (CB[j * Nx + i] !== 0) anyInside = true;
      }
      if (!anyInside) throw new Error('RefractMesh: the shape is empty');
      var LMAX = Math.round(Math.log2(maxB)), M = [null];
      var zOkBlock = function (i0, j0, B) {
        var c00 = Z[j0 * NX + i0], c10 = Z[j0 * NX + i0 + B], c01 = Z[(j0 + B) * NX + i0], c11 = Z[(j0 + B) * NX + i0 + B];
        var hb = B >> 1;
        for (var dj = 0; dj <= 2; dj++) for (var di = 0; di <= 2; di++) {
          var fx = di / 2, fy = dj / 2;
          var zi = (c00 * (1 - fx) + c10 * fx) * (1 - fy) + (c01 * (1 - fx) + c11 * fx) * fy;
          if (Math.abs(Z[(j0 + dj * hb) * NX + i0 + di * hb] - zi) > Q.tolZ) return false;
        }
        return true;
      };
      for (var l = 1; l <= LMAX; l++) {
        var B = 1 << l, w = Nx >> l, hgt = Ny >> l, arr = new Int8Array(w * hgt), prev = l === 1 ? null : M[l - 1], pw = Nx >> (l - 1);
        for (var by = 0; by < hgt; by++) for (var bx = 0; bx < w; bx++) {
          var c0, c1, c2, c3;
          if (l === 1) { c0 = CB[(2 * by) * Nx + 2 * bx]; c1 = CB[(2 * by) * Nx + 2 * bx + 1]; c2 = CB[(2 * by + 1) * Nx + 2 * bx]; c3 = CB[(2 * by + 1) * Nx + 2 * bx + 1]; }
          else { c0 = prev[(2 * by) * pw + 2 * bx]; c1 = prev[(2 * by) * pw + 2 * bx + 1]; c2 = prev[(2 * by + 1) * pw + 2 * bx]; c3 = prev[(2 * by + 1) * pw + 2 * bx + 1]; }
          var v = (c0 >= 1 && c0 === c1 && c0 === c2 && c0 === c3 && zOkBlock(bx * B, by * B, B)) ? c0 : (c0 === 0 && c1 === 0 && c2 === 0 && c3 === 0 ? 0 : -1);
          arr[by * w + bx] = v;
        }
        M[l] = arr;
      }
      var leaves = [], sliced = [], used = new Uint8Array(NN);
      var markCorners = function (i0, j0, B) { used[j0 * NX + i0] = 1; used[j0 * NX + i0 + B] = 1; used[(j0 + B) * NX + i0] = 1; used[(j0 + B) * NX + i0 + B] = 1; };
      (function () {
        var stack = [];
        for (var by = 0; by < (Ny >> LMAX); by++) for (var bx = 0; bx < (Nx >> LMAX); bx++) stack.push(LMAX, bx, by);
        while (stack.length) {
          var yy = stack.pop(), xx = stack.pop(), ll = stack.pop();
          if (ll === 0) {
            var cb = CB[yy * Nx + xx];
            if (cb >= 1) { leaves.push(xx, yy, 1); markCorners(xx, yy, 1); }
            else if (cb === -1) { sliced.push(xx, yy); markCorners(xx, yy, 1); }
            continue;
          }
          var mv = M[ll][yy * (Nx >> ll) + xx];
          if (mv === 0) continue;
          if (mv >= 1) { var BB = 1 << ll; leaves.push(xx * BB, yy * BB, BB); markCorners(xx * BB, yy * BB, BB); continue; }
          stack.push(ll - 1, 2 * xx, 2 * yy, ll - 1, 2 * xx + 1, 2 * yy, ll - 1, 2 * xx, 2 * yy + 1, ll - 1, 2 * xx + 1, 2 * yy + 1);
        }
      })();

      // ── top sheet
      var P = [], T = [], W = []; // positions (x,y,z), triangle indices, wall directed edges
      var nodeV = new Int32Array(NN).fill(-1);
      function nodeVert(nI) {
        var vI = nodeV[nI]; if (vI >= 0) return vI;
        vI = P.length / 3; nodeV[nI] = vI;
        P.push(x0 + (nI % NX) * h, y0 + Math.floor(nI / NX) * h, Z[nI]); return vI;
      }
      for (var li = 0; li < leaves.length; li += 3) {
        var i0 = leaves[li], j0 = leaves[li + 1], Bq = leaves[li + 2], ring = [], t;
        for (t = 0; t < Bq; t++) { var nn = j0 * NX + i0 + t; if (used[nn]) ring.push(nn); }
        for (t = 0; t < Bq; t++) { nn = (j0 + t) * NX + i0 + Bq; if (used[nn]) ring.push(nn); }
        for (t = 0; t < Bq; t++) { nn = (j0 + Bq) * NX + i0 + Bq - t; if (used[nn]) ring.push(nn); }
        for (t = 0; t < Bq; t++) { nn = (j0 + Bq - t) * NX + i0; if (used[nn]) ring.push(nn); }
        if (ring.length === 4) {
          var A = nodeVert(ring[0]), Bv = nodeVert(ring[1]), C = nodeVert(ring[2]), D = nodeVert(ring[3]);
          T.push(A, Bv, C, A, C, D);
        } else {
          var ctr = nodeVert((j0 + (Bq >> 1)) * NX + i0 + (Bq >> 1));
          var rv = ring.map(nodeVert);
          for (t = 0; t < rv.length; t++) T.push(ctr, rv[t], rv[(t + 1) % rv.length]);
        }
      }
      progress(0.5);

      // crossings: computed once per grid edge for every level it straddles, root-found on the true field
      var XK = new Map();
      function edgeCrossings(eid, na, nb) {
        var key0 = eid * (K + 1), ua = U[na], ub = U[nb];
        var xa = x0 + (na % NX) * h, ya = y0 + Math.floor(na / NX) * h, xb = x0 + (nb % NX) * h, yb = y0 + Math.floor(nb / NX) * h;
        var lo = Math.min(ua, ub), hi = Math.max(ua, ub), lastT = ua > ub ? 0 : 1;
        // walk levels in order of increasing t (from na to nb)
        var ks = [];
        for (var k = 0; k <= K; k++) if (L[k] > lo && L[k] < hi) ks.push(k);
        if (ua < ub) ks.reverse(); // u increasing along the edge -> levels with larger L come later (smaller k)
        var tPrev = 0;
        for (var m = 0; m < ks.length; m++) {
          var lv = L[ks[m]];
          // Illinois regula falsi on g(t) = u(t) - lv, bracket [0,1] (g(0)=ua-lv, g(1)=ub-lv opposite signs)
          var ta = 0, tb = 1, ga = ua - lv, gb = ub - lv, tt = ga / (ga - gb), side = 0;
          for (var it = 0; it < 12; it++) {
            tt = (ta * gb - tb * ga) / (gb - ga);
            var g = uAt(xa + (xb - xa) * tt, ya + (yb - ya) * tt) - lv;
            if (Math.abs(g) < 1e-7) break;
            if ((g > 0) === (ga > 0)) { ta = tt; ga = g; if (side === -1) gb *= 0.5; side = -1; }
            else { tb = tt; gb = g; if (side === 1) ga *= 0.5; side = 1; }
          }
          tt = clamp(tt, Math.max(0.002, tPrev + 0.001), 0.998);
          tPrev = tt;
          var px = xa + (xb - xa) * tt, py = ya + (yb - ya) * tt;
          uAt(px, py); var hz = HZ_;
          var vI = P.length / 3;
          P.push(px, py, ks[m] === 0 ? hz - rOf(hz) : zTop(lv, hz));
          XK.set(key0 + ks[m], vI);
        }
        void lastT;
      }
      function crossVert(eid, na, nb, k) {
        var key = eid * (K + 1) + k, vI = XK.get(key);
        if (vI === undefined) { edgeCrossings(eid, na, nb); vI = XK.get(key); }
        return vI;
      }
      // boundary walk of one CCW grid triangle -> convex band polygons
      var pv = new Int32Array(64), pval = new Float64Array(64), pz = new Int8Array(64);
      function sliceTri(na, nb, nc, eab, ebc, eca) {
        var cnt = 0;
        var tri = [na, nb, nc], eds = [eab, ebc, eca];
        for (var e = 0; e < 3; e++) {
          var pa = tri[e], pb = tri[(e + 1) % 3], ua = U[pa], ub = U[pb];
          pv[cnt] = -1 - pa; pval[cnt] = ua; pz[cnt] = 0; cnt++;
          var eid = eds[e];
          // the edge record is stored canonically (lower node first)
          var lo = Math.min(ua, ub), hi = Math.max(ua, ub);
          if (ua > ub) { for (var k = 0; k <= K; k++) if (L[k] > lo && L[k] < hi) { pv[cnt] = crossVert(eid, Math.min(pa, pb), Math.max(pa, pb), k); pval[cnt] = L[k]; pz[cnt] = k === 0 ? 1 : 0; cnt++; } }
          else { for (k = K; k >= 0; k--) if (L[k] > lo && L[k] < hi) { pv[cnt] = crossVert(eid, Math.min(pa, pb), Math.max(pa, pb), k); pval[cnt] = L[k]; pz[cnt] = k === 0 ? 1 : 0; cnt++; } }
        }
        var poly = [], isZ = [];
        for (var b = 1; b <= K + 1; b++) {
          var hiL = L[b - 1], loL = b <= K ? L[b] : -Infinity;
          poly.length = 0; isZ.length = 0;
          for (var c = 0; c < cnt; c++) {
            if (pval[c] <= hiL && pval[c] >= loL) {
              poly.push(pv[c] < 0 ? nodeVert(-1 - pv[c]) : pv[c]); isZ.push(b === 1 && pz[c] === 1);
            }
          }
          var m = poly.length; if (m < 3) continue;
          for (var t = 1; t + 1 < m; t++) T.push(poly[0], poly[t], poly[t + 1]);
          if (b === 1) for (t = 0; t < m; t++) if (isZ[t] && isZ[(t + 1) % m]) W.push(poly[t], poly[(t + 1) % m]);
        }
      }
      for (var si = 0; si < sliced.length; si += 2) {
        var ci = sliced[si], cj = sliced[si + 1];
        var na0 = cj * NX + ci, nb0 = na0 + 1, nc0 = na0 + NX + 1, nd0 = na0 + NX;
        var eH0 = 3 * na0, eV1 = 3 * nb0 + 1, eH2 = 3 * nd0, eV0 = 3 * na0 + 1, eD = 3 * na0 + 2;
        if (Math.abs(U[na0] - U[nc0]) <= Math.abs(U[nb0] - U[nd0])) { // diagonal a-c
          sliceTri(na0, nb0, nc0, eH0, eV1, eD);
          sliceTri(na0, nc0, nd0, eD, eH2, eV0);
        } else { // diagonal b-d
          sliceTri(na0, nb0, nd0, eH0, eD, eV0);
          sliceTri(nb0, nc0, nd0, eV1, eH2, eD);
        }
        if ((si & 4095) === 0) progress(0.5 + 0.3 * si / sliced.length);
      }
      var tTop = now();

      // ── simplify the top sheet (boundary = wall ring stays fixed), then compact
      var fixed = new Uint8Array(P.length / 3);
      for (t = 0; t < W.length; t++) fixed[W[t]] = 1;
      var nT0 = T.length / 3;
      if (job.simplify !== false) T = simplifySheet(P, T, fixed, Q.tolQ * Q.tolQ, function (p) { progress(0.8 + 0.12 * p); });
      var remap = new Int32Array(P.length / 3).fill(-1), P2 = [];
      for (t = 0; t < T.length; t++) { var vv = T[t]; if (remap[vv] < 0) { remap[vv] = P2.length / 3; P2.push(P[3 * vv], P[3 * vv + 1], P[3 * vv + 2]); } T[t] = remap[vv]; }
      for (t = 0; t < W.length; t++) W[t] = remap[W[t]];
      P = P2;
      var tSimp = now();

      // ── assemble: top, mirrored bottom, walls
      var nTop = P.length / 3, nT = T.length / 3, nW = W.length / 2;
      var pos = new Float32Array(nTop * 6), idx = new Uint32Array((nT * 2 + nW * 2) * 3);
      for (var vI = 0; vI < nTop; vI++) {
        pos[3 * vI] = P[3 * vI]; pos[3 * vI + 1] = P[3 * vI + 1]; pos[3 * vI + 2] = P[3 * vI + 2];
        var o = 3 * (vI + nTop); pos[o] = P[3 * vI]; pos[o + 1] = P[3 * vI + 1]; pos[o + 2] = -P[3 * vI + 2];
      }
      var w3 = 0;
      for (t = 0; t < nT; t++) { idx[w3++] = T[3 * t]; idx[w3++] = T[3 * t + 1]; idx[w3++] = T[3 * t + 2]; }
      for (t = 0; t < nT; t++) { idx[w3++] = T[3 * t] + nTop; idx[w3++] = T[3 * t + 2] + nTop; idx[w3++] = T[3 * t + 1] + nTop; }
      for (t = 0; t < nW; t++) {
        var ea = W[2 * t], eb = W[2 * t + 1];
        idx[w3++] = eb; idx[w3++] = ea; idx[w3++] = ea + nTop;
        idx[w3++] = eb; idx[w3++] = ea + nTop; idx[w3++] = eb + nTop;
      }

      // ── normals: gradient of the bicubic-smoothed solid (the field the shader's normalAt() shades with)
      var BS0 = 0;
      function bsW(t, out) { var t2 = t * t, t3 = t2 * t; out[0] = (1 - 3 * t + 3 * t2 - t3) / 6; out[1] = (4 - 6 * t2 + 3 * t3) / 6; out[2] = (1 + 3 * t + 3 * t2 - 3 * t3) / 6; out[3] = t3 / 6; }
      var wxA = new Float64Array(4), wyA = new Float64Array(4);
      function fS(x, y) {
        var cx = clamp(x, -1, 1), cy = clamp(y, -1, 1);
        var fx = (cx * 0.5 + 0.5) * s - 0.5, fy = (0.5 - cy * 0.5) * s - 0.5;
        var ix = Math.floor(fx), iy = Math.floor(fy); bsW(fx - ix, wxA); bsW(fy - iy, wyA);
        var a = 0, b = 0;
        for (var dy = 0; dy < 4; dy++) {
          var row = clamp(iy - 1 + dy, 0, s - 1) * s, wy = wyA[dy];
          for (var dx = 0; dx < 4; dx++) { var ii = row + clamp(ix - 1 + dx, 0, s - 1), ww = wy * wxA[dx]; a += ww * RF[ii]; b += ww * GF[ii]; }
        }
        var o = Math.hypot(Math.max(Math.abs(x) - 1, 0), Math.max(Math.abs(y) - 1, 0));
        BS0 = b + o; return a + o;
      }
      function sdfS(x, y, z) {
        var d2 = fS(x, y), hz = hzOf(BS0), r = Math.min(bevel, hz * 0.98);
        var wx = d2 + r, wy = Math.abs(z) - hz + r;
        return Math.min(Math.max(wx, wy), 0) + Math.hypot(Math.max(wx, 0), Math.max(wy, 0)) - r;
      }
      var eps = 0.5 / s; // small step on the C2 bicubic field: tilts stay local (a wide step leaks the round-over into the face)
      var nrm = new Float32Array(nTop * 6);
      for (vI = 0; vI < nTop; vI++) {
        var px = P[3 * vI], py = P[3 * vI + 1], pz0 = P[3 * vI + 2];
        var a1 = sdfS(px + eps, py - eps, pz0 - eps), a2 = sdfS(px - eps, py - eps, pz0 + eps), a3 = sdfS(px - eps, py + eps, pz0 - eps), a4 = sdfS(px + eps, py + eps, pz0 + eps);
        var gx = a1 - a2 - a3 + a4, gy = -a1 - a2 + a3 + a4, gz = -a1 + a2 - a3 + a4;
        var len = Math.hypot(gx, gy, gz);
        if (!(len > 1e-12)) { gx = 0; gy = 0; gz = 1; len = 1; }
        gx /= len; gy /= len; gz /= len;
        nrm[3 * vI] = gx; nrm[3 * vI + 1] = gy; nrm[3 * vI + 2] = gz;
        o = 3 * (vI + nTop); nrm[o] = gx; nrm[o + 1] = gy; nrm[o + 2] = -gz;
        if ((vI & 16383) === 0) progress(0.92 + 0.08 * vI / nTop);
      }
      // wall-ring vertices sit exactly where the round-over meets the wall: their true normal is horizontal
      for (t = 0; t < W.length; t++) {
        var q2 = W[t], qx = nrm[3 * q2], qy = nrm[3 * q2 + 1], ql = Math.hypot(qx, qy);
        if (ql > 1e-6) { nrm[3 * q2] = qx / ql; nrm[3 * q2 + 1] = qy / ql; nrm[3 * q2 + 2] = 0; o = 3 * (q2 + nTop); nrm[o] = qx / ql; nrm[o + 1] = qy / ql; nrm[o + 2] = 0; }
      }
      progress(1);
      return {
        positions: pos, normals: nrm, indices: idx,
        stats: { vertices: nTop * 2, triangles: idx.length / 3, levels: K, grid: [Nx, Ny], cell: h, leaves: leaves.length / 3, sliced: sliced.length / 2,
                 trianglesBeforeSimplify: nT0 * 2 + nW * 2, ms: { nodes: tNodes - t0, top: tTop - tNodes, simplify: tSimp - tTop, total: now() - t0 } }
      };
    }

    var isWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;
    if (isWorker) {
      self.onmessage = function (e) {
        var job = e.data;
        try {
          var lastP = -1;
          var m = buildMesh(job, function (p) { if (p - lastP >= 0.02 || p === 1) { lastP = p; self.postMessage({ progress: p }); } });
          self.postMessage({ mesh: m }, [m.positions.buffer, m.normals.buffer, m.indices.buffer]);
        } catch (err) { self.postMessage({ error: String((err && err.message) || err) }); }
      };
    }
    return buildMesh;
  }

  /* =====================================================================================
   * Main-thread API
   * ===================================================================================== */
  var localBuild = null;
  function sourceOf(engine) {
    var b = engine && (engine.beam || engine);
    if (!b || !b.ok || !b.R || !b.G || !b.sh || !b.s) throw new Error('RefractMesh: no shape loaded yet');
    return { R: b.R, G: b.G, size: b.s, shape: { depth: b.sh.depth, bevel: b.sh.bevel, inflate: b.sh.inflate, inset: b.sh.inset }, extent: [b.ext[0], b.ext[1]] };
  }
  function abortErr() { var e = new Error('Export cancelled'); e.name = 'AbortError'; return e; }

  /** engine -> Promise<{positions, normals, indices, stats}> in logo units (z = depth axis, centred on z=0).
   *  opts: { quality: 'standard'|'high'|'draft', onProgress(f), signal (AbortSignal), worker: bool } */
  function extract(engine, opts) {
    opts = opts || {};
    var src = sourceOf(engine);
    var job = { R: new Float32Array(src.R), G: new Float32Array(src.G), size: src.size, shape: src.shape, extent: src.extent, quality: opts.quality || 'standard', simplify: opts.simplify !== false };
    var onP = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    var signal = opts.signal;
    if (signal && signal.aborted) return Promise.reject(abortErr());
    var canWorker = opts.worker !== false && typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined';
    var runLocal = function () {
      return new Promise(function (resolve, reject) {
        setTimeout(function () { // let the UI paint its busy state first
          if (signal && signal.aborted) { reject(abortErr()); return; }
          try { if (!localBuild) localBuild = refractMeshCore(); resolve(localBuild(job, onP)); } catch (e) { reject(e); }
        }, 30);
      });
    };
    if (!canWorker) return runLocal();
    return new Promise(function (resolve, reject) {
      var w, url;
      try {
        url = URL.createObjectURL(new Blob(['(' + refractMeshCore.toString() + ')();'], { type: 'text/javascript' }));
        w = new Worker(url);
      } catch (e) { if (url) URL.revokeObjectURL(url); runLocal().then(resolve, reject); return; }
      var done = false;
      var finish = function () { done = true; try { w.terminate(); } catch (e) { /* noop */ } URL.revokeObjectURL(url); if (signal) signal.removeEventListener('abort', onAbort); };
      var onAbort = function () { if (done) return; finish(); reject(abortErr()); };
      if (signal) signal.addEventListener('abort', onAbort);
      w.onmessage = function (e) {
        var d = e.data || {};
        if (d.progress != null) { onP(d.progress); return; }
        if (done) return;
        finish();
        if (d.error) reject(new Error(d.error)); else resolve(d.mesh);
      };
      w.onerror = function (ev) { if (done) return; if (ev && ev.preventDefault) ev.preventDefault(); finish(); runLocal().then(resolve, reject); }; // CSP etc.
      w.postMessage(job); // copy, don't transfer: the runLocal() fallback (e.g. CSP blocks blob: workers -> async onerror) still needs job.R/G
    });
  }

  function bounds(pos) {
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < pos.length; i += 3) for (var k = 0; k < 3; k++) { var v = pos[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
    return { min: mn, max: mx };
  }
  function utf8(str) { return new TextEncoder().encode(str); }

  /** glTF 2.0 binary. Metres, +Y up, logo facing +Z, centred, longest side = size (default 0.2 m). */
  function toGLB(mesh, opts) {
    opts = opts || {};
    var name = String(opts.name || 'Refract logo').slice(0, 80);
    var size = opts.size || 0.2, material = opts.material === 'chrome' ? 'chrome' : 'glass';
    var src = mesh.positions, nV = src.length / 3, bb = bounds(src);
    var c = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2];
    var k = size / Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], 1e-9);
    var pos = new Float32Array(src.length);
    for (var i = 0; i < src.length; i += 3) { pos[i] = (src[i] - c[0]) * k; pos[i + 1] = (src[i + 1] - c[1]) * k; pos[i + 2] = (src[i + 2] - c[2]) * k; }
    var nrm = mesh.normals, bp = bounds(pos);
    var big = nV > 65535, ind = big ? new Uint32Array(mesh.indices) : new Uint16Array(mesh.indices);
    var pad4 = function (n) { return (n + 3) & ~3; };
    var offPos = 0, offNrm = pad4(pos.byteLength), offIdx = offNrm + pad4(nrm.byteLength), binLen = pad4(offIdx + ind.byteLength);
    var thickness = (bb.max[2] - bb.min[2]) * k;
    var mat = material === 'glass' ? {
      name: 'Refract glass',
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.02 },
      extensions: {
        KHR_materials_transmission: { transmissionFactor: 1 },
        KHR_materials_ior: { ior: 1.5 },
        KHR_materials_volume: { thicknessFactor: +thickness.toFixed(5) },
        KHR_materials_dispersion: { dispersion: 1 } // 20/Abbe: Abbe ≈ 20, a strong flint — visible fringes like the on-screen fan
      }
    } : {
      name: 'Refract chrome',
      pbrMetallicRoughness: { baseColorFactor: [0.96, 0.96, 0.97, 1], metallicFactor: 1, roughnessFactor: 0.05 }
    };
    var json = {
      asset: { version: '2.0', generator: 'Refract (refract mesh export)' },
      extensionsUsed: material === 'glass' ? ['KHR_materials_transmission', 'KHR_materials_ior', 'KHR_materials_volume', 'KHR_materials_dispersion'] : undefined,
      scene: 0,
      scenes: [{ name: name, nodes: [0] }],
      nodes: [{ name: name, mesh: 0 }],
      meshes: [{ name: name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0, mode: 4 }] }],
      materials: [mat],
      buffers: [{ byteLength: binLen }],
      bufferViews: [
        { buffer: 0, byteOffset: offPos, byteLength: pos.byteLength, byteStride: 12, target: 34962 },
        { buffer: 0, byteOffset: offNrm, byteLength: nrm.byteLength, byteStride: 12, target: 34962 },
        { buffer: 0, byteOffset: offIdx, byteLength: ind.byteLength, target: 34963 }
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: nV, type: 'VEC3', min: bp.min.map(Math.fround), max: bp.max.map(Math.fround) },
        { bufferView: 1, componentType: 5126, count: nV, type: 'VEC3' },
        { bufferView: 2, componentType: big ? 5125 : 5123, count: ind.length, type: 'SCALAR' }
      ]
    };
    if (!json.extensionsUsed) delete json.extensionsUsed;
    var jb = utf8(JSON.stringify(json)), jLen = pad4(jb.length);
    var total = 12 + 8 + jLen + 8 + binLen, out = new Uint8Array(total), dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
    dv.setUint32(12, jLen, true); dv.setUint32(16, 0x4E4F534A, true);
    out.set(jb, 20); for (i = 20 + jb.length; i < 20 + jLen; i++) out[i] = 0x20;
    var b0 = 20 + jLen; dv.setUint32(b0, binLen, true); dv.setUint32(b0 + 4, 0x004E4942, true);
    var d0 = b0 + 8;
    out.set(new Uint8Array(pos.buffer, pos.byteOffset, pos.byteLength), d0 + offPos);
    out.set(new Uint8Array(nrm.buffer, nrm.byteOffset, nrm.byteLength), d0 + offNrm);
    out.set(new Uint8Array(ind.buffer, ind.byteOffset, ind.byteLength), d0 + offIdx);
    return out;
  }

  /** Binary STL. Millimetres, Z up, lying flat on the plate (min z = 0), longest side = size (default 100 mm). */
  function toSTL(mesh, opts) {
    opts = opts || {};
    var size = opts.size || 100, src = mesh.positions, I = mesh.indices, bb = bounds(src);
    var c = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2];
    var k = size / Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], 1e-9);
    var nT = I.length / 3, out = new Uint8Array(84 + nT * 50), dv = new DataView(out.buffer);
    var head = utf8(('Refract STL ' + String(opts.name || '')).slice(0, 79));
    out.set(head, 0); dv.setUint32(80, nT, true);
    var X = function (i) { return (src[3 * i] - c[0]) * k; }, Y = function (i) { return (src[3 * i + 1] - c[1]) * k; }, Zf = function (i) { return (src[3 * i + 2] - bb.min[2]) * k; };
    var o = 84;
    for (var t = 0; t < nT; t++) {
      var a = I[3 * t], b = I[3 * t + 1], cc = I[3 * t + 2];
      var ax = X(a), ay = Y(a), az = Zf(a), bx = X(b), by = Y(b), bz = Zf(b), cx = X(cc), cy = Y(cc), cz = Zf(cc);
      var ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, nl = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(o, nx / nl, true); dv.setFloat32(o + 4, ny / nl, true); dv.setFloat32(o + 8, nz / nl, true);
      dv.setFloat32(o + 12, ax, true); dv.setFloat32(o + 16, ay, true); dv.setFloat32(o + 20, az, true);
      dv.setFloat32(o + 24, bx, true); dv.setFloat32(o + 28, by, true); dv.setFloat32(o + 32, bz, true);
      dv.setFloat32(o + 36, cx, true); dv.setFloat32(o + 40, cy, true); dv.setFloat32(o + 44, cz, true);
      dv.setUint16(o + 48, 0, true); o += 50;
    }
    return out;
  }

  /** One-shot: engine -> Promise<{ bytes: Uint8Array, mime, ext, stats }>. format 'glb' | 'stl'. */
  function exportFile(engine, format, opts) {
    opts = opts || {};
    var material = opts.material || (engine && engine.getMaterial ? engine.getMaterial() : 'glass');
    return extract(engine, opts).then(function (mesh) {
      if (opts.signal && opts.signal.aborted) throw abortErr();
      var bytes = format === 'stl' ? toSTL(mesh, opts) : toGLB(mesh, { name: opts.name, material: material, size: opts.size });
      return { bytes: bytes, mime: format === 'stl' ? 'model/stl' : 'model/gltf-binary', ext: format === 'stl' ? 'stl' : 'glb', stats: mesh.stats, mesh: mesh };
    });
  }

  global.RefractMesh = { extract: extract, toGLB: toGLB, toSTL: toSTL, export: exportFile, _core: refractMeshCore };
})(typeof window !== 'undefined' ? window : this);
