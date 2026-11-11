// The organism is drawn as dot particles and nothing else. Every dot computes its
// own position on the GPU: starting from a random seed it plays the chaos game of
// the 4D iterated function system for ITER steps, is rotated in four dimensions,
// projected 4D -> 3D, passed through the spatial effects and splatted as a Gaussian.
//
// A dot does not write a colour. It deposits (palette index, depth, energy, radius),
// each weighted by its energy, so the development pass can recover the mean colour
// AND the mean depth of every pixel and light the swarm as a three-dimensional body.
//
// GLSL ES 1.00: the same code runs on WebGL1 and WebGL2. `#define ITER n` is prepended.

export const POINT_VERT = /* glsl */ `
attribute vec2 aSeed;
uniform mat4 uA[4];     // linear part of each map (4D)
uniform vec4 uB[4];     // translation of each map
uniform vec4 uV[4];     // variation weights: linear, sinusoidal, spherical, swirl
uniform vec4 uV2[4];    // x: quaternion Julia root, y: bulb root, z: colour of the map, w: cumulative probability
uniform vec4 uSym;      // symmetry order, zw coupling, seed offset xy
uniform vec4 uSymB;     // symmetry of the next generation, its zw coupling, share of dots following it
uniform mat4 uRot4;     // rotation in 4-space
uniform mat4 uView;     // rotation in 3-space
uniform vec4 uProj;     // focal length, camera distance, 4D perspective, aspect
uniform vec4 uTile;     // centre xy and inverse half-size xy of the visible window in NDC
uniform vec4 uDot;      // dot size in pixels, depth-of-field strength, energy per dot, glow
uniform vec4 uDepth;    // depth bias, 1 = depth pre-pass, max point size, loop phase
uniform vec4 uFx;       // mirror, twist, wave, lattice
uniform float uRoute;   // 0 serial, 1 parallel
varying vec4 vAcc;

#define PI 3.14159265
#define TAU 6.2831853
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

// ---- spatial effects: each moves a dot in 3-space ---------------------------------
vec3 fxMirror(vec3 p) {
  // kaleidoscope in space: fold the azimuth into a wedge and mirror top to bottom
  float seg = TAU / 6.;
  float a = abs(mod(atan(p.y, p.x), seg) - seg * .5);
  return vec3(cos(a) * length(p.xy), sin(a) * length(p.xy), abs(p.z));
}
vec3 fxTwist(vec3 p) {
  float a = p.z * 2.2 + .6 * sin(uDepth.w);
  return vec3(p.x * cos(a) - p.y * sin(a), p.x * sin(a) + p.y * cos(a), p.z);
}
vec3 fxWave(vec3 p) {
  return p + .22 * sin(p.yzx * 3.5 + uDepth.w * 2.) + .1 * sin(p.zxy * 7. - uDepth.w * 3.);
}
vec3 fxLattice(vec3 p, float h) {
  // snap two of the three coordinates to a grid: the swarm condenses onto the bars
  // of a cubic lattice (after LeWitt's open cubes)
  vec3 g = floor(p * 5. + .5) / 5.;
  return h < .333 ? vec3(p.x, g.y, g.z) : (h < .666 ? vec3(g.x, p.y, g.z) : vec3(g.x, g.y, p.z));
}

void main() {
  vec2 s = aSeed + uSym.zw;
  vec4 p = vec4(hash(s), hash(s + 1.7), hash(s + 3.1), hash(s + 5.3)) * 2. - 1.;
  float c = hash(s + 9.);
  // a growing share of the swarm follows the next generation's symmetry: a smooth cross-fade
  vec2 sym = hash(aSeed + 47.) < uSymB.z ? uSymB.xy : uSym.xy;
  for (int i = 0; i < ITER; i++) {
    float fi = float(i);
    float r = hash(s + fi * vec2(.137, .731) + 11.);
    float h = hash(s + fi * vec2(.517, .291) + 23.);
    mat4 A; vec4 B; vec4 V; vec4 W;
    if (r < uV2[0].w) { A = uA[0]; B = uB[0]; V = uV[0]; W = uV2[0]; }
    else if (r < uV2[1].w) { A = uA[1]; B = uB[1]; V = uV[1]; W = uV2[1]; }
    else if (r < uV2[2].w) { A = uA[2]; B = uB[2]; V = uV[2]; W = uV2[2]; }
    else { A = uA[3]; B = uB[3]; V = uV[3]; W = uV2[3]; }
    // MUST match apply() in engine/src/evo.rs (the fitness function samples the same system)
    vec4 q = A * p + B;
    float r2 = dot(q, q) + 1e-4;
    float sn = sin(r2), cs = cos(r2);
    vec4 f = V.x * q + V.y * sin(q * 2.) + V.z * q / max(r2, .06)
           + V.w * vec4(q.x * sn - q.y * cs, q.x * cs + q.y * sn, q.z * sn - q.w * cs, q.z * cs + q.w * sn);
    if (W.x > .001) {
      // quaternion square root with a random sign: an inverse branch of the Julia map q -> q^2 + c
      float n = sqrt(r2);
      float sg = fract(h * 7.13) < .5 ? 1. : -1.;
      float im = sqrt(max(n - q.x, 0.) * .5) / (length(q.yzw) + 1e-6) * sg;
      f += W.x * vec4(sqrt(max(n + q.x, 0.) * .5) * sg, q.yzw * im);
    }
    if (W.y > .001) {
      // bulb root: the inverse of the Mandelbulb's spherical-coordinate squaring
      float r3 = length(q.xyz) + 1e-6;
      float th = acos(clamp(q.z / r3, -1., 1.)) * .5;
      float ph = atan(q.y, q.x) * .5 + (fract(h * 13.7) < .5 ? 0. : PI);
      float rr = sqrt(r3);
      f += W.y * vec4(rr * sin(th) * cos(ph), rr * sin(th) * sin(ph), rr * cos(th), q.w * .7);
    }
    f *= 1. / (1. + .03 * dot(f, f));
    float ang = TAU * floor(h * sym.x) / sym.x;
    float c1 = cos(ang), s1 = sin(ang), c2 = cos(ang * sym.y), s2 = sin(ang * sym.y);
    p = vec4(f.x * c1 - f.y * s1, f.x * s1 + f.y * c1, f.z * c2 - f.w * s2, f.z * s2 + f.w * c2);
    c = .5 * (c + W.z);
  }
  float rad = clamp(length(p) * .4, 0., 1.);

  // 4D rotation, then perspective projection from 4-space into 3-space
  p = uRot4 * p;
  vec3 p3 = p.xyz * (1.7 / (1.7 - p.w * uProj.z * .5));

  // spatial effects, in series or in parallel
  float hb = hash(aSeed + 71.);
  if (uRoute < .5) {
    // SERIAL: every dot passes through each effect in turn
    if (uFx.x > .003) p3 = mix(p3, fxMirror(p3), uFx.x);
    if (uFx.y > .003) p3 = mix(p3, fxTwist(p3), uFx.y);
    if (uFx.z > .003) p3 = mix(p3, fxWave(p3), uFx.z);
    if (uFx.w > .003) p3 = mix(p3, fxLattice(p3, hb), uFx.w);
  } else {
    // PARALLEL: the swarm is split into branches, one clean and one per effect, in
    // proportion to the sliders; what you see is the sum of the branches
    float pick = hash(aSeed + 83.) * (1. + uFx.x + uFx.y + uFx.z + uFx.w);
    if (pick > 1.) {
      pick -= 1.;
      if (pick < uFx.x) p3 = fxMirror(p3);
      else if (pick < uFx.x + uFx.y) p3 = fxTwist(p3);
      else if (pick < uFx.x + uFx.y + uFx.z) p3 = fxWave(p3);
      else p3 = fxLattice(p3, hb);
    }
  }

  vec3 v = (uView * vec4(p3, 1.)).xyz;
  float z = v.z + uProj.y;
  bool halo = hash(aSeed + 31.) < .03;
  if (z < .15 || (halo && uDepth.y > .5)) { gl_Position = vec4(2., 2., 2., 1.); gl_PointSize = 1.; vAcc = vec4(0.); return; }
  vec2 ndc = v.xy * uProj.x / z;
  ndc.x /= uProj.w;
  float zn = clamp(v.z / 3.8, -.999, .999);   // linear depth around the centre of the form
  gl_Position = vec4((ndc - uTile.xy) * uTile.zw, zn + uDepth.x, 1.);

  // Gaussian splat: grows out of focus (circle of confusion) while keeping its energy
  float size = uDot.x * (uProj.y / z) * (1. + abs(v.z) * uDot.y);
  float e = uDot.z;
  if (halo) { size *= 7.; e *= uDot.w * 2.5; }   // a few dots become soft halos: glow
  if (uDepth.y > .5) size = max(size * 1.7, 2.);  // the depth shell is drawn slightly fat so it is closed
  float drawn = clamp(size, 1., uDepth.z);
  gl_PointSize = drawn;
  e *= min(size * size, 1.) / (drawn * drawn) * (size > uDepth.z ? uDepth.z * uDepth.z / (size * size) * 4. : 1.);
  vAcc = vec4(c, zn * .5 + .5, 1., rad) * e;
}`;

export const POINT_FRAG = /* glsl */ `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec4 vAcc;
void main() {
  vec2 d = gl_PointCoord - .5;
  gl_FragColor = vAcc * exp(-dot(d, d) * 14.);
}`;
