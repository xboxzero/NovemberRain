import './style.css';
import { Engine, type ChatAction } from './engine';
import { Renderer } from './gl';
import { AudioEngine } from './audio';
import { Media } from './media';
import { YouTubeLayer, parseYouTubeId } from './youtube';
import { PresetStore, exportPreset, importPreset, type Preset } from './presets';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const clamp = (v: number, a = 0, b = 1): number => Math.min(b, Math.max(a, v));

/** Per-world camera defaults and chat suggestions. */
const WORLDS = [
  { short: 'Dune Storm', yaw: 0.3, pitch: 0.12, pmin: 0.03, pmax: 1.2, sway: false, chips: ['more lightning', 'sandstorm', 'calm it down', 'turn it purple', 'make it trippy'] },
  { short: 'Abyss', yaw: 0.0, pitch: 0.08, pmin: -0.15, pmax: 1.0, sway: false, chips: ['more creatures', 'brighter glow', 'slower and dreamy', 'less fog', 'turn it green'] },
  { short: 'Dragon Isle', yaw: 0.6, pitch: 0.1, pmin: 0.02, pmax: 1.1, sway: false, chips: ['more lava', 'two dragons', 'zoom in', 'make it epic', 'faster'] },
  { short: 'Titan', yaw: 0.22, pitch: -0.2, pmin: -0.24, pmax: 0.9, sway: true, chips: ['taller buildings', 'more rage', 'foggy and dark', 'zoom out', 'heavy footsteps'] },
];
const GLOBAL_CHIPS = ['camera on', 'mic on', 'randomize', 'help'];
const NOTE_KEYS: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14,
};

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

  const audio = new AudioEngine();
  const media = new Media();
  const yt = new YouTubeLayer($('yt'));
  const store = new PresetStore();
  const P = (key: string): number => engine.id(key);
  const val = (key: string): number => engine.getParam(P(key));

  let scene = -1;
  let activePreset = 0;
  let switchToken = 0;
  let blend = 'screen';
  let yaw = 0;
  let pitch = 0;
  let orbitPhase = 0;
  let xyOn = false;
  let octave = 0;

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
  const sliders = new Map<number, { input: HTMLInputElement; out: HTMLOutputElement }>();
  const applyYouTube = (): void => {
    const mix = val('ytmix');
    $('yt').style.opacity = yt.active ? String(mix) : '0';
    canvas.style.mixBlendMode = yt.active ? blend : 'normal';
    canvas.style.opacity = yt.active && blend === 'normal' ? String(1 - mix * 0.7) : '1';
  };
  const setParam = (id: number, v: number, fromSlider = false): void => {
    v = clamp(v);
    engine.setParam(id, v);
    audio.post({ t: 'p', id, v });
    const s = sliders.get(id);
    if (s) {
      if (!fromSlider) s.input.value = String(v);
      s.out.textContent = String(Math.round(v * 100));
    }
    if (id === P('ytmix')) applyYouTube();
  };
  const setAll = (values: ArrayLike<number>): void => {
    for (let i = 0; i < engine.params.length; i++) setParam(i, values[i]);
  };

  {
    const host = $('sliders');
    const groups = new Map<string, HTMLDetailsElement>();
    for (const p of engine.params) {
      let g = groups.get(p.group);
      if (!g) {
        g = document.createElement('details');
        g.open = p.group === 'Motion' || p.group === 'Look';
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
      const input = document.createElement('input');
      input.type = 'range';
      input.id = `p-${p.key}`;
      input.min = '0';
      input.max = '1';
      input.step = '0.005';
      const out = document.createElement('output');
      input.addEventListener('input', () => setParam(p.id, Number(input.value), true));
      row.append(label, input, out);
      g.appendChild(row);
      sliders.set(p.id, { input, out });
    }
  }

  // ------------------------------------------------------------------ worlds and presets
  const presetBar = $('presets');
  const presetButtons: HTMLButtonElement[] = [];
  const baseScene = $<HTMLSelectElement>('base-scene');
  const markPreset = (): void => presetButtons.forEach((b, i) => b.classList.toggle('on', i === activePreset));
  const chips = $('chips');
  const renderChips = (): void => {
    chips.replaceChildren();
    for (const c of [...WORLDS[Math.max(scene, 0)].chips, ...GLOBAL_CHIPS]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = c;
      b.addEventListener('click', () => void chat(c));
      chips.appendChild(b);
    }
  };

  const switchScene = async (i: number, values?: ArrayLike<number>): Promise<void> => {
    const token = ++switchToken;
    if (!renderer.ready(i)) toast(`Building world ${i + 1}…`, 20000);
    try {
      await renderer.prepare(i);
    } catch (e) {
      console.error(e);
      toast('This world failed to compile on your GPU');
      return;
    }
    if (token !== switchToken) return;
    if (toastEl.textContent?.startsWith('Building')) toastEl.classList.remove('show');
    const changed = scene !== i;
    scene = i;
    engine.setScene(i);
    audio.post({ t: 'scene', i });
    setAll(values ?? engine.sceneDefaults(i));
    if (changed) {
      yaw = WORLDS[i].yaw;
      pitch = WORLDS[i].pitch;
      orbitPhase = 0;
    }
    baseScene.value = String(i);
    renderChips();
  };

  const currentPreset = (name: string): Preset => {
    const params: Record<string, number> = {};
    const v = engine.values();
    for (const p of engine.params) params[p.key] = Math.round(v[p.id] * 1000) / 1000;
    return { app: 'novemberrain', v: 1, name, scene, params, blend, youtube: yt.videoId };
  };

  const setBlend = (mode: string): void => {
    blend = mode;
    $<HTMLSelectElement>('blend').value = mode;
    applyYouTube();
  };

  const loadYouTube = async (input: string): Promise<void> => {
    const id = parseYouTubeId(input);
    if (!id) throw new Error('That does not look like a YouTube link');
    await yt.load(id);
    applyYouTube();
  };

  const applyPreset = async (p: Preset): Promise<void> => {
    const values = engine.sceneDefaults(p.scene);
    for (const [k, v] of Object.entries(p.params)) {
      const def = engine.byKey.get(k);
      if (def) values[def.id] = v;
    }
    await switchScene(p.scene, values);
    setBlend(p.blend);
    activePreset = 4;
    markPreset();
    store.last = p.name;
    $<HTMLInputElement>('save-name').value = p.name;
    if (p.youtube && p.youtube !== yt.videoId) loadYouTube(p.youtube).catch(() => toast('Could not load the YouTube video of this preset'));
  };

  const savedList = $('saved');
  const renderSaved = (): void => {
    savedList.replaceChildren();
    const all = store.list();
    if (!all.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nothing saved yet. Shape a world, name it, press Save.';
      savedList.appendChild(li);
    }
    for (const p of all) {
      const li = document.createElement('li');
      const load = document.createElement('button');
      load.type = 'button';
      load.textContent = `${p.name} · ${WORLDS[p.scene].short}`;
      load.addEventListener('click', () => void applyPreset(p));
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
    activePreset = 4;
    markPreset();
    renderSaved();
    return n;
  };

  const loadBuiltin = async (i: number): Promise<void> => {
    activePreset = i;
    markPreset();
    await switchScene(i);
  };

  const loadCustom = async (): Promise<void> => {
    const last = store.last ? store.get(store.last) : store.list()[0];
    $('panel').hidden = false;
    $('btn-panel').classList.add('on');
    if (last) {
      await applyPreset(last);
      toast(`Custom preset: ${last.name}`);
    } else {
      activePreset = 4;
      markPreset();
      toast('Preset 5 is yours: shape this world, then press Save (or import a file)');
    }
  };

  engine.scenes.forEach((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = s.name;
    b.innerHTML = `<i>${i + 1}</i>`;
    b.append(WORLDS[i].short);
    b.addEventListener('click', () => void loadBuiltin(i));
    presetBar.appendChild(b);
    presetButtons.push(b);
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = WORLDS[i].short;
    baseScene.appendChild(o);
  });
  {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = 'Your own saved preset';
    b.innerHTML = '<i>5</i>';
    b.append('Custom');
    b.addEventListener('click', () => void loadCustom());
    presetBar.appendChild(b);
    presetButtons.push(b);
  }
  baseScene.addEventListener('change', () => {
    activePreset = 4;
    markPreset();
    void switchScene(Number(baseScene.value));
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
  $<HTMLFormElement>('yt-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('yt-url');
    loadYouTube(input.value)
      .then(() => toast('YouTube layer on. Try the blend modes and the YouTube mix slider.'))
      .catch((err: Error) => toast(err.message));
  });
  $('yt-off').addEventListener('click', () => {
    yt.off();
    applyYouTube();
  });
  $<HTMLSelectElement>('blend').addEventListener('change', (e) => setBlend((e.target as HTMLSelectElement).value));

  // ------------------------------------------------------------------ preset panel
  $<HTMLFormElement>('save-form').addEventListener('submit', (e) => {
    e.preventDefault();
    toast(`Saved "${savePreset($<HTMLInputElement>('save-name').value)}"`);
  });
  $('btn-export').addEventListener('click', () => exportPreset(currentPreset($<HTMLInputElement>('save-name').value.trim() || 'Custom')));
  $('btn-import').addEventListener('click', () => $<HTMLInputElement>('file-preset').click());
  $('btn-reset').addEventListener('click', () => void switchScene(scene));
  $<HTMLInputElement>('file-preset').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = '';
    if (!f) return;
    importPreset(f)
      .then(async (p) => {
        store.save(p);
        renderSaved();
        await applyPreset(p);
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

  // ------------------------------------------------------------------ chat
  const exec = async (a: ChatAction): Promise<void> => {
    switch (a.t) {
      case 'set': {
        const def = engine.byKey.get(a.k);
        if (def) setParam(def.id, a.v);
        break;
      }
      case 'scene':
        await loadBuiltin(a.i);
        break;
      case 'custom':
        await loadCustom();
        break;
      case 'device':
        await device(a.d, a.on);
        break;
      case 'youtube':
        await loadYouTube(a.url).catch((e: Error) => say(e.message, 'bot err'));
        break;
      case 'yt':
        if (a.cmd === 'off') {
          yt.off();
          applyYouTube();
        } else yt.command(a.cmd);
        break;
      case 'ytvol':
        yt.volume(a.v);
        break;
      case 'blend':
        setBlend(a.mode);
        break;
      case 'save':
        savePreset(a.name);
        break;
      case 'load': {
        const p = store.get(a.name);
        if (p) {
          await applyPreset(p);
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
      case 'random':
      case 'reset':
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
    if (e.key >= '1' && e.key <= '4') return void loadBuiltin(Number(e.key) - 1);
    if (e.key === '5') return void loadCustom();
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
        pitch = clamp(pitch + dy * 0.004, WORLDS[scene]?.pmin ?? 0, WORLDS[scene]?.pmax ?? 1);
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
        await audio.start(engine.wasmBytes, Math.max(scene, 0), [...engine.values()]);
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
  splashStatus.textContent = 'Building the first world…';
  await loadBuiltin(0);
  splashStatus.textContent = '';
  say('Hi! Tell me what you want to see and hear. Try "more lightning", "take me underwater", "make it trippy", "camera on", or paste a YouTube link. Type "help" for more.');
  // Warm the other worlds in the background so switching is instant.
  void (async () => {
    for (let i = 1; i < WORLDS.length; i++) await renderer.prepare(i).catch((e) => console.error(e));
  })();

  // ------------------------------------------------------------------ main loop
  const stat = $('stat');
  let last = performance.now();
  let acc = 0;
  let frames = 0;
  let lastDown = 0;
  const data = new Float32Array(320);
  // ?scale=0.5 pins the render resolution (useful for recording or debugging).
  const fixedScale = Number(new URLSearchParams(location.search).get('scale')) || 0;
  if (fixedScale) renderer.scale = clamp(fixedScale, 0.1, 1);

  const frame = (now: number): void => {
    requestAnimationFrame(frame);
    const rawDt = (now - last) / 1000;
    last = now;
    const dt = Math.min(rawDt, 0.1);
    if (scene < 0) return;
    renderer.resize();

    audio.update();
    const react = val('react') * 1.6;
    const bass = clamp(audio.bands.bass * react);
    const mid = clamp(audio.bands.mid * react);
    const high = clamp(audio.bands.high * react);
    engine.step(dt, bass, mid, high);
    const ev = engine.events();
    for (let i = 0; i < ev.length; i += 4) audio.post({ t: 'ev', k: ev[i], a: ev[i + 1], b: ev[i + 2] });
    data.set(engine.data());

    // Orbit camera around the target the simulation reports.
    const world = WORLDS[scene];
    if (!pointers.size || xyOn) orbitPhase += dt * val('orbit') * (world.sway ? 0.5 : 0.35);
    const y = yaw + (world.sway ? Math.sin(orbitPhase) * 0.75 : orbitPhase);
    const dist = data[319] * (1.9 - 1.45 * val('zoom'));
    const tgt: [number, number, number] = [data[316], data[317], data[318]];
    const pos: [number, number, number] = [
      tgt[0] + dist * Math.cos(pitch) * Math.sin(y),
      tgt[1] + dist * Math.sin(pitch),
      tgt[2] + dist * Math.cos(pitch) * Math.cos(y),
    ];
    if (scene === 3) {
      const shake = data[72] * 0.6;
      pos[0] += Math.sin(now * 0.05) * shake;
      pos[1] += Math.cos(now * 0.043) * shake;
    }

    renderer.render({
      scene,
      time: now / 1000,
      camPos: pos,
      camTgt: tgt,
      data,
      p: [val('intensity'), val('density'), val('fog'), val('warp')],
      audio: [bass, mid, high, (bass + mid + high) / 3],
      w: data[313],
      feedback: val('feedback'),
      bloom: val('bloom'),
      kaleido: val('kaleido'),
      glitch: val('glitch'),
      camMix: media.camOn ? val('cammix') : 0,
      vidMix: media.vidKind ? val('vidmix') : 0,
      hue: val('hue'),
      sat: val('saturation'),
      bright: val('brightness'),
      contrast: val('contrast'),
      cam: media.camOn ? media.cam : null,
      vid: media.vidKind ? media.vid : null,
    });

    // Adaptive resolution keeps the raymarcher interactive on phones and laptops.
    if (rawDt < 0.25) {
      acc += rawDt;
      frames++;
    }
    if (acc >= 0.6) {
      const fps = frames / acc;
      if (fixedScale) {
        /* resolution pinned by the URL */
      } else if (fps < 40 && renderer.scale > 0.3) {
        renderer.scale = Math.max(0.3, renderer.scale * 0.85);
        lastDown = now;
      } else if (fps > 56 && now - lastDown > 5000 && renderer.scale < 1) {
        renderer.scale = Math.min(1, renderer.scale * 1.07);
      }
      stat.textContent = `${Math.round(fps)} fps · ${Math.round(canvas.width * renderer.scale)}×${Math.round(canvas.height * renderer.scale)}`;
      acc = 0;
      frames = 0;
    }
  };
  requestAnimationFrame(frame);
}

void boot();
