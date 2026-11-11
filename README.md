# NovemberRain

A living fractal in four dimensions, drawn entirely in dots. It breeds, mutates and evolves by itself, listens to your devices and to the Earth, and you act as natural selection.

Live: https://xboxzero.github.io/NovemberRain/

Written in **Rust** (compiled to WebAssembly) and **TypeScript** (WebGL, Web Audio).

## What it is

| | |
|---|---|
| **4D fractal** | Each organism is an iterated function system in four dimensions: four maps, each an affine transform of (x, y, z, w) followed by a blend of non-linear variations (linear, sinusoidal, spherical, swirl), with a rotational symmetry that couples the xy and zw planes. It is rotated in the three planes that involve the fourth axis and perspective-projected 4D to 3D to screen. |
| **Dots only** | Everything on screen is point particles: up to 3 million per frame on desktop, a few hundred thousand on a phone. Every dot finds its own place on the GPU by playing the chaos game from a 4-byte random seed, so there is no geometry to store. New seeds every frame mean detail keeps accumulating through the trails. |
| **Gaussian** | Each dot is a Gaussian splat. Out of focus it widens while keeping its energy (depth of field); a few become wide halos (glow). Dots add up in a floating-point density buffer that is developed like a fractal flame: brightness is the logarithm of density. Mutation in the genetic algorithm is Gaussian too. |
| **Evolution** | A gene pool of ten organisms. Parents are chosen by tournament, crossed over map by map and mutated; the child is scored by an automatic fitness function that samples its attractor and rewards forms that are bounded, neither collapsed nor a formless cloud, use all four axes, and have a box-counting dimension near 2. The picture morphs from each generation to the next. **Love** protects a form and makes it breed; **Next** rejects it; **New life** restarts the pool. |
| **Senses** | **Mic**: sound makes it pulse, and loud beats make the next generation mutate harder. **Camera**: it takes its colours from what the camera sees. **Tilt**: turning the phone turns it through the 4th dimension. **Earth**: every earthquake of the last hour (USGS) shakes the gene pool in proportion to its magnitude, and wind and temperature at a wild place on the planet (Open-Meteo) set its drift through the 4th dimension and the warmth of its colours. |
| **8K** | **8K PNG** renders the current form 7680 pixels wide in 1024-pixel tiles, each built from many passes of fresh dots (about 50 million in total on desktop), and streams them into the file, so memory stays flat even on a phone. |
| **Sound** | A well-tempered synthesizer (Werckmeister III by default) plays organ chords, a pedal bass and a plucked melody; each birth rings a note chosen by the newborn's genes. |
| **Simple controls** | Thirteen sliders in four groups: Life (evolution speed, mutation, symmetry), Space (4th dimension, spin, zoom), Dots (count, softness, glow), Colour (colour, psychedelia, trails, brightness). Senses and Sound are folded away. |

## How it is built

```
engine/            Rust crate -> engine.wasm (under 100 kB, plain C ABI, no JS glue)
  src/evo.rs       genome, crossover, Gaussian mutation, fitness, gene pool, morphing
  src/synth.rs     the well-tempered synthesizer
  src/params.rs    parameter table (the UI is generated from it)
src/               TypeScript
  main.ts          app shell: controls, senses, governor, still export
  gl.ts            WebGL1/2 renderer: dots -> density -> develop + feedback -> sharpen
  shaders/points.ts  the chaos game in the vertex shader, Gaussian splat
  shaders/post.ts    log-density development, feedback loop, final pass
  feeds.ts         earthquake and weather feeds
  png.ts           streaming PNG encoder
  media.ts, audio.ts, synth.worklet.ts, presets.ts
```

The map formula exists twice, in `evo.rs` (for the fitness function) and in `points.ts` (for drawing), and the two must stay identical.

## Run it

Requires Node 20+ and Rust with the `wasm32-unknown-unknown` target.

```bash
rustup target add wasm32-unknown-unknown
npm install
npm run dev      # build the engine and start the dev server
npm run build    # production build in dist/
```

URL switches: `?gl=1` forces WebGL1, `?dots=500000` pins the swarm size, `?scale=0.5` pins the internal resolution, `?offline` leaves the Earth feed off.

## Deploying

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push. In the repository settings, set **Pages -> Build and deployment -> Source** to **GitHub Actions** once.

## Limits worth knowing

- **Internet use and privacy.** With Earth on (the default), the page downloads two public feeds: earthquakes from `earthquake.usgs.gov` and weather from `api.open-meteo.com` for a fixed list of wild places. No location or identifier is sent; as with any request, those servers see the visitor's IP address. The Earth button turns it off.
- **Live 8K** means the canvas matches the display's pixels while the dots are splatted at an adaptive internal resolution and sharpened. The 8K PNG is where the full resolution is rendered directly.
- An 8K still takes seconds on a desktop GPU and longer on a phone, where it uses fewer dots and looks softer.
- The fitness function measures structure, not beauty. It keeps evolution away from blobs and dust; taste comes from Love and Next.
- Without a float render target (rare), the density buffer falls back to 8 bits and the image is coarser.
