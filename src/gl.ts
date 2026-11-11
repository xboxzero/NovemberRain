// Renderer. Everything visible is dot particles: up to several million GL points
// per frame, each computed in the vertex shader and splatted additively into a
// floating-point density buffer, which is then developed (log tone mapping),
// fed through a feedback loop and sharpened to the display.
//
// Runs on WebGL2 or WebGL1. High-resolution stills are rendered tile by tile with
// many passes of fresh dots per tile, so an 8K image needs only a small buffer.

import { POINT_VERT, POINT_FRAG } from './shaders/points';
import { VERT, DEVELOP, FINAL } from './shaders/post';

export type Uniforms = Record<string, number | number[] | Float32Array>;
type GL = WebGLRenderingContext | WebGL2RenderingContext;

interface Program {
  prog: WebGLProgram;
  loc: Map<string, WebGLUniformLocation | null>;
}

interface Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

export interface Frame {
  /** Uniforms of the dot shader (genome, rotations, palette). */
  dots: Uniforms;
  /** Dot radius relative to a 1080-line image, depth of field, brightness, glow. */
  size: number;
  dof: number;
  gain: number;
  glow: number;
  hue: number;
  spread: number;
  camMix: number;
  /** Development and feedback. */
  tone: number[];
  fb: number[];
  bright: number;
  time: number;
}

const ATTRS: WebGLContextAttributes = { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' };
const ITERS = [10, 13, 16];

export class Renderer {
  gl!: GL;
  api: 'WebGL2' | 'WebGL1' = 'WebGL1';
  /** Detail level: iterations of the chaos game per dot. */
  tier = 2;
  /** Fraction of the canvas resolution used for the internal buffers. */
  scale = 0.6;
  /** Dots drawn per frame, and the size of the seed pool. */
  count = 200_000;
  capacity = 0;
  maxSize = 2048;
  maxPoint = 64;
  hdr = false;
  lost = false;
  private dots: Program | null = null;
  private develop: Program | null = null;
  private final: Program | null = null;
  private quad!: WebGLBuffer;
  private seeds!: WebGLBuffer;
  private acc: Target | null = null;
  private fb: [Target | null, Target | null] = [null, null];
  private tiles: [Target | null, Target | null, Target | null] = [null, null, null];
  private flip = 0;
  private frameNo = 0;
  private floatType = 0;
  private floatFormat = 0;

  constructor(readonly canvas: HTMLCanvasElement, private forceGL1 = false, private wantCapacity = 2_000_000) {
    this.setup();
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.dots = this.develop = this.final = null;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      try {
        this.setup();
        this.init(this.tier);
      } catch (err) {
        console.error(err);
      }
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
    this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number);
    this.maxPoint = Math.min(256, (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array)[1]);
    this.acc = null;
    this.fb = [null, null];
    this.tiles = [null, null, null];

    // A floating-point density buffer lets millions of faint dots add up without banding.
    this.hdr = false;
    if (gl2) {
      if (gl2.getExtension('EXT_color_buffer_float') || gl2.getExtension('EXT_color_buffer_half_float')) {
        this.floatFormat = gl2.RGBA16F;
        this.floatType = gl2.HALF_FLOAT;
        this.hdr = true;
      }
    } else {
      const hf = gl.getExtension('OES_texture_half_float');
      if (hf) {
        gl.getExtension('EXT_color_buffer_half_float');
        this.floatFormat = gl.RGBA;
        this.floatType = hf.HALF_FLOAT_OES;
        this.hdr = true;
      }
    }
    if (this.hdr) {
      // some drivers advertise the format but cannot render to it: test once
      const t = this.target(null, 4, 4, true);
      this.hdr = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      this.free(t);
    }

    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    // The seed pool: two random 16-bit numbers per dot (4 bytes), all a dot needs to find its place.
    this.capacity = this.wantCapacity;
    const seeds = new Uint16Array(this.capacity * 2);
    for (let i = 0; i < seeds.length; i += 32768) crypto.getRandomValues(seeds.subarray(i, Math.min(seeds.length, i + 32768)));
    this.seeds = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.seeds);
    gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.disable(gl.DEPTH_TEST);
  }

  private build(vert: string, frag: string, attr: string): Program {
    const gl = this.gl;
    const mk = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const vs = mk(gl.VERTEX_SHADER, vert);
    const fs = mk(gl.FRAGMENT_SHADER, frag);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, attr);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getShaderInfoLog(vs) || gl.getShaderInfoLog(fs) || gl.getProgramInfoLog(prog) || 'unknown error';
      throw new Error(`shader failed to compile: ${log}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return { prog, loc: new Map() };
  }

  /** Compile the shaders (they are small, so this is quick). */
  init(tier: number): void {
    this.develop = this.build(VERT, DEVELOP, 'aPos');
    this.final = this.build(VERT, FINAL, 'aPos');
    this.setTier(tier);
  }

  setTier(tier: number): void {
    const t = Math.max(0, Math.min(2, tier));
    const p = this.build(`#define ITER ${ITERS[t]}\n${POINT_VERT}`, POINT_FRAG, 'aSeed');
    if (this.dots) this.gl.deleteProgram(this.dots.prog);
    this.dots = p;
    this.tier = t;
  }

  get ready(): boolean {
    return !this.lost && !!this.dots && !!this.develop && !!this.final;
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
      else if (name === 'uA' || name === 'uRot4' || name === 'uView') gl.uniformMatrix4fv(loc, false, v);
      else if (name === 'uPal' || name === 'uCam') gl.uniform3fv(loc, v);
      else gl.uniform4fv(loc, v);
    }
  }

  private target(old: Target | null, w: number, h: number, float = false): Target {
    const gl = this.gl;
    if (old && old.w === w && old.h === h) return old;
    this.free(old);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, this.floatFormat, w, h, 0, gl.RGBA, this.floatType, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const filter = float ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
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

  get internal(): [number, number] {
    return [Math.max(2, Math.round(this.canvas.width * this.scale)), Math.max(2, Math.round(this.canvas.height * this.scale))];
  }

  /**
   * Splat dots into `dst`. (W, H) is the full image the dots are sized for; the
   * window [cx, cy, ihw, ihh] selects which part of it this buffer shows.
   */
  private splat(f: Frame, dst: Target, W: number, H: number, win: [number, number, number, number], count: number, passes: number): void {
    const gl = this.gl;
    const p = this.dots!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.w, dst.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(p.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.seeds);
    gl.vertexAttribPointer(0, 2, gl.UNSIGNED_SHORT, true, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.apply(p, f.dots);
    const sym = f.dots.uSym as number[];
    const proj = f.dots.uProj as number[];
    gl.uniform4f(this.u(p, 'uProj'), proj[0], proj[1], proj[2], W / H);
    gl.uniform4f(this.u(p, 'uTile'), win[0], win[1], win[2], win[3]);
    // Each dot carries the same share of light whatever the resolution or the dot count.
    const total = count * passes;
    let energy = ((f.gain * W * H) / total) * 0.7;
    if (!this.hdr) energy = Math.max(energy, 0.012); // 8-bit buffer: a dot must register at all
    gl.uniform4f(this.u(p, 'uDot'), (f.size * H) / 1080, f.dof, energy, f.glow);
    gl.uniform4f(this.u(p, 'uCol'), f.hue, f.spread, f.camMix, this.maxPoint);
    for (let i = 0; i < passes; i++) {
      // a different seed offset every pass and every frame: the dots never repeat,
      // so time (trails) and passes (stills) keep adding new detail
      const k = this.frameNo++;
      gl.uniform4f(this.u(p, 'uSym'), sym[0], sym[1], (k * 0.61803398875) % 1, (k * 0.7548776662) % 1);
      gl.drawArrays(gl.POINTS, 0, Math.min(count, this.capacity));
    }
    gl.disable(gl.BLEND);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  private bind(unit: number, tex: WebGLTexture): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
  }

  private developPass(f: Frame, src: Target, prev: Target | null, dst: Target, asp: number): void {
    const gl = this.gl;
    const d = this.develop!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.w, dst.h);
    gl.useProgram(d.prog);
    this.bind(0, src.tex);
    this.bind(1, (prev ?? src).tex);
    gl.uniform1i(this.u(d, 'uAcc'), 0);
    gl.uniform1i(this.u(d, 'uPrev'), 1);
    gl.uniform4f(this.u(d, 'uTone'), f.tone[0], f.tone[1], f.tone[2], this.hdr ? 0 : 1);
    gl.uniform4f(this.u(d, 'uFb'), prev ? f.fb[0] : 0, f.fb[1], f.fb[2], f.fb[3]);
    gl.uniform1f(this.u(d, 'uAsp'), asp);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private finalPass(f: Frame, src: Target, dst: Target | null, w: number, h: number, crop: number[], tile: number[], W: number, H: number, sharp: number): void {
    const gl = this.gl;
    const fin = this.final!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fbo : null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(fin.prog);
    this.bind(0, src.tex);
    gl.uniform1i(this.u(fin, 'uTex'), 0);
    gl.uniform2f(this.u(fin, 'uTexel'), 1 / src.w, 1 / src.h);
    gl.uniform4f(this.u(fin, 'uCrop'), crop[0], crop[1], crop[2], crop[3]);
    gl.uniform4f(this.u(fin, 'uTile'), tile[0], tile[1], tile[2], tile[3]);
    gl.uniform2f(this.u(fin, 'uOut'), W, H);
    gl.uniform1f(this.u(fin, 'uTime'), f.time);
    gl.uniform1f(this.u(fin, 'uSharp'), sharp);
    gl.uniform1f(this.u(fin, 'uBright'), f.bright);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Draw one live frame to the canvas. */
  render(f: Frame): void {
    if (!this.ready) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const [sw, sh] = this.internal;
    this.acc = this.target(this.acc, sw, sh, this.hdr);
    this.fb[0] = this.target(this.fb[0], sw, sh);
    this.fb[1] = this.target(this.fb[1], sw, sh);
    this.splat(f, this.acc, sw, sh, [0, 0, 1, 1], this.count, 1);
    const dst = this.fb[this.flip]!;
    this.developPass(f, this.acc, this.fb[1 - this.flip]!, dst, W / H);
    this.finalPass(f, dst, null, W, H, [0, 0, 1, 1], [0, 0, 1, 1], W, H, Math.min(0.8, 0.1 + (1 - this.scale)));
    this.flip = 1 - this.flip;
  }

  /**
   * Render one tile of a W x H still: `passes` rounds of fresh dots are accumulated,
   * developed and read back. (ox, oy) is the tile's bottom-left corner in image pixels
   * (GL orientation), `size` its edge, (w, h) the part needed. `out` receives w*h RGBA
   * pixels, bottom row first.
   */
  tile(f: Frame, W: number, H: number, ox: number, oy: number, size: number, w: number, h: number, passes: number, out: Uint8Array): void {
    const gl = this.gl;
    // guard band: a splat centred just outside the tile must still paint its share inside
    const M = Math.min(96, Math.ceil(this.maxPoint / 2) + 2);
    const S = size + 2 * M;
    this.tiles[0] = this.target(this.tiles[0], S, S, this.hdr);
    this.tiles[1] = this.target(this.tiles[1], S, S);
    this.tiles[2] = this.target(this.tiles[2], size, size);
    const [a, b, d] = this.tiles as [Target, Target, Target];
    const x0 = ((ox - M) / W) * 2 - 1;
    const y0 = ((oy - M) / H) * 2 - 1;
    const hw = S / W;
    const hh = S / H;
    // every tile draws the whole swarm (only the dots that land in it show), so the
    // energy per dot is the same in every tile and the tiles join without seams
    this.splat(f, a, W, H, [x0 + hw, y0 + hh, 1 / hw, 1 / hh], this.count, passes);
    this.developPass(f, a, null, b, W / H);
    this.finalPass(f, b, d, size, size, [M / S, M / S, size / S, size / S], [ox / W, oy / H, size / W, size / H], W, H, 0);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
  }

  freeTiles(): void {
    for (const t of this.tiles) this.free(t);
    this.tiles = [null, null, null];
  }
}
