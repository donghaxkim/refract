/* Spectra v2 — src/ui2.js
 * window.SpectraUI = { init(engine, deps) }   deps = { SpectraSDF, SpectraSamples, defaultSample? }
 * Plain browser JS. Binds the minimal UI (wordmark, one pill, two popovers, drop frame, hint, toast)
 * to the SpectraEngine v2 API. The boot script owns engine creation and resize.
 */
(function (global) {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);

  function init(engine, deps) {
    deps = deps || {};
    const root = $('#sp-root'), ui = $('#sp-ui'), canvas = $('#spectra-canvas');
    const pill = $('#sp-pill'), dock = $('#sp-dock'), seg = $('#sp-seg'), ind = $('#sp-seg-ind');
    const btnLogo = $('#sp-logo'), btnExport = $('#sp-export'), btnLight = $('#sp-light');
    const popLogo = $('#sp-pop-logo'), popExport = $('#sp-pop-export'), popLight = $('#sp-pop-light');
    const hint = $('#sp-hint');
    const Engine = global.SpectraEngine || (engine && engine.constructor) || {};
    const call = (name, ...args) => { try { if (engine && typeof engine[name] === 'function') return engine[name].apply(engine, args); } catch (e) { console.error('[Spectra UI] engine.' + name, e); } };

    let material = 'glass', uiHidden = false, paused = false;
    let buildToken = 0, activeSample = null, exporting = null, logoName = '';

    /* ───── toast ───── */
    const toastEl = $('#sp-toast'); let toastT = 0;
    function toast(msg, kind, ms) {
      toastEl.textContent = msg;
      toastEl.classList.toggle('is-err', kind === 'err');
      positionToast();
      toastEl.classList.add('is-on');
      clearTimeout(toastT);
      toastT = setTimeout(() => toastEl.classList.remove('is-on'), ms || 2200);
    }
    function positionToast() {
      const open = openPop && !openPop.hidden ? openPop : null;
      toastEl.style.bottom = open ? 'calc(100% + ' + (open.offsetHeight + 22) + 'px)' : '';
    }

    /* ───── material ───── */
    function placeIndicator(anim) {
      const b = $('button[aria-checked="true"]', seg); if (!b) return;
      if (!anim) seg.classList.add('no-anim');
      ind.style.setProperty('--x', b.offsetLeft + 'px');
      ind.style.setProperty('--w', b.offsetWidth + 'px');
      if (!anim) { void ind.offsetWidth; seg.classList.remove('no-anim'); }
    }
    function setMaterial(m, anim) {
      if (m !== 'glass' && m !== 'chrome') return;
      material = m;
      $$('button[data-material]', seg).forEach((b) => {
        const on = b.dataset.material === m;
        b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1;
      });
      placeIndicator(anim !== false);
      call('setMaterial', m);
    }
    seg.addEventListener('click', (e) => { const b = e.target.closest('button[data-material]'); if (b) setMaterial(b.dataset.material); });
    seg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault(); const m = material === 'glass' ? 'chrome' : 'glass';
        setMaterial(m); $('button[data-material="' + m + '"]', seg).focus();
      }
    });

    /* ───── popovers ───── */
    let openPop = null, openBtn = null;
    function anchor(pop, btn) {
      const narrow = window.matchMedia('(max-width: 560px)').matches;
      const dr = dock.getBoundingClientRect(), br = btn.getBoundingClientRect();
      const cx = br.left + br.width / 2;
      if (narrow) { pop.style.left = ''; pop.style.setProperty('--ox', (cx - pop.getBoundingClientRect().left) + 'px'); return; }
      const w = pop.offsetWidth, vw = window.innerWidth;
      const left = clamp(cx - w / 2, 12, vw - 12 - w);
      pop.style.left = (left - dr.left) + 'px';
      pop.style.setProperty('--ox', (cx - left) + 'px');
    }
    function open(pop, btn) {
      if (openPop === pop) { close(); return; }
      close(true);
      pop.hidden = false; anchor(pop, btn);
      void pop.offsetWidth; pop.classList.add('is-open');
      btn.setAttribute('aria-expanded', 'true');
      openPop = pop; openBtn = btn; ui.classList.add('has-pop');
      if (pop === popExport) refreshExport();
      positionToast();
      const first = pop === popLogo ? null : $('button:not(:disabled)', pop);
      if (first && document.activeElement === btn && btn.matches(':focus-visible')) first.focus();
    }
    function close(instant, refocus) {
      if (!openPop) return;
      const pop = openPop, btn = openBtn;
      openPop = openBtn = null; ui.classList.remove('has-pop');
      btn.setAttribute('aria-expanded', 'false');
      pop.classList.remove('is-open');
      const done = () => { if (!pop.classList.contains('is-open')) pop.hidden = true; };
      if (instant) done(); else setTimeout(done, 200);
      if (refocus) btn.focus();
      positionToast();
    }
    btnLogo.addEventListener('click', () => open(popLogo, btnLogo));
    btnExport.addEventListener('click', () => open(popExport, btnExport));
    btnLight.addEventListener('click', () => open(popLight, btnLight));
    /* ───── shape: thickness & roundness ───── */
    (function shapeSliders() {
      let raf = 0; const st = {};
      const bind = (id, key) => {
        const el = $('#' + id), out = $('#' + id + '-v');
        const paint = () => { el.style.setProperty('--p', el.value + '%'); out.textContent = el.value; };
        el.addEventListener('input', () => { paint(); st[key] = el.value / 100; cancelAnimationFrame(raf); raf = requestAnimationFrame(() => call('setShape', { ...st })); });
        el.addEventListener('dblclick', () => { el.value = key === 'thickness' ? 50 : 65; el.dispatchEvent(new Event('input')); });
        paint();
      };
      bind('sp-thick', 'thickness'); bind('sp-round', 'roundness');
    })();
    /* ───── light mode & background ───── */
    function pick(attr, val) { $$('button[data-' + attr + ']', popLight).forEach((b) => b.setAttribute('aria-checked', String(b.dataset[attr] === val))); }
    function setLight(v) { pick('light', v); call('setLightMode', v); }
    function setTheme(v) { pick('theme', v); root.classList.toggle('is-light', v === 'light'); call('setTheme', v); }
    function setSource(v) { pick('source', v); call('setLightSource', v); }
    popLight.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.light) setLight(b.dataset.light);
      if (b.dataset.theme) setTheme(b.dataset.theme);
      if (b.dataset.source) setSource(b.dataset.source);
    });
    // arrow keys move (and select) within each radio group, like native radios
    popLight.addEventListener('keydown', (e) => {
      const k = e.key; if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k)) return;
      const b = e.target.closest('.sp-opt'); const g = b && b.parentElement; if (!g) return;
      const all = $$('.sp-opt', g), i = all.indexOf(b), d = k === 'ArrowLeft' || k === 'ArrowUp' ? -1 : 1;
      const nb = all[(i + d + all.length) % all.length]; e.preventDefault(); nb.focus(); nb.click();
    });
    // spectrum swatches, drawn from the engine's own source data: a gradient for continuous light, thin bars for emission lines
    (function paintSources() {
      const S = window.SpectraEngine && window.SpectraEngine.lightSources; if (!S) return;
      const hex = (c) => '#' + c.map(v => { v = Math.max(0, Math.min(1, v)); v = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; return Math.round(v * 255).toString(16).padStart(2, '0'); }).join('');
      const pos = (l) => ((l - 400) / 300 * 100).toFixed(2) + '%';
      S.forEach((s) => {
        const el = $('button[data-source="' + s.id + '"] .sp-ico-src i', popLight); if (!el) return;
        const mx = Math.max(...s.bands.map(b => Math.max(...b.rgb))) || 1;
        if (s.kind === 'cont') {
          el.style.backgroundImage = 'linear-gradient(90deg,' + s.bands.map(b => hex(b.rgb.map(v => v / mx)) + ' ' + pos(b.lam)).join(',') + ')';
        } else {
          const stops = []; s.bands.forEach((b) => {
            const m = Math.max(...b.rgb); if (m < mx * 0.01) return;
            const c = hex(b.rgb.map(v => v / m * Math.pow(m / mx, 0.35))), x = (b.lam - 400) / 300 * 100;
            stops.push('transparent ' + (x - 0.9).toFixed(2) + '%', c + ' ' + (x - 0.9).toFixed(2) + '%', c + ' ' + (x + 0.9).toFixed(2) + '%', 'transparent ' + (x + 0.9).toFixed(2) + '%');
          });
          el.style.backgroundImage = 'linear-gradient(90deg,' + stops.join(',') + ')';
        }
      });
    })();
    document.addEventListener('pointerdown', (e) => {
      if (!openPop) return;
      if (openPop.contains(e.target) || (openBtn && openBtn.contains(e.target))) return;
      close();
    }, true);

    /* ───── logo: samples / file / word ───── */
    function whiteSvgURL(svgText) {
      try {
        const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        const svg = doc.documentElement;
        if (!svg || svg.nodeName.toLowerCase() !== 'svg') throw new Error('not svg');
        svg.setAttribute('fill', '#fff');
        svg.querySelectorAll('*').forEach((el) => {
          const f = el.getAttribute('fill'), s = el.getAttribute('stroke');
          if (f && f !== 'none') el.setAttribute('fill', '#fff');
          if (s && s !== 'none') el.setAttribute('stroke', '#fff');
        });
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
      } catch (e) { return null; }
    }
    const samples = deps.SpectraSamples || global.SpectraSamples || [];
    const sampleRow = $('#sp-samples');
    samples.forEach((s, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'sp-smp'; b.dataset.sid = s.id || String(i);
      b.setAttribute('aria-pressed', 'false'); b.setAttribute('aria-label', s.name || 'Sample ' + (i + 1)); b.title = s.name || '';
      const url = whiteSvgURL(s.svg);
      if (url) { const img = new Image(); img.alt = ''; img.decoding = 'async'; img.src = url; b.appendChild(img); }
      b.addEventListener('click', () => loadSample(i));
      sampleRow.appendChild(b);
    });
    function markSample(sid, busy) {
      $$('.sp-smp', sampleRow).forEach((b) => {
        const on = sid != null && b.dataset.sid === sid;
        b.setAttribute('aria-pressed', String(on)); b.classList.toggle('is-busy', !!busy && on);
      });
    }
    function loadSample(i, quiet) {
      const s = samples[i]; if (!s) return;
      const sid = s.id || String(i); activeSample = sid; markSample(sid, true);
      return buildField({ type: 'svg', text: s.svg }, { sid, done: quiet ? null : s.name, name: s.name || sid });
    }
    async function buildField(source, opts) {
      opts = opts || {};
      const SDF = deps.SpectraSDF || global.SpectraSDF;
      if (!SDF || typeof SDF.build !== 'function') { toast('Shape builder isn’t available', 'err'); return; }
      const token = ++buildToken;
      btnLogo.classList.add('is-busy');
      try {
        const field = await SDF.build(source, { size: 1024 });
        if (token !== buildToken) return;
        call('setField', field);
        markSample(opts.sid || null, false);
        logoName = opts.name || '';
        if (opts.done) toast(opts.done);
      } catch (e) {
        console.error('[Spectra UI] build failed', e);
        if (token !== buildToken) return;
        markSample(activeSample, false);
        toast(opts.fail || 'Couldn’t read that shape. Try an SVG, or a PNG with transparency.', 'err', 4200);
      } finally {
        if (token === buildToken) btnLogo.classList.remove('is-busy');
      }
    }
    async function loadFile(file) {
      if (!file) return;
      const name = file.name || 'file';
      const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(name);
      const isImg = /^image\/(png|jpe?g|webp)$/i.test(file.type) || /\.(png|jpe?g|webp)$/i.test(name);
      const short = name.length > 28 ? name.slice(0, 25) + '…' : name;
      if (!isSvg && !isImg) { toast('Use an SVG or PNG file', 'err', 3200); return; }
      activeSample = null; markSample(null); close();
      if (isSvg) {
        let text = '';
        try { text = await file.text(); } catch (e) { toast('Couldn’t open ' + short, 'err'); return; }
        if (!/<svg[\s>]/i.test(text)) { toast(short + ' isn’t a valid SVG', 'err', 3200); return; }
        return buildField({ type: 'svg', text }, { done: 'Using ' + short, name: name.replace(/\.[^.]+$/, '') });
      }
      return buildField({ type: 'image', blob: file }, { done: 'Using ' + short, name: name.replace(/\.[^.]+$/, '') });
    }
    const fileIn = $('#sp-file');
    $('#sp-pick').addEventListener('click', () => fileIn.click());
    fileIn.addEventListener('change', () => { const f = fileIn.files && fileIn.files[0]; fileIn.value = ''; loadFile(f); });
    const wordForm = $('#sp-word'), wordIn = $('#sp-word-in');
    wordForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const w = wordIn.value.trim(); if (!w) return;
      activeSample = null; markSample(null);
      buildField({ type: 'text', text: w, fontFamily: '"Instrument Sans", Inter, system-ui, sans-serif', fontWeight: 700 }, { done: 'Using “' + w + '”', name: w });
      wordIn.blur(); close();
    });

    // drag & drop anywhere
    const dz = $('#sp-dropzone'); let depth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;
    window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; dz.classList.add('is-on'); });
    window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) dz.classList.remove('is-on'); });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return; e.preventDefault(); depth = 0; dz.classList.remove('is-on');
      loadFile(e.dataTransfer.files && e.dataTransfer.files[0]);
    });

    /* ───── downloads ───── */
    async function saveBlob(blob, filename) {
      let dl = null;
      try {
        const c = global.claude;
        if (c && c.use) { const r = c.use('downloads'); dl = r && typeof r.then === 'function' ? await r : r; }
      } catch (e) { dl = null; }
      if (dl && typeof dl.save === 'function') {
        try { await dl.save({ filename, data: blob }); toast('Saved ' + filename); return true; }
        catch (e) {
          const code = (e && (e.code || e.message)) || '';
          if (/declin|cancel|abort/i.test(String(code))) toast('Not saved');
          else toast('Couldn’t save ' + filename, 'err');
          return false;
        }
      }
      try {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = filename; a.rel = 'noopener'; a.style.display = 'none';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        toast('Saved ' + filename); return true;
      } catch (e) { toast('Couldn’t save ' + filename, 'err'); return false; }
    }

    /* ───── export ───── */
    const xpPng = $('#sp-xp-png'), xpMp4 = $('#sp-xp-mp4'), mp4Wrap = $('#sp-xp-mp4-wrap');
    const prog = $('#sp-prog'), progFill = $('#sp-prog-fill'), progPct = $('#sp-prog-pct'), progLabel = $('#sp-prog-label');
    const xp3d = $('#sp-xp-3d'), xpGlb = $('#sp-xp-glb'), xpStl = $('#sp-xp-stl');
    const Mesh = deps.SpectraMesh || global.SpectraMesh || null;
    let meshAbort = null;
    const canVideo = () => { try { return !!Engine.canRenderVideo; } catch (e) { return false; } };
    function viewSize() { return [Math.max(1, canvas.clientWidth || window.innerWidth), Math.max(1, canvas.clientHeight || window.innerHeight)]; }
    function pngSize() { const v = viewSize(); let W = v[0] * 2, H = v[1] * 2; const m = Math.max(W, H); if (m > 8192) { W *= 8192 / m; H *= 8192 / m; } return [Math.round(W), Math.round(H)]; }
    function videoSize() { const v = viewSize(), a = v[0] / v[1]; return a > 0.8 && a < 1.25 ? [1080, 1080] : [1920, 1080]; }
    function stamp() { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
    function refreshExport() {
      const p = pngSize(), v = videoSize();
      $('#sp-xp-png-s').textContent = p[0] + '×' + p[1];
      $('#sp-xp-mp4-s').textContent = v[0] + '×' + v[1] + ', 6s';
      mp4Wrap.hidden = !canVideo();
      xpPng.disabled = !!exporting; xpMp4.disabled = !!exporting;
      xp3d.hidden = !Mesh;
      const noShape = !(engine && engine.beam && engine.beam.ok);
      xpGlb.disabled = !!exporting || noShape; xpStl.disabled = !!exporting || noShape;
    }
    function setProg(f, label) {
      f = clamp(f || 0, 0, 1);
      progFill.style.setProperty('--p', f.toFixed(4));
      progPct.textContent = Math.round(f * 100) + '%';
      prog.querySelector('.sp-prog-bar').setAttribute('aria-valuenow', String(Math.round(f * 100)));
      if (label) progLabel.textContent = label;
    }
    const isAbort = (e) => e && (e.name === 'AbortError' || /cancel|abort/i.test(e.message || ''));
    xpPng.addEventListener('click', async () => {
      if (exporting) return;
      exporting = 'png'; refreshExport();
      const s = pngSize();
      const old = xpPng.querySelector('.sp-row-s').textContent;
      try {
        const blob = await engine.renderStill({ width: s[0], height: s[1], onProgress: (f) => { if (typeof f === 'number') xpPng.querySelector('.sp-row-s').textContent = Math.round(clamp(f, 0, 1) * 100) + '%'; } });
        if (!blob) throw new Error('empty');
        close(); await saveBlob(blob, 'spectra-' + stamp() + '.png');
      } catch (e) {
        if (isAbort(e)) toast('Export cancelled'); else { console.error('[Spectra UI] renderStill', e); toast('PNG export failed', 'err'); }
      } finally { exporting = null; xpPng.querySelector('.sp-row-s').textContent = old; refreshExport(); }
    });
    xpMp4.addEventListener('click', async () => {
      if (exporting || !canVideo()) return;
      exporting = 'mp4'; refreshExport();
      const v = videoSize();
      xpMp4.hidden = true; prog.hidden = false; setProg(0, 'Rendering loop');
      $('#sp-cancel').focus();
      try {
        const blob = await engine.renderVideo({ width: v[0], height: v[1], fps: 30, seconds: 6, onProgress: (f) => setProg(typeof f === 'number' ? f : (f && f.progress) || 0) });
        if (!blob) throw new Error('empty');
        setProg(1, 'Saving');
        await saveBlob(blob, 'spectra-loop-' + stamp() + '.mp4');
        close();
      } catch (e) {
        if (isAbort(e)) toast('Export cancelled'); else { console.error('[Spectra UI] renderVideo', e); toast('MP4 export failed', 'err'); }
      } finally {
        exporting = null; prog.hidden = true; xpMp4.hidden = false; refreshExport();
      }
    });
    /* 3D model: GLB (glTF 2.0, metres, Y-up) / STL (mm, Z-up, flat on the plate). Meshing runs in a worker. */
    function slug(s) { return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'logo'; }
    async function exportMesh(format, btn, wrap, high) {
      if (exporting || !Mesh) return;
      exporting = format; refreshExport();
      const home = prog.parentNode, label = format === 'glb' ? 'Building GLB' : 'Building STL';
      wrap.appendChild(prog); btn.hidden = true; prog.hidden = false; setProg(0, high ? label + ' · fine' : label);
      $('#sp-cancel').focus();
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null; meshAbort = ctl;
      try {
        const r = await Mesh.export(engine, format, { quality: high ? 'high' : 'standard', name: logoName || 'Spectra logo', material, signal: ctl && ctl.signal, onProgress: (f) => setProg(f * 0.96) });
        setProg(1, 'Saving');
        const blob = new Blob([r.bytes], { type: r.mime });
        await saveBlob(blob, 'spectra-' + slug(logoName) + '-' + stamp() + '.' + r.ext);
        close();
      } catch (e) {
        if (isAbort(e)) toast('Export cancelled'); else { console.error('[Spectra UI] mesh export', e); toast(format.toUpperCase() + ' export failed', 'err'); }
      } finally {
        meshAbort = null; exporting = null; prog.hidden = true; btn.hidden = false; home.appendChild(prog); refreshExport();
      }
    }
    xpGlb.addEventListener('click', (e) => exportMesh('glb', xpGlb, $('#sp-xp-glb-wrap'), e.shiftKey));
    xpStl.addEventListener('click', (e) => exportMesh('stl', xpStl, $('#sp-xp-stl-wrap'), e.shiftKey));
    $('#sp-cancel').addEventListener('click', () => { if (meshAbort) meshAbort.abort(); else call('cancelRender'); });

    /* ───── pointer → engine ───── */
    let hinted = false, drag = null;
    // Camera mode: only steer while the pointer is inside the viewfinder (and not on a camera control); elsewhere, and when the
    // pointer leaves the window, the last aim is held so the composition doesn't swing on the way to Shutter / Stop.
    const camOpen = () => !!(api.camera && api.camera.isOpen());
    // The path from the logo to Shutter / Stop crosses the lower part of the frame, so on leaving the steering area the light is put
    // back where that last, roughly straight stroke out began: the move to a control never becomes the composition. Geometric
    // rather than timed, so it holds however laggy the live view (and so the pointer event rate) is.
    let trail = [], steering = false;
    function rewindPoint() {
      const n = trail.length, E = trail[n - 1]; let j = n - 1;
      while (j > 0 && Math.hypot(E[0] - trail[j][0], E[1] - trail[j][1]) < 24) j--; // local exit direction, over ≥ 24 px
      const dx = E[0] - trail[j][0], dy = E[1] - trail[j][1], L = Math.hypot(dx, dy);
      if (L < 24) return [E[0], E[1], curAng()]; // barely moved: hold where it is
      const ux = dx / L, uy = dy / L; let k = n - 1;
      for (let i = n - 2; i >= 0; i--) {
        const sx = trail[i + 1][0] - trail[i][0], sy = trail[i + 1][1] - trail[i][1], sl = Math.hypot(sx, sy);
        if (sl > 2 && (sx * ux + sy * uy) / sl < 0.7) break; // the stroke turned (> ~45°): this is where it began
        k = i;
      }
      // near the logo the pointer doesn't set the light's angle, so also restore the angle it had while the pointer was there
      // (the target as seen when the next point arrived, i.e. after frames with this point applied)
      return [trail[k][0], trail[k][1], (trail[k + 1] || [0, 0, curAng()])[2]];
    }
    const curAng = () => (engine && engine.target ? engine.target.ang : null);
    function camSteers(e) {
      if (!camOpen() || !api.camera.steers) { trail.length = 0; steering = false; return true; }
      if (api.camera.steers(e)) { trail.push(toCanvas(e).concat(curAng())); if (trail.length > 96) trail.shift(); steering = true; return true; }
      if (steering && trail.length) { const p = rewindPoint(); call('setPointer', p[0], p[1]); if (p[2] != null && engine.target) engine.target.ang = p[2]; }
      steering = false; trail.length = 0; return false;
    }
    function toCanvas(e) { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    function dismissHint() { if (hinted) return; hinted = true; setTimeout(() => hint.classList.add('is-gone'), 2600); }
    // hover steers the light; press-and-drag spins the logo (touch: drag spins, tap aims the light)
    window.addEventListener('pointermove', (e) => {
      if (drag && e.pointerId === drag.id) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
        call('rotateBy', dx, dy); dismissHint(); return;
      }
      if (e.pointerType === 'touch') return;
      if (!camSteers(e)) return; // camera: hold the composed aim while the pointer is on the controls
      const p = toCanvas(e); call('setPointer', p[0], p[1]); dismissHint();
    }, { passive: true });
    canvas.addEventListener('pointerdown', (e) => {
      if (openPop) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0, touch: e.pointerType === 'touch' };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      canvas.classList.add('is-dragging'); call('beginRotate');
    });
    const endDrag = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.touch && drag.moved < 8 && camSteers(e)) { const p = toCanvas(e); call('setPointer', p[0], p[1]); }
      drag = null; canvas.classList.remove('is-dragging'); call('endRotate');
    };
    window.addEventListener('pointerup', endDrag); window.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('dblclick', () => call('resetRotation'));
    document.documentElement.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && !drag && !camOpen()) call('setPointer', null); });
    document.addEventListener('mouseout', (e) => { if (!e.relatedTarget && !e.toElement && !drag && !camOpen()) call('setPointer', null); });
    window.addEventListener('blur', () => { if (!camOpen()) call('setPointer', null); });

    /* ───── keyboard ───── */
    function setHidden(h) {
      uiHidden = h; ui.classList.toggle('is-hidden', h);
      if (h) { close(true); if (ui.contains(document.activeElement)) document.activeElement.blur(); }
    }
    window.addEventListener('keydown', (e) => {
      const t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === 'Escape') {
        if (openPop) { e.preventDefault(); close(false, true); return; }
        if (uiHidden) { setHidden(false); return; }
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'g') setMaterial('glass');
      else if (k === 'c') setMaterial('chrome');
      else if (k === 'h') setHidden(!uiHidden);
      else if (e.key === ' ' || e.code === 'Space') {
        if (t && t.tagName === 'BUTTON' && t.matches(':focus-visible')) return; // keyboard users: Space activates the focused button
        e.preventDefault();
        const r = call('togglePause', !paused); paused = typeof r === 'boolean' ? r : !paused;
        toast(paused ? 'Paused' : 'Playing', null, 1200);
      }
    });

    /* ───── layout / insets ───── */
    function insets() {
      if (!pill.offsetParent) return; // pill hidden (camera mode frames the view itself)
      const r = pill.getBoundingClientRect();
      const bottom = Math.max(0, Math.round(window.innerHeight - r.top + 8));
      call('setViewInsets', { right: 0, bottom });
    }
    let rT = 0;
    window.addEventListener('resize', () => { cancelAnimationFrame(rT); rT = requestAnimationFrame(() => { placeIndicator(false); insets(); if (openPop) anchor(openPop, openBtn); }); });

    /* ───── engine events ───── */
    if (engine && typeof engine.on === 'function') {
      engine.on('error', (e) => { console.error('[Spectra UI] engine error', e); toast((e && e.message) || 'Rendering error', 'err', 4200); });
      engine.on('ready', () => ui.classList.add('is-in'));
    }

    /* ───── boot ───── */
    try { const m = engine && engine.getMaterial && engine.getMaterial(); if (m === 'glass' || m === 'chrome') material = m; } catch (e) { /* noop */ }
    setMaterial(material, false);
    insets();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { placeIndicator(false); insets(); });
    requestAnimationFrame(() => ui.classList.add('is-in')); // don't wait on 'ready' forever
    if (deps.defaultSample != null) {
      const i = typeof deps.defaultSample === 'number' ? deps.defaultSample : samples.findIndex((s) => s.id === deps.defaultSample);
      if (i >= 0) loadSample(i, true);
    }
    if (!engine) toast('Renderer unavailable in this browser', 'err', 6000);

    const api = { toast, setMaterial, loadFile, loadSample, close, hide: setHidden, isHidden: () => uiHidden, saveBlob, relayout: () => { placeIndicator(false); insets(); } };
    // camera mode (src/camera.js): Photo / Video / Loop with viewfinder, trimmer and offline capture
    if (global.SpectraCamera) { try { api.camera = global.SpectraCamera.init(engine, api); } catch (e) { console.error('[Spectra UI] camera', e); } }
    return api;
  }

  global.SpectraUI = { init };
})(typeof window !== 'undefined' ? window : this);
