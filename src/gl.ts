// Renderer. Runs on WebGL2 or WebGL1 with the same GLSL ES 1.00 shaders, uses only
// 8-bit render targets, and keeps every buffer at the (adaptive) internal resolution:
//
//   world (raymarch + coordinate FX)  ->  scene        internal res
//   colour FX, flame, bloom, trails   ->  feedback     internal res
//   sharpen-upscale + grade           ->  canvas       display res
//
// High-resolution stills are rendered tile by tile through the same three passes
// into small off-screen targets, so an 8K frame needs only a few megabytes of GPU memory.

import { VERT } from './shaders/common';
import { WORLD } from './shaders/world';
import { COMPOSITE, FINAL } from './shaders/post';

export type Uniforms = Record<string, number | number[] | Float32Array>;
type GL = WebGLRenderingContext | WebGL2RenderingContext;

interface Program {
  prog: WebGLProgram;
  loc: Map<string, WebGLUniformLocation | null>;
}

interface Pending {
  prog: WebGLProgram;
  vs: WebGLShader;
  fs: WebGLShader;
  resolve: (p: Program) => void;
  reject: (e: Error) => void;
}

interface Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

export interface Frame {
  world: Uniforms;
  fx: Uniforms;
  grade: Uniforms;
  cam: HTMLVideoElement | null;
  vid: HTMLVideoElement | null;
}

const ATTRS: WebGLContextAttributes = { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' };

export class Renderer {
  gl!: GL;
  api: 'WebGL2' | 'WebGL1' = 'WebGL1';
  /** Shader detail level actually in use: 2 full, 1 lite, 0 minimal. */
  tier = 2;
  /** Fraction of the canvas resolution used for the internal buffers. */
  scale = 0.5;
  maxSize = 2048;
  lost = false;
  private parallel: { COMPLETION_STATUS_KHR: number } | null = null;
  private pending: Pending[] = [];
  private world: Program | null = null;
  private composite: Program | null = null;
  private final: Program | null = null;
  private sceneT: Target | null = null;
  private fb: [Target | null, Target | null] = [null, null];
  private tiles: [Target | null, Target | null, Target | null] = [null, null, null];
  private flip = 0;
  private camTex!: WebGLTexture;
  private vidTex!: WebGLTexture;
  private flameTex!: WebGLTexture;

  constructor(readonly canvas: HTMLCanvasElement, private forceGL1 = false) {
    this.setup();
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.world = this.composite = this.final = null;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.setup();
      void this.init(this.tier).catch((err) => console.error(err));
    });
  }

  private setup(): void {
    const c = this.canvas;
    const gl2 = this.forceGL1 ? null : (c.getContext('webgl2', ATTRS) as WebGL2RenderingContext | null);
    const gl = gl2 ?? (c.getContext('webgl', ATTRS) as GL | null) ?? (c.getContext('experimental-webgl', ATTRS) as GL | null);
    if (!gl) throw new Error('this browser has no WebGL at all (hardware acceleration may be switched off)');
    this.gl = gl;
    this.api = gl2 ? 'WebGL2' : 'WebGL1';
    this.lost = false;
    if ((gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) as number) < 128) throw new Error('this GPU exposes too few shader uniforms');
    this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number);
    this.parallel = gl.getExtension('KHR_parallel_shader_compile');
    this.pending = [];
    this.sceneT = null;
    this.fb = [null, null];
    this.tiles = [null, null, null];
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    this.camTex = this.texture();
    this.vidTex = this.texture();
    this.flameTex = this.texture();
  }

  private texture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private build(frag: string): Promise<Program> {
    const gl = this.gl;
    const mk = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const vs = mk(gl.VERTEX_SHADER, VERT);
    const fs = mk(gl.FRAGMENT_SHADER, frag);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    return new Promise<Program>((resolve, reject) => {
      this.pending.push({ prog, vs, fs, resolve, reject });
      if (!this.parallel) this.poll();
    });
  }

  /** Finish any shader builds that are ready. Non-blocking when the driver compiles in parallel. */
  poll(): void {
    const gl = this.gl;
    if (!this.pending.length) return;
    this.pending = this.pending.filter((p) => {
      if (this.parallel && !gl.getProgramParameter(p.prog, this.parallel.COMPLETION_STATUS_KHR)) return true;
      if (gl.getProgramParameter(p.prog, gl.LINK_STATUS)) {
        p.resolve({ prog: p.prog, loc: new Map() });
      } else {
        const log = gl.getShaderInfoLog(p.fs) || gl.getShaderInfoLog(p.vs) || gl.getProgramInfoLog(p.prog) || 'unknown error';
        p.reject(new Error(`shader failed to compile: ${log}`));
      }
      gl.deleteShader(p.vs);
      gl.deleteShader(p.fs);
      return false;
    });
  }

  private async buildWorld(tier: number): Promise<void> {
    // Walk down the detail tiers until one compiles on this GPU.
    for (let t = tier; t >= 0; t--) {
      try {
        const p = await this.build(`#define TIER ${t}\n${WORLD}`);
        if (this.world) this.gl.deleteProgram(this.world.prog);
        this.world = p;
        this.tier = t;
        return;
      } catch (e) {
        console.warn(`world shader tier ${t} unavailable`, e);
        if (t === 0) throw e;
      }
    }
  }

  /** Compile everything. Resolves when the world can be drawn. */
  async init(tier: number): Promise<void> {
    [this.composite, this.final] = await Promise.all([this.build(COMPOSITE), this.build(FINAL)]);
    await this.buildWorld(tier);
  }

  /** Switch to another detail tier; the current one keeps drawing until the new one is ready. */
  async setTier(tier: number): Promise<void> {
    await this.buildWorld(Math.max(0, Math.min(2, tier)));
  }

  get ready(): boolean {
    return !this.lost && !!this.world && !!this.composite && !!this.final;
  }

  private u(p: Program, name: string): WebGLUniformLocation | null {
    let l = p.loc.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(p.prog, name);
      p.loc.set(name, l);
    }
    return l;
  }

  private apply(p: Program, u: Uniforms): void {
    const gl = this.gl;
    for (const name in u) {
      const v = u[name];
      const loc = this.u(p, name);
      if (!loc) continue;
      if (typeof v === 'number') gl.uniform1f(loc, v);
      else if (name === 'uD' || v.length === 4) gl.uniform4fv(loc, v);
      else if (v.length === 3) gl.uniform3fv(loc, v);
      else gl.uniform2fv(loc, v);
    }
  }

  private target(old: Target | null, w: number, h: number): Target {
    const gl = this.gl;
    if (old && old.w === w && old.h === h) return old;
    this.free(old);
    const tex = this.texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { fbo, tex, w, h };
  }

  private free(t: Target | null): void {
    if (!t) return;
    this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteTexture(t.tex);
  }

  /** Match the drawing buffer to the display, in real device pixels (so an 8K screen gets an 8K canvas). */
  resize(): boolean {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    let w = Math.max(2, Math.round(this.canvas.clientWidth * dpr));
    let h = Math.max(2, Math.round(this.canvas.clientHeight * dpr));
    const k = Math.min(1, this.maxSize / Math.max(w, h), Math.sqrt(33_200_000 / (w * h)));
    w = Math.round(w * k);
    h = Math.round(h * k);
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    return true;
  }

  /** Internal buffer size for the current canvas and scale. */
  get internal(): [number, number] {
    return [Math.max(2, Math.round(this.canvas.width * this.scale)), Math.max(2, Math.round(this.canvas.height * this.scale))];
  }

  private bind(unit: number, tex: WebGLTexture): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
  }

  private video(tex: WebGLTexture, v: HTMLVideoElement | null, unit: number): void {
    const gl = this.gl;
    this.bind(unit, tex);
    if (v && v.readyState >= 2 && v.videoWidth > 0) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
      } catch {
        /* frame not available yet */
      }
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }
  }

  /** Upload the fractal flame image produced by the Rust chaos game. */
  setFlame(pixels: Uint8Array, size: number): void {
    const gl = this.gl;
    if (this.lost) return;
    this.bind(4, this.flameTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  }

  private pass(p: Program, dst: Target | null, w: number, h: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fbo : null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(p.prog);
  }

  private compositeInputs(c: Program, scene: Target, low: Target, prev: Target, f: Frame): void {
    const gl = this.gl;
    this.bind(0, scene.tex);
    this.bind(1, low.tex);
    this.bind(2, prev.tex);
    this.video(this.camTex, f.cam, 3);
    this.bind(4, this.flameTex);
    this.video(this.vidTex, f.vid, 5);
    gl.uniform1i(this.u(c, 'uScene'), 0);
    gl.uniform1i(this.u(c, 'uLow'), 1);
    gl.uniform1i(this.u(c, 'uPrev'), 2);
    gl.uniform1i(this.u(c, 'uCam'), 3);
    gl.uniform1i(this.u(c, 'uFlame'), 4);
    gl.uniform1i(this.u(c, 'uVid'), 5);
    gl.uniform2f(this.u(c, 'uTexel'), 1 / scene.w, 1 / scene.h);
    this.apply(c, f.fx);
  }

  /** Draw one live frame to the canvas. */
  render(f: Frame): void {
    this.poll();
    if (!this.ready) return;
    const gl = this.gl;
    const world = this.world!;
    const c = this.composite!;
    const fin = this.final!;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const [sw, sh] = this.internal;
    this.sceneT = this.target(this.sceneT, sw, sh);
    this.fb[0] = this.target(this.fb[0], sw, sh);
    this.fb[1] = this.target(this.fb[1], sw, sh);

    this.pass(world, this.sceneT, sw, sh);
    gl.uniform2f(this.u(world, 'uRes'), sw, sh);
    gl.uniform2f(this.u(world, 'uOrigin'), 0, 0);
    this.apply(world, f.world);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const dst = this.fb[this.flip]!;
    this.pass(c, dst, sw, sh);
    this.compositeInputs(c, this.sceneT, this.sceneT, this.fb[1 - this.flip]!, f);
    gl.uniform4f(this.u(c, 'uTile'), 0, 0, 1, 1);
    gl.uniform1f(this.u(c, 'uAsp'), W / H);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.pass(fin, null, W, H);
    this.bind(0, dst.tex);
    gl.uniform1i(this.u(fin, 'uTex'), 0);
    gl.uniform2f(this.u(fin, 'uTexel'), 1 / sw, 1 / sh);
    gl.uniform4f(this.u(fin, 'uCrop'), 0, 0, 1, 1);
    gl.uniform4f(this.u(fin, 'uTile'), 0, 0, 1, 1);
    gl.uniform2f(this.u(fin, 'uOut'), W, H);
    // the more the image is stretched, the more sharpening it gets
    gl.uniform1f(this.u(fin, 'uSharp'), Math.min(0.9, 0.12 + (1 - this.scale) * 1.1));
    this.apply(fin, f.grade);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.flip = 1 - this.flip;
  }

  /**
   * Render one tile of a W x H still. (ox, oy) is the tile's bottom-left corner in
   * image pixels (GL orientation), `size` its edge, (w, h) the part actually needed.
   * Returns w*h RGBA pixels, bottom row first. Must follow a `render()` of the same frame.
   */
  tile(f: Frame, W: number, H: number, ox: number, oy: number, size: number, w: number, h: number, out: Uint8Array): void {
    const gl = this.gl;
    const world = this.world!;
    const c = this.composite!;
    const fin = this.final!;
    const M = 8; // overlap so edge detection and filtering never see a tile border
    const S = size + 2 * M;
    this.tiles[0] = this.target(this.tiles[0], S, S);
    this.tiles[1] = this.target(this.tiles[1], S, S);
    this.tiles[2] = this.target(this.tiles[2], size, size);
    const [a, b, d] = this.tiles as [Target, Target, Target];
    const live = this.fb[1 - this.flip]!; // the frame currently on screen

    this.pass(world, a, S, S);
    gl.uniform2f(this.u(world, 'uRes'), W, H);
    gl.uniform2f(this.u(world, 'uOrigin'), ox - M, oy - M);
    this.apply(world, f.world);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.pass(c, b, S, S);
    this.compositeInputs(c, a, this.sceneT!, live, f);
    gl.uniform4f(this.u(c, 'uTile'), (ox - M) / W, (oy - M) / H, S / W, S / H);
    gl.uniform1f(this.u(c, 'uAsp'), W / H);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.pass(fin, d, size, size);
    this.bind(0, b.tex);
    gl.uniform1i(this.u(fin, 'uTex'), 0);
    gl.uniform2f(this.u(fin, 'uTexel'), 1 / S, 1 / S);
    gl.uniform4f(this.u(fin, 'uCrop'), M / S, M / S, size / S, size / S);
    gl.uniform4f(this.u(fin, 'uTile'), ox / W, oy / H, size / W, size / H);
    gl.uniform2f(this.u(fin, 'uOut'), W, H);
    gl.uniform1f(this.u(fin, 'uSharp'), 0);
    this.apply(fin, f.grade);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
  }

  /** Release the tile targets after a still. */
  freeTiles(): void {
    for (const t of this.tiles) this.free(t);
    this.tiles = [null, null, null];
  }
}
