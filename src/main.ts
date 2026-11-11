import './style.css';
import { Engine } from './engine';
import { Renderer, type Frame } from './gl';
import { AudioEngine } from './audio';
import { Media } from './media';
import { EarthFeed } from './feeds';
import { PresetStore, exportPreset, importPreset, type Preset } from './presets';
import { PngStream } from './png';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const clamp = (v: number, a = 0, b = 1): number => Math.min(b, Math.max(a, v));

const NOTE_KEYS: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13,
};
type Quality = 'auto' | 'eco' | 'sharp';
const TILE = 1024;
// genome layout (see engine/src/evo.rs)
const MAP_LEN = 26;
const G_SYM = 104;
const G_PAL = 106;
const G_ROT = 118;
const G_PERSP = 121;

/** Column-major 4x4 rotation in the plane of axes (i, j), multiplied into `m`. */
function rotate4(m: Float32Array, i: number, j: number, a: number): void {
  const s = Math.sin(a);
  const c = Math.cos(a);
  for (let r = 0; r < 4; r++) {
    const x = m[i * 4 + r];
    const y = m[j * 4 + r];
    m[i * 4 + r] = x * c + y * s;
    m[j * 4 + r] = -x * s + y * c;
  }
}
const identity = (): Float32Array => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

async function boot(): Promise<void> {
  const splashStatus = $('splash-status');
  const canvas = $<HTMLCanvasElement>('view');
  const query = new URLSearchParams(location.search);
  const mobile = window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 760;
  // The seed pool is the upper bound of dots per frame: 4 bytes per dot.
  const capacity = Number(query.get('dots')) || (mobile ? 700_000 : 3_000_000);
  let renderer: Renderer;
  let engine: Engine;
  try {
    renderer = new Renderer(canvas, query.get('gl') === '1', capacity);
    renderer.init(query.has('tier') ? Number(query.get('tier')) : mobile || renderer.api === 'WebGL1' ? 1 : 2);
    engine = await Engine.load(`${import.meta.env.BASE_URL}engine.wasm`);
  } catch (e) {
    console.error(e);
    splashStatus.textContent = `Cannot start: ${(e as Error).message}`;
    $<HTMLButtonElement>('start').disabled = true;
    $<HTMLButtonElement>('start-silent').disabled = true;
    return;
  }

  const audio = new AudioEngine();
  const media = new Media();
  const earth = new EarthFeed();
  const store = new PresetStore();
  const P = (key: string): number => engine.id(key);
  const val = (key: string): number => engine.getParam(P(key));

  let yaw = 0.4;
  let pitch = 0.25;
  let quality: Quality = 'auto';
  let busy = false;
  let octave = 0;
  let tiltOn = false;
  const tilt = [0, 0];

  // ------------------------------------------------------------------ feedback
  const toastEl = $('toast');
  let toastTimer = 0;
  const toast = (text: string, ms = 2800): void => {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), ms);
  };

  // ------------------------------------------------------------------ controls
  const controls = new Map<number, (v: number) => void>();
  const setParam = (id: number, v: number, fromControl = false): void => {
    v = clamp(v);
    engine.setParam(id, v);
    audio.post({ t: 'p', id, v });
    if (!fromControl) controls.get(id)?.(v);
  };
  const setAll = (values: ArrayLike<number>): void => {
    for (let i = 0; i < engine.params.length; i++) setParam(i, values[i]);
  };

  {
    const host = $('sliders');
    const groups = new Map<string, HTMLDetailsElement>();
    const openGroups = new Set(mobile ? ['Life'] : ['Life', 'Space', 'Dots', 'Colour']);
    for (const p of engine.params) {
      let g = groups.get(p.group);
      if (!g) {
        g = document.createElement('details');
        g.open = openGroups.has(p.group);
        const sum = document.createElement('summary');
        sum.textContent = p.group;
        g.appendChild(sum);
        host.appendChild(g);
        groups.set(p.group, g);
      }
      const row = document.createElement('div');
      row.className = 'slider';
      const label = document.createElement('label');
      label.textContent = p.label;
      label.htmlFor = `p-${p.key}`;
      row.appendChild(label);
      if (p.options.length) {
        const sel = document.createElement('select');
        sel.id = `p-${p.key}`;
        p.options.forEach((o, i) => sel.add(new Option(o, String(i))));
        const n = p.options.length - 1;
        sel.addEventListener('change', () => setParam(p.id, Number(sel.value) / n, true));
        controls.set(p.id, (v) => (sel.value = String(Math.round(v * n))));
        row.appendChild(sel);
      } else {
        const input = document.createElement('input');
        input.type = 'range';
        input.id = `p-${p.key}`;
        input.min = '0';
        input.max = '1';
        input.step = '0.005';
        const out = document.createElement('output');
        input.addEventListener('input', () => {
          setParam(p.id, Number(input.value), true);
          out.textContent = String(Math.round(Number(input.value) * 100));
        });
        controls.set(p.id, (v) => {
          input.value = String(v);
          out.textContent = String(Math.round(v * 100));
        });
        row.append(input, out);
      }
      g.appendChild(row);
    }
  }
  setAll(engine.defaults());

  // ------------------------------------------------------------------ evolution buttons
  const genome = new Float32Array(engine.genomeLength);
  const loveBtn = $('btn-love');
  const love = (): void => {
    engine.love();
    loveBtn.classList.add('on');
    toast('Loved: this form stays in the gene pool and will breed');
  };
  const next = (): void => {
    engine.skip();
    loveBtn.classList.remove('on');
  };
  const newLife = (): void => {
    engine.reseed();
    loveBtn.classList.remove('on');
    toast('A fresh gene pool');
  };
  loveBtn.addEventListener('click', love);
  $('btn-next').addEventListener('click', next);
  $('btn-new').addEventListener('click', newLife);

  // ------------------------------------------------------------------ saved organisms
  const current = (name: string): Preset => {
    const params: Record<string, number> = {};
    const v = engine.values();
    for (const p of engine.params) params[p.key] = Math.round(v[p.id] * 10000) / 10000;
    return { app: 'novemberrain', v: 1, name, params, genome: Array.from(genome, (x) => Math.round(x * 1e5) / 1e5) };
  };
  const applyPreset = (p: Preset): void => {
    const values = engine.values();
    for (const [k, v] of Object.entries(p.params)) {
      const def = engine.byKey.get(k);
      if (def) values[def.id] = v;
    }
    setAll(values);
    if (p.genome.length === engine.genomeLength) engine.adopt(p.genome);
    $<HTMLInputElement>('save-name').value = p.name;
    loveBtn.classList.add('on');
  };
  const savedList = $('saved');
  const renderSaved = (): void => {
    savedList.replaceChildren();
    const all = store.list();
    if (!all.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nothing kept yet. When a form is worth keeping, name it and press Save.';
      savedList.appendChild(li);
    }
    for (const p of all) {
      const li = document.createElement('li');
      const load = document.createElement('button');
      load.type = 'button';
      load.textContent = p.name;
      load.addEventListener('click', () => applyPreset(p));
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '✕';
      del.title = `Delete ${p.name}`;
      del.addEventListener('click', () => {
        store.delete(p.name);
        renderSaved();
      });
      li.append(load, del);
      savedList.appendChild(li);
    }
  };
  $<HTMLFormElement>('save-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const n = $<HTMLInputElement>('save-name').value.trim() || `Organism ${store.list().length + 1}`;
    store.save(current(n));
    $<HTMLInputElement>('save-name').value = n;
    renderSaved();
    toast(`Saved "${n}"`);
  });
  $('btn-export').addEventListener('click', () => exportPreset(current($<HTMLInputElement>('save-name').value.trim() || 'Organism')));
  $('btn-import').addEventListener('click', () => $<HTMLInputElement>('file-preset').click());
  $('btn-reset').addEventListener('click', () => setAll(engine.defaults()));
  $<HTMLInputElement>('file-preset').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = '';
    if (!f) return;
    importPreset(f)
      .then((p) => {
        store.save(p);
        renderSaved();
        applyPreset(p);
        toast(`Imported "${p.name}"`);
      })
      .catch((err: Error) => toast(err.message));
  });

  // ------------------------------------------------------------------ senses
  const devButtons = [...document.querySelectorAll<HTMLButtonElement>('#devices button')];
  const refreshDevices = (): void => {
    for (const b of devButtons) {
      const d = b.dataset.dev;
      b.classList.toggle('on', d === 'camera' ? media.camOn : d === 'mic' ? audio.micOn : d === 'tilt' ? tiltOn : earth.on);
    }
  };
  media.onchange = refreshDevices;
  const onTilt = (e: DeviceOrientationEvent): void => {
    tilt[0] = ((e.gamma ?? 0) / 90) * 1.6;
    tilt[1] = (((e.beta ?? 0) - 45) / 90) * 1.6;
  };
  const device = async (d: string, on: boolean): Promise<void> => {
    try {
      if (d === 'camera') await media.camera(on);
      else if (d === 'mic') await audio.mic(on);
      else if (d === 'earth') {
        if (on) earth.start();
        else earth.stop();
      } else if (d === 'tilt') {
        if (on) {
          const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
          if (typeof DOE.requestPermission === 'function' && (await DOE.requestPermission()) !== 'granted') throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
          window.addEventListener('deviceorientation', onTilt);
          toast('Tilt the device to turn the form through the 4th dimension');
        } else {
          window.removeEventListener('deviceorientation', onTilt);
          tilt[0] = tilt[1] = 0;
        }
        tiltOn = on;
      }
    } catch (e) {
      const err = e as Error;
      const denied = err.name === 'NotAllowedError' || err.name === 'SecurityError';
      toast(denied ? `Permission for ${d} was not given. Allow it in the browser's site settings.` : `Could not start ${d}: ${err.message}`, 5000);
    }
    refreshDevices();
  };
  for (const b of devButtons) b.addEventListener('click', () => void device(b.dataset.dev!, !b.classList.contains('on')));

  // ------------------------------------------------------------------ interface chrome
  const setUi = (on: boolean): void => {
    document.body.classList.toggle('hidden-ui', !on);
  };
  const fullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => toast('Fullscreen is not available here'));
  };
  $('btn-panel').addEventListener('click', () => {
    const el = $('panel');
    el.hidden = !el.hidden;
    $('btn-panel').classList.toggle('on', !el.hidden);
  });
  $('btn-full').addEventListener('click', fullscreen);
  $('btn-hide').addEventListener('click', () => setUi(false));
  $('unhide').addEventListener('click', () => setUi(true));
  if (mobile) $('btn-panel').click();
  $<HTMLSelectElement>('quality').addEventListener('change', (e) => {
    quality = (e.target as HTMLSelectElement).value as Quality;
  });

  // ------------------------------------------------------------------ frame assembly
  const pointers = new Map<number, { x: number; y: number }>();
  const rot4 = identity();
  const view = identity();
  const angle4 = [0, 0, 0];
  const camCols = new Float32Array([0.9, 0.3, 0.2, 0.2, 0.8, 0.6, 0.3, 0.4, 1.0]);
  const uB = new Float32Array(16);
  const uV = new Float32Array(16);
  const uCP = new Float32Array(16);
  const uA = new Float32Array(64);
  const uPal = new Float32Array(12);
  let spin = 0;
  let hueClock = 0;
  let camTimer = 0;
  let quakeTimer = 4;
  let pulse = 0;
  let lastGeneration = 0;

  /** Advance the organism by `dt` seconds and describe the frame to draw. */
  const compose = (now: number, dt: number): Frame => {
    audio.update();
    const react = val('react') * 1.6;
    const bass = clamp(audio.bands.bass * react);
    const mid = clamp(audio.bands.mid * react);
    const high = clamp(audio.bands.high * react);

    // Impulses from the world: a loud beat or an earthquake make the next generation mutate harder.
    let kick = audio.micOn && bass > 0.75 ? dt * 0.6 : 0;
    quakeTimer -= dt;
    if (earth.on && quakeTimer <= 0) {
      const q = earth.next();
      quakeTimer = q ? 9 : 3;
      if (q) {
        const strength = clamp((q.mag + 1) / 8) * val('earth');
        kick += strength;
        pulse = Math.max(pulse, strength);
      }
    }
    pulse *= Math.exp(-dt * 1.2);

    genome.set(engine.evolve(dt, clamp(kick)));
    const info = engine.info();
    if (info.born) {
      loveBtn.classList.remove('on');
      // every birth rings a note chosen by the newborn's genes
      if (info.generation !== lastGeneration) audio.post({ t: 'on', n: Math.round(Math.abs(genome[24]) * 12), v: 0.5 });
      window.setTimeout(() => audio.post({ t: 'off', n: Math.round(Math.abs(genome[24]) * 12) }), 900);
      lastGeneration = info.generation;
    }

    // genome -> uniforms
    let total = 0;
    for (let m = 0; m < 4; m++) total += genome[m * MAP_LEN + 25];
    let accP = 0;
    for (let m = 0; m < 4; m++) {
      const o = m * MAP_LEN;
      uA.set(genome.subarray(o, o + 16), m * 16);
      uB.set(genome.subarray(o + 16, o + 20), m * 4);
      uV.set(genome.subarray(o + 20, o + 24), m * 4);
      accP += genome[o + 25] / total;
      uCP[m * 4] = genome[o + 24];
      uCP[m * 4 + 1] = m === 3 ? 2 : accP;
    }
    uPal.set(genome.subarray(G_PAL, G_PAL + 12));
    const psy = val('psy');
    const windy = earth.on ? earth.wind * val('earth') : 0;
    // psychedelia multiplies how many colour bands wrap around the form
    for (let k = 6; k < 9; k++) uPal[k] *= 0.6 + psy * 2.4;
    if (earth.on) {
      // warm air reddens the palette, cold air blues it
      const w = (earth.warmth - 0.5) * 0.25 * val('earth');
      uPal[0] += w;
      uPal[2] -= w;
    }
    const symSel = Math.round(val('symmetry') * 8);
    const sym = symSel > 0 ? symSel : genome[G_SYM];

    // rotation in the three planes that involve the 4th axis: evolved speeds, the slider, wind and tilt
    const dim = val('dim');
    const rate = dim * dim * 1.6 * (1 + windy * 2 + mid);
    for (let k = 0; k < 3; k++) angle4[k] += dt * rate * (0.25 + 0.5 * genome[G_ROT + k]);
    rot4.set(identity());
    rotate4(rot4, 0, 3, angle4[0] + tilt[0]);
    rotate4(rot4, 1, 3, angle4[1] + tilt[1]);
    rotate4(rot4, 2, 3, angle4[2]);
    if (!pointers.size) spin += dt * val('orbit') * 0.6;
    view.set(identity());
    rotate4(view, 0, 2, yaw + spin);
    rotate4(view, 1, 2, pitch);

    if (media.camOn && (camTimer -= dt) <= 0) {
      camTimer = 0.25;
      const c = media.colours();
      if (c) for (let i = 0; i < 9; i++) camCols[i] += (c[i] - camCols[i]) * 0.4;
    }

    hueClock += dt * (0.01 + psy * psy * 0.35) * (1 + high);
    const zoom = val('zoom');
    const soft = val('soft');
    const trails = val('trails');
    return {
      dots: {
        uA,
        uB,
        uV,
        uCP,
        uSym: [sym, genome[G_SYM + 1], 0, 0],
        uRot4: rot4,
        uView: view,
        uProj: [1.9, 5.6 - zoom * 4.2, genome[G_PERSP] * (0.3 + dim * 0.9), 1],
        uPal,
        uCam: camCols,
      },
      size: (0.9 + soft * soft * 9) * (1 + bass * 0.8 + pulse * 1.5),
      dof: soft * 0.9,
      gain: 1,
      glow: val('glow') * (1 + bass + pulse * 2),
      hue: val('hue') + hueClock,
      spread: 0.7 + psy * 1.6,
      camMix: media.camOn ? val('camcol') : 0,
      tone: [9 + psy * 20, 0.34 + bass * 0.12 + pulse * 0.2, 1.25 + psy * 0.9, 0],
      // feedback: persistence, zoom, twist, colour cycle (the last three grow with psychedelia)
      fb: [trails * 0.97, psy * 0.012 * (1 + bass * 2), (psy - 0.3) * 0.02, psy * psy * 0.25],
      bright: Math.pow(2, (val('brightness') - 0.5) * 3),
      time: now / 1000,
    };
  };

  // ------------------------------------------------------------------ stills
  const progress = $('progress');
  const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

  /**
   * Render the current form `width` pixels wide and save it as PNG. Each tile gets many
   * passes of fresh dots (hundreds of millions in total on a desktop GPU) and is streamed
   * straight into the encoder, so the full image never sits in memory.
   */
  const still = async (width: number): Promise<void> => {
    if (busy || !renderer.ready) return;
    if (!PngStream.supported) return toast('This browser cannot stream-compress images. Please update it to save stills.', 6000);
    busy = true;
    const W = width;
    const H = Math.max(2, Math.round((W * canvas.clientHeight) / Math.max(1, canvas.clientWidth)));
    // Enough dots for the pixel count: about 1.5 per pixel on desktop, fewer on phones.
    const want = W * H * (mobile ? 0.25 : 1.5);
    const keep = renderer.count;
    renderer.count = renderer.capacity;
    const passes = Math.max(2, Math.min(64, Number(query.get('passes')) || Math.round(want / renderer.count)));
    progress.hidden = false;
    const setProgress = (f: number, text: string): void => {
      $('progress-bar').style.width = `${Math.round(f * 100)}%`;
      $('progress-text').textContent = text;
    };
    const millions = ((passes * renderer.count) / 1e6).toFixed(0);
    setProgress(0, `Rendering ${W}×${H} from ${millions} million dots…`);
    try {
      const frame = compose(performance.now(), 0); // freeze this instant
      await nextFrame();
      const png = new PngStream(W, H);
      const band = new Uint8Array(W * TILE * 4);
      const tilePx = new Uint8Array(TILE * TILE * 4);
      const bands = Math.ceil(H / TILE);
      const cols = Math.ceil(W / TILE);
      for (let j = 0; j < bands; j++) {
        const rows = Math.min(TILE, H - j * TILE);
        const oy = H - j * TILE - rows;
        for (let i = 0; i < cols; i++) {
          const ox = i * TILE;
          const w = Math.min(TILE, W - ox);
          if (renderer.lost) throw new Error('the graphics context was lost');
          renderer.tile(frame, W, H, ox, oy, TILE, w, rows, passes, tilePx);
          for (let r = 0; r < rows; r++) band.set(tilePx.subarray(r * w * 4, (r + 1) * w * 4), (r * W + ox) * 4);
          setProgress((j * cols + i + 1) / (bands * cols), `Rendering ${W}×${H} from ${millions} million dots… ${Math.round(((j * cols + i + 1) / (bands * cols)) * 100)}%`);
          await nextFrame(); // keep the page responsive and the GPU watchdog calm
        }
        await png.write(band.subarray(0, W * rows * 4), rows);
      }
      setProgress(1, 'Saving…');
      const blob = await png.finish();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `novemberrain-${W}x${H}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      toast(`Saved ${W}×${H} (${(blob.size / 1048576).toFixed(1)} MB)`, 5000);
      document.body.dataset.still = `${W}x${H}:${blob.size}`;
    } catch (e) {
      toast(`The still could not be rendered: ${(e as Error).message}`, 6000);
    } finally {
      renderer.freeTiles();
      renderer.count = keep;
      progress.hidden = true;
      busy = false;
    }
  };
  $('btn-4k').addEventListener('click', () => void still(Number(query.get('still')) || 3840));
  $('btn-8k').addEventListener('click', () => void still(Number(query.get('still')) || 7680));

  // ------------------------------------------------------------------ keyboard
  const typing = (e: KeyboardEvent): boolean => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') && (t as HTMLInputElement).type !== 'range';
  };
  const held = new Set<string>();
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      setUi(document.body.classList.contains('hidden-ui'));
      return;
    }
    if (typing(e)) {
      if (e.key === 'Escape') (e.target as HTMLElement).blur();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.code === 'Space') {
      e.preventDefault();
      return next();
    }
    if (e.code === 'KeyL') return love();
    if (e.code === 'KeyN') return newLife();
    if (e.code === 'KeyZ') octave = Math.max(-2, octave - 1);
    if (e.code === 'KeyX') octave = Math.min(2, octave + 1);
    const n = NOTE_KEYS[e.code];
    if (n !== undefined && !held.has(e.code)) {
      held.add(e.code);
      audio.post({ t: 'on', n: n + octave * 12, v: 0.8 });
    }
  });
  window.addEventListener('keyup', (e) => {
    const n = NOTE_KEYS[e.code];
    if (n !== undefined && held.delete(e.code)) audio.post({ t: 'off', n: n + octave * 12 });
  });

  // ------------------------------------------------------------------ mouse and touch
  let pinch = 0;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.classList.add('drag');
    pinch = 0;
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 1) {
      yaw += dx * 0.006;
      pitch = clamp(pitch + dy * 0.006, -1.5, 1.5);
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch > 0) setParam(P('zoom'), val('zoom') + (d - pinch) * 0.003);
      pinch = d;
    }
  });
  const release = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    pinch = 0;
    if (!pointers.size) canvas.classList.remove('drag');
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    setParam(P('zoom'), val('zoom') - e.deltaY * 0.0006);
  }, { passive: false });

  // ------------------------------------------------------------------ start-up
  const start = async (withSound: boolean): Promise<void> => {
    if (withSound) {
      $<HTMLButtonElement>('start').disabled = true;
      splashStatus.textContent = 'Starting the synthesizer…';
      try {
        await audio.start(engine.wasmBytes, [...engine.values()]);
      } catch (e) {
        console.error(e);
        toast(`Sound could not start (${(e as Error).message}). The visuals still work.`, 6000);
      }
    }
    $('splash').classList.add('gone');
    // The Earth feed is on by default: it only downloads public data and sends nothing about you.
    if (!query.has('offline')) void device('earth', true);
  };
  $('start').addEventListener('click', () => void start(true));
  $('start-silent').addEventListener('click', () => void start(false));
  renderSaved();
  refreshDevices();

  // ------------------------------------------------------------------ main loop
  const stat = $('stat');
  const statusEl = $('status');
  const fixedScale = Number(query.get('scale')) || 0;
  renderer.scale = fixedScale || (mobile ? 0.5 : 0.7);
  const fixedDots = query.has('dots'); // ?dots=N pins the swarm size (testing, recording)
  let budget = fixedDots ? capacity : mobile ? 150_000 : 600_000; // dots the GPU has shown it can draw per frame
  let last = performance.now();
  let acc = 0;
  let frames = 0;
  let lastDown = 0;
  const frame = (now: number): void => {
    requestAnimationFrame(frame);
    const rawDt = (now - last) / 1000;
    last = now;
    if (busy || document.hidden) return;
    renderer.resize();
    renderer.count = Math.max(20_000, Math.round(Math.min(budget, renderer.capacity) * (0.08 + 0.92 * val('dots'))));
    renderer.render(compose(now, Math.min(rawDt, 0.1)));

    if (rawDt < 0.25) {
      acc += rawDt;
      frames++;
    }
    if (acc < 0.6) return;
    const fps = frames / acc;
    acc = 0;
    frames = 0;
    // Governor: hold the frame rate by trading dots first, then internal pixels.
    const cap = quality === 'eco' ? 0.45 : 1;
    if (fixedScale) renderer.scale = fixedScale;
    else if (quality === 'sharp') renderer.scale = 1;
    if (fixedDots) {
      /* swarm size pinned by the URL */
    } else if (fps < 40) {
      budget = Math.max(40_000, budget * (fps < 22 ? 0.6 : 0.85));
      if (budget <= 60_000 && !fixedScale && quality !== 'sharp') renderer.scale = Math.max(0.3, renderer.scale * 0.88);
      lastDown = now;
    } else if (fps > 55 && now - lastDown > 2500) {
      if (!fixedScale && quality !== 'sharp' && renderer.scale < cap) renderer.scale = Math.min(cap, renderer.scale * 1.08);
      else budget = Math.min(renderer.capacity, budget * 1.15);
    }
    if (!fixedScale && quality === 'eco') renderer.scale = Math.min(renderer.scale, cap);
    const [sw, sh] = renderer.internal;
    const dots = renderer.count >= 1e6 ? `${(renderer.count / 1e6).toFixed(1)}M` : `${Math.round(renderer.count / 1000)}k`;
    stat.textContent = `${Math.round(fps)} fps · ${dots} dots · ${sw}×${sh} → ${canvas.width}×${canvas.height}`;
    const info = engine.info();
    statusEl.textContent = `Generation ${info.generation} · fitness ${info.fitness.toFixed(2)} · pool ${info.poolFitness.toFixed(2)}${info.loved ? ` · ♥ ${info.loved}` : ''}${earth.status ? `\n${earth.status}` : ''}`;
  };
  requestAnimationFrame(frame);
}

void boot();
