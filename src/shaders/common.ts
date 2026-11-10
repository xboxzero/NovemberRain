// Shared GLSL: uniforms, hashes, value noise (incl. a 4D slice noise), SDF helpers
// and the camera ray generator with the "4D warp" lens.

export const VERT = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const COMMON = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uCamPos;
uniform vec3 uCamTgt;
uniform vec4 uD[130];  // world state written by the Rust simulation
uniform vec4 uP;       // storm, rain, sand, hyper lens
uniform vec4 uQ;       // tesseract, dune fold, 0, 0
uniform vec4 uAudio;   // bass, mid, high, level
uniform float uW;      // position along the 4th dimension
out vec4 fragColor;

#define PI 3.14159265
#define TAU 6.2831853
#define T (uD[128].x)

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
// 4D value noise: a 3D slice at coordinate w of a 4D lattice.
float noise4(vec3 p, float w) {
  float i = floor(w), f = fract(w);
  f = f * f * (3. - 2. * f);
  vec3 o = vec3(17.13, 31.71, 47.37);
  return mix(noise3(p + i * o), noise3(p + (i + 1.) * o), f);
}
float fbm2(vec2 p) {
  float a = .5, s = 0.;
  for (int i = 0; i < 4; i++) { s += a * noise2(p); p = p * 2.03 + 7.1; a *= .5; }
  return s;
}
float fbm3(vec3 p) {
  float a = .5, s = 0.;
  for (int i = 0; i < 4; i++) { s += a * noise3(p); p = p * 2.02 + 5.3; a *= .5; }
  return s;
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
vec3 camRay(vec2 fc, out vec3 ro) {
  vec2 uv = (fc * 2. - uRes) / uRes.y;
  ro = uCamPos;
  vec3 f = normalize(uCamTgt - ro);
  vec3 r = normalize(cross(f, vec3(0, 1, 0)));
  vec3 u = cross(r, f);
  vec3 rd = normalize(f * 1.55 + r * uv.x + u * uv.y);
  float wp = uP.w;
  if (wp > .002) {
    // Hyper lens: treat the image plane as a slice of 4-space, rotate it through the
    // xw and yw planes and project back with a 4D perspective divide.
    vec4 h = vec4(uv, 1.55, 0.);
    h.xw = rot(wp * .9 * sin(uW * .5)) * h.xw;
    h.yw = rot(wp * .9 * cos(uW * .37)) * h.yw;
    h.xy /= 1. + h.w * .45;
    rd = normalize(f * h.z + r * h.x + u * h.y);
    // ...then let a vector field sampled from 4D noise fold it further.
    vec3 q = vec3(uv * 1.3, T * .05);
    vec3 n = vec3(noise4(q, uW), noise4(q + 9.1, uW), noise4(q + 4.7, uW)) - .5;
    rd = normalize(rd + (r * n.x + u * n.y + f * n.z) * wp * .7);
  }
  return rd;
}
// Drifting screen-space specks (rain motes, marine snow, embers).
float specks(vec2 fc, float scale, vec2 drift, float thresh) {
  vec2 uv = fc / uRes.y * scale + drift;
  vec2 id = floor(uv), f = fract(uv) - .5;
  float h = hash21(id);
  vec2 o = (vec2(hash21(id + 3.1), hash21(id + 7.7)) - .5) * .7;
  return smoothstep(.09, 0., length(f - o)) * step(thresh, h) * (.5 + .5 * sin(T * 3. + h * 40.));
}
`;
