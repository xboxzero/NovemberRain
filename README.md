# NovemberRain

An experimental visual-programming instrument for the browser, in the spirit of TouchDesigner and Unreal Engine. One world, rendered in real time: **a titan skeleton walking through sand dunes in a thunderstorm**. You photograph it like architecture, bend it through a fourth dimension, push it through a routable psychedelic effect chain with fractal flames, and play a well-tempered synthesizer alongside it.

Live: https://xboxzero.github.io/NovemberRain/

Written in **Rust** (compiled to WebAssembly) and **TypeScript** (WebGL, Web Audio).

## What it does

| | |
|---|---|
| **Runs on modest hardware** | One set of GLSL ES 1.00 shaders serves both WebGL2 and WebGL1. Three detail tiers; the renderer steps down automatically if a tier will not compile or will not hold the frame rate. All buffers are plain 8-bit and live at an adaptive internal resolution; the final pass sharpens while stretching to the display. |
| **8K without the memory** | The canvas matches the display's real pixels (an 8K screen gets an 8K canvas) while the heavy work stays at the internal resolution. **8K PNG** renders the frozen frame in 512-pixel tiles and streams them band by band through the browser's native deflate into the file, so neither GPU nor page ever holds the full image. |
| **Skeleton** | Built from anatomical parts: vertebral column, sloped ribs with costal arch and sternum, clavicles and scapulae, iliac bowl with sacrum and pubic arch, femur with neck and trochanter, patella, tibia and fibula, heel, arch and toes, radius and ulna, palm and fingers, cranium with brow ridge, orbits, nasal aperture, zygomatic arches, teeth and a hinged mandible. |
| **Dunes** | Transverse dunes with the real cross-section: a long windward slope, a sharp crest and a slip face near the angle of repose (measured maximum 35 degrees), sinuous crest lines, interdune flats, wind ripples that fade by pixel footprint, footprints and damp sand. |
| **Architectural camera** | The camera stands on the sand at eye height, the film plane stays vertical and the lens is shifted rather than tilted, so verticals never converge (two-point perspective). Controls: distance, eye height, lens from wide to tele, lens shift. |
| **Simulation** | Feet planted on the terrain with two-bone IK, a spring-damper pelvis that takes an impulse at every heel strike, pendulum arms, stepped-leader lightning that prefers the titan, thunder delayed by distance, wind-driven ballistic dust. |
| **Fractal flame** | A real flame generator in Rust: an iterated function system of three drifting affine maps with blended non-linear variations (linear, sinusoidal, spherical, swirl, horseshoe, bubble), rotational symmetry, iterated colour and log-density tone mapping. Controls: amount, variation, symmetry, morph speed, size. |
| **Psychedelic FX** | Kaleidoscope, tunnel, liquid and glitch remap the image plane *before* rays are cast, so they cost nothing extra and stay sharp at any resolution. Spectrum, neon edges, posterize, RGB split and feedback trails follow. Both stages run in **serial** or **parallel**; the audio effects have the same switch. |
| **Sound** | Every pitch comes from a well temperament (Werckmeister III by default, Kirnberger III, Vallotti, Young II, equal for comparison). Organ chords, pedal bass and a harpsichord-like melody in a selectable key; thunder, footfalls and strikes triggered by the simulation. |
| **Inputs** | Camera, microphone, screen capture, video file, keyboard (A-K notes, Z/X octave, Space throws lightning), mouse, touchscreen (drag, pinch, XY synth pad). |
| **Presets** | 1 Titan Storm, 2 Custom: save, load, export and import your own. |

## How it is built

```
engine/            Rust crate -> engine.wasm (about 100 kB, plain C ABI, no JS glue)
  src/params.rs    parameter table shared by everything (the UI is generated from it)
  src/sim.rs       physics: terrain, walk, IK, pendulums, lightning, wind, dust
  src/flame.rs     fractal flame chaos game
  src/synth.rs     the well-tempered synthesizer
src/               TypeScript
  main.ts          app shell: UI, presets, input, camera, resolution governor, still export
  gl.ts            WebGL1/2 renderer: world -> FX -> sharpen and grade; tiled stills
  png.ts           streaming PNG encoder
  shaders/         world (three tiers), FX chain, final pass
  audio.ts         Web Audio graph and analysers
  synth.worklet.ts AudioWorklet hosting a second instance of the Rust engine
  media.ts         camera, screen capture, video file
  presets.ts       custom preset storage, export, import
```

The dune height function exists in both Rust and GLSL and must stay identical, because the simulation plants the titan's feet on the surface the shader draws.

## Run it

Requires Node 20+ and Rust with the `wasm32-unknown-unknown` target.

```bash
rustup target add wasm32-unknown-unknown
npm install
npm run dev      # build the engine and start the dev server
npm run build    # production build in dist/
```

URL switches for testing: `?gl=1` forces WebGL1, `?tier=0|1|2` pins the detail tier, `?scale=0.5` pins the internal resolution.

## Deploying

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push. In the repository settings, set **Pages -> Build and deployment -> Source** to **GitHub Actions** once.

## Limits worth knowing

- **Live 8K means an 8K canvas fed from a lower internal resolution**, sharpened on the way up. Tracing every one of 33 million pixels per frame is beyond any phone; the 8K PNG is where every pixel is traced.
- An 8K still takes from seconds to a few minutes depending on the GPU. It freezes one instant; trails in it come from the on-screen frame.
- WebGL1 support assumes a GPU that can compile at least the minimal tier. Very old integrated graphics may still refuse, in which case the start screen says so.
- "Physical" means integrated dynamics (springs, pendulums, ballistic particles, IK), not a rigid-body or fluid solver.
- The effect order inside each stage is fixed.
