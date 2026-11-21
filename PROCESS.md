# Refract: how it was built

How a "what should I make for my lab page?" question became **Refract**: a web tool that turns any logo into glass or chrome, with a beam of light that splits into a rainbow through it. This covers every stage from the first idea to the current build, including the wrong turns and what fixed them.

- **Live:** https://claude.ai/artifact/NTMMq9XHdP8bnHaW44CqKD
- **Standalone file:** `refract.html` (one self-contained HTML file, no build step)

---

## 1. The idea

You asked what a design engineer could make that would do well on Twitter and live on a lab page. The shortlist:

- tactile controls that feel physical
- physics and material experiments (glass, cloth)
- type that reacts to input
- AI-native interactions
- small tools people bookmark

You chose a glass/chrome logo render like Vercel's visuals, where **the colour comes from light passing through or reflecting off the material**. The flow you wanted: drop in an SVG logo, get that render out.

## 2. Does it already exist? (research round 1)

I searched GitHub and the web for existing tools.

**The general idea is common.** Several open-source "SVG → 3D logo" tools exist: **3dsvg**, **Vecto3d**, **Vitrum** and **SolidWave**. There are also hosted ones like 3dlogo.io, and shader effects such as **Paper Shaders' Liquid Metal** and **glass-icon-reveal**.

**The gap.** Almost all of them use stock three.js glass in a neutral studio. The thing you cared about, a strong spectral rainbow from light splitting through the material, was missing or weak.

**Feasibility.** Very buildable with WebGL/WebGPU, three.js-style techniques and spectral rendering.

Vercel had also open-sourced **vgpu**, their WebGPU library, including the code for the prism hero on vgpu.sh. That became the main reference.

## 3. Version 1: the "everything" build (multi-agent)

You asked for subagents and a premium result. The work was split up:

| Who | What |
|---|---|
| Research agent | Read the cloned repos (vgpu, glass-icon-reveal, Paper Shaders, 3dsvg) and wrote notes on their techniques, constants and colour maths |
| Shape agent | Built the pipeline that turns SVG, PNG or text into a **signed distance field**: a map of how far each point is from the logo's edge |
| UI agent | Designed a pro "instrument" interface against a mock renderer |
| Me (lead) | Wrote the WebGL2 renderer |
| QA agent | Reviewed the finished build independently, without seeing how it was made |

**How v1 rendered**
- **No 3D model.** The logo's distance field was extruded into 3D on the fly with a rounded bevel, then raymarched.
- **Glass split light by wavelength.** Each wavelength bends by a slightly different amount, which is where the rainbow comes from.
- **The image sharpened over time.** Random samples were averaged frame after frame, the way a path tracer converges.
- **Finish:** a hand-built light rig, filmic tone mapping (AgX) and bloom.

**What the QA review found**, all fixed before you saw the update:
- noise that never went away while the logo moved
- resolution that dropped and never recovered
- an opaque "ice" preset
- chrome that went black
- a crease down the middle of puffy shapes
- reduced motion being ignored

**What you said about v1:** too many controls, and the 3D still felt unfinished.

## 4. Studying vgpu.sh (research round 2)

I opened vgpu.sh in a real browser and read its source. It looks clean for three reasons:

1. **The prism is dark glass, defined only by thin, crisp white edges.**
2. **The colour lives in a light beam, not inside the glass.** A white beam goes in and a continuous rainbow fan comes out; the cursor steers it. The beam is calculated on the CPU and drawn as smooth ribbons.
3. **Nothing in the image is random.** There's no noise and nothing visibly "converging", which is why it never looks like it's still loading.

A second research agent went through papers and repos: Maxime Heckel's dispersion article, drei's MeshTransmissionMaterial, three.js dispersion and hero-wavelength sampling. Its top conclusion matched: **remove all randomness**.

**Diagnosis:** v1 looked unfinished because of its random sampling, its noise and its rainbow chaos inside the glass.

## 5. Version 2: "your logo is the prism"

The renderer was rebuilt from scratch on vgpu's model.

**The beam**
- A white beam is traced through *your logo's real outline* at 40–56 wavelengths. Each one refracts at its own angle through the glass.
- Neighbouring wavelengths are joined into filled ribbons whose brightness thins out as they spread. That gives one continuous rainbow fan instead of separate lines.
- The rainbow colours use **Zucconi's spectral palette**, which has real yellows and cyans instead of harsh red, green and blue stripes.

**Smart aim.** Logos with holes, like rings and letters, can cancel the rainbow out, the same way light passes through a window pane without splitting. The engine quietly finds the line through your logo that splits light best and glides to it. It only considers lines where every colour takes the same route through the glass, so the beam never fractures.

**The glass**
- Every frame is computed the same way, with no randomness.
- It refracts whatever is behind it, including the beam itself, and adds studio reflections and thin bright rims.
- A still image settles in about 20 frames, purely for edge smoothing.

**Finish:** dust in the air that lights up near the beam, and the cursor steers the light.

**The UI was rebuilt by a new agent around three controls:** Glass/Chrome, Logo and Export.

Problems fixed along the way:
- the exit fan first looked like spaghetti, and then like stacked rainbows from parallel beam slices
- hollow logos produced little or no rainbow (fixed by smart aim)
- smart aim at first picked lines that split the beam chaotically

## 6. Your feedback, round by round

### Round A: edges, rotation, "why MP4?"

**"Make the edges smoother and rounder, less rendered."**
- The hard creases came from a squared-off bevel profile and from the logo's sharp inner corners.
- The glass now has a fully rounded, pebble-like profile, the outline is softened slightly, and the inside of the glass is calmer.

**"Let users spin the logo, and keep the beam realistic."**
- The beam tracer moved from 2D to **full 3D**. It runs on the CPU through exactly the same rounded solid the GPU draws.
- Drag spins the logo with momentum, double-click resets it, and the light refracts through whatever the logo is actually facing.

**"Why MP4?"** It's for Twitter. Twitter doesn't accept WebM, and screen recordings lose quality. The export renders a seamless 6-second loop frame by frame at full quality, encoded as H.264.

### Round B: light theme, smoothness, blocky colours, beam on/off

**Light background**
- Modelled on vgpu's light theme: a warm paper-grey wall, soft window-light shadows and a soft shadow of your logo on the wall.
- It uses a different tone curve (Khronos Neutral) that keeps whites and colours honest on a light background.

**Flicker.** There were three causes:
- smart aim hopping between nearly equal lines (fixed with a switching threshold and a slower glide)
- colours shifting inside the glass every frame while moving
- the beam snapping to the cursor too fast (now a slow, smooth follow)

**Blocky colours.** Neighbouring rainbow strips were cut into different numbers of pieces, which left visible steps. They're now all cut identically, and hard cut-offs became smooth fades.

**Beam on/off.** I recommended two light modes rather than many: **Beam**, and **Studio**, a soft room light whose key light follows the cursor. These sit with Dark/Light in one small **Light** menu.

### Round C: softer backgrounds

- **Dark** became a charcoal with a soft falloff and faint grain.
- **Light** became a warm stone-grey.

Neither is pure black or white anymore.

### Round D: typed text, thickness/roundness, real chrome

**Why typed text looked weird.** It took several experiments to isolate, including a debug view that drew the surface directions directly. There were three stacked causes:

1. **Fixed-size smoothing.** A blur about 26 pixels wide was used to smooth large logos. A letter's stroke is only about 36 pixels across, so the blur wiped out the letter's real shape. The blur now scales with stroke thickness.
2. **The bevel sat on the letter's centre line.** The rounded edge was as wide as half the stroke, so the top of each letter landed on the stroke's centre ridge, where the surface flips direction. The bevel is now capped below that.
3. **The real culprit: lost edge smoothing while moving.** The idle light drift kept the image constantly in motion, and smoothing was switched off during motion, so small curved letters aliased into sparkle.
   - The debug view proved the surface itself was perfectly smooth.
   - A paused render came out clean.
   - Now smoothing stays on during motion, an extra smoothing sample is added when the GPU has spare time, and the idle light settles into a resting pose so the image goes crisp.

**Thickness and Roundness sliders**, inside the Logo menu:
- **Thickness:** from a thin glass sheet to a chunky block.
- **Roundness:** from crisp edges (a flat slab with a fine chamfer that still catches light) to a soft pebble.

**Silver chrome**
- The pearl look came from a rainbow sheen and bright soft panels; both were removed.
- Chrome now reflects a classic studio: a graded sky, a dark floor, a crisp horizon line and sharp strip lights.
- On the light background, chrome was wrongly reflecting the wall *behind* it. It now only picks up glints from the beam.

## 7. Where it stands now

**What the user sees**
- One small pill: **Light · Logo · Export · Camera**.
- **Light:** Beam or Studio, and the light **Source** (white, sun, tungsten, neon, sodium, mercury), on the light background.
- **Logo:** upload an SVG or PNG, type a word, or pick from 6 original sample marks, plus Thickness and Roundness.
- **Export:** a PNG at 2×, or a 6-second H.264 MP4 loop.
- **Camera** (K): Photo, Video (record, trim, re-render offline) and Loop, framed by an aspect-ratio viewfinder that is exactly the output.
- **Interaction:** hover steers the light, drag spins the logo, H hides the interface for screen recording, Space pauses.

**Under the hood**
- **Shape pipeline:** SVG, PNG or text becomes a high-precision distance field, built in a background thread.
- **Beam:** traced on the CPU through the same 3D shape the GPU draws.
- **Glass and chrome:** computed the same way every frame, with no randomness.
- **Finish:** a separate tone curve per theme, bloom and dust.
- **Dependencies:** none, apart from the MP4 encoder library (mp4-muxer), which loads only when you export a video.

**Known limits and what's untested**
- Tested only in software rendering. Smoothness and frame rate on a real GPU need checking on your machine.
- A full 1080×1080 MP4 export hasn't been run end to end. Small test renders are valid.
- Very intricate logos can still send out a second, fainter beam.

### Later additions
- **Light sources with real spectra.** White keeps the beam exactly as it was; Sun (D65) and Tungsten (2700 K) weight its 56 bands by their spectral power; Neon, Sodium and Mercury trace one ribbon per NIST emission line, with no sheet between lines, so they split into separate coloured lines. The source also tints the light seen through the glass.
- **The rainbow lands.** The wall now curves through a cove into a floor. Every slice of the traced beam is clipped where it meets a surface and leaves an energy-weighted caustic there; a beam coming from below rises out of the floor. Before the user first steers, the light starts at an angle whose rainbow reaches the floor (or its mirror when the logo can't split light from there). Transparent output has no room.
- **Camera mode** (UX adapted from 3dsvg, MIT): the viewfinder renders with the offline camera, Video records what drives the image each frame and re-renders the trimmed range offline, Loop exports keep one coherent line through the logo.

## 8. Lessons that carried through

1. **Look at the reference properly.** vgpu.sh's quality came from what it *leaves out* (randomness, noise, colour inside the glass), not from more features.
2. **Clean means deterministic.** Anything that visibly converges or sparkles reads as "in development".
3. **Debug by isolating.** The text bug was three stacked causes. Each fix only made sense once a debug view or a controlled test separated them.
4. **Fewer controls, better defaults.** Most parameters became art-directed defaults; users only get choices that change the *idea*: material, light, background, shape.
5. **Independent review catches what the builder misses.** The QA agent found a dozen real issues the build process didn't.
