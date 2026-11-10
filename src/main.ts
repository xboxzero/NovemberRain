import './style.css';
import { Engine, type ChatAction } from './engine';
import { Renderer } from './gl';
import { AudioEngine } from './audio';
import { Media } from './media';
import { PresetStore, exportPreset, importPreset, type Preset } from './presets';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const clamp = (v: number, a = 0, b = 1): number => Math.min(b, Math.max(a, v));

const CHIPS = ['more lightning', 'strike the titan', 'make it trippy', 'effects in parallel', 'make it 4d', 'kirnberger tuning', 'key of G minor', 'clean', 'help'];
const NOTE_KEYS: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14,
};
/** Output modes: number of lines rendered (0 = follow the window and adapt). */
const RESOLUTIONS: Record<string, number> = { auto: 0, '1080p': 1080, '1440p': 1440, '4k': 2160, '8k': 4320 };
const CAM = { yaw: 0.22, pitch: -0.16, pmin: -0.3, pmax: 1.0 };

async function boot(): Promise<void> {
  const splashStatus = $('splash-status');
  const canvas = $<HTMLCanvasElement>('view');
  let renderer: Renderer;
  let engine: Engine;
  try {
    renderer = new Renderer(canvas);
    [engine] = await Promise.all([Engine.load(`${import.meta.env.BASE_URL}engine.wasm`), renderer.init()]);
  } catch (e) {
    splashStatus.textContent = `Cannot start: ${(e as Error).message}`;
    $<HTMLButtonElement>('start').disabled = true;
    return;
  }

  const query = new URLSearchParams(location.search);
  const audio = new AudioEngine();
  const media = new Media();
  const store = new PresetStore();
  const P = (key: string): number => engine.id(key);
  const val = (key: string): number => engine.getParam(P(key));

  let activePreset = 0;
  let yaw = CAM.yaw;
  let pitch = CAM.pitch;
  let orbitPhase = 0;
  let xyOn = false;
  let octave = 0;
  let resMode = 'auto';
  let busy = false;

  // ------------------------------------------------------------------ feedback
  const toastEl = $('toast');
  let toastTimer = 0;
  const toast = (text: string, ms = 2600): void => {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), ms);
  };
  const log = $('log');
  const say = (text: string, cls: 'user' | 'bot' | 'bot err' = 'bot'): void => {
    const d = document.createElement('div');
    d.className = `msg ${cls}`;
    d.textContent = text;
    log.appendChild(d);
    while (log.children.length > 60) log.firstChild?.remove();
    log.scrollTop = log.scrollHeight;
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
    const openGroups = new Set(['World', '4D', 'Psychedelic FX']);
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

  const savePreset = (name: string): string => {
    const n = name.trim() || $<HTMLInputElement>('save-name').value.trim() || 'Custom';
    store.save(currentPreset(n));
    $<HTMLInputElement>('save-name').value = n;
    activePreset = 1;
    markPreset();
    renderSaved();
    return n;
  };

  const loadDefault = (): void => {
    setAll(engine.defaults());
    activePreset = 0;
    markPreset();
    yaw = CAM.yaw;
    pitch = CAM.pitch;
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

  // ------------------------------------------------------------------ output resolution
  const resSelect = $<HTMLSelectElement>('res');
  const setResolution = (mode: string): void => {
    if (!(mode in RESOLUTIONS)) return;
    resMode = mode;
    resSelect.value = mode;
    renderer.fixedHeight = RESOLUTIONS[mode];
    if (renderer.fixedHeight) {
      renderer.scale = 1;
      const w = Math.round((renderer.fixedHeight * canvas.clientWidth) / Math.max(1, canvas.clientHeight));
      if (Math.max(w, renderer.fixedHeight) > renderer.maxSize) toast(`This GPU tops out at ${renderer.maxSize}px: rendering as large as it allows`, 5000);
      else if (renderer.fixedHeight >= 2160) toast(`Rendering every frame at ${mode.toUpperCase()}. Expect a low frame rate without a high-end GPU.`, 5000);
    } else {
      renderer.scale = 0.6;
    }
  };
  resSelect.addEventListener('change', () => setResolution(resSelect.value));
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    toast('The GPU ran out of memory at this resolution. Reloading in Auto…', 4000);
    setTimeout(() => location.reload(), 1800);
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
        toast(on ? 'XY pad on: drag on the picture to play (left-right pitch, up-down filter)' : 'XY pad off: drag orbits the camera');
      }
    } catch (e) {
      const err = e as Error;
      const denied = err.name === 'NotAllowedError' || err.name === 'SecurityError';
      say(denied ? `I was not given permission to use the ${d}. Allow it in the browser's site settings and try again.` : `Could not start the ${d}: ${err.message}`, 'bot err');
    }
    refreshDevices();
  };
  for (const b of devButtons) {
    b.addEventListener('click', () => void device(b.dataset.dev!, !b.classList.contains('on')));
  }
  $<HTMLInputElement>('file-video').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) media.file(f).catch((err: Error) => say(`Could not play that file: ${err.message}`, 'bot err'));
    (e.target as HTMLInputElement).value = '';
  });

  // ------------------------------------------------------------------ preset panel
  $<HTMLFormElement>('save-form').addEventListener('submit', (e) => {
    e.preventDefault();
    toast(`Saved "${savePreset($<HTMLInputElement>('save-name').value)}"`);
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

  // ------------------------------------------------------------------ interface chrome
  const setUi = (on: boolean): void => {
    document.body.classList.toggle('hidden-ui', !on);
  };
  const fullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => toast('Fullscreen is not available here'));
  };
  const togglePane = (pane: string, btn: string): void => {
    const el = $(pane);
    el.hidden = !el.hidden;
    $(btn).classList.toggle('on', !el.hidden);
  };
  $('btn-chat').addEventListener('click', () => togglePane('chat', 'btn-chat'));
  $('btn-panel').addEventListener('click', () => togglePane('panel', 'btn-panel'));
  $('btn-full').addEventListener('click', fullscreen);
  $('btn-hide').addEventListener('click', () => setUi(false));
  $('unhide').addEventListener('click', () => setUi(true));
  if (window.matchMedia('(max-width: 760px)').matches) togglePane('panel', 'btn-panel');

  // ------------------------------------------------------------------ drawing
  const stat = $('stat');
  const data = new Float32Array(520);
  const fixedScale = Number(query.get('scale')) || 0; // ?scale=0.5 pins the internal scale in Auto mode
  if (fixedScale) renderer.scale = clamp(fixedScale, 0.1, 1);

  /** Advance the world by `dt` seconds and draw one frame at the current buffer size. */
  const draw = (now: number, dt: number): void => {
    audio.update();
    const react = val('react') * 1.6;
    const bass = clamp(audio.bands.bass * react);
    const mid = clamp(audio.bands.mid * react);
    const high = clamp(audio.bands.high * react);
    engine.step(dt, bass, mid, high);
    const ev = engine.events();
    for (let i = 0; i < ev.length; i += 4) audio.post({ t: 'ev', k: ev[i], a: ev[i + 1], b: ev[i + 2] });
    data.set(engine.data());

    // The camera sways around the walking titan and shakes with every footfall.
    if (!pointers.size || xyOn) orbitPhase += dt * val('orbit') * 0.5;
    const y = yaw + Math.sin(orbitPhase) * 0.9;
    const dist = data[519] * (1.9 - 1.45 * val('zoom'));
    const tgt = [data[516], data[517], data[518]];
    const shake = data[72] * 0.6;
    const pos = [
      tgt[0] + dist * Math.cos(pitch) * Math.sin(y) + Math.sin(now * 0.05) * shake,
      tgt[1] + dist * Math.sin(pitch) + Math.cos(now * 0.043) * shake,
      tgt[2] + dist * Math.cos(pitch) * Math.cos(y),
    ];
    const time = now / 1000;
    const au = [bass, mid, high, (bass + mid + high) / 3];
    renderer.render({
      world: {
        uTime: time,
        uCamPos: pos,
        uCamTgt: tgt,
        uD: data,
        uP: [val('storm'), val('rain'), val('sand'), val('warp')],
        uQ: [val('tess'), val('fold'), 0, 0],
        uAudio: au,
        uW: data[513],
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
        uKal: [val('kaleido'), val('kseg'), val('kspin')],
        uFb: [val('feedback'), val('fbzoom'), val('fbrot'), val('fbhue')],
        uTun: [val('tunnel'), val('tunspeed')],
        uLiq: [val('liquid'), val('liqscale')],
        uAcid: [val('acid'), val('acidcyc'), val('acidspeed')],
        uAudio: au,
      },
      grade: {
        uTime: time,
        uHue: val('hue'),
        uSat: val('saturation'),
        uBright: val('brightness'),
        uContrast: val('contrast'),
        uGlitch: val('glitch'),
      },
      cam: media.camOn ? media.cam : null,
      vid: media.vidKind ? media.vid : null,
    });
  };

  /** Render a single frame 7680 pixels wide (or as large as the GPU allows) and download it. */
  const snapshot = async (): Promise<void> => {
    if (busy || !renderer.ready) return;
    busy = true;
    toast('Rendering an 8K still…', 20000);
    await new Promise((r) => setTimeout(r, 60)); // let the toast paint before the GPU stalls
    const keep = { fixed: renderer.fixedHeight, scale: renderer.scale };
    try {
      const width = Math.min(Number(query.get('snap')) || 7680, renderer.maxSize);
      renderer.fixedHeight = Math.round((width * canvas.clientHeight) / Math.max(1, canvas.clientWidth));
      renderer.scale = 1;
      renderer.resize();
      draw(performance.now(), 0);
      const size = `${canvas.width}×${canvas.height}`;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
      if (!blob) throw new Error('the browser could not encode the image');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `novemberrain-${canvas.width}x${canvas.height}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast(`Saved a ${size} still`);
      document.body.dataset.snap = size;
    } catch (e) {
      say(`The still could not be rendered: ${(e as Error).message}`, 'bot err');
    } finally {
      renderer.fixedHeight = keep.fixed;
      renderer.scale = keep.scale;
      renderer.freeTargets();
      renderer.resize();
      busy = false;
    }
  };
  $('btn-snap').addEventListener('click', () => void snapshot());

  // ------------------------------------------------------------------ chat
  const exec = async (a: ChatAction): Promise<void> => {
    switch (a.t) {
      case 'set': {
        const def = engine.byKey.get(a.k);
        if (def) setParam(def.id, a.v);
        break;
      }
      case 'preset':
        loadDefault();
        break;
      case 'custom':
        loadCustom();
        break;
      case 'device':
        await device(a.d, a.on);
        break;
      case 'res':
        setResolution(a.v);
        break;
      case 'snap':
        await snapshot();
        break;
      case 'strike':
        engine.strike(true);
        break;
      case 'save':
        savePreset(a.name);
        break;
      case 'load': {
        const p = store.get(a.name);
        if (p) {
          applyPreset(p);
          say(`Loaded "${p.name}".`);
        } else {
          const names = store.list().map((x) => x.name);
          say(names.length ? `I have no preset called "${a.name}". Saved: ${names.join(', ')}.` : `I have no preset called "${a.name}" - nothing is saved yet.`, 'bot err');
        }
        break;
      }
      case 'delete':
        say(store.delete(a.name) ? `Deleted "${a.name}".` : `I have no preset called "${a.name}".`);
        renderSaved();
        break;
      case 'list': {
        const names = store.list().map((x) => x.name);
        say(names.length ? `Saved presets: ${names.join(', ')}.` : 'No custom presets saved yet. Say "save as <name>".');
        break;
      }
      case 'export':
        exportPreset(currentPreset($<HTMLInputElement>('save-name').value.trim() || 'Custom'));
        break;
      case 'import':
        $<HTMLInputElement>('file-preset').click();
        break;
      case 'fullscreen':
        fullscreen();
        break;
      case 'ui':
        setUi(a.on);
        break;
    }
  };

  const chat = async (text: string): Promise<void> => {
    text = text.trim();
    if (!text) return;
    say(text, 'user');
    const res = engine.chat(text);
    if (res.reply) say(res.reply, res.ok ? 'bot' : 'bot err');
    for (const a of res.actions) {
      try {
        await exec(a);
      } catch (e) {
        say(`That did not work: ${(e as Error).message}`, 'bot err');
      }
    }
  };
  const chatInput = $<HTMLInputElement>('chat-input');
  $<HTMLFormElement>('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = chatInput.value;
    chatInput.value = '';
    void chat(t);
  });
  {
    const chips = $('chips');
    for (const c of CHIPS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = c;
      b.addEventListener('click', () => void chat(c));
      chips.appendChild(b);
    }
  }

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
    if (e.key === 'Enter' || e.key === '/') {
      e.preventDefault();
      setUi(true);
      $('chat').hidden = false;
      $('btn-chat').classList.add('on');
      chatInput.focus();
      return;
    }
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
  const pointers = new Map<number, { x: number; y: number }>();
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
        pitch = clamp(pitch + dy * 0.004, CAM.pmin, CAM.pmax);
      }
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
    if (!pointers.size) {
      canvas.classList.remove('drag');
      if (xyOn) xyAt(e, false);
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    setParam(P('zoom'), val('zoom') - e.deltaY * 0.0006);
  }, { passive: false });

  // ------------------------------------------------------------------ start-up
  const start = async (withSound: boolean): Promise<void> => {
    const btn = $<HTMLButtonElement>('start');
    if (withSound) {
      btn.disabled = true;
      splashStatus.textContent = 'Starting the synthesizer…';
      try {
        await audio.start(engine.wasmBytes, [...engine.values()]);
      } catch (e) {
        console.error(e);
        say(`Sound could not start (${(e as Error).message}). The visuals still work.`, 'bot err');
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
  try {
    await renderer.prepare();
  } catch (e) {
    console.error(e);
    splashStatus.textContent = 'The world shader failed to compile on this GPU.';
    return;
  }
  splashStatus.textContent = '';
  say('Hi! A titan is crossing the dunes in a thunderstorm. Try "more lightning", "make it trippy", "effects in parallel", "key of G minor", "8k" - or type "help".');

  // ------------------------------------------------------------------ main loop
  let last = performance.now();
  let acc = 0;
  let frames = 0;
  let lastDown = 0;
  const frame = (now: number): void => {
    requestAnimationFrame(frame);
    const rawDt = (now - last) / 1000;
    last = now;
    if (busy) return;
    renderer.resize();
    draw(now, Math.min(rawDt, 0.1));

    // In Auto mode the internal resolution follows the frame rate.
    if (rawDt < 0.25) {
      acc += rawDt;
      frames++;
    }
    if (acc >= 0.6) {
      const fps = frames / acc;
      if (resMode === 'auto' && !fixedScale) {
        if (fps < 40 && renderer.scale > 0.3) {
          renderer.scale = Math.max(0.3, renderer.scale * 0.85);
          lastDown = now;
        } else if (fps > 56 && now - lastDown > 5000 && renderer.scale < 1) {
          renderer.scale = Math.min(1, renderer.scale * 1.07);
        }
      }
      stat.textContent = `${Math.round(fps)} fps · ${Math.round(canvas.width * renderer.scale)}×${Math.round(canvas.height * renderer.scale)}`;
      acc = 0;
      frames = 0;
    }
  };
  requestAnimationFrame(frame);
}

void boot();
