/* Spectra — src/camera.js
 * Camera mode: Photo / Video / Loop, a shutter, an aspect-ratio viewfinder, resolution presets, transparent photos,
 * a recording pill and a preview sheet with an iOS-style filmstrip trimmer.
 *
 * Camera UX adapted from 3dsvg by Renato Costa, MIT (packages/web/src/components/export-bar.tsx: ShutterButton,
 * ViewfinderOverlay, camera bar → recording pill → preview; video-trimmer.tsx: filmstrip, start/end handles, scrub playhead).
 *
 * The capture pipeline is Spectra's own. Nothing is screen-recorded or cropped:
 *  - the viewfinder IS the output: engine.setFrameAspect() renders the live view only inside the frame with the offline camera;
 *  - Photo → engine.renderStill({ aspect, width, height }) at full quality;
 *  - Video → engine.startTimeline() records what drives the image each frame; the preview replays it live; Download renders the
 *    trimmed range offline at a fixed fps (engine.renderTimeline) to H.264 MP4: frame-perfect however laggy the session was;
 *  - Loop → the seamless 6 s loop (engine.renderVideo) at the chosen aspect and resolution.
 *
 * window.SpectraCamera = { init(engine, api) }   api = SpectraUI's { toast, saveBlob, relayout, close, isHidden }
 */
(function (global) {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const ASPECTS = { free: 0, '1:1': 1, '4:5': 4 / 5, '9:16': 9 / 16, '16:9': 16 / 9 };
  const RES = [{ label: '1080p', s: 1080 }, { label: '2K', s: 1440 }, { label: '4K', s: 2160 }]; // short edge, like 1080p / 1440p / 2160p
  const MAX_REC = 60, MIN_TRIM = 0.3, LOOP_SECONDS = 6, LOOP_FPS = 30;
  const NOTES = {
    photo: 'Rendered offline at full quality, framed exactly as you see it.',
    video: 'Steer and spin while recording. Every frame is re-rendered offline, so it’s smooth even if this view stutters.',
    loop: 'A seamless 6-second loop of the light, rendered offline.',
  };
  const fmt = (t) => { const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); };
  const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); };
  const isAbort = (e) => e && (e.name === 'AbortError' || /cancel|abort/i.test(e.message || ''));

  function init(engine, api) {
    api = api || {};
    const root = $('#sp-root'), ui = $('#sp-ui'), canvas = $('#spectra-canvas'), dock = $('#sp-dock');
    const camBtn = $('#sp-camera'), cam = $('#sp-cam');
    if (!cam || !engine || typeof engine.setFrameAspect !== 'function') { if (camBtn) camBtn.hidden = true; return null; }
    const vf = $('#sp-vf'), vfSize = $('#sp-vf-size'), flash = $('#sp-vf-flash'), vfImg = $('#sp-vf-img'), vfVideo = $('#sp-vf-video');
    const bar = $('#sp-cam-bar'), aspectGroup = $('#sp-cam-aspect'), modeGroup = $('#sp-cam-modes'), resBtn = $('#sp-cam-res');
    const shutter = $('#sp-shutter'), closeBtn = $('#sp-cam-close'), clearBtn = $('#sp-cam-clear'), note = $('#sp-cam-note');
    const rec = $('#sp-cam-rec'), recTime = $('#sp-rec-time'), recStop = $('#sp-rec-stop');
    const busy = $('#sp-cam-busy');
    const sheet = $('#sp-sheet'), sheetTitle = $('#sp-sheet-title'), sheetMeta = $('#sp-sheet-meta'), sheetOpts = $('#sp-sheet-opts'), sheetNote = $('#sp-sheet-note');
    const sheetProg = $('#sp-sheet-prog'), actions = $('#sp-sheet-actions'), retakeBtn = $('#sp-retake'), dlBtn = $('#sp-dl'), fpsGroup = $('#sp-cam-fps');
    const trim = $('#sp-trim'), strip = $('#sp-trim-strip'), film = $('#sp-trim-film'), playBtn = $('#sp-trim-play');
    const hS = $('#sp-trim-hs'), hE = $('#sp-trim-he'), head = $('#sp-trim-head'), sel = $('#sp-trim-sel'), dimL = $('#sp-trim-dim-l'), dimR = $('#sp-trim-dim-r');
    const Engine = global.SpectraEngine || engine.constructor || {};
    const canVideo = () => { try { return !!Engine.canRenderVideo; } catch (e) { return false; } };
    const reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
    const toast = (m, k, ms) => { if (api.toast) api.toast(m, k, ms); };
    // checkerboard under the canvas, inside the frame, for transparent photos
    const checker = document.createElement('div'); checker.className = 'sp-cam-checker'; checker.hidden = true; checker.setAttribute('aria-hidden', 'true');
    root.insertBefore(checker, canvas);

    const st = {
      open: false, state: 'bar', mode: 'photo', aspect: 'free', res: { photo: 1, video: 0, loop: 0 }, clear: false,
      frame: null, reserve: 0, prevTransparent: false, suspended: false, session: 0,
      tl: null, trim: [0, 0], fps: 60, blob: null, url: null, timer: 0, recT0: 0, rendering: false, hinted: false,
    };

    /* ───── sizes & framing ───── */
    function dims(mode) {
      mode = mode || st.mode;
      const a = st.frame ? st.frame.aspect : 1, S = RES[st.res[mode]].s;
      let w = a >= 1 ? S * a : S, h = a >= 1 ? S : S / a;
      const cap = mode === 'photo' ? Math.min(engine.maxTex || 8192, 8192) : 4096; // H.264 encoders top out around 4096
      const k = Math.min(1, cap / Math.max(w, h)); w *= k; h *= k;
      if (mode === 'photo') return [Math.round(w), Math.round(h)];
      return [Math.max(2, Math.round(w / 2) * 2), Math.max(2, Math.round(h / 2) * 2)];
    }
    function box() {
      const W = canvas.clientWidth || window.innerWidth, H = canvas.clientHeight || window.innerHeight, narrow = W <= 560;
      const side = narrow ? 14 : 28, top = narrow ? 58 : 64;
      return { x: side, y: top, w: W - 2 * side, h: H - top - st.reserve - 14 };
    }
    function measureReserve() {
      const el = st.state === 'preview' ? sheet : st.state === 'bar' ? bar : null; // recording / rendering keep the frame still
      if (!el || el.hidden) return;
      // layout box, not getBoundingClientRect: the entry animation's transform must not change the framing
      st.reserve = Math.max(0, (canvas.clientHeight || window.innerHeight) - el.offsetTop);
    }
    function fit() {
      if (!st.open) return;
      measureReserve();
      const f = engine.setFrameAspect(ASPECTS[st.aspect], box()); st.frame = f; if (!f) return;
      const css = 'left:' + f.x + 'px;top:' + f.y + 'px;width:' + f.w + 'px;height:' + f.h + 'px';
      vf.style.cssText = css; checker.style.cssText = css;
      const d = dims(); vfSize.textContent = d[0] + ' × ' + d[1];
      resBtn.textContent = RES[st.res[st.mode]].label;
      resBtn.setAttribute('aria-label', 'Resolution ' + RES[st.res[st.mode]].label + ', ' + d[0] + ' by ' + d[1] + ' pixels');
      resBtn.title = d[0] + ' × ' + d[1] + ' px · click to change';
      dock.style.bottom = (st.reserve + 8) + 'px'; // keep toasts above the camera UI
      if (st.state === 'preview' && st.tl) layoutTrim(true);
    }

    /* ───── state ───── */
    function setState(s) {
      st.state = s;
      bar.hidden = s !== 'bar'; rec.hidden = s !== 'rec'; busy.hidden = s !== 'busy'; sheet.hidden = s !== 'preview';
      vf.classList.toggle('is-rec', s === 'rec');
      fit();
    }
    function setMode(m) {
      if (!NOTES[m]) return;
      if ((m === 'video' || m === 'loop') && !canVideo()) { toast('This browser can’t encode MP4 video', 'err', 3200); return; }
      st.mode = m;
      $$('button[data-mode]', modeGroup).forEach((b) => { const on = b.dataset.mode === m; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
      shutter.dataset.mode = m;
      shutter.setAttribute('aria-label', m === 'photo' ? 'Take photo' : m === 'video' ? 'Start recording' : 'Render 6-second loop');
      clearBtn.classList.toggle('is-off', m !== 'photo'); clearBtn.tabIndex = m === 'photo' ? 0 : -1;
      note.textContent = NOTES[m];
      applyClear(); fit();
    }
    function applyClear() {
      const on = st.open && st.mode === 'photo' && st.clear;
      clearBtn.setAttribute('aria-pressed', String(st.clear));
      if (typeof engine.setTransparent === 'function') engine.setTransparent(on || (!st.open && st.prevTransparent));
      checker.hidden = !on;
    }
    function setAspect(id) {
      if (!(id in ASPECTS)) return; st.aspect = id;
      $$('button[data-aspect]', aspectGroup).forEach((b) => { const on = b.dataset.aspect === id; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
      fit();
    }
    function radioKeys(group, attr, setFn) { // arrow keys move within a radiogroup, like the material switch
      group.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const bs = $$('button[data-' + attr + ']:not(:disabled)', group), i = bs.findIndex((b) => b.getAttribute('aria-checked') === 'true');
        const n = bs[(i + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length]; if (!n) return;
        e.preventDefault(); setFn(n.dataset[attr]); n.focus();
      });
      group.addEventListener('click', (e) => { const b = e.target.closest('button[data-' + attr + ']'); if (b) setFn(b.dataset[attr]); });
    }
    radioKeys(aspectGroup, 'aspect', setAspect);
    radioKeys(modeGroup, 'mode', setMode);
    radioKeys(fpsGroup, 'fps', (v) => { st.fps = +v; $$('button[data-fps]', fpsGroup).forEach((b) => { const on = +b.dataset.fps === st.fps; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }); updateMeta(); });
    resBtn.addEventListener('click', () => { st.res[st.mode] = (st.res[st.mode] + 1) % RES.length; fit(); });
    clearBtn.addEventListener('click', () => { st.clear = !st.clear; applyClear(); });
    if (!canVideo()) $$('button[data-mode="video"], button[data-mode="loop"]', modeGroup).forEach((b) => { b.disabled = true; b.title = 'This browser can’t encode MP4 video'; });

    /* ───── open / close ───── */
    function openCam() {
      if (st.open) return;
      if (api.close) api.close(true);
      st.open = true; st.session++; st.prevTransparent = !!engine.transparent;
      cam.hidden = false; ui.classList.add('is-cam'); camBtn.setAttribute('aria-expanded', 'true');
      setMode(st.mode); setAspect(st.aspect); setState('bar');
      shutter.focus({ preventScroll: true });
      if (!st.hinted) { st.hinted = true; toast('Camera · Esc to close', null, 1800); }
    }
    function closeCam(refocus) {
      if (!st.open) return;
      if (st.state === 'rec') stopRecTimer(), engine.stopTimeline();
      if (st.rendering) engine.cancelRender();
      clearPreview();
      st.open = false; st.session++;
      engine.setFrameAspect(null); applyClear();
      cam.hidden = true; checker.hidden = true; ui.classList.remove('is-cam'); dock.style.bottom = '';
      camBtn.setAttribute('aria-expanded', 'false');
      if (api.relayout) api.relayout();
      if (refocus) camBtn.focus({ preventScroll: true });
    }
    camBtn.addEventListener('click', () => (st.open ? closeCam(true) : openCam()));
    closeBtn.addEventListener('click', () => closeCam(true));

    /* ───── photo ───── */
    function doFlash() {
      if (reduce.matches) return;
      flash.classList.remove('is-on'); void flash.offsetWidth; flash.classList.add('is-on');
    }
    async function takePhoto() {
      if (st.rendering) return;
      const session = st.session, [w, h] = dims('photo'), aspect = st.frame.aspect, clear = st.clear;
      st.rendering = true; shutter.classList.add('is-busy'); shutter.setAttribute('aria-busy', 'true');
      doFlash();
      try {
        const blob = await engine.renderStill({ width: w, height: h, aspect, samples: 32, transparent: clear });
        if (session !== st.session || !blob) return;
        showMedia('photo', blob, { w, h, clear });
      } catch (e) {
        if (isAbort(e)) toast('Cancelled'); else { console.error('[Spectra camera] photo', e); toast('Photo failed', 'err'); }
      } finally { st.rendering = false; shutter.classList.remove('is-busy'); shutter.removeAttribute('aria-busy'); }
    }

    /* ───── loop (the seamless 6 s export, framed by the viewfinder) ───── */
    const busyLabel = $('#sp-busy-label'), busyPct = $('#sp-busy-pct'), busyFill = $('#sp-busy-fill');
    function setBusyProg(f, label) {
      f = clamp(f || 0, 0, 1); busyFill.style.setProperty('--p', f.toFixed(4)); busyPct.textContent = Math.round(f * 100) + '%';
      busy.querySelector('.sp-prog-bar').setAttribute('aria-valuenow', String(Math.round(f * 100))); if (label) busyLabel.textContent = label;
    }
    async function renderLoop() {
      if (st.rendering || !canVideo()) return;
      const session = st.session, [w, h] = dims('loop');
      st.rendering = true; setState('busy'); setBusyProg(0, 'Rendering loop'); $('#sp-busy-cancel').focus({ preventScroll: true });
      try {
        const blob = await engine.renderVideo({ width: w, height: h, fps: LOOP_FPS, seconds: LOOP_SECONDS, spp: 8, onProgress: (f) => setBusyProg(f) });
        if (session !== st.session || !blob) return;
        showMedia('loop', blob, { w, h });
      } catch (e) {
        if (session !== st.session) return;
        if (isAbort(e)) toast('Render cancelled'); else { console.error('[Spectra camera] loop', e); toast('MP4 render failed', 'err'); }
        setState('bar'); shutter.focus({ preventScroll: true });
      } finally { st.rendering = false; }
    }
    $('#sp-busy-cancel').addEventListener('click', () => engine.cancelRender());

    /* ───── preview of a finished file (photo / loop) ───── */
    function showMedia(kind, blob, o) {
      clearPreview();
      st.blob = blob; st.url = URL.createObjectURL(blob); st.kind = kind; st.file = { w: o.w, h: o.h };
      const el = kind === 'photo' ? vfImg : vfVideo;
      el.classList.toggle('is-clear', !!o.clear); el.src = st.url; el.hidden = false;
      if (kind === 'loop') { vfVideo.controls = !!reduce.matches; if (!reduce.matches) vfVideo.play().catch(() => {}); }
      if (typeof engine.suspend === 'function') { engine.suspend(); st.suspended = true; } // the preview is the file itself
      sheetTitle.textContent = kind === 'photo' ? 'Photo' : 'Loop';
      sheetMeta.textContent = o.w + ' × ' + o.h + (kind === 'photo' ? ' · PNG' + (o.clear ? ' · transparent' : '') : ' · ' + LOOP_SECONDS + ' s · ' + LOOP_FPS + ' fps · MP4');
      trim.hidden = true; sheetOpts.hidden = true; sheetProg.hidden = true; actions.hidden = false;
      retakeBtn.textContent = kind === 'photo' ? 'Retake' : 'Back';
      dlBtn.textContent = kind === 'photo' ? 'Download PNG' : 'Download MP4'; dlBtn.disabled = false;
      setState('preview'); dlBtn.focus({ preventScroll: true });
    }
    function clearPreview() {
      if (st.url) { URL.revokeObjectURL(st.url); st.url = null; }
      st.blob = null; st.kind = null;
      vfImg.hidden = true; vfImg.removeAttribute('src');
      try { vfVideo.pause(); } catch (e) { /* noop */ }
      vfVideo.hidden = true; vfVideo.removeAttribute('src'); try { vfVideo.load(); } catch (e) { /* noop */ }
      if (st.tl) { engine.stopReplay(); st.tl = null; }
      if (st.suspended) { st.suspended = false; if (typeof engine.resume === 'function') engine.resume(); }
    }
    function retake() {
      if (st.rendering) { engine.cancelRender(); return; }
      clearPreview(); setState('bar'); shutter.focus({ preventScroll: true });
    }
    retakeBtn.addEventListener('click', retake);

    /* ───── video: record a timeline ───── */
    function stopRecTimer() { clearInterval(st.timer); st.timer = 0; }
    function startRec() {
      if (st.rendering || !canVideo()) return;
      engine.startTimeline({ maxSeconds: MAX_REC + 1, thumbHeight: 72, thumbEvery: 0.15 });
      st.recT0 = performance.now(); recTime.textContent = fmt(0);
      setState('rec'); recStop.focus({ preventScroll: true });
      st.timer = setInterval(() => {
        const t = (performance.now() - st.recT0) / 1000; recTime.textContent = fmt(Math.min(t, MAX_REC));
        if (t >= MAX_REC) stopRec();
      }, 100);
    }
    function stopRec() {
      if (st.state !== 'rec') return;
      stopRecTimer();
      const tl = engine.stopTimeline();
      if (!tl || tl.duration < MIN_TRIM) { toast('Too short. Record a little longer.'); setState('bar'); shutter.focus({ preventScroll: true }); return; }
      clearPreview();
      st.tl = tl; st.trim = [0, tl.duration]; st.kind = 'video';
      engine.playTimeline(tl, { start: 0, end: tl.duration, playing: !reduce.matches });
      sheetTitle.textContent = 'Video';
      trim.hidden = false; sheetOpts.hidden = false; sheetProg.hidden = true; actions.hidden = false;
      retakeBtn.textContent = 'Retake'; dlBtn.textContent = 'Download MP4'; dlBtn.disabled = !canVideo();
      updateMeta();
      setState('preview'); // fit() → layoutTrim()
      drawFilm(); syncPlay();
      playBtn.focus({ preventScroll: true }); // not Download: activating it starts a long render (Space plays / pauses here)
    }
    recStop.addEventListener('click', stopRec);
    function updateMeta() {
      if (st.kind !== 'video' || !st.tl) return;
      const [w, h] = dims('video'), len = st.trim[1] - st.trim[0];
      sheetMeta.textContent = w + ' × ' + h + ' · ' + len.toFixed(1) + ' s · ' + st.fps + ' fps · MP4';
      sheetNote.textContent = 'Download renders all ' + Math.max(1, Math.round(len * st.fps)) + ' frames offline: smooth even if the live view stuttered.';
    }

    /* ───── trimmer (filmstrip, handles, scrub playhead) ───── */
    const HW = 14;
    function trackW() { return Math.max(1, strip.clientWidth - 2 * HW); }
    const tToX = (t) => HW + (t / (st.tl ? st.tl.duration : 1)) * trackW();
    const xToT = (clientX) => { const r = strip.getBoundingClientRect(); return clamp((clientX - r.left - HW) / trackW(), 0, 1) * st.tl.duration; };
    function drawFilm() {
      const tl = st.tl; if (!tl) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2), W = trackW(), H = strip.clientHeight || 48;
      film.width = Math.round(W * dpr); film.height = Math.round(H * dpr);
      const g = film.getContext('2d'); g.clearRect(0, 0, film.width, film.height);
      const th = tl.thumbs || []; if (!th.length) return;
      const a = th[0].canvas.width / th[0].canvas.height, slot = Math.max(16, H * a), n = Math.ceil(W / slot);
      let j = 0;
      for (let i = 0; i < n; i++) {
        const t = clamp((i + 0.5) * slot / W, 0, 1) * tl.duration;
        while (j < th.length - 1 && Math.abs(th[j + 1].t - t) <= Math.abs(th[j].t - t)) j++;
        const c = th[j].canvas, sw = c.width, sh = c.height, s = Math.max(slot / sw, H / sh); // cover
        const cw = slot / s, ch = H / s;
        g.drawImage(c, (sw - cw) / 2, (sh - ch) / 2, cw, ch, Math.round(i * slot * dpr), 0, Math.ceil(slot * dpr), film.height);
      }
    }
    function layoutTrim(redraw) {
      if (!st.tl) return;
      const [s, e] = st.trim, xs = tToX(s), xe = tToX(e), W = strip.clientWidth, d = st.tl.duration;
      hS.style.left = (xs - HW) + 'px'; hE.style.left = xe + 'px';
      sel.style.left = (xs - HW) + 'px'; sel.style.width = (xe - xs + 2 * HW) + 'px';
      dimL.style.left = HW + 'px'; dimL.style.width = Math.max(0, xs - HW) + 'px';
      dimR.style.left = xe + 'px'; dimR.style.width = Math.max(0, W - HW - xe) + 'px';
      [[hS, s, 0, e - MIN_TRIM], [hE, e, s + MIN_TRIM, d]].forEach(([h, v, mn, mx]) => {
        h.setAttribute('aria-valuemin', mn.toFixed(1)); h.setAttribute('aria-valuemax', mx.toFixed(1));
        h.setAttribute('aria-valuenow', v.toFixed(1)); h.setAttribute('aria-valuetext', v.toFixed(1) + ' seconds');
      });
      $('#sp-trim-t0').textContent = s.toFixed(1) + 's'; $('#sp-trim-t1').textContent = e.toFixed(1) + 's';
      $('#sp-trim-len').textContent = (e - s).toFixed(1) + 's';
      const r = engine.getReplay && engine.getReplay(); if (r) placeHead(r.t);
      if (redraw) drawFilm();
      updateMeta();
    }
    function placeHead(t) { head.style.transform = 'translateX(' + tToX(clamp(t, st.trim[0], st.trim[1])) + 'px)'; }
    function syncPlay() {
      const r = engine.getReplay && engine.getReplay(), playing = !!(r && r.playing);
      playBtn.classList.toggle('is-paused', !playing); playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }
    function setTrim(s, e) {
      const d = st.tl.duration;
      s = clamp(s, 0, Math.max(0, d - MIN_TRIM)); e = clamp(e, Math.min(d, s + MIN_TRIM), d);
      st.trim = [s, e]; engine.setReplay({ start: s, end: e }); layoutTrim(false);
    }
    const seek = (t) => { engine.setReplay({ t }); placeHead(t); };
    function togglePlay(force) {
      const r = engine.getReplay(); if (!r) return;
      const p = typeof force === 'boolean' ? force : !r.playing;
      engine.setReplay({ playing: p, t: p && (r.t < st.trim[0] || r.t >= st.trim[1] - 0.02) ? st.trim[0] : r.t }); syncPlay();
    }
    playBtn.addEventListener('click', () => togglePlay());
    engine.on('replay', (r) => { if (st.state === 'preview' && st.tl) placeHead(r.t); });
    let drag = null;
    strip.addEventListener('pointerdown', (e) => {
      if (!st.tl || st.rendering || e.button > 0) return;
      e.preventDefault();
      const h = e.target.closest('[data-handle]'), r = engine.getReplay();
      drag = { kind: h ? h.dataset.handle : 'scrub', id: e.pointerId, was: !!(r && r.playing) };
      engine.setReplay({ playing: false }); syncPlay();
      try { strip.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      if (h) h.focus({ preventScroll: true }); else seek(clamp(xToT(e.clientX), st.trim[0], st.trim[1]));
    });
    strip.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const t = xToT(e.clientX);
      if (drag.kind === 'start') { setTrim(t, st.trim[1]); seek(st.trim[0]); }
      else if (drag.kind === 'end') { setTrim(st.trim[0], t); seek(st.trim[1]); }
      else seek(clamp(t, st.trim[0], st.trim[1]));
    });
    const endDrag = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag; drag = null;
      if (d.kind !== 'scrub') seek(st.trim[0]); // like iOS: after trimming, play from the new start
      if (d.was) togglePlay(true); else syncPlay();
    };
    strip.addEventListener('pointerup', endDrag); strip.addEventListener('pointercancel', endDrag);
    [hS, hE].forEach((h) => h.addEventListener('keydown', (e) => {
      if (!st.tl) return;
      const step = e.shiftKey ? 1 : 0.1, isS = h === hS; let v = isS ? st.trim[0] : st.trim[1];
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v -= step; else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v += step;
      else if (e.key === 'Home') v = 0; else if (e.key === 'End') v = st.tl.duration; else return;
      e.preventDefault();
      if (isS) setTrim(v, st.trim[1]); else setTrim(st.trim[0], v);
      seek(isS ? st.trim[0] : st.trim[1]);
    }));

    /* ───── download ───── */
    const spPct = $('#sp-sheet-prog-pct'), spFill = $('#sp-sheet-prog-fill'), spLabel = $('#sp-sheet-prog-label');
    function setSheetProg(f, label) {
      f = clamp(f || 0, 0, 1); spFill.style.setProperty('--p', f.toFixed(4)); spPct.textContent = Math.round(f * 100) + '%';
      sheetProg.querySelector('.sp-prog-bar').setAttribute('aria-valuenow', String(Math.round(f * 100))); if (label) spLabel.textContent = label;
    }
    async function download() {
      if (st.kind === 'photo' || st.kind === 'loop') {
        if (!st.blob) return;
        const f = st.file || {};
        await (api.saveBlob ? api.saveBlob(st.blob, 'spectra-' + (st.kind === 'loop' ? 'loop-' : '') + f.w + 'x' + f.h + '-' + stamp() + (st.kind === 'photo' ? '.png' : '.mp4')) : null);
        return;
      }
      if (st.kind !== 'video' || !st.tl || st.rendering) return;
      const session = st.session, [w, h] = dims('video'), tl = st.tl, [s, e] = st.trim, fps = st.fps;
      const wasPlaying = !!(engine.getReplay() || {}).playing;
      st.rendering = true; engine.setReplay({ playing: false }); syncPlay();
      actions.hidden = true; sheetProg.hidden = false; trim.inert = true; sheetOpts.inert = true;
      setSheetProg(0, 'Rendering'); $('#sp-sheet-cancel').focus({ preventScroll: true });
      try {
        const blob = await engine.renderTimeline({ timeline: tl, start: s, end: e, width: w, height: h, aspect: st.frame.aspect, fps, spp: 8,
          onProgress: (f, i) => setSheetProg(f, i ? 'Rendering frame ' + i.frame + ' / ' + i.frames : null) });
        if (session !== st.session || !blob) return;
        setSheetProg(1, 'Saving');
        if (api.saveBlob) await api.saveBlob(blob, 'spectra-' + w + 'x' + h + '-' + stamp() + '.mp4');
      } catch (err) {
        if (session !== st.session) return;
        if (isAbort(err)) toast('Render cancelled'); else { console.error('[Spectra camera] renderTimeline', err); toast('MP4 render failed', 'err', 4200); }
      } finally {
        st.rendering = false;
        if (session === st.session) {
          sheetProg.hidden = true; actions.hidden = false; trim.inert = false; sheetOpts.inert = false;
          if (wasPlaying) togglePlay(true);
          dlBtn.focus({ preventScroll: true });
        }
      }
    }
    dlBtn.addEventListener('click', download);
    $('#sp-sheet-cancel').addEventListener('click', () => engine.cancelRender());

    /* ───── shutter ───── */
    shutter.addEventListener('click', () => {
      if (!st.open || st.state !== 'bar') return;
      if (st.mode === 'photo') takePhoto(); else if (st.mode === 'video') startRec(); else renderLoop();
    });

    /* ───── keyboard: K toggles, Esc steps back (stop → cancel → retake → close), Space plays/pauses the replay ───── */
    window.addEventListener('keydown', (e) => {
      const t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === 'Escape' && st.open) {
        if (api.isHidden && api.isHidden()) return; // SpectraUI un-hides first
        e.preventDefault(); e.stopPropagation();
        if (st.state === 'rec') stopRec();
        else if (st.rendering) engine.cancelRender();
        else if (st.state === 'preview') retake();
        else closeCam(true);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'k' || e.key === 'K') { e.preventDefault(); e.stopPropagation(); if (st.open) closeCam(true); else openCam(); return; }
      if (st.open && st.state === 'preview' && st.tl && !st.rendering && (e.key === ' ' || e.code === 'Space')) {
        // Space plays / pauses the video preview. It never activates Download (that starts a full offline render: use Enter or a
        // click); other buttons a keyboard user tabbed to (Retake, fps) keep their native Space activation.
        if (t && t.tagName === 'BUTTON' && t !== dlBtn && t !== playBtn && t.matches(':focus-visible')) return;
        e.preventDefault(); e.stopPropagation();
        if (!e.repeat) togglePlay();
      }
    }, true);

    let rT = 0;
    window.addEventListener('resize', () => { if (!st.open) return; cancelAnimationFrame(rT); rT = requestAnimationFrame(fit); });

    /** Should this pointer event steer the light? Only inside the viewfinder frame, and never over a camera control, so moving to
     *  Shutter / Stop (or any control) doesn't swing the composed light. Outside, SpectraUI holds the last aim. */
    function steers(e) {
      if (!st.open) return true;
      if (st.state !== 'bar' && st.state !== 'rec') return false; // preview / rendering: the timeline or the file drives the image
      const t = e.target;
      if (t && t.closest && t.closest('#sp-cam button, #sp-cam [role="slider"], #sp-cam-bar, #sp-cam-rec, #sp-cam-busy, #sp-sheet, #sp-dock')) return false;
      const f = st.frame; if (!f) return false;
      const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      return x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h;
    }

    /** Why the scene may not change right now ('' = it may): while recording, previewing or rendering, the look and the logo are
     *  pinned so the replay / MP4 show exactly what was recorded. SpectraUI blocks G/C, drops, uploads and pill actions with it. */
    function lockReason() {
      if (!st.open) return '';
      if (st.state === 'rec') return 'Not while recording';
      if (st.rendering || st.state === 'busy') return 'Not while rendering';
      if (st.state === 'preview') return 'Not while previewing · Retake first';
      return '';
    }

    const inst = { open: openCam, close: closeCam, isOpen: () => st.open, state: () => st.state, steers, lockReason, setMode, setAspect, _st: st };
    global.SpectraCamera.instance = inst; // handy for tests / embedding
    return inst;
  }

  global.SpectraCamera = { init };
})(typeof window !== 'undefined' ? window : this);
