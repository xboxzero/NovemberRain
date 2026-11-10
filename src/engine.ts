// Thin typed wrapper around the Rust engine (plain C-ABI wasm, no generated glue).

export interface ParamDef {
  id: number;
  key: string;
  label: string;
  group: string;
  default: number;
  /** Non-empty for selector parameters: value = index / (options.length - 1). */
  options: string[];
}

export type ChatAction =
  | { t: 'set'; k: string; v: number }
  | { t: 'preset' }
  | { t: 'custom' }
  | { t: 'device'; d: 'camera' | 'mic' | 'screen' | 'file' | 'xy'; on: boolean }
  | { t: 'res'; v: string }
  | { t: 'snap' }
  | { t: 'strike' }
  | { t: 'save'; name: string }
  | { t: 'load'; name: string }
  | { t: 'delete'; name: string }
  | { t: 'export' }
  | { t: 'import' }
  | { t: 'list' }
  | { t: 'fullscreen' }
  | { t: 'ui'; on: boolean };

export interface ChatResult {
  ok: boolean;
  reply: string;
  actions: ChatAction[];
}

interface Exports {
  memory: WebAssembly.Memory;
  init(seed: number, sampleRate: number): void;
  alloc(len: number): number;
  free(ptr: number, len: number): void;
  describe_ptr(): number;
  describe_len(): number;
  set_param(id: number, v: number): void;
  get_param(id: number): number;
  params_ptr(): number;
  defaults_ptr(): number;
  strike(toTitan: number): void;
  step(dt: number, bass: number, mid: number, high: number): void;
  data_ptr(): number;
  data_len(): number;
  events_ptr(): number;
  events_len(): number;
  chat(ptr: number, len: number): number;
  text_len(): number;
}

export class Engine {
  readonly params: ParamDef[];
  readonly world: string;
  readonly byKey = new Map<string, ParamDef>();
  private enc = new TextEncoder();
  private dec = new TextDecoder();

  private constructor(private x: Exports, readonly wasmBytes: ArrayBuffer) {
    const d = JSON.parse(this.str(x.describe_ptr(), x.describe_len())) as { params: ParamDef[]; world: string };
    this.params = d.params;
    this.world = d.world;
    for (const p of d.params) this.byKey.set(p.key, p);
  }

  static async load(url: string): Promise<Engine> {
    const bytes = await (await fetch(url)).arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const x = instance.exports as unknown as Exports;
    x.init((Math.random() * 0xffffffff) >>> 0, 48000);
    return new Engine(x, bytes);
  }

  private str(ptr: number, len: number): string {
    return this.dec.decode(new Uint8Array(this.x.memory.buffer, ptr, len));
  }

  id(key: string): number {
    const p = this.byKey.get(key);
    if (!p) throw new Error(`unknown parameter ${key}`);
    return p.id;
  }

  setParam(id: number, v: number): void {
    this.x.set_param(id, v);
  }

  getParam(id: number): number {
    return this.x.get_param(id);
  }

  /** Live view of all parameter values (do not keep across calls that may grow memory). */
  values(): Float32Array {
    return new Float32Array(this.x.memory.buffer, this.x.params_ptr(), this.params.length);
  }

  /** Parameter values of preset 1. */
  defaults(): Float32Array {
    return new Float32Array(this.x.memory.buffer, this.x.defaults_ptr(), this.params.length).slice();
  }

  /** Throw a lightning bolt now. */
  strike(toTitan: boolean): void {
    this.x.strike(toTitan ? 1 : 0);
  }

  step(dt: number, bass: number, mid: number, high: number): void {
    this.x.step(dt, bass, mid, high);
  }

  /** World state for the shader: 130 vec4. */
  data(): Float32Array {
    return new Float32Array(this.x.memory.buffer, this.x.data_ptr(), this.x.data_len());
  }

  /** Events raised by the last step: [kind, a, b, c] each. */
  events(): Float32Array {
    return new Float32Array(this.x.memory.buffer, this.x.events_ptr(), this.x.events_len() * 4);
  }

  chat(text: string): ChatResult {
    const bytes = this.enc.encode(text.slice(0, 2000));
    const ptr = this.x.alloc(bytes.length);
    new Uint8Array(this.x.memory.buffer, ptr, bytes.length).set(bytes);
    const out = this.x.chat(ptr, bytes.length);
    const json = this.str(out, this.x.text_len());
    this.x.free(ptr, bytes.length);
    try {
      return JSON.parse(json) as ChatResult;
    } catch {
      return { ok: false, reply: 'Sorry, I could not parse that.', actions: [] };
    }
  }
}
