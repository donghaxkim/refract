# Refract

Turn any logo into glass. A beam of white light refracts through your logo's real outline and leaves as a continuous rainbow, rendered live in WebGL2 with zero dependencies.

## Use

Open `dist/index.html` in a browser. It's one self-contained file, so you can drop it straight into a site.

- **Logo:** upload an SVG or PNG, type a word, or pick a sample. Adjust **Thickness** and **Roundness**.
- **Light:** **Beam** (light through your logo) or **Studio** (soft room light), on a light stone background. The rainbow lands where it meets the studio floor or wall. (Dark background and chrome are switched off for now; the engine still supports both.)
- **Source:** the light's real spectrum: **White**, **Sun** (D65 daylight), **Tungsten** (2700 K), or the emission lines of **Neon**, **Sodium** and **Mercury** (NIST wavelengths), which split into separate coloured lines instead of a continuous fan.
- **Export:** a PNG at 2×, or a seamless 6-second H.264 MP4 loop for Twitter.
- **3D model:** **GLB** for Blender or three.js (glTF 2.0, metres, Y-up, 0.2 m wide, with a glass material using transmission, IOR, volume and dispersion, or a chrome one) and **STL** for 3D printing (watertight, millimetres, lying flat, 100 mm on its longest side). Both are meshed from the exact shape on screen, including Thickness and Roundness. Shift-click either one for a finer mesh. The rainbow beam is a lighting effect, so it isn't part of the model.
- **Camera** (`K`): pick an aspect (Free, 1:1, 4:5, 9:16, 16:9) and a resolution (1080p, 2K, 4K), then shoot. **Photo** renders a PNG offline, framed exactly like the viewfinder (optionally with a transparent background). **Video** records your steering and spinning, lets you trim it on a filmstrip, then re-renders every frame offline to H.264 MP4 at 30 or 60 fps, so it's smooth however laggy the live view was. **Loop** renders the 6-second loop at the chosen framing. `Esc` steps back.
- **Interaction:** hover steers the light, drag spins the logo, double-click resets, `H` hides the interface, `Space` pauses, `K` opens the camera.

## Embed on your site

`<refract-logo>` is one file with no dependencies. Load it from jsDelivr:

```html
<script src="https://cdn.jsdelivr.net/gh/donghaxkim/refract@99b0c87334ceb77e59266d7047eff47f259fdc4f/dist/refract-logo.js"></script>
<refract-logo sample="meta" thickness="55" roundness="50" background="#f1eee6" style="display:block;height:480px"></refract-logo>
```

Or install it from npm (`npm install refract-logo`) and import it once:

```js
import 'refract-logo'                        // registers <refract-logo>
import { RefractLogo } from 'refract-logo/react'
<RefractLogo sample="meta" thickness={55} roundness={50} background="#f1eee6" style={{ height: 480 }} />
```

The playground at [refract.dongha.ca](https://refract.dongha.ca) writes this snippet for the logo and settings on screen.

- **Logo:** `src` (SVG/PNG URL, needs CORS if cross-origin), `text` (+ optional `font`), or `sample` (meta, x, vercel, hermes).
- **Look:** `light` (beam | studio), `source` (white | sun | tungsten | neon | sodium | mercury), `thickness`, `roundness` (0–100, on the playground's scales: thickness 55 and roundness 50 are the defaults; thickness below 65 is thinner than the app's slider goes). Glass on the light theme only, for now.
- **Page:** set `background` to your page colour so the render blends into it. This keeps the full look, because the glass still has a backdrop to bend. `transparent` gives true alpha but looks flatter (WebGL can't see the page behind it). Avoid pure `#fff`: the beam can't be brighter than white, so use an off-white.
- **Behaviour:** `interactive="false"` disables hover/drag; `poster` and `alt` for the fallback. Events: `ready`, `error` (`detail.phase`).
- Loads lazily near the viewport, pauses offscreen and in hidden tabs, shows a still frame for reduced motion, and falls back to the poster (or a static logo) without WebGL2. Each instance uses one WebGL context, and browsers allow about 16 per page.
- **React:** the wrapper maps props to attributes and forwards `onReady` and `onError`. It's safe to import during server-side rendering.

See `dist/embed-demo.html` (serve it over http).

## Develop

```bash
npm run build         # app (dist/index.html) + embed (dist/refract-logo*.js)
npm run build:app     # just the app
npm run build:embed   # just the component
npm publish           # publishes refract-logo (dist/refract-logo*.js only)
```

| File | What it does |
|---|---|
| `src/engine.js` | Renderer: 3D beam tracer, raymarched glass/chrome, themes, export |
| `src/camera.js` | Camera mode: viewfinder, shutter, recording, trimmer (UX adapted from [3dsvg](https://github.com/renatoworks/3dsvg) by Renato Costa, MIT) |
| `src/mesh.js` | Distance field → watertight mesh, GLB and STL writers (runs in a Web Worker) |
| `src/embed/` | The `<refract-logo>` element, React wrapper and demo page |
| `src/sdf.js` | SVG / PNG / text → signed distance field (runs in a Web Worker) |
| `src/samples.js` | The six built-in sample marks |
| `src/ui.html` / `ui.css` / `ui.js` | The interface |
| `build.mjs` | Combines everything into `dist/index.html` |

MP4 export loads [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) from jsDelivr on demand; nothing else is external.

## How it works

The logo is never turned into a mesh. Its distance field is extruded into a rounded solid inside the shader and raymarched. The beam is traced on the CPU through that same solid at 56 wavelengths and drawn as continuous spectral ribbons. Nothing in the image is random, so it never looks noisy. See [PROCESS.md](PROCESS.md) for the full story.

Inspired by the prism hero on [vgpu.sh](https://vgpu.sh). The beam's finite-width slicing, per-ray spectral density and the pointer mapping are adapted from [vercel-labs/vgpu](https://github.com/vercel-labs/vgpu) (MIT License, Copyright (c) 2025 Vercel, Inc.).
