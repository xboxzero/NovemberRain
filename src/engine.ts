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

export interface EvoInfo {
  generation: number;
  fitness: number;
  progress: number;
  poolFitness: number;
  loved: number;
  born: boolean;
}

interface Exports {
  memory: WebAssembly.Memory;
  init(seed: number, sampleRate: number): void;
  describe_ptr(): number;
  describe_len(): number;
  set_param(id: number, v: number): void;
  get_param(id: number): number;
  params_ptr(): number;
  defaults_ptr(): number;
  evolve(dt: number, kick: number): number;
  genome_len(): number;
  info_ptr(): number;
  love(): void;
  skip(): void;
  reseed(): void;
  io_ptr(): number;
  adopt(): void;
}

export class Engine {
  readonly params: ParamDef[];
  readonly byKey = new Map<string, ParamDef>();
  readonly genomeLength: number;

  private constructor(private x: Exports, readonly wasmBytes: ArrayBuffer) {
    const json = new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.describe_ptr(), x.describe_len()));
    this.params = (JSON.parse(json) as { params: ParamDef[] }).params;
    for (const p of this.params) this.byKey.set(p.key, p);
    this.genomeLength = x.genome_len();
  }

  static async load(url: string): Promise<Engine> {
    const bytes = await (await fetch(url)).arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const x = instance.exports as unknown as Exports;
    x.init((Math.random() * 0xffffffff) >>> 0, 48000);
    return new Engine(x, bytes);
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

  /** Copy of all parameter values. */
  values(): Float32Array {
    return new Float32Array(this.x.memory.buffer, this.x.params_ptr(), this.params.length).slice();
  }

  defaults(): Float32Array {
    return new Float32Array(this.x.memory.buffer, this.x.defaults_ptr(), this.params.length).slice();
  }

  /**
   * Advance evolution by `dt` seconds and return the genome currently on screen
   * (a view into wasm memory: read it before the next call). `kick` is a one-off
   * mutation impulse in 0..1.
   */
  evolve(dt: number, kick: number): Float32Array {
    const ptr = this.x.evolve(dt, kick);
    return new Float32Array(this.x.memory.buffer, ptr, this.genomeLength);
  }

  info(): EvoInfo {
    const v = new Float32Array(this.x.memory.buffer, this.x.info_ptr(), 6);
    return { generation: v[0], fitness: v[1], progress: v[2], poolFitness: v[3], loved: v[4], born: v[5] > 0.5 };
  }

  love(): void {
    this.x.love();
  }

  skip(): void {
    this.x.skip();
  }

  reseed(): void {
    this.x.reseed();
  }

  /** Load a saved genome: it joins the gene pool as a loved member and the picture morphs to it. */
  adopt(genome: ArrayLike<number>): void {
    if (genome.length !== this.genomeLength) return;
    new Float32Array(this.x.memory.buffer, this.x.io_ptr(), this.genomeLength).set(genome);
    this.x.adopt();
  }
}
