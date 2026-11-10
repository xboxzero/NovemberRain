// WebGL2 renderer: raymarched scene -> HDR target -> composite (trails, bloom, inputs) -> grade.

import { VERT } from './shaders/common';
import { WORLD } from './shaders/world';
import { COMPOSITE, FINAL } from './shaders/post';

export type Uniforms = Record<string, number | number[] | Float32Array>;

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
  /** Uniforms of the world shader. */
  world: Uniforms;
  /** Uniforms of the FX chain. */
  fx: Uniforms;
  /** Uniforms of the final grade. */
  grade: Uniforms;
  cam: HTMLVideoElement | null;
  vid: HTMLVideoElement | null;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  /** Fraction of the canvas resolution used for the raymarched scene. */
  scale = 0.6;
  private hdr: boolean;
  private parallel: { COMPLETION_STATUS_KHR: number } | null;
  private pending: Pending[] = [];
  private world: Program | null = null;
  private loading: Promise<Program> | null = null;
  /** Fixed output height in pixels (0 = follow the window). */
  fixedHeight = 0;
  readonly maxSize: number;
  private composite!: Program;
  private final!: Program;
  private sceneT: Target | null = null;
  private fb: [Target | null, Target | null] = [null, null];
  private flip = 0;
  private camTex: WebGLTexture;
  private vidTex: WebGLTexture;
  private vao: WebGLVertexArrayObject;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.hdr = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    this.parallel = gl.getExtension('KHR_parallel_shader_compile');
    this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.camTex = this.videoTexture();
    this.vidTex = this.videoTexture();
  }

  /** Compile the post-processing programs (small, done synchronously at start-up). */
  async init(): Promise<void> {
    [this.composite, this.final] = await Promise.all([this.build(COMPOSITE), this.build(FINAL)]);
  }

  private videoTexture(): WebGLTexture {
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
    gl.linkProgram(prog);
    return new Promise<Program>((resolve, reject) => {
      this.pending.push({ prog, vs, fs, resolve, reject });
      if (!this.parallel) this.poll();
    });
  }

  /** Finish any shader builds that are ready. Non-blocking when the driver compiles in parallel. */
  poll(): void {
    const gl = this.gl;
    this.pending = this.pending.filter((p) => {
      if (this.parallel && !gl.getProgramParameter(p.prog, this.parallel.COMPLETION_STATUS_KHR)) return true;
      if (gl.getProgramParameter(p.prog, gl.LINK_STATUS)) {
        p.resolve({ prog: p.prog, loc: new Map() });
      } else {
        const log = gl.getShaderInfoLog(p.fs) || gl.getShaderInfoLog(p.vs) || gl.getProgramInfoLog(p.prog) || 'unknown error';
        p.reject(new Error(`Shader failed to compile: ${log}`));
      }
      gl.deleteShader(p.vs);
      gl.deleteShader(p.fs);
      return false;
    });
  }

  /** Compile the world shader. Resolves when it can be drawn. */
  prepare(): Promise<void> {
    if (!this.loading) {
      this.loading = this.build(WORLD).then((p) => (this.world = p));
      this.loading.catch(() => (this.loading = null));
    }
    return this.loading.then(() => undefined);
  }

  get ready(): boolean {
    return !!this.world;
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

  private u(p: Program, name: string): WebGLUniformLocation | null {
    let l = p.loc.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(p.prog, name);
      p.loc.set(name, l);
    }
    return l;
  }

  private target(old: Target | null, w: number, h: number, mips: boolean): Target {
    const gl = this.gl;
    if (old && old.w === w && old.h === h) return old;
    if (old) {
      gl.deleteFramebuffer(old.fbo);
      gl.deleteTexture(old.tex);
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { fbo, tex, w, h };
  }

  /**
   * Size the drawing buffer. Normally it follows the window (capped at `maxDpr`);
   * with `fixedHeight` set it renders at that many lines regardless of the window,
   * e.g. 4320 for 8K. Returns true when the size changed.
   */
  resize(maxDpr = 2): boolean {
    const cw = Math.max(1, this.canvas.clientWidth);
    const ch = Math.max(1, this.canvas.clientHeight);
    let w: number;
    let h: number;
    if (this.fixedHeight > 0) {
      h = this.fixedHeight;
      w = Math.round((h * cw) / ch);
      const k = Math.min(1, this.maxSize / Math.max(w, h));
      w = Math.round(w * k);
      h = Math.round(h * k);
    } else {
      const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
      w = Math.round(cw * dpr);
      h = Math.round(ch * dpr);
    }
    w = Math.max(2, w);
    h = Math.max(2, h);
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    return true;
  }

  /** Release the off-screen targets (after a one-off high-resolution render). */
  freeTargets(): void {
    const gl = this.gl;
    for (const t of [this.sceneT, this.fb[0], this.fb[1]]) {
      if (t) {
        gl.deleteFramebuffer(t.fbo);
        gl.deleteTexture(t.tex);
      }
    }
    this.sceneT = null;
    this.fb = [null, null];
  }

  private upload(tex: WebGLTexture, v: HTMLVideoElement | null, unit: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
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

  render(f: Frame): void {
    const gl = this.gl;
    this.poll();
    const world = this.world;
    if (!world || !this.composite || !this.final) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const sw = Math.max(2, Math.round(W * this.scale));
    const sh = Math.max(2, Math.round(H * this.scale));
    this.sceneT = this.target(this.sceneT, sw, sh, true);
    this.fb[0] = this.target(this.fb[0], W, H, false);
    this.fb[1] = this.target(this.fb[1], W, H, false);
    gl.bindVertexArray(this.vao);

    // 1. raymarched world
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneT.fbo);
    gl.viewport(0, 0, sw, sh);
    gl.useProgram(world.prog);
    gl.uniform2f(this.u(world, 'uRes'), sw, sh);
    this.apply(world, f.world);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneT.tex);
    gl.generateMipmap(gl.TEXTURE_2D);

    // 2. FX chain into the feedback buffer
    const dst = this.fb[this.flip]!;
    const prev = this.fb[1 - this.flip]!;
    const c = this.composite;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, W, H);
    gl.useProgram(c.prog);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, prev.tex);
    this.upload(this.camTex, f.cam, 2);
    this.upload(this.vidTex, f.vid, 3);
    gl.uniform1i(this.u(c, 'uScene'), 0);
    gl.uniform1i(this.u(c, 'uPrev'), 1);
    gl.uniform1i(this.u(c, 'uCam'), 2);
    gl.uniform1i(this.u(c, 'uVid'), 3);
    gl.uniform2f(this.u(c, 'uRes'), W, H);
    // Keep the bloom radius constant on screen whatever the render resolution.
    gl.uniform1f(this.u(c, 'uLod'), Math.max(0, Math.log2(sh / 420)));
    this.apply(c, f.fx);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 3. grade to the screen
    const fin = this.final;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.useProgram(fin.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dst.tex);
    gl.uniform1i(this.u(fin, 'uTex'), 0);
    gl.uniform2f(this.u(fin, 'uRes'), W, H);
    this.apply(fin, f.grade);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.flip = 1 - this.flip;
  }
}
