# NovemberRain

A living fractal in four dimensions, drawn entirely in dots. It breeds, mutates and evolves by itself, listens to your devices and to the Earth, and you act as natural selection.

Live: https://xboxzero.github.io/NovemberRain/

Written in **Rust** (compiled to WebAssembly) and **TypeScript** (WebGL, Web Audio).

## What it is

| | |
|---|---|
| **4D fractal** | Each organism is an iterated function system in four dimensions: four maps, each an affine transform of (x, y, z, w) followed by a blend of non-linear variations. Two of them are 3D/4D fractal mathematics proper: the **quaternion square root** (an inverse branch of the quaternion Julia map, so random iteration draws the Julia set itself) and the **bulb root** (the inverse of the Mandelbulb's spherical-coordinate squaring). The rest are flame variations: linear, sinusoidal, spherical, swirl. |
| **A seamless loop of real motion** | The form does not just spin. Its maps rotate and slide along closed curves driven by one loop phase with integer harmonics; one map makes a full revolution per loop. The 4D rotation, the camera and the palette also make whole numbers of turns per loop. With evolution paused the animation repeats exactly (the genome at phase 0 and 2π differs by 1e-7). Loop length: 10 seconds to 5 minutes. |
| **Reads as 3D** | Dots deposit palette index, depth and energy rather than a colour. The development pass recovers the mean depth of every pixel, derives a surface normal from its gradient and lights the swarm: diffuse and specular light, ambient occlusion, depth haze. A depth shell lets near parts hide far ones (**Solidity**: from translucent cloud to opaque skin). A short lens close to the form gives strong perspective. |
| **Smooth** | Every frame is blended into a floating-point running average, so density and colour change gradually and the image is far denser than one frame of dots. Generations morph over 15 seconds to 5 minutes with a smootherstep curve; discrete genes (symmetry) cross-fade through the swarm instead of switching; inputs from microphone and Earth feed pass through slow followers. |
| **Dots only** | Up to 4 million point particles per frame on desktop. Every dot finds its own place on the GPU by playing the chaos game from a 4-byte random seed. Each is a Gaussian splat with depth of field and glow. |
| **Evolution** | A gene pool of ten. Tournament selection, map-wise crossover, Gaussian mutation, and an automatic fitness function (bounded, neither collapsed nor formless, uses all four axes, box-counting dimension near 2). **Love** protects a form and makes it breed; **Next** rejects it; **New life** restarts the pool. |
| **Effects, serial or parallel** | Spatial effects act on the dots in 3-space: **Mirror** (kaleidoscope fold), **Twist**, **Wave**, **Lattice** (the swarm condenses onto the bars of a cubic grid). Colour effects act in development: **Spectrum**, **Contours** (lines of equal depth), **Posterize**. In serial every dot passes through each effect in turn. In parallel the swarm is split into branches, one clean and one per effect, and you see their sum. |
| **Senses** | **Mic**: sound makes it pulse; loud beats make the next generation mutate harder. **Camera**: it takes its colours from what the camera sees. **Tilt**: turning the phone turns it through the 4th dimension. **Earth**: earthquakes of the last hour (USGS) shake the gene pool; wind and temperature at a wild place (Open-Meteo) speed up its time and warm its colours. |
| **Beyond 8K** | **4K**, **8K** and **16K** PNG (15360 pixels wide, 132 megapixels). The image is built from tiles, each from many passes of fresh dots, and read back in thin strips into a streaming encoder, so memory stays flat. |
| **Sound** | A well-tempered synthesizer (Werckmeister III by default); each birth rings a note chosen by the newborn's genes. |
| **The machine describes itself** | Each organism gets a species name and a one-line instruction read off its genes, for example "four maps in 4-space, mostly bulb roots with sinusoidal, 3-fold symmetry". |

## References this piece draws on

- **Systems art.** Jack Burnham's "Systems Esthetics" (Artforum, 1968) and "Real Time Systems" (1969) describe art as a system that gathers data from its environment in time to affect what happens next; Hans Haacke's *Condensation Cube* is the canonical example. Here the Earth feed, the microphone, the camera and the viewer's votes are that environment. Sol LeWitt's "the idea becomes a machine that makes art" (1967) and his open cubes are behind the Lattice effect and the generated instruction line.
- **Evolutionary art.** William Latham and Stephen Todd's *Mutator* (the artist as gardener), Karl Sims' "Artificial Evolution for Computer Graphics" (1991) and *Genetic Images*, and Scott Draves' *Electric Sheep* (1999), where an audience's preferences are the fitness function for evolving fractal flames. Love / Next is that mechanism with an audience of one.
- **Fractal mathematics.** Barnsley's iterated function systems and the chaos game; Draves' fractal flame (non-linear variations, log-density display); Alan Norton's quaternion Julia sets shown as 3D slices of 4-space (1982); the Mandelbulb's spherical-coordinate squaring, credited to Daniel White and Paul Nylander.

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
- **Live output** means the canvas matches the display's pixels while the dots are splatted at an adaptive internal resolution and sharpened. The 8K PNG is where the full resolution is rendered directly.
- An 8K still takes seconds on a desktop GPU; 16K takes considerably longer and produces a file of tens of megabytes. Phones use far fewer dots, so their large stills look softer.
- The loop is exact only while evolution is paused and the senses are quiet; otherwise it is a loop that slowly drifts, by design.
- Lighting comes from the mean depth per pixel, not from true surface normals: thin overlapping layers are lit as one surface.
- The fitness function measures structure, not beauty. It keeps evolution away from blobs and dust; taste comes from Love and Next.
- Without a float render target (rare), the density buffer falls back to 8 bits and the image is coarser.
