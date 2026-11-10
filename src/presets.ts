// Custom presets: saved in localStorage, exported / imported as JSON files.

export interface Preset {
  app: 'novemberrain';
  v: 1;
  name: string;
  scene: number;
  params: Record<string, number>;
  blend: string;
  youtube: string | null;
}

const KEY = 'novemberrain.presets.v1';
const LAST = 'novemberrain.last';

export class PresetStore {
  private map = new Map<string, Preset>();

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) for (const p of JSON.parse(raw) as unknown[]) {
        const v = validate(p);
        if (v) this.map.set(v.name.toLowerCase(), v);
      }
    } catch {
      /* storage unavailable or corrupt: start empty */
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify([...this.map.values()]));
    } catch {
      /* private mode: presets live for this session only */
    }
  }

  list(): Preset[] {
    return [...this.map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Preset | undefined {
    const k = name.trim().toLowerCase();
    return this.map.get(k) ?? this.list().find((p) => p.name.toLowerCase().includes(k));
  }

  save(p: Preset): void {
    this.map.set(p.name.toLowerCase(), p);
    this.last = p.name;
    this.persist();
  }

  delete(name: string): boolean {
    const p = this.get(name);
    if (!p) return false;
    this.map.delete(p.name.toLowerCase());
    this.persist();
    return true;
  }

  get last(): string | null {
    try {
      return localStorage.getItem(LAST);
    } catch {
      return null;
    }
  }

  set last(name: string | null) {
    try {
      if (name) localStorage.setItem(LAST, name);
    } catch {
      /* ignore */
    }
  }
}

/** Accept only well-formed preset objects; numbers are clamped to 0..1. */
export function validate(x: unknown): Preset | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o.scene !== 'number' || !o.params || typeof o.params !== 'object') return null;
  const params: Record<string, number> = {};
  for (const [k, v] of Object.entries(o.params as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v) && /^[a-z0-9]{1,24}$/.test(k)) params[k] = Math.min(1, Math.max(0, v));
  }
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 60) : 'Custom';
  return {
    app: 'novemberrain',
    v: 1,
    name,
    scene: Math.min(3, Math.max(0, Math.round(o.scene))),
    params,
    blend: typeof o.blend === 'string' && /^[a-z-]{1,20}$/.test(o.blend) ? o.blend : 'screen',
    youtube: typeof o.youtube === 'string' && /^[\w-]{11}$/.test(o.youtube) ? o.youtube : null,
  };
}

export function exportPreset(p: Preset): void {
  const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${p.name.replace(/[^\w-]+/g, '_') || 'preset'}.novemberrain.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export async function importPreset(file: File): Promise<Preset> {
  if (file.size > 200_000) throw new Error('That file is too large to be a preset');
  const p = validate(JSON.parse(await file.text()));
  if (!p) throw new Error('That file is not a NovemberRain preset');
  return p;
}
