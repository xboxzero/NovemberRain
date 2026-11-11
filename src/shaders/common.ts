// Shared GLSL, written in GLSL ES 1.00 so the very same source runs on WebGL1 and WebGL2.

export const VERT = /* glsl */ `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * .5 + .5;
  gl_Position = vec4(aPos, 0., 1.);
}`;

export const PRECISION = /* glsl */ `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

export const COMMON = PRECISION + /* glsl */ `
uniform vec2 uRes;      // full output resolution in pixels
uniform vec2 uOrigin;   // pixel offset of this tile inside the full image
uniform vec3 uCamPos;
uniform vec3 uCamR;     // camera right
uniform vec3 uCamF;     // camera forward, always horizontal: verticals stay vertical
uniform vec4 uLens;     // focal length, vertical shift, hyper-lens amount, wall time
uniform vec4 uD[84];    // world state written by the Rust simulation
uniform vec4 uP;        // storm, rain, sand, dune fold
uniform vec4 uP2;       // exposure, 0, 0, 0
uniform vec4 uFx1;      // kaleidoscope amount, segments, spin, routing (0 serial, 1 parallel)
uniform vec4 uFx2;      // tunnel amount, tunnel speed, liquid amount, liquid scale
uniform vec4 uFx3;      // glitch, 0, 0, 0
uniform vec4 uAudio;    // bass, mid, high, level
uniform float uW;       // position along the 4th dimension

#define PI 3.14159265
#define TAU 6.2831853
#define T (uD[82].x)

float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash31(vec3 p3) { p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }

float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}
float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(mix(hash31(i), hash31(i + vec3(1, 0, 0)), f.x),
                 mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x),
                 mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float smin(float a, float b, float k) { float h = clamp(.5 + .5 * (b - a) / k, 0., 1.); return mix(b, a, h) - k * h * (1. - h); }
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.);
  return length(pa - ba * h) - r;
}
float sdTaper(vec3 p, vec3 a, vec3 b, float ra, float rb) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.);
  return length(pa - ba * h) - mix(ra, rb, h);
}
float sdEll(vec3 p, vec3 r) {
  float k0 = length(p / r), k1 = length(p / (r * r));
  return k0 * (k0 - 1.) / max(k1, 1e-4);
}
// Closest distance between the view ray and a segment; tr = ray parameter of the closest point.
float segDist(vec3 ro, vec3 rd, vec3 a, vec3 b, out float tr) {
  vec3 ab = b - a, ao = ro - a;
  float d1 = dot(ab, ab), d2 = dot(ab, rd), d3 = dot(ab, ao), d4 = dot(rd, ao);
  float den = d1 - d2 * d2;
  float s = den > 1e-5 ? clamp((d3 - d2 * d4) / den, 0., 1.) : 0.;
  vec3 c = a + ab * s;
  tr = max(dot(c - ro, rd), 0.);
  return length(ro + rd * tr - c);
}
float pointDist(vec3 ro, vec3 rd, vec3 c, out float tr) {
  tr = max(dot(c - ro, rd), 0.);
  return length(ro + rd * tr - c);
}

// ---- coordinate effects: remap the image plane before a single ray is cast, so
// ---- they cost nothing extra and stay perfectly sharp at any output resolution.
vec2 fxKal(vec2 c) {
  float seg = TAU / floor(2. + uFx1.y * 14.);
  float a = atan(c.y, c.x) + uLens.w * (uFx1.z - .2) * .6;
  a = abs(mod(a, seg) - seg * .5);
  return vec2(cos(a), sin(a)) * length(c);
}
vec2 fxTun(vec2 c, float asp) {
  // log-polar: equal steps in log(r) are equal zoom factors, so the picture recurses forever
  float v = .6 * log(length(c) + 1e-4) - uLens.w * (uFx2.y - .15) * .5;
  return vec2((abs(atan(c.y, c.x)) / PI * 2. - 1.) * asp, abs(mod(v, 2.) - 1.) * 2. - 1.);
}
vec2 fxLiq(vec2 c) {
  float sc = 1. + uFx2.w * 8.;
  float t = uLens.w * .6;
  return c + .07 * (1. + uAudio.x) * vec2(sin(c.y * sc + t * 1.3) + .5 * sin(c.y * sc * 2.3 - t + c.x * 1.5),
                                           cos(c.x * sc * 1.1 - t * 1.1) + .5 * cos(c.x * sc * 2.1 + t * .7 + c.y * 2.));
}
vec2 fxGli(vec2 c) {
  float row = floor(c.y * 12.), tick = floor(uLens.w * 14.);
  float h = hash21(vec2(row, tick));
  if (h < .4) c.x += (hash21(vec2(tick, row)) - .5) * .6;
  return c;
}
vec2 fxCoord(vec2 c, float asp) {
  float gl = uFx3.x * (.6 + uAudio.x);
  float gate = step(.5, gl + hash21(vec2(floor(uLens.w * 9.), 3.)) * .6) * step(.01, gl);
  if (uFx1.w < .5) {
    // SERIAL: each effect feeds the next
    if (uFx1.x > .003) c = mix(c, fxKal(c), smoothstep(0., .15, uFx1.x));
    if (uFx2.x > .003) c = mix(c, fxTun(c, asp), uFx2.x);
    if (uFx2.z > .003) c = mix(c, fxLiq(c), uFx2.z);
    if (gate > .5) c = fxGli(c);
  } else {
    // PARALLEL: every effect displaces the clean signal; the displacements are summed
    vec2 o = c;
    if (uFx1.x > .003) c += (fxKal(o) - o) * uFx1.x;
    if (uFx2.x > .003) c += (fxTun(o, asp) - o) * uFx2.x;
    if (uFx2.z > .003) c += (fxLiq(o) - o) * uFx2.z;
    if (gate > .5) c += fxGli(o) - o;
  }
  return c;
}

// Architectural camera: the film plane stays vertical (two-point perspective) and the
// lens is shifted instead of tilted, so the titan's verticals never converge.
vec3 camRay(vec2 fc) {
  float asp = uRes.x / uRes.y;
  vec2 c = fxCoord((fc * 2. - uRes) / uRes.y, asp);
  float wp = uLens.z;
  if (wp > .002) {
    // Hyper lens: rotate the image plane through 4-space and project back.
    vec4 h = vec4(c, uLens.x, 0.);
    h.xw = rot(wp * .9 * sin(uW * .5)) * h.xw;
    h.yw = rot(wp * .9 * cos(uW * .37)) * h.yw;
    c = h.xy / (1. + h.w * .45);
    vec3 q = vec3(c * 1.3, uW * .5);
    c += (vec2(noise3(q), noise3(q + 9.1)) - .5) * wp * .5;
  }
  return normalize(uCamF * uLens.x + uCamR * c.x + vec3(0., 1., 0.) * (c.y + uLens.y));
}
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.); }
`;
