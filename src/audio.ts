// Web Audio side: hosts the Rust synthesizer in an AudioWorklet, analyses both the
// synth output and the microphone, and exposes smoothed band levels to the visuals.

import workletUrl from './synth.worklet.ts?worker&url';
import type { SynthMessage } from './synth.worklet';

export interface Bands {
  bass: number;
  mid: number;
  high: number;
  level: number;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private buf = new Uint8Array(1024);
  readonly bands: Bands = { bass: 0, mid: 0, high: 0, level: 0 };

  get running(): boolean {
    return !!this.node && this.ctx?.state === 'running';
  }

  get micOn(): boolean {
    return !!this.micStream;
  }

  private async context(): Promise<AudioContext> {
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: 'interactive' });
    if (this.ctx.state !== 'running') await this.ctx.resume();
    return this.ctx;
  }

  async start(wasm: ArrayBuffer, scene: number, params: number[]): Promise<void> {
    const ctx = await this.context();
    if (this.node) return;
    await ctx.audioWorklet.addModule(workletUrl);
    this.node = new AudioWorkletNode(ctx, 'novemberrain-synth', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { wasm, seed: (Math.random() * 0xffffffff) >>> 0, scene, params },
    });
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.6;
    this.node.connect(this.analyser);
    this.node.connect(ctx.destination);
  }

  post(m: SynthMessage): void {
    this.node?.port.postMessage(m);
  }

  async mic(on: boolean): Promise<void> {
    if (!on) {
      this.micStream?.getTracks().forEach((t) => t.stop());
      this.micSource?.disconnect();
      this.micStream = null;
      this.micSource = null;
      this.micAnalyser = null;
      return;
    }
    if (this.micStream) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const ctx = await this.context();
    this.micStream = stream;
    this.micSource = ctx.createMediaStreamSource(stream);
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 2048;
    this.micAnalyser.smoothingTimeConstant = 0.5;
    // Analysed only: the microphone is never routed to the speakers (no feedback loop).
    this.micSource.connect(this.micAnalyser);
  }

  private read(an: AnalyserNode, gain: number): [number, number, number] {
    an.getByteFrequencyData(this.buf);
    const hz = (this.ctx?.sampleRate ?? 48000) / an.fftSize;
    const avg = (lo: number, hi: number): number => {
      const a = Math.max(1, Math.floor(lo / hz));
      const b = Math.min(this.buf.length - 1, Math.ceil(hi / hz));
      let s = 0;
      for (let i = a; i <= b; i++) s += this.buf[i];
      return (s / (b - a + 1) / 255) * gain;
    };
    return [avg(25, 160), avg(160, 2000), avg(2000, 9000)];
  }

  /** Call once per frame. */
  update(): void {
    let b = 0;
    let m = 0;
    let h = 0;
    if (this.analyser) [b, m, h] = this.read(this.analyser, 1.0);
    if (this.micAnalyser) {
      const [mb, mm, mh] = this.read(this.micAnalyser, 1.6);
      b = Math.max(b, mb);
      m = Math.max(m, mm);
      h = Math.max(h, mh * 1.5);
    }
    const s = (cur: number, next: number): number => cur + (Math.min(next, 1) - cur) * (next > cur ? 0.6 : 0.15);
    this.bands.bass = s(this.bands.bass, b);
    this.bands.mid = s(this.bands.mid, m);
    this.bands.high = s(this.bands.high, h);
    this.bands.level = (this.bands.bass + this.bands.mid + this.bands.high) / 3;
  }
}
