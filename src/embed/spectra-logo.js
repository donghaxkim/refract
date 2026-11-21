/* Spectra — src/embed/spectra-logo.js
 * <spectra-logo> custom element: an embeddable, framework-free Spectra render.
 * Built by build-embed.mjs into dist/spectra-logo.js together with samples.js, sdf.js and engine.js;
 * this file expects `DEPS = { Engine, SDF, Samples }` from that wrapper (it never touches window.Spectra*).
 */
/* global DEPS */
(function (Engine, SDF, Samples) {
  'use strict';
  if (typeof window === 'undefined' || !window.customElements || customElements.get('spectra-logo')) return;

  const ATTRS = ['src', 'text', 'sample', 'font', 'material', 'light', 'theme', 'background', 'transparent', 'thickness', 'roundness', 'interactive', 'poster', 'alt'];
  const THEME_BG = { dark: '#0f0f11', light: '#bdb7ae' }; // what each theme's backdrop tone-maps to (pre-render / fallback fill)
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const fieldCache = new Map(); // shared by every instance: key → Promise<field>
  const hasGL2 = () => { try { return !!window.WebGL2RenderingContext; } catch (e) { return false; } };
  const boolAttr = (v, dflt) => v == null ? dflt : !/^(false|off|0|no)$/i.test(String(v).trim());
  const truthy = (v) => v === '' || (!!v && !/^(false|off|0|no)$/i.test(String(v).trim()));
  const num01 = (v, dflt) => { const n = parseFloat(v); return isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : dflt; };
  let _pc = null;
  function cssLuma(c) { // relative luminance of a CSS colour, or null if it doesn't parse
    if (!_pc) { const cv = document.createElement('canvas'); cv.width = cv.height = 1; _pc = cv.getContext('2d', { willReadFrequently: true }); }
    _pc.fillStyle = '#010203'; _pc.fillStyle = c; if (_pc.fillStyle === '#010203' && !/^#010203$/i.test(c)) return null;
    _pc.clearRect(0, 0, 1, 1); _pc.fillRect(0, 0, 1, 1); const d = _pc.getImageData(0, 0, 1, 1).data;
    const l = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * l(d[0]) + 0.7152 * l(d[1]) + 0.0722 * l(d[2]);
  }
  const CSS = `
:host{display:block;position:relative;aspect-ratio:16/9;overflow:hidden;contain:layout paint;-webkit-tap-highlight-color:transparent}
:host([hidden]){display:none}
.bg,.cv,.poster,.fb{position:absolute;inset:0;width:100%;height:100%;border:0;margin:0}
.cv{display:block;outline:none;opacity:0;transition:opacity .45s ease}
.cv.on{opacity:1}
.cv.int{touch-action:pan-y;cursor:grab}.cv.int.drag{cursor:grabbing}
.cv:not(.int){pointer-events:none}
.poster{object-fit:cover;pointer-events:none;transition:opacity .45s ease}
.poster.off{opacity:0}
.poster[hidden],.fb[hidden]{display:none}
.fb{display:grid;place-items:center;overflow:hidden;background:radial-gradient(60% 70% at 50% 45%,rgba(255,255,255,var(--_hl,.07)),transparent 70%),var(--_bg)}
.fb .mk{width:38%;height:38%;max-width:60%;display:grid;place-items:center;filter:drop-shadow(0 6px 18px rgba(0,0,0,var(--_sh,.45)))}
.fb .mk svg,.fb .mk img{width:100%;height:100%;object-fit:contain}
.fb .tx{font:700 clamp(18px,9cqw,120px)/1 ${FONT};letter-spacing:-.02em;background:linear-gradient(160deg,#fff,#9aa0a8 45%,#f4f4f6 55%,#6b7078);-webkit-background-clip:text;background-clip:text;color:transparent}
.fb{container-type:inline-size}
@media (prefers-reduced-motion:reduce){.cv,.poster{transition:none}}`;

  class SpectraLogo extends HTMLElement {
    static get observedAttributes() { return ATTRS; }
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${CSS}</style><div class="bg" part="backdrop"></div><img class="poster" alt="" hidden decoding="async"><div class="fb" hidden part="fallback"></div>`;
      this._bgEl = root.querySelector('.bg'); this._poster = root.querySelector('.poster'); this._fb = root.querySelector('.fb');
      this.engine = null; this._canvas = null; this._field = null; this._token = 0;
      this._near = false; this._vis = false; this._lost = false; this._failed = false; this._ready = false; this._needsStill = true;
      this._onVis = () => this._sync();
      this._onMotion = () => { this._applyMotion(); this._kick(); };
      this._mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
      this._tickB = this._tick.bind(this); this._tickRaf = 0;
    }
    // ── reflected properties
    get src() { return this.getAttribute('src'); } set src(v) { this._setAttr('src', v); }
    get text() { return this.getAttribute('text'); } set text(v) { this._setAttr('text', v); }
    get sample() { return this.getAttribute('sample'); } set sample(v) { this._setAttr('sample', v); }
    get font() { return this.getAttribute('font'); } set font(v) { this._setAttr('font', v); }
    get material() { return this.getAttribute('material') === 'chrome' ? 'chrome' : 'glass'; } set material(v) { this._setAttr('material', v); }
    get light() { return this.getAttribute('light') === 'studio' ? 'studio' : 'beam'; } set light(v) { this._setAttr('light', v); }
    get theme() { return this._theme(); } set theme(v) { this._setAttr('theme', v); }
    get background() { return this.getAttribute('background'); } set background(v) { this._setAttr('background', v); }
    get transparent() { return boolAttr(this.getAttribute('transparent'), false); } set transparent(v) { this._setBool('transparent', v); }
    get interactive() { return boolAttr(this.getAttribute('interactive'), true); } set interactive(v) { this.setAttribute('interactive', v == null || truthy(v) ? 'true' : 'false'); }
    get thickness() { return Math.round(num01(this.getAttribute('thickness'), 0.5) * 100); } set thickness(v) { this._setAttr('thickness', v); }
    get roundness() { return Math.round(num01(this.getAttribute('roundness'), 0.65) * 100); } set roundness(v) { this._setAttr('roundness', v); }
    get poster() { return this.getAttribute('poster'); } set poster(v) { this._setAttr('poster', v); }
    get alt() { return this.getAttribute('alt'); } set alt(v) { this._setAttr('alt', v); }
    get ready() { return this._ready; }
    _setAttr(n, v) { if (v == null || v === false) this.removeAttribute(n); else this.setAttribute(n, String(v)); }
    _setBool(n, v) { if (truthy(v)) this.setAttribute(n, ''); else this.removeAttribute(n); }

    // ── lifecycle
    connectedCallback() {
      this._alive = true;
      this._paintStatic();
      if (!this._io) {
        this._io = new IntersectionObserver((es) => {
          const e = es[es.length - 1]; this._near = e.isIntersecting;
          if (this._near && !this.engine && !this._failed) this._init();
          this._sync();
        }, { rootMargin: '200px 0px' });
        this._io.observe(this);
        document.addEventListener('visibilitychange', this._onVis);
        if (this._mq) (this._mq.addEventListener ? this._mq.addEventListener('change', this._onMotion) : this._mq.addListener(this._onMotion));
      }
    }
    disconnectedCallback() {
      this._alive = false;
      // defer: a synchronous move (remove + re-insert) keeps its context
      Promise.resolve().then(() => { if (!this.isConnected) this._teardown(); });
    }
    _teardown() {
      if (this._io) { this._io.disconnect(); this._io = null; }
      document.removeEventListener('visibilitychange', this._onVis);
      if (this._mq) (this._mq.removeEventListener ? this._mq.removeEventListener('change', this._onMotion) : this._mq.removeListener(this._onMotion));
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
      cancelAnimationFrame(this._tickRaf); this._tickRaf = 0; clearTimeout(this._kickT);
      this._destroyEngine();
      if (this._canvas) { this._canvas.remove(); this._canvas = null; }
      this._near = false; this._vis = false; this._failed = false; this._lost = false; this._ready = false; this._token++;
    }
    _destroyEngine() {
      const e = this.engine; if (!e) return;
      this.engine = null; this._unbindPointer();
      this._destroying = true; try { e.destroy(); } catch (err) { /* context already gone */ } this._destroying = false;
    }
    attributeChangedCallback(name, oldV, newV) {
      if (oldV === newV) return;
      switch (name) {
        case 'src': case 'text': case 'sample': case 'font': this._paintStatic(); if (this.engine) this._loadSource(); break;
        case 'poster': this._paintStatic(); break;
        case 'alt': if (this._canvas) this._canvas.setAttribute('aria-label', this._label()); break;
        case 'interactive': if (this.engine) this._bindPointer(); break;
        default: this._paintStatic(); this._applySettings(); this._kick();
      }
    }

    // ── engine setup
    _init() {
      if (!hasGL2()) return this._fail('webgl', new Error('WebGL2 is not available in this browser.'));
      const cv = document.createElement('canvas'); cv.className = 'cv'; cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', this._label());
      this.shadowRoot.insertBefore(cv, this._poster); this._canvas = cv;
      cv.addEventListener('webglcontextlost', (ev) => {
        if (this._destroying || cv !== this._canvas) return;
        ev.preventDefault(); this._lost = true; const e = this.engine; this.engine = null; this._unbindPointer();
        if (e) e.dispose(); cv.classList.remove('on'); this._paintStatic(true);
        this._emit('error', { phase: 'context', message: 'WebGL context lost', error: null });
      });
      cv.addEventListener('webglcontextrestored', () => { if (cv !== this._canvas || !this._alive) return; this._lost = false; this._createEngine(); });
      this._createEngine();
      this._ro = new ResizeObserver(() => { if (this.engine) { this.engine.resize(); this._kick(); } });
      this._ro.observe(this);
    }
    _createEngine() {
      let e;
      try { e = new Engine(this._canvas); } catch (err) { return this._fail('webgl', err); }
      this.engine = e; this._failed = false;
      e.on('error', (err) => this._emit('error', { phase: 'render', message: String(err && err.message || err), error: err }));
      this._applySettings(); this._applyMotion(); this._bindPointer();
      if (this._field) { e.setField(this._field); this._afterField(); } else this._loadSource();
      this._sync();
    }
    _fail(phase, err) {
      this._failed = true;
      if (this._canvas) { this._canvas.remove(); this._canvas = null; }
      this._paintStatic(true);
      this._emit('error', { phase, message: String(err && err.message || err), error: err });
    }
    _theme() {
      const t = this.getAttribute('theme'); if (t === 'dark' || t === 'light') return t;
      const bg = this.getAttribute('background'); if (bg && !this.transparent) { const l = cssLuma(bg); if (l != null) return l > 0.3 ? 'light' : 'dark'; }
      return 'dark';
    }
    _applySettings() {
      const e = this.engine; if (!e) return;
      e.setTheme(this._theme()); e.setMaterial(this.material); e.setLightMode(this.light);
      e.setTransparent(this.transparent);
      const bg = this.getAttribute('background');
      e.setBackground(bg && cssLuma(bg) != null ? bg : null);
      const sh = { thickness: num01(this.getAttribute('thickness'), 0.5), roundness: num01(this.getAttribute('roundness'), 0.65) };
      const cur = e.getShape(); if (cur.thickness !== sh.thickness || cur.roundness !== sh.roundness) e.setShape(sh);
    }
    _reduced() { return !!(this._mq && this._mq.matches); }
    _applyMotion() { const e = this.engine; if (!e) return; e.togglePause(this._reduced()); if (this._reduced()) e.settle(); }
    _label() { return this.getAttribute('alt') || (this.getAttribute('text') ? this.getAttribute('text') + ' (glass logo)' : 'Glass logo render'); }

    // ── source → distance field (cached across instances)
    _source() {
      const src = this.getAttribute('src'), text = this.getAttribute('text'), sid = this.getAttribute('sample');
      if (src) return { key: 'src:' + new URL(src, document.baseURI).href, src };
      if (text && text.trim()) { const font = this.getAttribute('font') || FONT; return { key: 'text:' + font + ':' + text, build: { type: 'text', text: text.trim(), fontFamily: font, fontWeight: 700 } }; }
      const s = Samples.find((x) => x.id === sid) || Samples[0];
      return { key: 'sample:' + s.id, build: { type: 'svg', text: s.svg }, svg: s.svg };
    }
    async _fetchSource(url) {
      const r = await fetch(url, { mode: 'cors', credentials: 'same-origin' });
      if (!r.ok) throw new Error('Could not load ' + url + ' (' + r.status + ')');
      const type = r.headers.get('content-type') || '';
      if (/svg/i.test(type) || /\.svg(\?|#|$)/i.test(url)) return { type: 'svg', text: await r.text() };
      const b = await r.blob(); return { type: 'image', blob: b };
    }
    async _loadSource() {
      const tok = ++this._token, s = this._source();
      const r = this.getBoundingClientRect(), px = Math.max(r.width, r.height) * Math.min(window.devicePixelRatio || 1, 2);
      const size = px > 900 ? 1024 : 512, key = s.key + '@' + size;
      let p = fieldCache.get(key);
      if (!p) {
        p = (async () => SDF.build(s.src ? await this._fetchSource(new URL(s.src, document.baseURI).href) : s.build, { size }))();
        fieldCache.set(key, p); p.catch(() => fieldCache.delete(key));
        if (fieldCache.size > 24) fieldCache.delete(fieldCache.keys().next().value);
      }
      try {
        const field = await p;
        if (tok !== this._token || !this.engine) return;
        this._field = field; this.engine.setField(field); this._afterField();
      } catch (err) {
        if (tok !== this._token) return;
        this._emit('error', { phase: 'source', message: String(err && err.message || err), error: err });
        if (!this._field) this._paintStatic(true); // nothing to show: keep the static version visible
      }
    }
    _afterField() {
      const e = this.engine; if (!e) return;
      if (this._reduced()) e.settle();
      this._readyFrame = e.frame; this._awaitReady = true; this._kick();
    }

    // ── run control: only render while near the viewport, the tab is visible, and (reduced motion) until settled
    _kick() { this._needsStill = true; this._sync(); clearTimeout(this._kickT); if (this._reduced()) this._kickT = setTimeout(() => { this._needsStill = true; this._sync(); }, 160); }
    _sync() {
      const e = this.engine; if (!e) return;
      const run = this._near && !document.hidden && !this._lost && (!this._reduced() || this._needsStill || this._awaitReady);
      if (run) { e.resume(); if (!this._tickRaf) this._tickRaf = requestAnimationFrame(this._tickB); }
      else e.suspend();
    }
    _tick() {
      this._tickRaf = 0; const e = this.engine; if (!e || e.isSuspended()) return;
      if (this._awaitReady && e.field && e.frame > this._readyFrame) {
        this._awaitReady = false; this._ready = true;
        this._canvas.classList.add('on'); this._poster.classList.add('off'); this._fb.hidden = true;
        this._emit('ready', { material: this.material, theme: this._theme() });
      }
      if (this._reduced() && !this._awaitReady && !this._drag && e.isSettled()) { this._needsStill = false; e.suspend(); return; }
      this._tickRaf = requestAnimationFrame(this._tickB);
    }

    // ── pointer: hover steers the light, drag spins (horizontal; vertical pans still scroll the page on touch)
    _bindPointer() {
      this._unbindPointer(); const cv = this._canvas, e = this.engine; if (!cv || !e) return;
      const on = this.interactive; cv.classList.toggle('int', on); if (!on) return;
      const pos = (ev) => { const r = cv.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
      const L = {
        pointermove: (ev) => {
          const d = this._drag;
          if (d && ev.pointerId === d.id) { const dx = ev.clientX - d.x, dy = ev.clientY - d.y; d.x = ev.clientX; d.y = ev.clientY; d.moved += Math.abs(dx) + Math.abs(dy); e.rotateBy(dx, dy); this._kick(); return; }
          if (ev.pointerType === 'touch' || this._reduced()) return;
          const p = pos(ev); e.setPointer(p[0], p[1]); this._kick();
        },
        pointerdown: (ev) => {
          if (ev.button > 0) return;
          this._drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, moved: 0, touch: ev.pointerType === 'touch' };
          try { cv.setPointerCapture(ev.pointerId); } catch (err) { /* noop */ }
          cv.classList.add('drag'); e.beginRotate(); this._kick();
        },
        pointerup: (ev) => this._endDrag(ev, pos), pointercancel: (ev) => this._endDrag(ev, pos),
        pointerleave: (ev) => { if (ev.pointerType !== 'touch' && !this._drag) { e.setPointer(null); this._kick(); } },
        dblclick: () => { e.resetRotation(); this._kick(); },
      };
      for (const k in L) cv.addEventListener(k, L[k], k === 'pointermove' ? { passive: true } : false);
      this._ptr = { cv, L };
    }
    _endDrag(ev, pos) {
      const d = this._drag, e = this.engine; if (!d || ev.pointerId !== d.id || !e) return;
      if (d.touch && d.moved < 8 && ev.type === 'pointerup' && !this._reduced()) { const p = pos(ev); e.setPointer(p[0], p[1]); }
      this._drag = null; this._canvas && this._canvas.classList.remove('drag'); e.endRotate(); this._kick();
    }
    _unbindPointer() {
      if (this._ptr) { for (const k in this._ptr.L) this._ptr.cv.removeEventListener(k, this._ptr.L[k], k === 'pointermove' ? { passive: true } : false); this._ptr = null; }
      this._drag = null;
    }

    // ── static layers: page colour, poster, and a styled fallback when WebGL can't run
    _paintStatic(forceFallback) {
      const t = this._theme(), bg = this.getAttribute('background');
      const fill = this.transparent ? 'transparent' : (bg && cssLuma(bg) != null ? bg : THEME_BG[t]);
      this._bgEl.style.background = fill; this._fb.style.setProperty('--_bg', fill);
      const light = this.transparent ? false : t === 'light';
      this._fb.style.setProperty('--_hl', light ? '.35' : '.07'); this._fb.style.setProperty('--_sh', light ? '.18' : '.5');
      const poster = this.getAttribute('poster');
      if (poster) { if (this._poster.getAttribute('src') !== poster) this._poster.src = poster; this._poster.hidden = false; } else { this._poster.hidden = true; this._poster.removeAttribute('src'); }
      const showFb = (forceFallback || this._failed || this._lost) && !poster;
      if (forceFallback || this._failed || this._lost) this._poster.classList.remove('off');
      this._fb.hidden = !showFb;
      if (showFb) {
        const s = this._source(), fb = this._fb; fb.textContent = '';
        if (s.build && s.build.type === 'text') { const sp = document.createElement('span'); sp.className = 'tx'; sp.textContent = s.build.text; fb.appendChild(sp); }
        else {
          const mk = document.createElement('div'); mk.className = 'mk';
          if (s.svg) {
            const g = light ? ['#ffffff', '#8f8a83', '#f3f1ee'] : ['#f6f7f9', '#6d727a', '#e4e6ea'];
            mk.innerHTML = s.svg.replace('<svg ', '<svg aria-hidden="true" ').replace('<path ', `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${g[0]}"/><stop offset=".5" stop-color="${g[1]}"/><stop offset="1" stop-color="${g[2]}"/></linearGradient></defs><path fill="url(#g)" `);
          } else { const im = document.createElement('img'); im.alt = ''; im.src = s.src; mk.appendChild(im); }
          fb.appendChild(mk);
        }
        fb.setAttribute('role', 'img'); fb.setAttribute('aria-label', this._label());
      }
    }
    _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true })); }
  }
  customElements.define('spectra-logo', SpectraLogo);
})(DEPS.Engine, DEPS.SDF, DEPS.Samples);
