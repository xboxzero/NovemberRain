// AudioWorklet processor: instantiates its own copy of the Rust engine and renders
// the synthesizer on the audio thread.

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

interface SynthExports {
  memory: WebAssembly.Memory;
  init(seed: number, sampleRate: number): void;
  set_param(id: number, v: number): void;
  note_on(note: number, vel: number): void;
  note_off(note: number): void;
  xy(x: number, y: number, down: number): void;
  trigger(kind: number, a: number, b: number): void;
  render(frames: number): number;
  render_right_ptr(): number;
}

export type SynthMessage =
  | { t: 'p'; id: number; v: number }
  | { t: 'on'; n: number; v: number }
  | { t: 'off'; n: number }
  | { t: 'xy'; x: number; y: number; d: boolean }
  | { t: 'ev'; k: number; a: number; b: number };

class NovemberRainSynth extends AudioWorkletProcessor {
  private x: SynthExports;

  constructor(options: { processorOptions: { wasm: ArrayBuffer; seed: number; params: number[] } }) {
    super();
    const o = options.processorOptions;
    const instance = new WebAssembly.Instance(new WebAssembly.Module(o.wasm), {});
    this.x = instance.exports as unknown as SynthExports;
    this.x.init(o.seed, sampleRate);
    o.params.forEach((v, i) => this.x.set_param(i, v));
    this.port.onmessage = (e: MessageEvent<SynthMessage>) => {
      const m = e.data;
      switch (m.t) {
        case 'p':
          this.x.set_param(m.id, m.v);
          break;
        case 'on':
          this.x.note_on(m.n, m.v);
          break;
        case 'off':
          this.x.note_off(m.n);
          break;
        case 'xy':
          this.x.xy(m.x, m.y, m.d ? 1 : 0);
          break;
        case 'ev':
          this.x.trigger(m.k, m.a, m.b);
          break;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const n = out[0].length;
    const left = this.x.render(n) >> 2;
    const right = this.x.render_right_ptr() >> 2;
    const mem = new Float32Array(this.x.memory.buffer);
    out[0].set(mem.subarray(left, left + n));
    if (out[1]) out[1].set(mem.subarray(right, right + n));
    return true;
  }
}

registerProcessor('novemberrain-synth', NovemberRainSynth);
