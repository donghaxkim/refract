# Spectra

Turn any logo into glass. A beam of white light refracts through your logo's real outline and leaves as a continuous rainbow, rendered live in WebGL2 with zero dependencies.

## Use

Open `dist/index.html` in a browser. It's one self-contained file, so you can drop it straight into a site.

- **Logo:** upload an SVG or PNG, type a word, or pick a sample. Adjust **Thickness** and **Roundness**.
- **Light:** **Beam** (light through your logo) or **Studio** (soft room light), on a light stone background. (Dark background and chrome are switched off for now; the engine still supports both.)
- **Export:** a PNG at 2×, or a seamless 6-second H.264 MP4 loop for Twitter.
- **3D model:** **GLB** for Blender or three.js (glTF 2.0, metres, Y-up, 0.2 m wide, with a glass material using transmission, IOR, volume and dispersion, or a chrome one) and **STL** for 3D printing (watertight, millimetres, lying flat, 100 mm on its longest side). Both are meshed from the exact shape on screen, including Thickness and Roundness. Shift-click either one for a finer mesh. The rainbow beam is a lighting effect, so it isn't part of the model.
- **Interaction:** hover steers the light, drag spins the logo, double-click resets, `H` hides the interface, `Space` pauses.

## Embed on your site

`dist/spectra-logo.js` is one file with no dependencies (~37 KB gzipped).

```html
<script src="spectra-logo.js"></script>   <!-- or: import './spectra-logo.js' -->
<spectra-logo sample="spark" background="#0b0b0c" style="height:480px"></spectra-logo>
```

- **Logo:** `src` (SVG/PNG URL, needs CORS if cross-origin), `text` (+ optional `font`), or `sample` (spark, links, loop, ribbon, mono, gem).
- **Look:** `light` (beam | studio), `thickness`, `roundness` (0–100). Glass on the light theme only, for now.
- **Page:** set `background` to your page colour so the render blends into it. This keeps the full look, because the glass still has a backdrop to bend. `transparent` gives true alpha but looks flatter (WebGL can't see the page behind it). Avoid pure `#fff`: the beam can't be brighter than white, so use an off-white.
- **Behaviour:** `interactive="false"` disables hover/drag; `poster` and `alt` for the fallback. Events: `ready`, `error` (`detail.phase`).
- Loads lazily near the viewport, pauses offscreen and in hidden tabs, shows a still frame for reduced motion, and falls back to the poster (or a static logo) without WebGL2. Each instance uses one WebGL context, and browsers allow about 16 per page.
- **React:** `import { SpectraLogo } from './spectra-logo-react.js'`. Props map to attributes; `onReady` and `onError` are forwarded. It's safe to import during server-side rendering.

See `dist/embed-demo.html` (serve it over http).

## Develop

```bash
npm run build         # app (dist/index.html) + embed (dist/spectra-logo*.js)
npm run build:app     # just the app
npm run build:embed   # just the component
```

| File | What it does |
|---|---|
| `src/engine.js` | Renderer: 3D beam tracer, raymarched glass/chrome, themes, export |
| `src/mesh.js` | Distance field → watertight mesh, GLB and STL writers (runs in a Web Worker) |
| `src/embed/` | The `<spectra-logo>` element, React wrapper and demo page |
| `src/sdf.js` | SVG / PNG / text → signed distance field (runs in a Web Worker) |
| `src/samples.js` | The six built-in sample marks |
| `src/ui.html` / `ui.css` / `ui.js` | The interface |
| `build.mjs` | Combines everything into `dist/index.html` |

MP4 export loads [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) from jsDelivr on demand; nothing else is external.

## How it works

The logo is never turned into a mesh. Its distance field is extruded into a rounded solid inside the shader and raymarched. The beam is traced on the CPU through that same solid at 56 wavelengths and drawn as continuous spectral ribbons. Nothing in the image is random, so it never looks noisy. See [PROCESS.md](PROCESS.md) for the full story.

Inspired by the prism hero on [vgpu.sh](https://vgpu.sh). The beam's finite-width slicing, per-ray spectral density and the pointer mapping are adapted from [vercel-labs/vgpu](https://github.com/vercel-labs/vgpu) (MIT License, Copyright (c) 2025 Vercel, Inc.).
