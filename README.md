# Spectra

Turn any logo into glass or chrome. A beam of white light refracts through your logo's real outline and leaves as a continuous rainbow, rendered live in WebGL2 with zero dependencies.

## Use

Open `dist/index.html` in a browser. It's one self-contained file, so you can drop it straight into a site.

- **Logo:** upload an SVG or PNG, type a word, or pick a sample. Adjust **Thickness** and **Roundness**.
- **Glass / Chrome:** dispersive glass or polished silver.
- **Light:** **Beam** (light through your logo) or **Studio** (soft room light), on a **Dark** or **Light** background.
- **Export:** a PNG at 2×, or a seamless 6-second H.264 MP4 loop for Twitter.
- **Interaction:** hover steers the light, drag spins the logo, double-click resets, `H` hides the interface, `Space` pauses.

## Develop

```bash
npm run build   # combines src/ into dist/index.html
```

| File | What it does |
|---|---|
| `src/engine.js` | Renderer: 3D beam tracer, raymarched glass/chrome, themes, export |
| `src/sdf.js` | SVG / PNG / text → signed distance field (runs in a Web Worker) |
| `src/samples.js` | The six built-in sample marks |
| `src/ui.html` / `ui.css` / `ui.js` | The interface |
| `build.mjs` | Combines everything into `dist/index.html` |

MP4 export loads [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) from jsDelivr on demand; nothing else is external.

## How it works

The logo is never turned into a mesh. Its distance field is extruded into a rounded solid inside the shader and raymarched. The beam is traced on the CPU through that same solid at 56 wavelengths and drawn as continuous spectral ribbons. Nothing in the image is random, so it never looks noisy. See [PROCESS.md](PROCESS.md) for the full story.

Inspired by the prism hero on [vgpu.sh](https://vgpu.sh).
