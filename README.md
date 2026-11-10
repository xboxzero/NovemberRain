# NovemberRain

An experimental visual-programming instrument for the browser, in the spirit of TouchDesigner and Unreal Engine. One world, rendered in real time: **a titan skeleton walking through sand dunes in a thunderstorm**. You bend it through a fourth dimension, push it through a routable psychedelic effect chain, play a well-tempered synthesizer alongside it, and steer everything by chat.

Live: https://xboxzero.github.io/NovemberRain/

Written in **Rust** (compiled to WebAssembly) and **TypeScript** (WebGL2, Web Audio).

## What it does

| | |
|---|---|
| **Chat control** | `more lightning, less rain`, `strike the titan`, `make it trippy`, `kaleidoscope 70%`, `effects in parallel`, `key of F sharp minor`, `kirnberger tuning`, `8k`, `snapshot`, `save as my show`. The parser runs locally in Rust. |
| **Simulation** | Feet are planted on the real dune height field with two-bone IK; the pelvis rides a spring-damper and takes an impulse at every heel strike; arms are driven, damped pendulums. Lightning grows as a stepped leader before the return stroke, prefers the titan as the tallest conductor, and its thunder arrives late by distance / speed of sound. Footfalls throw ballistic dust that a gusting wind field drags away, and leave footprints. |
| **Rendering** | Raymarched in HDR: soft shadow of the titan from the brightest strike (or the moon), wet-sand specular, in-scattered flash in the haze, cavity occlusion on bone. Fine detail fades by pixel footprint, so more resolution shows more detail. |
| **Output** | Auto (adaptive), 1080p, 1440p, 4K or 8K live, plus an **8K still** button that renders one 7680-pixel-wide frame to PNG. |
| **4D** | A tesseract rotated in the xw / yw / zw planes and perspective-projected around the titan; a hyper lens that rotates the image plane through 4-space; dunes and clouds that are slices of 4D fields you drift through. |
| **Psychedelic FX** | Kaleidoscope (segments, spin), tunnel / infinite zoom (speed), liquid (scale), spectrum mapping (bands, flow), neon edges, RGB split, posterize / solarize, glitch, feedback trails (zoom, twist, colour cycle). |
| **Signal routing** | The FX chain runs in **serial** (each effect feeds the next) or **parallel** (each effect processes the clean signal and the results are summed). The audio effects have the same switch: echo into reverb, or echo beside reverb. |
| **Sound** | Every pitch is looked up in a well temperament: Werckmeister III (default), Kirnberger III, Vallotti, Young II, with equal temperament for comparison. Organ chords, pedal bass and a harpsichord-like melody play a minor-key progression, so changing **Key** changes the size of the thirds and fifths you hear. Thunder, footfalls and the crack of a direct hit are triggered by the simulation. |
| **Inputs** | Camera, microphone (drives the visuals), screen or tab capture, video file, keyboard (A-K notes, Z/X octave, Space throws lightning, 1-2 presets), mouse, touchscreen (orbit, pinch zoom, XY synth pad). |
| **Presets** | 1 Titan Storm, 2 Custom: save, load, export and import your own. |

## How it is built

```
engine/            Rust crate -> engine.wasm (plain C ABI, no JS glue)
  src/params.rs    parameter table shared by everything (the UI is generated from it)
  src/sim.rs       physics: terrain, walk, IK, pendulums, lightning, wind, dust, tesseract
  src/synth.rs     the well-tempered synthesizer
  src/chat.rs      natural-language command parser
src/               TypeScript
  main.ts          app shell: UI, chat, presets, input, resolution, main loop
  gl.ts            WebGL2 renderer (world -> HDR target -> FX chain -> grade)
  shaders/world.ts the raymarched world
  shaders/post.ts  the FX chain with serial / parallel routing, and the final grade
  audio.ts         Web Audio graph and analysers
  synth.worklet.ts AudioWorklet hosting a second instance of the Rust engine
  media.ts         camera, screen capture, video file
  presets.ts       custom preset storage, export, import
```

The same `engine.wasm` is instantiated twice: on the main thread for simulation and chat, and inside an AudioWorklet for sound. The dune height function exists in both Rust and GLSL and must stay identical, because the simulation plants the titan's feet on the surface the shader draws.

## Run it

Requires Node 20+ and Rust with the `wasm32-unknown-unknown` target.

```bash
rustup target add wasm32-unknown-unknown
npm install
npm run dev      # build the engine and start the dev server
npm run build    # production build in dist/
```

## Deploying

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push. In the repository settings, set **Pages -> Build and deployment -> Source** to **GitHub Actions** once.

## Limits worth knowing

- **8K is a lot of pixels.** Live 8K raymarching needs a high-end desktop GPU and roughly 1 GB of video memory; most machines will run it at a few frames per second, and phones cap out at their maximum texture size (often 4096). The 8K still works on more hardware because it is one frame. Stills do not include feedback trails.
- **"Physical" here means integrated dynamics, not a rigid-body or fluid solver.** Springs, pendulums, ballistic particles and IK run every frame; sand does not flow and bones do not collide.
- **The chat is a rule-based parser, not a language model.** It understands parameters, quantities, moods, colours, keys, tunings, devices and presets, not open-ended requests.
- The effect order inside each stage is fixed.
- Camera, microphone and screen capture need HTTPS and your permission.
