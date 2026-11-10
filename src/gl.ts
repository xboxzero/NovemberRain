// WebGL2 renderer: raymarched scene -> HDR target -> composite (trails, bloom, inputs) -> grade.

import { VERT } from './shaders/common';
import { STORM } from './shaders/storm';
import { ABYSS } from './shaders/abyss';
import { VOLCANO } from './shaders/volcano';
import { TITAN } from './shaders/titan';
import { COMPOSITE, FINAL } from './shaders/post';

const SCENES = [STORM, ABYSS, VOLCANO, TITAN];

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
  scene: number;
  time: number;
  camPos: [number, number, number];
  camTgt: [number, number, number];
  data: Float32Array;
  p: [number, number, number, number];
  audio: [number, number, number, number];
  w: number;
  feedback: number;
  bloom: number;
  kaleido: number;
  glitch: number;
  camMix: number;
  vidMix: number;
  hue: number;
  sat: number;
  bright: number;
  contrast: number;
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
  private scenes: (Program | null)[] = [null, null, null, null];
  private loading: (Promise<Program> | null)[] = [null, null, null, null];
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

  /** Make sure the shader of a scene is compiled. Resolves when it can be drawn. */
  prepare(scene: number): Promise<void> {
    if (!this.loading[scene]) {
      this.loading[scene] = this.build(SCENES[scene]).then((p) => (this.scenes[scene] = p));
      this.loading[scene]!.catch(() => (this.loading[scene] = null));
    }
    return this.loading[scene]!.then(() => undefined);
  }

  ready(scene: number): boolean {
    return !!this.scenes[scene];
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

  /** Match the drawing buffer to the CSS size. Returns true when it changed. */
  resize(maxDpr = 1.5): boolean {
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    const w = Math.max(2, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    return true;
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
    const scene = this.scenes[f.scene];
    if (!scene || !this.composite || !this.final) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const sw = Math.max(2, Math.round(W * this.scale));
    const sh = Math.max(2, Math.round(H * this.scale));
    this.sceneT = this.target(this.sceneT, sw, sh, true);
    this.fb[0] = this.target(this.fb[0], W, H, false);
    this.fb[1] = this.target(this.fb[1], W, H, false);
    gl.bindVertexArray(this.vao);

    // 1. raymarched scene
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneT.fbo);
    gl.viewport(0, 0, sw, sh);
    gl.useProgram(scene.prog);
    gl.uniform2f(this.u(scene, 'uRes'), sw, sh);
    gl.uniform1f(this.u(scene, 'uTime'), f.time);
    gl.uniform3fv(this.u(scene, 'uCamPos'), f.camPos);
    gl.uniform3fv(this.u(scene, 'uCamTgt'), f.camTgt);
    gl.uniform4fv(this.u(scene, 'uD'), f.data);
    gl.uniform4fv(this.u(scene, 'uP'), f.p);
    gl.uniform4fv(this.u(scene, 'uAudio'), f.audio);
    gl.uniform1f(this.u(scene, 'uW'), f.w);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneT.tex);
    gl.generateMipmap(gl.TEXTURE_2D);

    // 2. composite into the feedback buffer
    const dst = this.fb[this.flip]!;
    const prev = this.fb[1 - this.flip]!;
    const c = this.composite;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, W, H);
    gl.useProgram(c.prog);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, prev.tex);
    this.upload(this.camTex, f.camMix > 0 ? f.cam : null, 2);
    this.upload(this.vidTex, f.vidMix > 0 ? f.vid : null, 3);
    gl.uniform1i(this.u(c, 'uScene'), 0);
    gl.uniform1i(this.u(c, 'uPrev'), 1);
    gl.uniform1i(this.u(c, 'uCam'), 2);
    gl.uniform1i(this.u(c, 'uVid'), 3);
    gl.uniform2f(this.u(c, 'uRes'), W, H);
    gl.uniform1f(this.u(c, 'uTime'), f.time);
    gl.uniform1f(this.u(c, 'uFeedback'), f.feedback);
    gl.uniform1f(this.u(c, 'uBloom'), f.bloom);
    gl.uniform1f(this.u(c, 'uKaleido'), f.kaleido);
    gl.uniform1f(this.u(c, 'uGlitch'), f.glitch);
    gl.uniform1f(this.u(c, 'uCamMix'), f.camMix);
    gl.uniform1f(this.u(c, 'uVidMix'), f.vidMix);
    gl.uniform4fv(this.u(c, 'uAudio'), f.audio);
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
    gl.uniform1f(this.u(fin, 'uTime'), f.time);
    gl.uniform1f(this.u(fin, 'uHue'), f.hue);
    gl.uniform1f(this.u(fin, 'uSat'), f.sat);
    gl.uniform1f(this.u(fin, 'uBright'), f.bright);
    gl.uniform1f(this.u(fin, 'uContrast'), f.contrast);
    gl.uniform1f(this.u(fin, 'uGlitch'), f.glitch);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.flip = 1 - this.flip;
  }
}
