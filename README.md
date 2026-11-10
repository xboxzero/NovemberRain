# NovemberRain

An experimental visual-programming instrument for the browser, in the spirit of TouchDesigner and Unreal Engine: real-time raymarched 3D worlds that move through a fourth dimension, a generative sound synthesizer that plays in lock with the picture, and a chat box that lets you steer all of it in plain language.

Live: https://xboxzero.github.io/NovemberRain/

Written in **Rust** (compiled to WebAssembly) and **TypeScript** (WebGL2, Web Audio).

## What it does

| | |
|---|---|
| **Chat control** | Type what you want: `more lightning, a lot less fog`, `take me underwater`, `make it trippy and slower`, `set bloom to 80%`, `turn it purple`, `camera on`, `save as my show`. The parser runs locally in Rust. No account, no server. |
| **Presets** | 1 Multi-lightning storm over sand dunes · 2 Underwater abyss with deep sea creatures · 3 Volcano island with Chinese dragons · 4 Titan skeleton walking through a city · 5 Custom (save, load, export and import your own). |
| **Inputs** | Camera, microphone (drives the visuals), screen or tab capture, local video files, keyboard (A-K play notes, Z/X octave, 1-5 presets), mouse (drag to orbit, wheel to zoom), touchscreen (drag, pinch, XY synth pad). |
| **YouTube** | Paste a link in the chat or the panel. The player is mixed with the visuals using blend modes (`blend difference`, `blend screen`, ...). |
| **Sound** | Drone, ambience, generative melody, FM voices, ping-pong echo and reverb, each world with its own scale and timbre. Lightning triggers thunder, the titan's feet trigger impacts, the dragon roars. |
| **4D motion** | Noise fields are sampled as 3D slices of a 4D lattice; `4D drift` moves the slice, `4D warp` folds the camera lens through it. |

## How it is built

```
engine/            Rust crate -> engine.wasm (plain C ABI, no JS glue)
  src/params.rs    parameter table shared by everything (UI is generated from it)
  src/sim.rs       scene simulation: lightning, creatures, dragons, titan walk cycle
  src/synth.rs     the synthesizer DSP
  src/chat.rs      natural-language command parser
src/               TypeScript
  main.ts          app shell: UI, chat, presets, keyboard / pointer input, main loop
  gl.ts            WebGL2 renderer (scene -> HDR target -> trails/bloom/mix -> grade)
  shaders/         one raymarching fragment shader per world + post-processing
  audio.ts         Web Audio graph and analysers
  synth.worklet.ts AudioWorklet hosting a second instance of the Rust engine
  media.ts         camera, screen capture, video file
  youtube.ts       YouTube player layer
  presets.ts       custom preset storage, export, import
```

The same `engine.wasm` is instantiated twice: on the main thread for simulation and chat, and inside an AudioWorklet for sound. The simulation writes its state into a flat buffer that the shaders read as a uniform array; events such as thunder or footsteps are forwarded to the audio thread.

## Run it

Requires Node 20+ and Rust with the `wasm32-unknown-unknown` target.

```bash
rustup target add wasm32-unknown-unknown
npm install
npm run dev      # build the engine and start the dev server
npm run build    # production build in dist/
```

`?scale=0.5` in the URL pins the render resolution (otherwise it adapts to the frame rate).

## Deploying

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push. In the repository settings, set **Pages -> Build and deployment -> Source** to **GitHub Actions** once.

## Limits worth knowing

- **YouTube pixels are not readable by a web page.** Browsers isolate the player, so YouTube is composited with CSS blend modes rather than fed into the shaders, and its sound does not drive the visuals. For shader-level mixing of any video, use **Screen** (capture a tab) or **Video file**.
- **The chat is a rule-based parser, not a language model.** It understands parameters, quantities, moods, colours, devices and presets, but not open-ended requests like "add a second moon".
- Camera, microphone and screen capture need HTTPS (GitHub Pages is fine) and your permission. Screen capture is not available in most phone browsers.
- Raymarching is GPU-heavy; on phones the internal resolution drops automatically.
