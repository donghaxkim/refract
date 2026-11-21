/* Spectra engine v2 — "clean" renderer.
 * Your logo is the prism: a white light beam (CPU-traced through the logo's 2D distance field, 48
 * wavelengths × 9 slices) enters, refracts, and leaves as a continuous rainbow fan. The logo itself is
 * an analytically extruded SDF, raymarched deterministically: dark dielectric glass that refracts the
 * lit scene behind it, or studio chrome. No Monte-Carlo noise anywhere; frames only accumulate for
 * antialiasing and spectral smoothness while the image is still.
 * Zero dependencies (mp4-muxer is lazy-loaded only for MP4 export).
 */
(function () {
  'use strict';
  const DEG = Math.PI / 180;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // ───────────────────────────────────────── optics constants
  const IOR = 1.5, CAUCHY_B = 0.065;              // stylised flint: strong, clean fan
  const iorAt = (lamNm) => { const l = lamNm * 0.001; return IOR + CAUCHY_B * (1 / (l * l) - 1 / (0.5876 * 0.5876)); };
  const BEAM_WAVES = 56, BEAM_SLICES = 1, BEAM_WIDTH = 0.034;

  // CIE 1931 fit → linear sRGB (clamped), normalised so an even spread of N wavelengths sums to white
  function g1(x, mu, s1, s2) { const t = (x - mu) / (x < mu ? s1 : s2); return Math.exp(-0.5 * t * t); }
  function lamRGB(l) {
    const X = 1.056 * g1(l, 599.8, 37.9, 31.0) + 0.362 * g1(l, 442.0, 16.0, 26.7) - 0.065 * g1(l, 501.1, 20.4, 26.2);
    const Y = 0.821 * g1(l, 568.8, 46.9, 40.5) + 0.286 * g1(l, 530.9, 16.3, 31.1);
    const Z = 1.217 * g1(l, 437.0, 11.8, 36.0) + 0.681 * g1(l, 459.0, 26.0, 13.8);
    return [Math.max(0, 3.2406 * X - 1.5372 * Y - 0.4986 * Z), Math.max(0, -0.9689 * X + 1.8758 * Y + 0.0415 * Z), Math.max(0, 0.0557 * X - 0.2040 * Y + 1.0570 * Z)];
  }
  // Zucconi's 6-bump spectral fit: smooth rainbow with real yellows/cyans (looks far better than clamped CIE)
  function zucconi(w) {
    const x = clamp((w - 400) / 300, 0, 1);
    const b = (c, x0, y0) => Math.max(0, 1 - (c * (x - x0)) * (c * (x - x0)) - y0);
    const C1 = [3.54585104, 2.93225262, 2.41593945], X1 = [0.69549072, 0.49228336, 0.27699880], Y1 = [0.02312639, 0.15225084, 0.52607955];
    const C2 = [3.90307140, 3.21182957, 3.96587128], X2 = [0.11748627, 0.86755042, 0.66077860], Y2 = [0.84897130, 0.88445281, 0.73949448];
    return [0, 1, 2].map(i => b(C1[i], X1[i], Y1[i]) + b(C2[i], X2[i], Y2[i]));
  }
  function specNorm(lo, hi, N) {
    const a = [0, 0, 0];
    for (let i = 0; i < N; i++) { const c = zucconi(lo + (hi - lo) * (i + 0.5) / N); a[0] += c[0]; a[1] += c[1]; a[2] += c[2]; }
    return a.map(v => N / v);
  }
  let SPEC_NORM_SHADER;
  SPEC_NORM_SHADER = specNorm(400, 700, 4000);
  const BEAM_COLORS = (() => {
    const n = specNorm(400, 700, BEAM_WAVES); const out = [];
    for (let i = 0; i < BEAM_WAVES; i++) { const l = 400 + 300 * (i + 0.5) / BEAM_WAVES; const c = zucconi(l); out.push({ lam: l, rgb: [c[0] * n[0], c[1] * n[1], c[2] * n[2]] }); }
    return out;
  })();

  // ───────────────────────────────────────── shaders
  const VERT = `#version 300 es
  layout(location=0) in vec2 aPos; out vec2 vUv;
  void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }`;

  const BG_FRAG = `#version 300 es
  precision highp float; in vec2 vUv; out vec4 o;
  uniform vec3 uBg; uniform vec2 uRes, uCenter, uJitter; uniform int uMode;
  uniform sampler2D uField; uniform mat3 uRotT; uniform float uCamDist, uTanFov, uShadow, uEnvYaw;
  float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
  float vn(vec2 x){ vec2 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
    return mix(mix(h12(i),h12(i+vec2(1,0)),f.x), mix(h12(i+vec2(0,1)),h12(i+vec2(1,1)),f.x), f.y); }
  void main(){
    vec2 ndc = (gl_FragCoord.xy + uJitter)/uRes*2.0 - 1.0 - uCenter;
    if (uMode == 0){ vec2 q = ndc; q.x *= uRes.x/uRes.y; float g = exp(-dot(q,q)*0.7); float n = (vn(gl_FragCoord.xy*0.35) - 0.5)*0.05 + (h12(gl_FragCoord.xy) - 0.5)*0.03;
      o = vec4(uBg*(0.95 + 0.6*g + n) + vec3(0.0006,0.0007,0.0011)*(1.0-g), 1.0); return; }
    // light: a paper wall 1.3 units behind the logo, lit by a soft window from the upper left
    vec3 rd = normalize(vec3(ndc.x*(uRes.x/uRes.y)*uTanFov, ndc.y*uTanFov, -1.0));
    float t = (uCamDist + 1.3)/(-rd.z); vec3 W = vec3(0.0,0.0,uCamDist) + rd*t;
    vec2 w = W.xy;
    float lit = 0.86 + 0.16*smoothstep(1.8, -1.2, w.x - w.y*0.6) - 0.06*smoothstep(0.6, 2.6, length(w*vec2(0.55,0.8)));
    // window mullions: soft diagonal bars of shadow (gobo)
    vec2 g = mat2(0.906,-0.423,0.423,0.906)*(w + vec2(uEnvYaw*0.6, 0.0)) + vec2(1.4,0.3);
    float bars = smoothstep(0.05, 0.16, abs(fract(g.x*0.55)-0.5)) * smoothstep(0.04, 0.14, abs(fract(g.y*0.42)-0.5));
    float win = smoothstep(2.6, 0.4, length((g - vec2(0.2,0.1))*vec2(0.55,0.75)));
    lit *= mix(1.0, mix(0.9, 1.06, bars), win);
    // soft shadow of the logo, projected along the window light onto the wall
    vec3 Ls = normalize(vec3(-0.42 + uEnvYaw*0.35, 0.5, 1.0));
    vec3 P = W + Ls*(1.3/Ls.z); vec3 pl = uRotT*P;
    vec2 uv = clamp(vec2(pl.x*0.5+0.5, 0.5-pl.y*0.5), 0.0, 1.0);
    float d = texture(uField, uv).g + length(max(abs(pl.xy)-1.0, 0.0));
    float sh = smoothstep(0.12, -0.08, d);
    sh *= uShadow > 1.2 ? 0.55 : (0.42 - 0.22*smoothstep(-0.03, -0.14, d)); // glass: lighter core, darker rim
    lit *= 1.0 - sh;
    float paper = (vn(gl_FragCoord.xy*0.35) - 0.5)*0.025 + (h12(gl_FragCoord.xy) - 0.5)*0.012;
    o = vec4(uBg*(lit + paper), 1.0);
  }`;

  const BEAM_VERT = `#version 300 es
  layout(location=0) in vec3 aPos; layout(location=1) in vec3 aCol; layout(location=2) in float aV;
  uniform mat4 uVP; out vec3 vCol; out float vV;
  void main(){ gl_Position = uVP*vec4(aPos,1.0); vCol = aCol; vV = aV; }`;
  const BEAM_FRAG = `#version 300 es
  precision highp float; in vec3 vCol; in float vV; out vec4 o;
  void main(){ float r = abs(vV); float f = exp(-3.4*r*r)*(1.0-smoothstep(0.62,1.0,r)); o = vec4(vCol*f, 0.0); }`;

  const DUST_VERT = `#version 300 es
  layout(location=0) in vec4 aP; // xyz, seed
  uniform mat4 uVPw; uniform float uTime, uPx, uFlipY; uniform sampler2D uGlow;
  out float vB;
  float h(float n){ return fract(sin(n*91.345)*47453.21); }
  void main(){
    float s = aP.w;
    vec3 p = aP.xyz + vec3(sin(uTime*6.2831853/12.0 + s*40.0)*0.08, sin(uTime*6.2831853/6.0 + s*17.0)*0.05, 0.0);
    vec4 c = uVPw*vec4(p,1.0); gl_Position = c;
    vec2 uv = c.xy/c.w*0.5+0.5; if (uFlipY > 0.5) uv.y = 1.0-uv.y;
    vec3 g = texture(uGlow, uv).rgb; float lit = dot(g, vec3(0.2126,0.7152,0.0722));
    float tw = 0.55 + 0.45*sin(uTime*6.2831853*(1.0/3.0 + floor(h(s)*3.0)/3.0) + s*30.0);
    vB = (0.012 + lit*1.6)*tw;
    gl_PointSize = uPx*(0.9 + 1.8*h(s+1.0))*(4.2/max(c.w,0.5));
  }`;
  const DUST_FRAG = `#version 300 es
  precision highp float; in float vB; out vec4 o;
  void main(){ vec2 q = gl_PointCoord*2.0-1.0; float d = dot(q,q); float a = exp(-d*3.0)*(1.0-step(1.0,d)); o = vec4(vec3(1.0)*vB*a, 0.0); }`;

  const COMMON = `
  float g1(float x, float mu, float s1, float s2){ float t = (x-mu)/(x<mu?s1:s2); return exp(-0.5*t*t); }
  vec3 cieXYZ(float l){
    return vec3(1.056*g1(l,599.8,37.9,31.0)+0.362*g1(l,442.0,16.0,26.7)-0.065*g1(l,501.1,20.4,26.2),
                0.821*g1(l,568.8,46.9,40.5)+0.286*g1(l,530.9,16.3,31.1),
                1.217*g1(l,437.0,11.8,36.0)+0.681*g1(l,459.0,26.0,13.8)); }
  vec3 xyz2rgb(vec3 c){ return mat3(3.2406,-0.9689,0.0557, -1.5372,1.8758,-0.2040, -0.4986,0.0415,1.0570)*c; }`;

  const GLASS_FRAG = `#version 300 es
  precision highp float; precision highp int;
  in vec2 vUv; out vec4 outColor;
  uniform sampler2D uField, uScene, uPrev; uniform float uFieldSize, uNormEps, uBlend;
  uniform vec2 uRes, uJitter, uCenter; uniform float uLamOffset;
  uniform mat3 uRotT; uniform mat4 uVP; uniform float uCamDist, uTanFov;
  uniform vec3 uBox; uniform float uDepth, uBevel, uInflate, uMaxInset;
  uniform int uMaterial; uniform float uIor, uCauchyB; uniform vec3 uAbsorb; uniform float uBgDepth, uEnvThrough;
  uniform vec3 uChromeTint; uniform float uSpectral;
  uniform int uLightCount; uniform vec3 uLD[6]; uniform vec3 uLT[6]; uniform vec3 uLB[6]; uniform vec2 uLS[6]; uniform vec3 uLC[6]; uniform int uLK[6];
  uniform float uAmbient, uHorizon; uniform vec3 uUp; uniform vec3 uSpecNorm; uniform float uSky, uGround, uSceneFloor; uniform int uDebug;
  ${COMMON}
  vec3 bump3(vec3 x, vec3 y){ vec3 r = 1.0 - x*x; return clamp(r - y, 0.0, 1.0); }
  vec3 zucconi(float w){ float x = clamp((w-400.0)/300.0, 0.0, 1.0);
    return bump3(vec3(3.54585104,2.93225262,2.41593945)*(x-vec3(0.69549072,0.49228336,0.27699880)), vec3(0.02312639,0.15225084,0.52607955))
         + bump3(vec3(3.90307140,3.21182957,3.96587128)*(x-vec3(0.11748627,0.86755042,0.66077860)), vec3(0.84897130,0.88445281,0.73949448)); }
  vec3 specW(float l){ return zucconi(l)*uSpecNorm; }
  vec2 toUv(vec2 p){ return vec2(p.x*0.5+0.5, 0.5-p.y*0.5); }
  float outside(vec2 p){ return length(max(abs(p)-1.0, 0.0)); }
  vec2 fieldB(vec2 p){ return texture(uField, clamp(toUv(p),0.0,1.0)).rg + outside(p); }
  vec2 fieldS(vec2 p){
    vec2 st = clamp(toUv(p),0.0,1.0)*uFieldSize - 0.5; vec2 i = floor(st); vec2 f = st - i;
    vec2 f2 = f*f, f3 = f2*f;
    vec2 w0 = (1.0-3.0*f+3.0*f2-f3)/6.0, w1 = (4.0-6.0*f2+3.0*f3)/6.0, w2 = (1.0+3.0*f+3.0*f2-3.0*f3)/6.0, w3 = f3/6.0;
    vec2 g0 = w0+w1, g1v = w2+w3; vec2 h0 = (i-0.5+w1/g0)/uFieldSize, h1 = (i+1.5+w3/g1v)/uFieldSize;
    vec2 a = texture(uField, vec2(h0.x,h0.y)).rg, b = texture(uField, vec2(h1.x,h0.y)).rg;
    vec2 c = texture(uField, vec2(h0.x,h1.y)).rg, d = texture(uField, vec2(h1.x,h1.y)).rg;
    return g0.y*(g0.x*a+g1v.x*b) + g1v.y*(g0.x*c+g1v.x*d) + outside(p);
  }
  float extrude(vec3 p, vec2 dd){
    float d2 = dd.x; float hz = uDepth;
    if (uInflate > 0.0){ float k = clamp(-dd.y/max(uMaxInset,1e-3),0.0,1.0); float pk = 1.0-(1.0-k)*(1.0-k); hz *= mix(1.0, 0.3+0.7*pk, uInflate); } // smooth dome, bounded slope
    float r = min(uBevel, hz*0.98);
    vec2 w = vec2(d2 + r, abs(p.z) - hz + r);
    return min(max(w.x,w.y),0.0) + length(max(w,0.0)) - r;
  }
  float mapB(vec3 p){ return extrude(p, fieldB(p.xy)); }
  float mapS(vec3 p){ return extrude(p, fieldS(p.xy)); }
  vec3 normalAt(vec3 p){ const vec2 k = vec2(1.0,-1.0); float e = uNormEps;
    return normalize(k.xyy*mapS(p+k.xyy*e) + k.yyx*mapS(p+k.yyx*e) + k.yxy*mapS(p+k.yxy*e) + k.xxx*mapS(p+k.xxx*e)); }
  vec2 boxHit(vec3 ro, vec3 rd){ vec3 inv = 1.0/rd; vec3 t0 = (-uBox-ro)*inv, t1 = (uBox-ro)*inv;
    vec3 a = min(t0,t1), b = max(t0,t1); return vec2(max(max(a.x,a.y),a.z), min(min(b.x,b.y),b.z)); }
  bool marchOut(vec3 ro, vec3 rd, float t0, float t1, out float t, bool primary){
    // inflated faces are not an exact distance field: step conservatively; hit tolerance grows with distance (≈ pixel cone)
    t = t0; float sc = uInflate > 0.0 ? 0.6 : 0.85; float dmin = 1e9;
    for (int i=0;i<260;i++){ float d = mapB(ro+rd*t); float eps = 0.00015 + t*0.00018; if (d < eps) return true; dmin = min(dmin, d); t += max(d*sc, 0.00008); if (t > t1) break; }
    return primary && dmin < 0.0012 && t <= t1 + 0.01; // grazing silhouette: treat a near miss as a hit instead of a dotted gap
  }
  float marchIn(vec3 ro, vec3 rd){ float t = 0.004; float sc = uInflate > 0.0 ? 0.6 : 0.85;
    for (int i=0;i<140;i++){ float d = -mapB(ro+rd*t); if (d < 0.0002) break; t += max(d*sc, 0.0002); } return t; }
  vec3 env(vec3 d){
    float up = dot(d,uUp);
    vec3 c = vec3(uAmbient*(0.25+0.75*clamp(up*0.5+0.5,0.0,1.0))) + vec3(uHorizon*exp(-abs(up)*9.0));
    if (uSky > 0.0){ // chrome studio: graded sky above, dark ground below, a crisp bright horizon between
      float sky = mix(0.05, 0.9, pow(clamp(up,0.0,1.0), 0.7));
      float edge = smoothstep(-0.012, 0.012, up);
      c += uSky*(mix(vec3(uGround), vec3(sky), edge) + vec3(3.2)*exp(-abs(up-0.018)*160.0));
    }
    for (int i=0;i<6;i++){
      if (i>=uLightCount) break;
      float cz = dot(d, uLD[i]); if (cz <= 0.03) continue;
      vec2 a = vec2(atan(dot(d,uLT[i]), cz), atan(dot(d,uLB[i]), cz));
      vec2 hs = uLS[i]; float mn = min(hs.x,hs.y); float rad = mn*0.9;
      vec2 q = abs(a) - hs + rad; float sd = length(max(q,0.0)) + min(max(q.x,q.y),0.0) - rad;
      float soft = (uLK[i]==1) ? 0.45*mn : 0.004 + 0.1*mn;
      float m = 1.0 - smoothstep(-soft, soft, sd);
      m *= mix(0.6, 1.0, 1.0 - abs(a.y/hs.y)); // softbox falloff along length
      c += uLC[i]*m;
    }
    return c;
  }
  float fresnel(float ci, float n1, float n2){
    float eta = n1/n2; float st2 = eta*eta*(1.0-ci*ci); if (st2 >= 1.0) return 1.0;
    float ct = sqrt(1.0-st2); float rs = (n1*ci-n2*ct)/(n1*ci+n2*ct); float rp = (n1*ct-n2*ci)/(n1*ct+n2*ci);
    return 0.5*(rs*rs+rp*rp);
  }
  float iorAt(float lam){ float lm = lam*0.001; return uIor + uCauchyB*(1.0/(lm*lm) - 2.89617); }
  vec2 projUv(vec3 p){ vec4 c = uVP*vec4(p,1.0); return c.xy/max(c.w,1e-4)*0.5+0.5; }
  vec3 scene(vec2 uv){ return texture(uScene, clamp(uv, vec2(0.0005), vec2(0.9995))).rgb; }
  vec3 panelHighlight(vec3 R, float ci){
    float lum = dot(R, vec3(0.2126,0.7152,0.0722));
    return R*smoothstep(0.6, 2.4, lum)*0.22*(0.65+0.35*pow(1.0-ci,1.5));
  }
  vec3 shadeGlass(vec3 p, vec3 n, vec3 rd){
    float ci = clamp(-dot(rd,n),0.0,1.0);
    float F = fresnel(ci, 1.0, uIor);
    vec3 R = env(reflect(rd,n));
    vec3 col = R*F + panelHighlight(R, ci);
    vec3 acc = vec3(0.0), wsum = vec3(0.0);
    const int K = 6;
    for (int k=0;k<K;k++){
      float lam = 400.0 + 300.0*fract((float(k)+0.5)/float(K) + uLamOffset);
      vec3 w = specW(lam); float nl = iorAt(lam);
      vec3 dir = refract(rd, n, 1.0/nl);
      vec3 pos = p - n*0.0012; float thr = 1.0-F; vec3 L = vec3(0.0); vec3 trans = vec3(1.0);
      for (int b=0;b<2;b++){
        float tl = marchIn(pos, dir); vec3 q = pos + dir*tl; vec3 nq = normalAt(q);
        trans *= exp(-uAbsorb*tl);
        vec3 td = refract(dir, -nq, nl);
        if (dot(td,td) > 0.5){
          float c = clamp(dot(dir,nq),0.0,1.0); float Fi = fresnel(c, nl, 1.0);
          vec3 behind = scene(projUv(q + td*uBgDepth)) + env(td)*uEnvThrough;
          L += thr*(1.0-Fi)*trans*behind;
          thr *= Fi;
        }
        dir = reflect(dir, -nq); pos = q - nq*0.0012;
        if (thr < 0.02) break;
      }
      acc += L*w; wsum += w;
    }
    return col + acc/max(wsum, vec3(0.1));
  }
  vec3 shadeChrome(vec3 p, vec3 n, vec3 rd){
    vec3 r = reflect(rd, n); if (dot(r,n) < 0.0) r = reflect(r,n);
    float ci = clamp(-dot(rd,n),0.0,1.0);
    vec3 F0 = uChromeTint; vec3 Fm = F0 + (1.0-F0)*pow(1.0-ci,5.0);
    vec3 sdir = r, sn = n, extra = vec3(1.0); float t2;
    vec3 ro2 = p + n*0.003; vec2 bh = boxHit(ro2, r);
    if (bh.y > 0.0 && marchOut(ro2, r, max(bh.x,0.006), bh.y, t2, false) && t2 > 0.012){
      vec3 p2 = ro2 + r*t2; vec3 n2 = normalAt(p2); float c2 = clamp(-dot(r,n2),0.0,1.0);
      extra = F0 + (1.0-F0)*pow(1.0-c2,5.0); sdir = reflect(r,n2); sn = n2;
    }
    vec3 tg = sdir - sn*dot(sdir,sn); float tl = length(tg); tg = tl > 1e-4 ? tg/tl : vec3(0.0);
    vec3 acc = vec3(0.0), wsum = vec3(0.0);
    for (int k=0;k<6;k++){
      float lam = 400.0 + 300.0*fract((float(k)+0.5)/6.0 + uLamOffset);
      vec3 d = normalize(sdir + tg*((lam-550.0)/145.0)*uSpectral);
      vec3 w = specW(lam); acc += env(d)*w; wsum += w;
    }
    vec3 L = acc/max(wsum, vec3(0.1));
    L += max(scene(projUv(p + r*0.5)) - uSceneFloor, 0.0)*0.9; // only the beam glints on the metal, not the wall behind it
    return L*Fm*extra;
  }
  void main(){
    vec2 ndc = (gl_FragCoord.xy + uJitter)/uRes*2.0 - 1.0 - uCenter;
    vec3 rdW = normalize(vec3(ndc.x*(uRes.x/uRes.y)*uTanFov, ndc.y*uTanFov, -1.0));
    vec3 ro = uRotT*vec3(0.0,0.0,uCamDist); vec3 rd = uRotT*rdW;
    vec3 c = scene(gl_FragCoord.xy/uRes); float cov = 0.0;
    vec2 bh = boxHit(ro, rd); float t;
    if (uDepth > 0.0 && bh.x < bh.y && bh.y > 0.0 && marchOut(ro, rd, max(bh.x,0.0), bh.y, t, true)){
      vec3 p = ro + rd*t; vec3 n = normalAt(p);
      c = uMaterial == 0 ? shadeGlass(p, n, rd) : shadeChrome(p, n, rd);
      if (uDebug == 1) c = n*0.5+0.5;
      if (uDebug == 2) c = vec3(fract(p.z*40.0), mapB(p)*500.0+0.5, -mapB(p)*500.0);
      cov = 1.0;
    }
    vec4 cur = vec4(min(c, vec3(48.0)), cov);
    vec4 prev = texelFetch(uPrev, ivec2(gl_FragCoord.xy), 0);
    outColor = mix(prev, cur, uBlend);
  }`;

  const BLOOM_PRE = `#version 300 es
  precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uThreshold;
  vec3 pre(vec3 c){ float b = max(c.r,max(c.g,c.b)); float knee = uThreshold*0.7;
    float s = clamp(b - uThreshold + knee, 0.0, 2.0*knee); s = s*s/(4.0*knee+1e-4); return c*max(s, b-uThreshold)/max(b,1e-4); }
  void main(){ vec2 h = uTexel*0.5;
    vec3 c = pre(texture(uSrc,vUv).rgb)*4.0 + pre(texture(uSrc,vUv+vec2(-h.x,-h.y)).rgb) + pre(texture(uSrc,vUv+vec2(h.x,-h.y)).rgb)
           + pre(texture(uSrc,vUv+vec2(-h.x,h.y)).rgb) + pre(texture(uSrc,vUv+vec2(h.x,h.y)).rgb);
    o = vec4(c/8.0, 1.0); }`;
  const BLOOM_DOWN = `#version 300 es
  precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D uSrc; uniform vec2 uTexel;
  void main(){ vec2 h = uTexel;
    vec3 c = texture(uSrc,vUv).rgb*4.0 + texture(uSrc,vUv-h).rgb + texture(uSrc,vUv+h).rgb + texture(uSrc,vUv+vec2(h.x,-h.y)).rgb + texture(uSrc,vUv+vec2(-h.x,h.y)).rgb;
    o = vec4(c/8.0, 1.0); }`;
  const BLOOM_UP = `#version 300 es
  precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D uSrc; uniform vec2 uTexel;
  void main(){ vec2 h = uTexel;
    vec3 c = texture(uSrc,vUv+vec2(-h.x*2.0,0.0)).rgb + texture(uSrc,vUv+vec2(h.x*2.0,0.0)).rgb + texture(uSrc,vUv+vec2(0.0,-h.y*2.0)).rgb + texture(uSrc,vUv+vec2(0.0,h.y*2.0)).rgb
           + (texture(uSrc,vUv+vec2(-h.x,h.y)).rgb + texture(uSrc,vUv+vec2(h.x,h.y)).rgb + texture(uSrc,vUv+vec2(-h.x,-h.y)).rgb + texture(uSrc,vUv+vec2(h.x,-h.y)).rgb)*2.0;
    o = vec4(c/12.0, 1.0); }`;

  const COMPOSITE = `#version 300 es
  precision highp float; in vec2 vUv; out vec4 o;
  uniform sampler2D uAccum, uBloom; uniform float uExposure, uBloomAmt, uVignette, uFlip, uTransparent; uniform vec2 uOutRes; uniform int uHasBloom, uTone;
  vec3 neutral(vec3 c){ // Khronos PBR Neutral: keeps hues and whites honest for the light theme
    float x = min(c.r, min(c.g, c.b)); float off = x < 0.08 ? x - 6.25*x*x : 0.04; c -= off;
    float peak = max(c.r, max(c.g, c.b)); const float sc = 0.76; if (peak < sc) return c;
    const float d = 1.0 - sc; float np = 1.0 - d*d/(peak + d - sc); c *= np/peak;
    float g = 1.0 - 1.0/(0.15*(peak - np) + 1.0); return mix(c, vec3(np), g); }
  vec3 agxCurve(vec3 x){ vec3 x2 = x*x, x4 = x2*x2; return 15.5*x4*x2 - 40.14*x4*x + 31.96*x4 - 6.868*x2*x + 0.4298*x2 + 0.1191*x - 0.00232; }
  vec3 agx(vec3 v){ const mat3 m = mat3(0.842479062253094,0.0423282422610123,0.0423756549057051, 0.0784335999999992,0.878468636469772,0.0784336, 0.0792237451477643,0.0791661274605434,0.879142973793104);
    const float lo = -12.47393, hi = 4.026069; v = m*v; v = clamp(log2(max(v,1e-10)), lo, hi); v = (v-lo)/(hi-lo); return agxCurve(v); }
  vec3 look(vec3 v){ float l = dot(v, vec3(0.2126,0.7152,0.0722)); v = pow(max(v,0.0), vec3(1.3)); l = pow(max(l,0.0), 1.3); return l + 1.45*(v-l); }
  vec3 agxEotf(vec3 v){ const mat3 mi = mat3(1.19687900512017,-0.0528968517574562,-0.0529716355144438, -0.0980208811401368,1.15190312990417,-0.0980434501171241, -0.0990297440797205,-0.0989611768448433,1.15107367264116);
    return pow(max(mi*v,0.0), vec3(2.2)); }
  vec3 toSrgb(vec3 c){ c = clamp(c,0.0,1.0); return mix(c*12.92, 1.055*pow(c,vec3(1.0/2.4))-0.055, step(0.0031308,c)); }
  float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
  void main(){
    vec2 uv = vUv; if (uFlip > 0.5) uv.y = 1.0-uv.y;
    vec4 a = texture(uAccum, uv);
    vec3 bl = uHasBloom == 1 ? texture(uBloom, uv).rgb : vec3(0.0);
    vec3 hdr = (max(a.rgb,0.0) + bl*uBloomAmt)*uExposure;
    vec3 c = uTone == 1 ? toSrgb(neutral(hdr)) : toSrgb(agxEotf(look(agx(hdr))));
    vec2 q = (uv-0.5)*vec2(uOutRes.x/uOutRes.y,1.0);
    c *= 1.0 - uVignette*smoothstep(0.3, 1.1, length(q)*1.1);
    c += (h12(gl_FragCoord.xy) - 0.5)/255.0;
    float al = 1.0;
    if (uTransparent > 0.5){ al = clamp(max(a.a, max(c.r,max(c.g,c.b))*1.2), 0.0, 1.0); c = al > 0.0 ? c/al : c; }
    o = vec4(clamp(c,0.0,1.0), al);
  }`;

  // ───────────────────────────────────────── material looks (art-directed, not user-tunable)
  const LOOKS = {
    glass: {
      shape: { depth: 0.16, bevel: 0.15, inflate: 0.75 },
      absorb: [0.22, 0.16, 0.1], bgDepth: 0.3, envThrough: 0.14,
      ambient: 0.004, horizon: 0.0, bg: [0.0035, 0.0035, 0.0042],
      exposure: 1.1, bloom: 0.4, vignette: 0.32,
      lights: [ // az/el deg, w/h deg, intensity, kind 0 strip / 1 soft panel, rot deg, colour
        { az: -58, el: 12, w: 2.2, h: 90, i: 9, kind: 0, rot: -8, col: [0.86, 0.93, 1.0] },
        { az: 64, el: 20, w: 1.8, h: 80, i: 6, kind: 0, rot: 10, col: [1, 1, 1] },
        { az: 4, el: 62, w: 110, h: 5, i: 3.2, kind: 0, rot: 0, col: [1, 1, 1] },
        { az: 0, el: 22, w: 80, h: 34, i: 0.22, kind: 1, rot: 0, col: [1, 1, 1] },
        { az: 170, el: 10, w: 2.4, h: 85, i: 5, kind: 0, rot: 0, col: [1, 1, 1] },
        { az: 180, el: -40, w: 120, h: 30, i: 0.3, kind: 1, rot: 0, col: [1, 0.97, 0.94] },
      ],
    },
    chrome: {
      shape: { depth: 0.15, bevel: 0.15, inflate: 0.8 },
      tint: [0.96, 0.96, 0.97], spectral: 0.0, sky: 1,
      ambient: 0.0, horizon: 0.0, bg: [0.0035, 0.0035, 0.004],
      exposure: 1.0, bloom: 0.45, vignette: 0.32,
      lights: [
        { az: -62, el: 15, w: 4, h: 95, i: 5, kind: 0, rot: -6, col: [0.9, 0.95, 1.0] },
        { az: 66, el: 22, w: 3, h: 85, i: 4.2, kind: 0, rot: 12, col: [1, 1, 1] },
        { az: 0, el: 72, w: 140, h: 26, i: 0.0, kind: 1, rot: 0, col: [1, 1, 1] },
        { az: 8, el: 6, w: 2.4, h: 100, i: 3.0, kind: 0, rot: 30, col: [1, 1, 1] },
        { az: 0, el: -28, w: 150, h: 4, i: 1.4, kind: 0, rot: 0, col: [1, 0.98, 0.95] },
        { az: 180, el: 0, w: 4, h: 90, i: 4, kind: 0, rot: 0, col: [1, 1, 1] },
      ],
    },
  };

  const THEMES = {
    dark: { mode: 0, bg: [0.0125, 0.0125, 0.0142], tone: 0, exposure: 1, bloomK: 1, vignetteK: 0.45, beamK: 1, ambient: null, lightK: 1 },
    light: { mode: 1, bg: [0.74, 0.715, 0.675], tone: 1, exposure: 0.97, bloomK: 0.35, vignetteK: 0.35, beamK: 0.42, ambient: 0.22, lightK: 0.75 },
  };
  // ───────────────────────────────────────── small math
  function hex(v) { return v; }
  const norm3 = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  function rotYX(yaw, pitch) { const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch); return [[cy, sy * sp, sy * cp], [0, cp, -sp], [-sy, cy * sp, cy * cp]]; }
  const mul = (R, v) => [R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2], R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2], R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]];
  const mulT = (R, v) => [R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2], R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2], R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2]];
  // column-major mat4 for clip = P * T(-cam) * R   (R optional), matching the raymarch camera exactly
  function viewProj(R, dist, tanF, aspect, cx, cy) {
    const a = 1 / (aspect * tanF), b = 1 / tanF;
    // camera space: xc = (R p).x, yc = (R p).y, zc = (R p).z - dist ; clip.x = a*xc - cx*zc ; clip.y = b*yc - cy*zc ; clip.w = -zc
    const r = R || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const m = new Float32Array(16);
    for (let j = 0; j < 3; j++) { // column j = image of basis vector e_j
      const xc = r[0][j], yc = r[1][j], zc = r[2][j];
      m[j * 4 + 0] = a * xc - cx * zc; m[j * 4 + 1] = b * yc - cy * zc; m[j * 4 + 2] = 0; m[j * 4 + 3] = -zc;
    }
    // translation column (point at origin): zc = -dist
    m[12] = -cx * -dist; m[13] = -cy * -dist; m[14] = 0; m[15] = dist;
    return m;
  }

  // ───────────────────────────────────────── GL helpers
  function compile(gl, type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(s)); return s; }
  function program(gl, vsrc, fsrc) {
    const p = gl.createProgram(); gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsrc)); gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsrc));
    gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }
  function boxBlur(data, size, r, iters) {
    const n = size * size; const a = new Float32Array(data); if (r < 1) return a; const b = new Float32Array(n);
    const pass = (src, dst, horiz) => { const inv = 1 / (2 * r + 1);
      for (let line = 0; line < size; line++) { const base = horiz ? line * size : line, step = horiz ? 1 : size; let acc = 0;
        for (let i = -r; i <= r; i++) acc += src[base + clamp(i, 0, size - 1) * step];
        for (let i = 0; i < size; i++) { dst[base + i * step] = acc * inv; acc += src[base + Math.min(size - 1, i + r + 1) * step] - src[base + Math.max(0, i - r) * step]; } } };
    for (let k = 0; k < iters; k++) { pass(a, b, true); pass(b, a, false); }
    return a;
  }
  // Blur radii scale with the thickest stroke (maxInset): a fixed radius wrecked thin shapes like typed letters.
  function heavyField(data, size, maxInset) {
    const px = maxInset * size / 2; const r = clamp(Math.round(px * 0.4), 1, Math.round(size / 1024 * 26));
    const g = boxBlur(data, size, r, 3); let mn = 0; for (let i = 0; i < g.length; i++) if (g[i] < mn) mn = g[i];
    return { g, blurInset: Math.max(-mn, 0.004) };
  }
  function outlineField(data, size, maxInset, roundness) {
    const px = maxInset * size / 2; const r = Math.round(roundness * clamp(px * 0.16, 1, size / 1024 * 6));
    return boxBlur(data, size, r, 2);
  }

  // ───────────────────────────────────────── 3D beam tracer (CPU) through the same rounded solid the GPU renders
  class Beam3D {
    constructor() { this.ok = false; }
    set(fieldR, fieldG, size, shape, extent) { this.R = fieldR; this.G = fieldG; this.s = size; this.sh = shape; this.ext = extent; this.ok = true; }
    f(x, y) { // bilinear [sharp-ish outline, heavy blur] in logo units with outside extension
      const s = this.s, cx = clamp(x, -1, 1), cy = clamp(y, -1, 1);
      const fx = (cx * 0.5 + 0.5) * s - 0.5, fy = (0.5 - cy * 0.5) * s - 0.5;
      const ix = clamp(Math.floor(fx), 0, s - 2), iy = clamp(Math.floor(fy), 0, s - 2);
      const tx = clamp(fx - ix, 0, 1), ty = clamp(fy - iy, 0, 1), i0 = iy * s + ix;
      const o = Math.hypot(Math.max(Math.abs(x) - 1, 0), Math.max(Math.abs(y) - 1, 0));
      const A = this.R, B = this.G;
      const a = (A[i0] * (1 - tx) + A[i0 + 1] * tx) * (1 - ty) + (A[i0 + s] * (1 - tx) + A[i0 + s + 1] * tx) * ty;
      const b = (B[i0] * (1 - tx) + B[i0 + 1] * tx) * (1 - ty) + (B[i0 + s] * (1 - tx) + B[i0 + s + 1] * tx) * ty;
      this._db = b + o; return a + o;
    }
    sdf(x, y, z) { // identical to the shader's extrude()
      const sh = this.sh; const d2 = this.f(x, y), db = this._db;
      let hz = sh.depth;
      if (sh.inflate > 0) { const k = clamp(-db / Math.max(sh.inset, 1e-3), 0, 1); hz *= lerp(1, 0.3 + 0.7 * (1 - (1 - k) * (1 - k)), sh.inflate); }
      const r = Math.min(sh.bevel, hz * 0.98);
      const wx = d2 + r, wy = Math.abs(z) - hz + r;
      return Math.min(Math.max(wx, wy), 0) + Math.hypot(Math.max(wx, 0), Math.max(wy, 0)) - r;
    }
    n(x, y, z) { const h = 0.0025; const gx = this.sdf(x + h, y, z) - this.sdf(x - h, y, z), gy = this.sdf(x, y + h, z) - this.sdf(x, y - h, z), gz = this.sdf(x, y, z + h) - this.sdf(x, y, z - h); const l = Math.hypot(gx, gy, gz) || 1; return [gx / l, gy / l, gz / l]; }
    box(o, d) { const B = [this.ext[0] + 0.04, this.ext[1] + 0.04, this.sh.depth + 0.02]; let t0 = -1e9, t1 = 1e9;
      for (let i = 0; i < 3; i++) { if (Math.abs(d[i]) < 1e-9) { if (Math.abs(o[i]) > B[i]) return null; continue; } let a = (-B[i] - o[i]) / d[i], b = (B[i] - o[i]) / d[i]; if (a > b) [a, b] = [b, a]; t0 = Math.max(t0, a); t1 = Math.min(t1, b); }
      return t1 > Math.max(t0, 0) ? [Math.max(t0, 0), t1] : null; }
    marchOut(o, d) { const bx = this.box(o, d); if (!bx) return -1; let t = bx[0];
      for (let i = 0; i < 400 && t < bx[1]; i++) { const v = this.sdf(o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t); if (v < 0.0007) return t; t += Math.max(v * 0.6, 0.0006); }
      return -1; }
    marchIn(o, d) { let t = 0; for (let i = 0; i < 400; i++) { const v = -this.sdf(o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t); if (v < 0.0007) return t; t += Math.max(v * 0.6, 0.0006); if (t > 4) return -1; } return -1; }
    /** World-space ray → polyline [[x,y,z, sinceExit, total, energy], …] in WORLD space. R = object rotation rows. */
    trace(ow, dw, lam, mirror, R) {
      const toObj = (v) => mulT(R, v), toW = (v) => mul(R, v);
      let p = toObj(ow), v = toObj(dw); const nl = iorAt(lam);
      const pts = []; let total = 0, since = 0, exited = false, energy = 1;
      const push = (q) => { const w = toW(q); pts.push([w[0], w[1], w[2], exited ? since : 0, total, energy]); };
      push(p);
      if (this.ok) for (let ev = 0; ev < 6; ev++) {
        const t = this.marchOut(p, v); if (t < 0) break;
        p = [p[0] + v[0] * t, p[1] + v[1] * t, p[2] + v[2] * t]; total += t; if (exited) since += t; push(p);
        const n = this.n(p[0], p[1], p[2]);
        if (mirror) { const dn = dot3(v, n); v = [v[0] - 2 * dn * n[0], v[1] - 2 * dn * n[1], v[2] - 2 * dn * n[2]]; p = add3(p, n, 0.003); energy *= 0.92; exited = true; since = 0; pts[pts.length - 1][5] = energy; continue; }
        let r = refract3(v, n, 1 / nl);
        if (!r) { const dn = dot3(v, n); v = [v[0] - 2 * dn * n[0], v[1] - 2 * dn * n[1], v[2] - 2 * dn * n[2]]; p = add3(p, n, 0.003); continue; }
        v = r; p = add3(p, n, -0.002);
        let out = false;
        for (let b = 0; b < 5; b++) {
          const ti = this.marchIn(p, v); if (ti < 0) break;
          p = [p[0] + v[0] * ti, p[1] + v[1] * ti, p[2] + v[2] * ti]; total += ti; push(p);
          const m = this.n(p[0], p[1], p[2]);
          const r2 = refract3(v, [-m[0], -m[1], -m[2]], nl);
          if (r2) { v = r2; p = add3(p, m, 0.002); out = true; break; }
          const dn = dot3(v, m); v = [v[0] - 2 * dn * m[0], v[1] - 2 * dn * m[1], v[2] - 2 * dn * m[2]]; p = add3(p, m, -0.002);
          energy *= 0.4; pts[pts.length - 1][5] = energy;
        }
        if (!out) return pts;
        if (exited) { energy *= 0.55; pts[pts.length - 1][5] = energy; }
        exited = true; since = 0;
      }
      const L = 9; const end = [p[0] + v[0] * L, p[1] + v[1] * L, p[2] + v[2] * L]; if (exited) since += L; total += L; push(end);
      return pts;
    }
  }
  const smooth01 = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const add3 = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
  function refract3(v, n, eta) { const c = -dot3(v, n); const k = 1 - eta * eta * (1 - c * c); if (k < 0) return null; const s = eta * c - Math.sqrt(k); return [eta * v[0] + s * n[0], eta * v[1] + s * n[1], eta * v[2] + s * n[2]]; }

  // ───────────────────────────────────────── engine
  class SpectraEngine {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
      if (!gl) throw new Error('WebGL2 is not available in this browser.');
      this.gl = gl;
      const fOK = !!gl.getExtension('EXT_color_buffer_float'); gl.getExtension('OES_texture_float_linear');
      this.hdr = fOK ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT } : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
      this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      this.p = {
        bg: program(gl, VERT, BG_FRAG), beam: program(gl, BEAM_VERT, BEAM_FRAG), dust: program(gl, DUST_VERT, DUST_FRAG),
        glass: program(gl, VERT, GLASS_FRAG), pre: program(gl, VERT, BLOOM_PRE), down: program(gl, VERT, BLOOM_DOWN), up: program(gl, VERT, BLOOM_UP), comp: program(gl, VERT, COMPOSITE),
      };
      // fullscreen triangle
      this.quadVao = gl.createVertexArray(); gl.bindVertexArray(this.quadVao);
      const qb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, qb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      // beam ribbons
      this.beamVao = gl.createVertexArray(); gl.bindVertexArray(this.beamVao);
      this.beamBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.beamBuf);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 12);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 24);
      this.beamCount = 0;
      // dust
      this.dustVao = gl.createVertexArray(); gl.bindVertexArray(this.dustVao);
      const N = 260, dd = new Float32Array(N * 4); let s = 7;
      const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
      for (let i = 0; i < N; i++) { dd.set([(rnd() * 2 - 1) * 3.4, (rnd() * 2 - 1) * 2.0, (rnd() * 2 - 1) * 1.2, rnd()], i * 4); }
      const db = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, db); gl.bufferData(gl.ARRAY_BUFFER, dd, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
      this.dustN = N;
      gl.bindVertexArray(null);
      // field
      this.fieldTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, 1, 1, 0, gl.RG, gl.FLOAT, new Float32Array([1, 1])); this._tp(gl.LINEAR);
      this.field = null; this.fi = { size: 1, extent: [0.5, 0.5], maxInset: 0.05, blurInset: 0.05 };
      this.beam = new Beam3D();

      this.material = 'glass'; this.shape = { thickness: 0.5, roundness: 0.65 }; this.theme = 'dark'; this.lightMode = 'beam'; this.envYaw = 0; this.envYawT = 0;
      this.listeners = {};
      this.time = 0; this.frame = 0; this.samples = 0; this.paused = false;
      this.pointer = null; this.lastPointerT = -1e9;
      this.aim = { ang: Math.PI + 0.22, angV: 0, yaw: 0, pitch: 0 }; // beam direction angle (where the light comes FROM), tilt
      this.target = { ang: Math.PI + 0.22, yaw: 0, pitch: 0 };
      this.rot = { yaw: 0, pitch: 0, vy: 0, vp: 0, drag: false, reset: false };
      this.ins = { r: 0, b: 0 }; this.autoScale = 1; this._ft = 16; this._scaleT = 0;
      this.main = {}; this.busy = false; this._cancel = false; this._lastT = performance.now(); this._fpsA = 0; this._fpsN = 0;
      this.resize();
      this._applyLook();
      this._raf = requestAnimationFrame(this._loop.bind(this));
    }
    // ── API
    on(e, f) { (this.listeners[e] = this.listeners[e] || []).push(f); return () => { this.listeners[e] = this.listeners[e].filter(x => x !== f); }; }
    _emit(e, d) { (this.listeners[e] || []).forEach(f => { try { f(d); } catch (err) { console.error(err); } }); }
    setField(field) {
      if (!field || !field.data) return;
      const gl = this.gl; this.field = field;
      const maxInset = field.maxInset || 0.05;
      const { g, blurInset } = heavyField(field.data, field.size, maxInset); this._fg = g;
      this.fi = { size: field.size, extent: field.extent || [0.78, 0.78], maxInset, blurInset };
      this._uploadField(); this._applyLook(); this._dirty = true; this._emit('ready');
    }
    _uploadField() {
      const f = this.field, gl = this.gl, n = f.size * f.size;
      const r = outlineField(f.data, f.size, this.fi.maxInset, this.shape.roundness); this._fr = r;
      const rg = new Float32Array(n * 2); for (let i = 0; i < n; i++) { rg[2 * i] = r[i]; rg[2 * i + 1] = this._fg[i]; }
      gl.bindTexture(gl.TEXTURE_2D, this.fieldTex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, f.size, f.size, 0, gl.RG, gl.FLOAT, rg); this._tp(gl.LINEAR);
      this._fieldRound = this.shape.roundness;
    }
    /** thickness 0..1 (0.5 = default), roundness 0..1 (0 = crisp edges, 1 = soft pebble) */
    setShape({ thickness, roundness } = {}) {
      if (typeof thickness === 'number') this.shape.thickness = clamp(thickness, 0, 1);
      if (typeof roundness === 'number') this.shape.roundness = clamp(roundness, 0, 1);
      this._applyLook(); this._dirty = true;
      // re-filter the outline (corner rounding) once the slider settles
      clearTimeout(this._rt); if (this.field && Math.abs(this.shape.roundness - this._fieldRound) > 0.02) this._rt = setTimeout(() => { this._uploadField(); this._applyLook(); this._dirty = true; }, 90);
    }
    getShape() { return { ...this.shape }; }
    setTheme(t) { if (!THEMES[t] || t === this.theme) return; this.theme = t; this._applyLook(); this._dirty = true; }
    getTheme() { return this.theme; }
    setLightMode(m) { if (m !== 'beam' && m !== 'studio') return; if (m === this.lightMode) return; this.lightMode = m; this._applyLook(); this._dirty = true; }
    getLightMode() { return this.lightMode; }
    setMaterial(m) { if (m !== 'glass' && m !== 'chrome') return; if (m === this.material) return; this.material = m; this._applyLook(); this._dirty = true; }
    getMaterial() { return this.material; }
    setPointer(x, y) {
      if (x == null || y == null) { this.pointer = null; return; }
      this.pointer = [x, y]; this.lastPointerT = this.time;
    }
    setViewInsets({ right = 0, bottom = 0 } = {}) { if (this.ins.r === right && this.ins.b === bottom) return; this.ins = { r: Math.max(0, right), b: Math.max(0, bottom) }; this._dirty = true; }
    /** Spin the logo (pixels of drag). The beam is re-traced through the rotated solid every frame. */
    beginRotate() { this.rot.drag = true; this.rot.vy = 0; this.rot.vp = 0; this.rot.reset = false; }
    rotateBy(dx, dy) { const k = 0.0085; this.rot.yaw += dx * k; this.rot.pitch = clamp(this.rot.pitch + dy * k, -1.35, 1.35); this.rot.vy = this.rot.vy * 0.5 + dx * k * 30; this.rot.vp = this.rot.vp * 0.5 + dy * k * 30; this.rot.last = performance.now(); }
    endRotate() { this.rot.drag = false; if (performance.now() - (this.rot.last || 0) > 90) { this.rot.vy = 0; this.rot.vp = 0; } }
    resetRotation() { this.rot.reset = true; this.rot.vy = 0; this.rot.vp = 0; }
    togglePause(v) { this.paused = typeof v === 'boolean' ? v : !this.paused; return this.paused; }
    cancelRender() { this._cancel = true; }
    captureStream(fps = 60) { return this.canvas.captureStream ? this.canvas.captureStream(fps) : null; }
    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2); const r = this.canvas.getBoundingClientRect();
      const w = Math.max(2, Math.round((r.width || 800) * dpr)), h = Math.max(2, Math.round((r.height || 600) * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
      this._resizeMain();
    }
    dispose() { cancelAnimationFrame(this._raf); this._disposed = true; }

    // ── internals
    _tp(f) { const gl = this.gl; gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); }
    _target(w, h, hdr = true) {
      const gl = this.gl; const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      if (hdr) gl.texImage2D(gl.TEXTURE_2D, 0, this.hdr.internal, w, h, 0, gl.RGBA, this.hdr.type, null); else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this._tp(gl.LINEAR);
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); return { tex, fb, w, h };
    }
    _pipe(w, h, out) {
      const P = { w, h, scene: this._target(w, h), accum: [this._target(w, h), this._target(w, h)], cur: 0, bloom: [] };
      let bw = w >> 1, bh = h >> 1; for (let i = 0; i < 7 && bw >= 4 && bh >= 4; i++) { P.bloom.push(this._target(bw, bh)); bw >>= 1; bh >>= 1; }
      if (out) P.out = this._target(w, h, false); return P;
    }
    _free(P) { const gl = this.gl; if (!P || !P.scene) return; [P.scene, ...P.accum, ...P.bloom, P.out].forEach(t => { if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); } }); P.scene = null; }
    _internal() {
      const cw = this.canvas.width, ch = this.canvas.height; let s = this.autoScale;
      if (cw * ch * s * s > 3.2e6) s = Math.sqrt(3.2e6 / (cw * ch));
      return [Math.max(2, Math.round(cw * s)), Math.max(2, Math.round(ch * s))];
    }
    _resizeMain() { const [w, h] = this._internal(); if (this.main.scene && this.main.w === w && this.main.h === h) return; this._free(this.main); this.main = this._pipe(w, h); this._dirty = true; }
    _applyLook() {
      const gl = this.gl, L = LOOKS[this.material], u = this.p.glass.u, fi = this.fi;
      gl.useProgram(this.p.glass.p);
      gl.uniform1i(u.uMaterial, this.material === 'glass' ? 0 : 1);
      gl.uniform1f(u.uIor, IOR);
      gl.uniform3fv(u.uAbsorb, L.absorb || [0, 0, 0]); gl.uniform1f(u.uBgDepth, L.bgDepth || 0.3);
      gl.uniform3fv(u.uChromeTint, L.tint || [1, 1, 1]); gl.uniform1f(u.uSpectral, L.spectral || 0);
      gl.uniform1f(u.uSky, L.sky ? (THEMES[this.theme].mode ? 0.62 : 0.8) : 0); gl.uniform1f(u.uGround, THEMES[this.theme].mode ? 0.02 : 0.006); gl.uniform1f(u.uSceneFloor, THEMES[this.theme].mode ? 0.95 : 0.0);
      const T = THEMES[this.theme], studio = this.lightMode === 'studio';
      const chromeM = this.material === 'chrome';
      gl.uniform1f(u.uAmbient, chromeM ? (T.mode ? 0.05 : 0.0) : (T.ambient != null ? T.ambient : (studio ? L.ambient * 3 : L.ambient))); gl.uniform1f(u.uHorizon, chromeM ? 0 : (T.mode ? 0.5 : L.horizon)); gl.uniform3fv(u.uSpecNorm, SPEC_NORM_SHADER);
      gl.uniform1f(u.uEnvThrough, T.mode ? (studio ? 0.25 : 0.08) : (studio ? 0.75 : (L.envThrough || 0)));
      gl.uniform1f(u.uCauchyB, CAUCHY_B * (studio ? 0.5 : 0.22));
      const S = this.shape, th = S.thickness, ro = S.roundness;
      const depth = clamp(L.shape.depth * Math.pow(2, (th - 0.5) * 2.4), 0.012, Math.max(fi.maxInset * (1.6 + 3.4 * th), 0.05));
      const bevelMax = Math.min(depth * 0.98, Math.max(fi.maxInset * 0.72, 0.004)); // keep the surface off the stroke's centre ridge
      const bevel = clamp(lerp(Math.min(0.014, bevelMax), bevelMax, smooth01(ro / 0.85)), 0.0005, 0.3); // sharp still keeps a fine chamfer that catches light
      const inflate = L.shape.inflate * smooth01((ro - 0.3) / 0.45);
      gl.uniform1f(u.uDepth, this.field ? depth : 0);
      gl.uniform1f(u.uBevel, bevel);
      gl.uniform1f(u.uInflate, inflate); gl.uniform1f(u.uMaxInset, fi.blurInset || fi.maxInset);
      gl.uniform3fv(u.uBox, [fi.extent[0] + 0.03, fi.extent[1] + 0.03, depth + 0.01]);
      gl.uniform1f(u.uFieldSize, fi.size); gl.uniform1f(u.uNormEps, Math.max(3.4 / fi.size, 0.0016));
      if (this._fr) this.beam.set(this._fr, this._fg, fi.size, { depth, bevel, inflate, inset: fi.blurInset || fi.maxInset }, fi.extent);
      this._lights = L.lights.map(l => {
        const az = l.az * DEG, el = l.el * DEG; const d = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
        let t = cross([0, 1, 0], d); if (Math.hypot(...t) < 1e-3) t = [1, 0, 0]; t = norm3(t); const b = norm3(cross(d, t));
        const r = (l.rot || 0) * DEG, cr = Math.cos(r), sr = Math.sin(r);
        return { d, t: [t[0] * cr + b[0] * sr, t[1] * cr + b[1] * sr, t[2] * cr + b[2] * sr], b: [-t[0] * sr + b[0] * cr, -t[1] * sr + b[1] * cr, -t[2] * sr + b[2] * cr], hs: [l.w * 0.5 * DEG, l.h * 0.5 * DEG], c: l.col.map(v => v * l.i * (this.lightMode === 'studio' ? 1.5 : 1) * (this.material === 'chrome' ? 1 : THEMES[this.theme].lightK)), k: l.kind };
      });
    }
    _insetCam(W, H) { // CSS-size based framing: centre in free area, fit width on portrait screens
      const r = Math.min(this.ins.r, W * 0.6), b = Math.min(this.ins.b, H * 0.6);
      const k = Math.max(1, (H * 1.15) / Math.max(W - r, 1), H / Math.max(H - b, 1));
      return { cx: -r / W, cy: b / H, k };
    }
    _pose() { return { yaw: this.rot.yaw + this.aim.yaw, pitch: clamp(this.rot.pitch + this.aim.pitch, -1.45, 1.45), ang: this.aim.ang }; }
    // beam origin/direction in the logo plane from the aim angle
    _beamRays(ang, off = this.aimOff || 0) {
      const d2 = [-Math.cos(ang), -Math.sin(ang)]; // light travels from angle 'ang' (in the screen plane) toward the logo
      const perp = [-d2[1], d2[0], 0], dir = [d2[0], d2[1], 0];
      const o = [perp[0] * off - dir[0] * 6, perp[1] * off - dir[1] * 6, 0];
      return { o, dir, perp };
    }
    /** Pick the line through the logo whose exit spectrum is widest (hollow / symmetric logos cancel dispersion). */
    _bestOffset(ang, R) {
      if (!this.beam.ok || this.material === 'chrome') return 0.06;
      let best = 0.06, bestScore = -1;
      const ext = Math.max(this.fi.extent[0], this.fi.extent[1]);
      const last = (P) => { const a = P[P.length - 1], b = P[P.length - 2]; return norm3([a[0] - b[0], a[1] - b[1], a[2] - b[2]]); };
      const cur = this._bestOff; let curScore = -1;
      for (let o = -ext * 0.85; o <= ext * 0.85 + 1e-6; o += ext * 0.05) {
        const { o: org, dir } = this._beamRays(ang, o);
        const a = this.beam.trace(org, dir, 420, false, R); if (a.length < 4) continue;
        const b = this.beam.trace(org, dir, 680, false, R); if (b.length !== a.length) continue;
        const m = this.beam.trace(org, dir, 550, false, R); if (m.length !== a.length) continue; // one coherent route for all colours
        const d = Math.acos(clamp(dot3(last(a), last(b)), -1, 1));
        const e = Math.min(a[a.length - 1][5], b[b.length - 1][5]);
        const score = Math.min(d, 0.22) * e - Math.abs(o) * 0.01 - (a.length - 4) * 0.012;
        if (score > bestScore) { bestScore = score; best = o; }
        if (cur != null && Math.abs(o - cur) < ext * 0.051) curScore = Math.max(curScore, score);
      }
      if (cur != null && curScore > 0.002 && bestScore < curScore + 0.02) return cur; // hysteresis: don't hop between near-equal lines
      return bestScore > 0.002 ? best : 0.06;
    }
    _buildBeam(ang, R) {
      const mirror = this.material === 'chrome';
      const { o, dir, perp } = this._beamRays(ang);
      const waves = mirror ? 1 : BEAM_WAVES;
      const V = []; const I0 = (mirror ? 5.5 : 5.0) * THEMES[this.theme].beamK; const w0 = BEAM_WIDTH * 0.5;
      const paths = [];
      for (let k = 0; k < waves; k++) {
        const bc = mirror ? { lam: 550, rgb: [1, 1, 1] } : BEAM_COLORS[k];
        paths.push({ P: this.beam.trace(o, dir, bc.lam, mirror, R), rgb: bc.rgb });
      }
      const base = I0 / 1.4 / waves;
      const ref = paths[waves >> 1].P; // one subdivision per segment index for every wavelength → no T-junction steps
      const nRef = (i, A) => { const P = (ref.length === A.length ? ref : A); const a = P[i], b = P[i + 1]; return Math.max(4, Math.min(48, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 0.12))); };
      for (let k = 0; k < waves; k++) {
        const A = paths[k].P, B = k + 1 < waves ? paths[k + 1].P : null, Bp = k > 0 ? paths[k - 1].P : null;
        const same = !!B && A.length === B.length;
        const nb = same ? B : (Bp && Bp.length === A.length ? Bp : null);
        const sep = (j) => nb ? Math.hypot(A[j][0] - nb[j][0], A[j][1] - nb[j][1], A[j][2] - nb[j][2]) : 0;
        for (let i = 0; i + 1 < A.length; i++) {
          const n = nRef(i, A);
          this._seg(V, A[i], A[i + 1], paths[k].rgb, base, w0, sep(i), sep(i + 1), mirror ? 0 : 1, n);
          if (same && !mirror) this._sheet(V, A[i], A[i + 1], B[i], B[i + 1], paths[k].rgb, paths[k + 1].rgb, base, w0, n);
        }
      }
      return new Float32Array(V);
    }
    _fall(q) { return (q[5] == null ? 1 : q[5]) / Math.pow(1 + q[3] * 0.22, 1.25); }
    _lerpPt(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t, a[4] + (b[4] - a[4]) * t, a[5] + (b[5] - a[5]) * t]; }
    _seg(V, a, b, rgb, base, w0, sepA, sepB, fadeWithSep, n) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); if (len < 1e-5) return;
      const d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len, (b[2] - a[2]) / len];
      let nn = cross(d, [0, 0, 1]); if (Math.hypot(...nn) < 0.15) nn = cross(d, [0, 1, 0]); nn = norm3(nn);
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n, p0 = this._lerpPt(a, b, t0), p1 = this._lerpPt(a, b, t1);
        const f0 = fadeWithSep ? clamp(1 - (sepA + (sepB - sepA) * t0) / (w0 * 1.6), 0, 1) : 1;
        const f1 = fadeWithSep ? clamp(1 - (sepA + (sepB - sepA) * t1) / (w0 * 1.6), 0, 1) : 1;
        if (f0 <= 0 && f1 <= 0) continue;
        const i0 = base * this._fall(p0) * f0, i1 = base * this._fall(p1) * f1;
        const v = (p, c, side) => V.push(p[0] + nn[0] * w0 * side, p[1] + nn[1] * w0 * side, p[2] + nn[2] * w0 * side, rgb[0] * c, rgb[1] * c, rgb[2] * c, side);
        v(p0, i0, -1); v(p0, i0, 1); v(p1, i1, 1); v(p0, i0, -1); v(p1, i1, 1); v(p1, i1, -1);
      }
    }
    _sheet(V, a0, a1, b0, b1, ca, cb, base, w0, n) {
      const g = (sep) => clamp(sep / (w0 * 1.6), 0, 1) * 0.96 * w0 * 2 / Math.max(sep, w0 * 0.4);
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n;
        const A0 = this._lerpPt(a0, a1, t0), A1 = this._lerpPt(a0, a1, t1), B0 = this._lerpPt(b0, b1, t0), B1 = this._lerpPt(b0, b1, t1);
        const s0 = Math.hypot(A0[0] - B0[0], A0[1] - B0[1], A0[2] - B0[2]), s1 = Math.hypot(A1[0] - B1[0], A1[1] - B1[1], A1[2] - B1[2]);
        if (s0 < 1e-4 && s1 < 1e-4) continue;
        const q = (sep) => 1 - smooth01((sep - 0.22) / 0.4); // neighbours on different routes fade out smoothly instead of popping
        const k0 = base * this._fall(A0) * g(s0) * q(s0), k1 = base * this._fall(A1) * g(s1) * q(s1);
        const v = (p, c, k) => V.push(p[0], p[1], p[2], c[0] * k, c[1] * k, c[2] * k, 0);
        v(A0, ca, k0); v(B0, cb, k0); v(B1, cb, k1); v(A0, ca, k0); v(B1, cb, k1); v(A1, ca, k1);
      }
    }
    _uploadBeam(arr) { const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.beamBuf); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW); this.beamCount = arr.length / 7; }
    _draw(fb, w, h) { const gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, w, h); gl.bindVertexArray(this.quadVao); gl.drawArrays(gl.TRIANGLES, 0, 3); }
    _halton(i) { const h = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; }; const k = (i % 32) + 1; return [h(k, 2) - 0.5, h(k, 3) - 0.5]; }
    /** One full deterministic sample of the image into P.accum with weight 'blend'. */
    _sample(P, pose, blend, cam, jitterIdx, lamOffset) {
      const gl = this.gl; const R = rotYX(pose.yaw, pose.pitch);
      const j = this._halton(jitterIdx);
      const tanF = Math.tan(15 * DEG) * cam.k, dist = 4.6, aspect = P.w / P.h;
      const cxJ = cam.cx - 2 * j[0] / P.w, cyJ = cam.cy - 2 * j[1] / P.h;
      const VP = viewProj(R, dist, tanF, aspect, cxJ, cyJ);
      // 1. scene: background + beam
      gl.disable(gl.BLEND);
      const T = THEMES[this.theme], bu = this.p.bg.u;
      gl.useProgram(this.p.bg.p); gl.uniform3fv(bu.uBg, T.bg || LOOKS[this.material].bg); gl.uniform2f(bu.uRes, P.w, P.h); gl.uniform2f(bu.uCenter, cam.cx, cam.cy);
      gl.uniform1i(bu.uMode, T.mode); gl.uniform2f(bu.uJitter, j[0], j[1]); gl.uniform1f(bu.uCamDist, dist); gl.uniform1f(bu.uTanFov, tanF); gl.uniform1f(bu.uEnvYaw, this.envYaw);
      gl.uniform1f(bu.uShadow, this.field ? (this.material === 'chrome' ? 1.4 : 1.0) : 0.0);
      gl.uniformMatrix3fv(bu.uRotT, false, new Float32Array([R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2]]));
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.fieldTex); gl.uniform1i(bu.uField, 0);
      this._draw(P.scene.fb, P.w, P.h);
      if (this.beamCount && this.lightMode === 'beam') {
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(this.p.beam.p); gl.uniformMatrix4fv(this.p.beam.u.uVP, false, viewProj(null, dist, tanF, aspect, cxJ, cyJ));
        gl.bindVertexArray(this.beamVao); gl.drawArrays(gl.TRIANGLES, 0, this.beamCount);
        gl.disable(gl.BLEND);
      }
      // 2. glass / chrome over the scene, blended into the accumulation
      const g = this.p.glass, u = g.u; gl.useProgram(g.p);
      const src = P.accum[P.cur], dst = P.accum[1 - P.cur];
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.fieldTex); gl.uniform1i(u.uField, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, P.scene.tex); gl.uniform1i(u.uScene, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, src.tex); gl.uniform1i(u.uPrev, 2);
      gl.uniform1f(u.uBlend, blend); gl.uniform2f(u.uRes, P.w, P.h); gl.uniform2f(u.uJitter, j[0], j[1]); gl.uniform2f(u.uCenter, cam.cx, cam.cy);
      gl.uniform1f(u.uLamOffset, lamOffset); gl.uniform1i(u.uDebug, this.debug | 0);
      gl.uniformMatrix3fv(u.uRotT, false, new Float32Array([R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2]]));
      gl.uniformMatrix4fv(u.uVP, false, VP); // jittered, matches the scene texture
      gl.uniform1f(u.uCamDist, dist); gl.uniform1f(u.uTanFov, tanF);
      const n = this._lights.length; gl.uniform1i(u.uLightCount, n);
      const LD = new Float32Array(18), LT = new Float32Array(18), LB = new Float32Array(18), LS = new Float32Array(12), LC = new Float32Array(18), LK = new Int32Array(6);
      const ey = this.envYaw, cy = Math.cos(ey), sy = Math.sin(ey), Y = (v) => [cy * v[0] + sy * v[2], v[1], -sy * v[0] + cy * v[2]];
      this._lights.forEach((l, i) => { LD.set(mulT(R, Y(l.d)), i * 3); LT.set(mulT(R, Y(l.t)), i * 3); LB.set(mulT(R, Y(l.b)), i * 3); LS.set(l.hs, i * 2); LC.set(l.c, i * 3); LK[i] = l.k; });
      gl.uniform3fv(u.uLD, LD); gl.uniform3fv(u.uLT, LT); gl.uniform3fv(u.uLB, LB); gl.uniform2fv(u.uLS, LS); gl.uniform3fv(u.uLC, LC); gl.uniform1iv(u.uLK, LK);
      gl.uniform3fv(u.uUp, mulT(R, [0, 1, 0]));
      this._draw(dst.fb, P.w, P.h);
      P.cur = 1 - P.cur;
    }
    _bloom(P) {
      const gl = this.gl, p = this.p; if (!P.bloom.length) return false;
      gl.disable(gl.BLEND);
      gl.useProgram(p.pre.p); gl.activeTexture(gl.TEXTURE0); gl.uniform1i(p.pre.u.uSrc, 0); gl.bindTexture(gl.TEXTURE_2D, P.accum[P.cur].tex);
      gl.uniform2f(p.pre.u.uTexel, 1 / P.w, 1 / P.h); gl.uniform1f(p.pre.u.uThreshold, 0.75); this._draw(P.bloom[0].fb, P.bloom[0].w, P.bloom[0].h);
      gl.useProgram(p.down.p); gl.uniform1i(p.down.u.uSrc, 0);
      for (let i = 1; i < P.bloom.length; i++) { const s = P.bloom[i - 1], d = P.bloom[i]; gl.bindTexture(gl.TEXTURE_2D, s.tex); gl.uniform2f(p.down.u.uTexel, 1 / s.w, 1 / s.h); this._draw(d.fb, d.w, d.h); }
      gl.useProgram(p.up.p); gl.uniform1i(p.up.u.uSrc, 0); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = P.bloom.length - 2; i >= 0; i--) { const s = P.bloom[i + 1], d = P.bloom[i]; gl.bindTexture(gl.TEXTURE_2D, s.tex); gl.uniform2f(p.up.u.uTexel, 1 / s.w, 1 / s.h); this._draw(d.fb, d.w, d.h); }
      gl.disable(gl.BLEND); return true;
    }
    _composite(P, fb, w, h, flip, cam, time, transparent) {
      const gl = this.gl, c = this.p.comp, u = c.u, L = LOOKS[this.material];
      const hb = this._bloom(P);
      gl.useProgram(c.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, P.accum[P.cur].tex); gl.uniform1i(u.uAccum, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, hb ? P.bloom[0].tex : P.accum[P.cur].tex); gl.uniform1i(u.uBloom, 1);
      const T = THEMES[this.theme]; gl.uniform1i(u.uHasBloom, hb ? 1 : 0); gl.uniform1f(u.uExposure, L.exposure * T.exposure * (T.mode ? 1 / L.exposure : 1)); gl.uniform1f(u.uBloomAmt, L.bloom * T.bloomK); gl.uniform1i(u.uTone, T.tone);
      gl.uniform1f(u.uVignette, transparent ? 0 : L.vignette * T.vignetteK); gl.uniform1f(u.uFlip, flip ? 1 : 0); gl.uniform2f(u.uOutRes, w, h); gl.uniform1f(u.uTransparent, transparent ? 1 : 0);
      this._draw(fb, w, h);
      // dust, lit by the beam's glow
      if (hb && !transparent && this.theme === 'dark' && this.lightMode === 'beam') {
        const d = this.p.dust; gl.useProgram(d.p);
        const tanF = Math.tan(15 * DEG) * cam.k;
        const VPw = viewProj(null, 4.6, tanF, w / h, cam.cx, cam.cy);
        if (flip) { for (let i = 1; i < 16; i += 4) VPw[i] = -VPw[i]; }
        gl.uniformMatrix4fv(d.u.uVPw, false, VPw); gl.uniform1f(d.u.uFlipY, flip ? 1 : 0); gl.uniform1f(d.u.uTime, time); gl.uniform1f(d.u.uPx, Math.max(1, h / 900) * 1.6);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, P.bloom[Math.min(2, P.bloom.length - 1)].tex); gl.uniform1i(d.u.uGlow, 0);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, w, h);
        gl.bindVertexArray(this.dustVao); gl.drawArrays(gl.POINTS, 0, this.dustN); gl.disable(gl.BLEND);
      }
    }
    _updateTargets(dt) {
      const W = this.canvas.clientWidth || 1, H = this.canvas.clientHeight || 1; const cam = this._insetCam(W, H);
      if (this.pointer) {
        // pointer → point on the logo plane (approx: un-tilted camera); light comes FROM the pointer side
        const tanF = Math.tan(15 * DEG) * cam.k; const nx = (this.pointer[0] / W * 2 - 1) - cam.cx, ny = (1 - this.pointer[1] / H * 2) - cam.cy;
        const x = nx * (W / H) * tanF * 4.6, y = ny * tanF * 4.6;
        const dx = x - 0.0, dy = y - 0.06; const r = Math.hypot(dx, dy);
        if (r > 0.35) this.target.ang = Math.atan2(dy, dx);
        this.target.yaw = clamp(x / 3, -1, 1) * 0.12; this.target.pitch = clamp(-y / 2, -1, 1) * 0.07; this.envYawT = clamp(x / 2.6, -1, 1) * 0.9;
      } else if (this.time - this.lastPointerT > 3.5 && !this.paused) {
        // idle: slow seamless drift of the light (6 s period)
        // idle: glide to a calm resting pose and stop, so the image settles into a crisp still
        this.target.ang = Math.PI + 0.2; this.target.yaw = 0.0; this.target.pitch = 0.0; this.envYawT = 0.35;
      }
      // critically damped follow (angles wrap)
      const k = 1 - Math.exp(-dt * 2.6); // slow, critically damped follow: elegant, no jitter
      let da = this.target.ang - this.aim.ang; da = Math.atan2(Math.sin(da), Math.cos(da));
      this.aim.ang += da * k; this.aim.yaw += (this.target.yaw - this.aim.yaw) * k; this.aim.pitch += (this.target.pitch - this.aim.pitch) * k; this.envYaw += (this.envYawT - this.envYaw) * k;
      return cam;
    }
    _loop(now) {
      if (this._disposed) return; this._raf = requestAnimationFrame(this._loop.bind(this));
      if (this.busy) return;
      const dt = Math.min(0.1, (now - this._lastT) / 1000); this._lastT = now;
      this._fpsA += dt; this._fpsN++; if (this._fpsA > 0.5) { this._emit('fps', Math.round(this._fpsN / this._fpsA)); this._fpsA = 0; this._fpsN = 0; }
      if (!this.paused) this.time += dt;
      const cam = this._updateTargets(dt);
      // spin inertia / reset
      const r = this.rot;
      if (r.reset) { const k = 1 - Math.exp(-dt * 6); const ty = Math.round(r.yaw / (2 * Math.PI)) * 2 * Math.PI; r.yaw += (ty - r.yaw) * k; r.pitch += (0 - r.pitch) * k; if (Math.abs(ty - r.yaw) < 1e-4 && Math.abs(r.pitch) < 1e-4) { r.yaw = 0; r.pitch = 0; r.reset = false; } }
      else if (!r.drag && (Math.abs(r.vy) > 1e-4 || Math.abs(r.vp) > 1e-4)) { r.yaw += r.vy * dt; r.pitch = clamp(r.pitch + r.vp * dt, -1.35, 1.35); const d = Math.exp(-dt * 2.6); r.vy *= d; r.vp *= d; if (Math.abs(r.vy) < 1e-3) r.vy = 0; if (Math.abs(r.vp) < 1e-3) r.vp = 0; }
      const pose = this._pose(); const Rm = rotYX(pose.yaw, pose.pitch);
      const rotKey = pose.yaw.toFixed(4) + ',' + pose.pitch.toFixed(4);
      if (this.field && (this._bestAng == null || Math.abs(this.aim.ang - this._bestAng) > 0.01 || rotKey !== this._bestRot || this._dirty)) {
        if (!this._bestT || now - this._bestT > 60 || this._dirty) { this._bestT = now; this._bestAng = this.aim.ang; this._bestRot = rotKey; this._bestOff = this._bestOffset(this.aim.ang, Rm); }
      }
      if (this._bestOff != null) { this.aimOff = (this.aimOff ?? this._bestOff) + (this._bestOff - (this.aimOff ?? this._bestOff)) * (1 - Math.exp(-dt * 1.4)); }
      const key = [(this.aimOff || 0).toFixed(4), this.envYaw.toFixed(4), this.aim.ang.toFixed(4), pose.yaw.toFixed(4), pose.pitch.toFixed(4), cam.cx.toFixed(4), cam.cy.toFixed(4), cam.k.toFixed(4)].join('|');
      const moving = key !== this._key; this._key = key;
      this._ft = this._ft * 0.9 + dt * 1000 * 0.1;
      if (moving && now - this._scaleT > 800) { this._scaleT = now; if (this._ft > 24 && this.autoScale > 0.55) { this.autoScale *= 0.85; this._resizeMain(); } else if (this._ft < 19 && this.autoScale < 1) { this.autoScale = Math.min(1, this.autoScale * 1.1); this._resizeMain(); } }
      if (!moving && this.autoScale < 1 && now - this._scaleT > 500) { this.autoScale = 1; this._scaleT = now; this._resizeMain(); }
      const P = this.main; const target = 24;
      if (moving || this._dirty || this.samples < target) {
        if (moving || this._dirty) this._uploadBeam(this._buildBeam(pose.ang, Rm));
        let blend;
        if (this._dirty) { blend = 1; this.samples = 0; this._dirty = false; }
        else if (moving) { blend = this.samples === 0 ? 1 : 0.35; this.samples = 1; }
        else blend = 1 / (this.samples + 1);
        this.frame++;
        this._sample(P, pose, blend, cam, this.frame, moving ? 0.0 : (this.frame * 0.6180339887) % 1); // jitter always on: motion stays antialiased
        if (moving && this._ft < 12) { this.frame++; this._sample(P, pose, 0.3, cam, this.frame, 0.0); } // spare GPU time → a second AA sample
        this.samples++;
      }
      this._composite(P, null, this.canvas.width, this.canvas.height, false, cam, this.time, false);
    }
    // ── offline rendering
    _wait() { const gl = this.gl; const s = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush(); return new Promise(r => { const p = () => { if (gl.clientWaitSync(s, 0, 0) === gl.TIMEOUT_EXPIRED) { setTimeout(p, 2); return; } gl.deleteSync(s); r(); }; p(); }); }
    async _offlineFrame(P, pose, cam, spp, time, transparent) {
      this._uploadBeam(this._buildBeam(pose.ang, rotYX(pose.yaw, pose.pitch)));
      for (let i = 0; i < spp; i++) {
        if (this._cancel) throw Object.assign(new Error('Render cancelled'), { name: 'AbortError' });
        this._sample(P, pose, 1 / (i + 1), cam, i + 1, ((i + 0.5) / spp + 0.137) % 1);
        if (i % 4 === 3) await this._wait();
      }
      this._composite(P, P.out.fb, P.w, P.h, true, cam, time, transparent);
      const px = new Uint8Array(P.w * P.h * 4); const gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, P.out.fb); gl.readPixels(0, 0, P.w, P.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    }
    _offlineCam(w, h) { // same framing as the live view, but without UI insets
      return { cx: 0, cy: 0, k: Math.max(1, (h * 1.15) / w) };
    }
    async renderStill({ width, height, samples = 32, onProgress, transparent = false } = {}) {
      if (this.busy) throw new Error('A render is already running.');
      const w = clamp(Math.round(width || this.canvas.width), 16, this.maxTex), h = clamp(Math.round(height || this.canvas.height), 16, this.maxTex);
      this.busy = true; this._cancel = false; const P = this._pipe(w, h, true);
      try {
        if (onProgress) onProgress(0.05);
        const px = await this._offlineFrame(P, this._pose(), this._offlineCam(w, h), samples, this.time, transparent);
        if (onProgress) onProgress(1);
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer), w, h), 0, 0);
        return await new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('PNG encode failed')), 'image/png'));
      } finally { this._free(P); this.busy = false; this._dirty = true; }
    }
    async _muxer() {
      if (window.Mp4Muxer) return window.Mp4Muxer;
      await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.js'; s.onload = res; s.onerror = () => rej(new Error('Could not load the MP4 muxer.')); document.head.appendChild(s); });
      return window.Mp4Muxer;
    }
    /** Seamless loop: the light sweeps across the logo and back over `seconds`. */
    async renderVideo({ width = 1080, height = 1080, fps = 60, seconds = 6, spp = 8, onProgress } = {}) {
      if (!SpectraEngine.canRenderVideo) throw new Error('This browser cannot encode MP4.');
      if (this.busy) throw new Error('A render is already running.');
      const w = Math.round(width / 2) * 2, h = Math.round(height / 2) * 2; const M = await this._muxer();
      let config = null;
      for (const codec of ['avc1.640033', 'avc1.640032', 'avc1.64002A', 'avc1.640028', 'avc1.4D402A', 'avc1.42E01F']) {
        const cfg = { codec, width: w, height: h, bitrate: Math.round(w * h * fps * 0.2), framerate: fps, avc: { format: 'avc' } };
        try { const s = await VideoEncoder.isConfigSupported(cfg); if (s.supported) { config = cfg; break; } } catch (e) { /* next */ }
      }
      if (!config) throw new Error('No supported H.264 encoder for ' + w + '×' + h + '.');
      const target = new M.ArrayBufferTarget();
      const muxer = new M.Muxer({ target, video: { codec: 'avc', width: w, height: h, frameRate: fps }, fastStart: 'in-memory' });
      let err = null; const enc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => { err = e; } }); enc.configure(config);
      this.busy = true; this._cancel = false; const P = this._pipe(w, h, true); const frames = Math.round(fps * seconds); const cam = this._offlineCam(w, h);
      const base = this._pose();
      try {
        for (let f = 0; f < frames; f++) {
          if (err) throw err;
          const t = f / fps, ph = 2 * Math.PI * t / seconds;
          const pose = { ang: base.ang + 0.24 * Math.sin(ph), yaw: base.yaw + 0.06 * Math.sin(ph + 0.6), pitch: base.pitch + 0.035 * Math.sin(2 * ph) };
          this.aimOff = this._bestOffset(pose.ang, rotYX(pose.yaw, pose.pitch)); const px = await this._offlineFrame(P, pose, cam, spp, t * (12 / seconds), false);
          const vf = new VideoFrame(px, { format: 'RGBA', codedWidth: w, codedHeight: h, timestamp: Math.round(f * 1e6 / fps), duration: Math.round(1e6 / fps) });
          enc.encode(vf, { keyFrame: f % (fps * 2) === 0 }); vf.close();
          while (enc.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 4));
          if (onProgress) onProgress((f + 1) / frames);
        }
        await enc.flush(); muxer.finalize(); return new Blob([target.buffer], { type: 'video/mp4' });
      } finally { try { enc.close(); } catch (e) { /* closed */ } this._free(P); this.busy = false; this._dirty = true; }
    }
  }
  SpectraEngine.canRenderVideo = typeof window.VideoEncoder !== 'undefined' && typeof window.VideoFrame !== 'undefined';
  SpectraEngine.version = 2;
  window.SpectraEngine = SpectraEngine;
})();
