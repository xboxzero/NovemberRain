import './style.css';
import { Engine } from './engine';
import { Renderer, type Frame } from './gl';
import { AudioEngine } from './audio';
import { Media } from './media';
import { PresetStore, exportPreset, importPreset, type Preset } from './presets';
import { PngStream } from './png';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const clamp = (v: number, a = 0, b = 1): number => Math.min(b, Math.max(a, v));

const NOTE_KEYS: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14,
};
/** Internal pixel budget per shader tier (megapixels) and quality mode. */
const BUDGET = { auto: [0.5, 1.1, 2.4], eco: [0.2, 0.3, 0.45], balanced: [0.45, 0.9, 1.6], sharp: [99, 99, 99] } as const;
type Quality = keyof typeof BUDGET;
const FLAME_ITERS = [30_000, 60_000, 110_000];
const TILE = 512;

async function boot(): Promise<void> {
  const splashStatus = $('splash-status');
  const canvas = $<HTMLCanvasElement>('view');
  const query = new URLSearchParams(location.search);
  const mobile = window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 760;
  let renderer: Renderer;
  let engine: Engine;
  try {
    renderer = new Renderer(canvas, query.get('gl') === '1');
    engine = await Engine.load(`${import.meta.env.BASE_URL}engine.wasm`);
  } catch (e) {
    splashStatus.textContent = `Cannot start: ${(e as Error).message}`;
    $<HTMLButtonElement>('start').disabled = true;
    $<HTMLButtonElement>('start-silent').disabled = true;
    return;
  }

  const audio = new AudioEngine();
  const media = new Media();
  const store = new PresetStore();
  const P = (key: string): number => engine.id(key);
  const val = (key: string): number => engine.getParam(P(key));

  let activePreset = 0;
  let yaw = 0.25;
  let orbitPhase = 0;
  let xyOn = false;
  let octave = 0;
  let quality: Quality = 'auto';
  let busy = false;

  // ------------------------------------------------------------------ feedback
  const toastEl = $('toast');
  let toastTimer = 0;
  const toast = (text: string, ms = 2800): void => {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), ms);
  };

  // ------------------------------------------------------------------ parameters
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
    const openGroups = new Set(mobile ? ['World'] : ['World', 'Camera', 'Psychedelic FX']);
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
        // Selector parameter (routing, key, temperament).
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

  // ------------------------------------------------------------------ presets
  const presetBar = $('presets');
  const presetButtons: HTMLButtonElement[] = [];
  const markPreset = (): void => presetButtons.forEach((b, i) => b.classList.toggle('on', i === activePreset));

  const currentPreset = (name: string): Preset => {
    const params: Record<string, number> = {};
    const v = engine.values();
    for (const p of engine.params) params[p.key] = Math.round(v[p.id] * 10000) / 10000;
    return { app: 'novemberrain', v: 1, name, params };
  };

  const applyPreset = (p: Preset): void => {
    const values = engine.defaults();
    for (const [k, v] of Object.entries(p.params)) {
      const def = engine.byKey.get(k);
      if (def) values[def.id] = v;
    }
    setAll(values);
    activePreset = 1;
    markPreset();
    store.last = p.name;
    $<HTMLInputElement>('save-name').value = p.name;
  };

  const savedList = $('saved');
  const renderSaved = (): void => {
    savedList.replaceChildren();
    const all = store.list();
    if (!all.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nothing saved yet. Shape the world, name it, press Save.';
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

  const loadDefault = (): void => {
    setAll(engine.defaults());
    activePreset = 0;
    markPreset();
    yaw = 0.25;
    orbitPhase = 0;
  };

  const loadCustom = (): void => {
    const last = (store.last ? store.get(store.last) : undefined) ?? store.list()[0];
    $('panel').hidden = false;
    $('btn-panel').classList.add('on');
    if (last) {
      applyPreset(last);
      toast(`Custom preset: ${last.name}`);
    } else {
      activePreset = 1;
      markPreset();
      toast('Preset 2 is yours: shape the world, then press Save (or import a file)');
    }
  };

  for (const [i, label, title, fn] of [
    [1, 'Titan Storm', engine.world, loadDefault],
    [2, 'Custom', 'Your own saved preset', loadCustom],
  ] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = title;
    b.innerHTML = `<i>${i}</i>`;
    b.append(label);
    b.addEventListener('click', fn);
    presetBar.appendChild(b);
    presetButtons.push(b);
  }

  $<HTMLFormElement>('save-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const n = $<HTMLInputElement>('save-name').value.trim() || 'Custom';
    store.save(currentPreset(n));
    $<HTMLInputElement>('save-name').value = n;
    activePreset = 1;
    markPreset();
    renderSaved();
    toast(`Saved "${n}"`);
  });
  $('btn-export').addEventListener('click', () => exportPreset(currentPreset($<HTMLInputElement>('save-name').value.trim() || 'Custom')));
  $('btn-import').addEventListener('click', () => $<HTMLInputElement>('file-preset').click());
  $('btn-reset').addEventListener('click', loadDefault);
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

  // ------------------------------------------------------------------ devices
  const devButtons = [...document.querySelectorAll<HTMLButtonElement>('#devices button')];
  const refreshDevices = (): void => {
    for (const b of devButtons) {
      const d = b.dataset.dev;
      b.classList.toggle('on', d === 'camera' ? media.camOn : d === 'mic' ? audio.micOn : d === 'screen' ? media.vidKind === 'screen' : d === 'file' ? media.vidKind === 'file' : xyOn);
    }
  };
  media.onchange = refreshDevices;

  const device = async (d: string, on: boolean): Promise<void> => {
    try {
      if (d === 'camera') await media.camera(on);
      else if (d === 'mic') await audio.mic(on);
      else if (d === 'screen') await media.screen(on);
      else if (d === 'file') {
        if (on) $<HTMLInputElement>('file-video').click();
        else if (media.vidKind === 'file') media.stopVideo();
      } else if (d === 'xy') {
        xyOn = on;
        if (!on) audio.post({ t: 'xy', x: 0.5, y: 0.5, d: false });
        toast(on ? 'XY pad on: drag on the picture to play (left-right pitch, up-down filter)' : 'XY pad off: drag moves the camera');
      }
    } catch (e) {
      const err = e as Error;
      const denied = err.name === 'NotAllowedError' || err.name === 'SecurityError';
      toast(denied ? `Permission to use the ${d} was not given. Allow it in the browser's site settings.` : `Could not start the ${d}: ${err.message}`, 5000);
    }
    refreshDevices();
  };
  for (const b of devButtons) {
    b.addEventListener('click', () => void device(b.dataset.dev!, !b.classList.contains('on')));
  }
  $<HTMLInputElement>('file-video').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) media.file(f).catch((err: Error) => toast(`Could not play that file: ${err.message}`, 5000));
    (e.target as HTMLInputElement).value = '';
  });

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
  $('btn-strike').addEventListener('click', () => engine.strike(true));
  if (mobile) $('btn-panel').click();
  const qualitySelect = $<HTMLSelectElement>('quality');
  qualitySelect.addEventListener('change', () => {
    quality = qualitySelect.value as Quality;
  });

  // ------------------------------------------------------------------ frame assembly
  const stat = $('stat');
  const data = new Float32Array(336);
  const pointers = new Map<number, { x: number; y: number }>();
  let flameDt = 0;
  let flameTick = 0;

  /** Advance the world by `dt` seconds and describe the frame to draw. */
  const compose = (now: number, dt: number): Frame => {
    audio.update();
    const react = val('react') * 1.6;
    const bass = clamp(audio.bands.bass * react);
    const mid = clamp(audio.bands.mid * react);
    const high = clamp(audio.bands.high * react);
    engine.step(dt, bass, mid, high);
    const ev = engine.events();
    for (let i = 0; i < ev.length; i += 4) audio.post({ t: 'ev', k: ev[i], a: ev[i + 1], b: ev[i + 2] });
    data.set(engine.data());

    const flame = val('flame');
    // The chaos game runs every frame on the full tier, every other frame below it.
    flameDt += dt;
    if (flame > 0.003 && dt > 0 && (renderer.tier === 2 || ++flameTick % 2 === 0)) {
      const f = engine.flame(FLAME_ITERS[renderer.tier], flameDt, bass);
      renderer.setFlame(f.pixels, f.size);
      flameDt = 0;
    }

    // Architectural camera: it stands on the sand at eye height, the film plane stays
    // vertical and the lens is shifted (not tilted) to take in the whole titan.
    if (!pointers.size || xyOn) orbitPhase += dt * val('orbit') * 0.5;
    const y = yaw + Math.sin(orbitPhase) * 0.9;
    const dist = data[335] * (0.35 + 1.4 * val('zoom'));
    const tx = data[332];
    const ty = data[333];
    const tz = data[334];
    const cx = tx + dist * Math.sin(y);
    const cz = tz + dist * Math.cos(y);
    const eye = val('eye');
    const shake = data[72] * 0.5;
    const cy = engine.ground(cx, cz) + 1.3 + eye * eye * 70 + Math.cos(now * 0.043) * shake;
    const fx = (tx - cx) / dist;
    const fz = (tz - cz) / dist;
    const lens = val('lens');
    const focal = 0.8 + Math.pow(lens, 1.5) * 4.2;
    const rise = ((ty - cy) / dist) * focal + (val('shift') - 0.5) * 1.6;
    const time = now / 1000;
    const au = [bass, mid, high, (bass + mid + high) / 3];
    return {
      world: {
        uCamPos: [cx + Math.sin(now * 0.05) * shake, cy, cz],
        uCamR: [-fz, 0, fx],
        uCamF: [fx, 0, fz],
        uLens: [focal, rise, val('warp'), time],
        uD: data,
        uP: [val('storm'), val('rain'), val('sand'), val('fold')],
        uP2: [Math.pow(2, (val('brightness') - 0.5) * 4), 0, 0, 0],
        uFx1: [val('kaleido'), val('kseg'), val('kspin'), Math.round(val('route'))],
        uFx2: [val('tunnel'), val('tunspeed'), val('liquid'), val('liqscale')],
        uFx3: [val('glitch'), 0, 0, 0],
        uAudio: au,
        uW: data[329],
      },
      fx: {
        uTime: time,
        uRoute: Math.round(val('route')),
        uBloom: val('bloom'),
        uRgb: val('rgb'),
        uEdge: val('edge'),
        uPoster: val('poster'),
        uGlitch: val('glitch'),
        uCamMix: media.camOn ? val('cammix') : 0,
        uVidMix: media.vidKind ? val('vidmix') : 0,
        uFb: [val('feedback'), val('fbzoom'), val('fbrot'), val('fbhue')],
        uAcid: [val('acid'), val('acidcyc'), val('acidspeed')],
        uFlameP: [flame, val('flamezoom')],
        uAudio: au,
      },
      grade: { uTime: time, uHue: val('hue'), uSat: val('saturation'), uContrast: val('contrast'), uGlitch: val('glitch') },
      cam: media.camOn ? media.cam : null,
      vid: media.vidKind ? media.vid : null,
    };
  };

  // ------------------------------------------------------------------ high-resolution stills
  const progress = $('progress');
  const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

  /**
   * Render the current frame `width` pixels wide and save it as PNG. The image is
   * drawn in small tiles and streamed into the encoder band by band, so neither the
   * GPU nor the browser ever holds the full picture: this is what lets a phone make an 8K image.
   */
  const still = async (width: number): Promise<void> => {
    if (busy || !renderer.ready) return;
    if (!PngStream.supported) return toast('This browser cannot stream-compress images. Please update it to export stills.', 6000);
    busy = true;
    const W = width;
    const H = Math.max(2, Math.round((W * canvas.clientHeight) / Math.max(1, canvas.clientWidth)));
    progress.hidden = false;
    const setProgress = (f: number, text: string): void => {
      $('progress-bar').style.width = `${Math.round(f * 100)}%`;
      $('progress-text').textContent = text;
    };
    setProgress(0, `Rendering ${W}×${H}…`);
    try {
      const frame = compose(performance.now(), 0); // freeze this instant
      renderer.render(frame);
      await nextFrame();
      const png = new PngStream(W, H);
      const band = new Uint8Array(W * TILE * 4);
      const tilePx = new Uint8Array(TILE * TILE * 4);
      const bands = Math.ceil(H / TILE);
      for (let j = 0; j < bands; j++) {
        const rows = Math.min(TILE, H - j * TILE); // image rows j*TILE .. j*TILE+rows, from the top
        const oy = H - j * TILE - rows; // GL y of the band's bottom edge
        for (let ox = 0; ox < W; ox += TILE) {
          const w = Math.min(TILE, W - ox);
          if (renderer.lost) throw new Error('the graphics context was lost');
          renderer.tile(frame, W, H, ox, oy, TILE, w, rows, tilePx);
          for (let r = 0; r < rows; r++) band.set(tilePx.subarray(r * w * 4, (r + 1) * w * 4), (r * W + ox) * 4);
        }
        await png.write(band.subarray(0, W * rows * 4), rows);
        setProgress((j + 1) / bands, `Rendering ${W}×${H}… ${Math.round(((j + 1) / bands) * 100)}%`);
        await nextFrame(); // keep the page responsive and the GPU watchdog calm
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
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) engine.strike(true);
      return;
    }
    if (e.key === '1') return loadDefault();
    if (e.key === '2') return loadCustom();
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
  const xyAt = (e: PointerEvent, down: boolean): void => {
    const r = canvas.getBoundingClientRect();
    audio.post({ t: 'xy', x: clamp((e.clientX - r.left) / r.width), y: clamp(1 - (e.clientY - r.top) / r.height), d: down });
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.classList.add('drag');
    pinch = 0;
    if (xyOn && pointers.size === 1) xyAt(e, true);
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 1) {
      if (xyOn) xyAt(e, true);
      else {
        yaw -= dx * 0.005;
        setParam(P('eye'), val('eye') + dy * 0.0012); // drag down: the camera rises
      }
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch > 0) setParam(P('zoom'), val('zoom') - (d - pinch) * 0.003);
      pinch = d;
    }
  });
  const release = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    pinch = 0;
    if (!pointers.size) {
      canvas.classList.remove('drag');
      if (xyOn) xyAt(e, false);
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    setParam(P('zoom'), val('zoom') + e.deltaY * 0.0006);
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
  };
  $('start').addEventListener('click', () => void start(true));
  $('start-silent').addEventListener('click', () => void start(false));

  renderSaved();
  refreshDevices();
  loadDefault();
  splashStatus.textContent = 'Building the world…';
  // Start modest on phones and on WebGL1 hardware; the renderer steps down further by itself
  // if a tier will not compile, and the loop below steps down if it will not run smoothly.
  const wantTier = query.has('tier') ? Number(query.get('tier')) : renderer.api === 'WebGL1' || mobile ? 1 : 2;
  try {
    await renderer.init(clamp(wantTier, 0, 2));
  } catch (e) {
    console.error(e);
    splashStatus.textContent = `This GPU could not build the world shader (${renderer.api}).`;
    return;
  }
  splashStatus.textContent = '';
  const fixedScale = Number(query.get('scale')) || 0;
  renderer.scale = fixedScale || (mobile ? 0.35 : 0.5);

  // ------------------------------------------------------------------ main loop
  let last = performance.now();
  let acc = 0;
  let frames = 0;
  let lastDown = 0;
  let slow = 0;
  let switching = false;
  const frame = (now: number): void => {
    requestAnimationFrame(frame);
    const rawDt = (now - last) / 1000;
    last = now;
    if (busy || document.hidden) return;
    renderer.resize();
    renderer.render(compose(now, Math.min(rawDt, 0.1)));

    if (rawDt < 0.25) {
      acc += rawDt;
      frames++;
    }
    if (acc < 0.6) return;
    const fps = frames / acc;
    acc = 0;
    frames = 0;
    // Resolution governor: hold the frame rate by trading internal pixels, never above the budget.
    const px = canvas.width * canvas.height;
    const cap = Math.min(1, Math.sqrt((BUDGET[quality][renderer.tier] * 1e6) / px));
    const floor = Math.min(cap, 0.16);
    if (fixedScale) {
      renderer.scale = fixedScale;
    } else if (quality === 'sharp') {
      renderer.scale = 1;
    } else if (fps < 38 && renderer.scale > floor) {
      renderer.scale = Math.max(floor, renderer.scale * (fps < 20 ? 0.7 : 0.86));
      lastDown = now;
    } else if (fps > 55 && now - lastDown > 4000 && renderer.scale < cap) {
      renderer.scale = Math.min(cap, renderer.scale * 1.08);
    }
    if (!fixedScale) renderer.scale = Math.min(renderer.scale, Math.max(cap, floor));
    // Still crawling at the lowest resolution: drop to a simpler shader.
    slow = fps < 18 && renderer.scale <= floor * 1.05 ? slow + 1 : 0;
    if (slow >= 4 && renderer.tier > 0 && !switching && !query.has('tier')) {
      switching = true;
      slow = 0;
      void renderer.setTier(renderer.tier - 1).finally(() => (switching = false));
    }
    const [sw, sh] = renderer.internal;
    stat.textContent = `${Math.round(fps)} fps · ${sw}×${sh} → ${canvas.width}×${canvas.height} · ${renderer.api} T${renderer.tier}`;
  };
  requestAnimationFrame(frame);
}

void boot();
