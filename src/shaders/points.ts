// The organism is drawn as dot particles and nothing else. Every dot computes its
// own position on the GPU: starting from a random seed it plays the chaos game of
// the 4D iterated function system for ITER steps, is rotated in four dimensions,
// projected 4D -> 3D -> screen and splatted as a Gaussian. GLSL ES 1.00, so the
// same code runs on WebGL1 and WebGL2. `#define ITER n` is prepended by the renderer.

export const POINT_VERT = /* glsl */ `
attribute vec2 aSeed;
uniform mat4 uA[4];     // linear part of each map (4D)
uniform vec4 uB[4];     // translation of each map
uniform vec4 uV[4];     // variation weights: linear, sinusoidal, spherical, swirl
uniform vec4 uCP[4];    // x: colour of the map, y: cumulative probability
uniform vec4 uSym;      // symmetry order, zw coupling, seed offset xy
uniform mat4 uRot4;     // rotation in 4-space
uniform mat4 uView;     // rotation in 3-space
uniform vec4 uProj;     // focal length, camera distance, 4D perspective, aspect
uniform vec4 uTile;     // centre xy and inverse half-size xy of the visible window in NDC
uniform vec4 uDot;      // dot size in pixels, depth-of-field strength, energy per dot, glow
uniform vec4 uCol;      // hue offset, palette spread, camera palette mix, max point size
uniform vec3 uPal[4];   // cosine palette: offset, amplitude, frequency, phase
uniform vec3 uCam[3];   // colours sampled from the camera
varying vec4 vCol;

#define TAU 6.2831853
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 s = aSeed + uSym.zw;
  vec4 p = vec4(hash(s), hash(s + 1.7), hash(s + 3.1), hash(s + 5.3)) * 2. - 1.;
  float c = hash(s + 9.);
  for (int i = 0; i < ITER; i++) {
    float fi = float(i);
    float r = hash(s + fi * vec2(.137, .731) + 11.);
    float h = hash(s + fi * vec2(.517, .291) + 23.);
    mat4 A; vec4 B; vec4 V; float cc;
    if (r < uCP[0].y) { A = uA[0]; B = uB[0]; V = uV[0]; cc = uCP[0].x; }
    else if (r < uCP[1].y) { A = uA[1]; B = uB[1]; V = uV[1]; cc = uCP[1].x; }
    else if (r < uCP[2].y) { A = uA[2]; B = uB[2]; V = uV[2]; cc = uCP[2].x; }
    else { A = uA[3]; B = uB[3]; V = uV[3]; cc = uCP[3].x; }
    // MUST match apply() in engine/src/evo.rs (the fitness function samples the same system)
    vec4 q = A * p + B;
    float r2 = dot(q, q) + 1e-4;
    float sn = sin(r2), cs = cos(r2);
    vec4 sw = vec4(q.x * sn - q.y * cs, q.x * cs + q.y * sn, q.z * sn - q.w * cs, q.z * cs + q.w * sn);
    vec4 f = V.x * q + V.y * sin(q * 2.) + V.z * q / max(r2, .06) + V.w * sw;
    f *= 1. / (1. + .03 * dot(f, f));
    float ang = TAU * floor(h * uSym.x) / uSym.x;
    float c1 = cos(ang), s1 = sin(ang), c2 = cos(ang * uSym.y), s2 = sin(ang * uSym.y);
    p = vec4(f.x * c1 - f.y * s1, f.x * s1 + f.y * c1, f.z * c2 - f.w * s2, f.z * s2 + f.w * c2);
    c = .5 * (c + cc);
  }

  // 4D rotation, then perspective projection from 4-space into 3-space
  p = uRot4 * p;
  vec3 p3 = p.xyz * (1.7 / (1.7 - p.w * uProj.z * .5));
  vec3 v = (uView * vec4(p3, 1.)).xyz;
  float z = v.z + uProj.y;
  if (z < .15) { gl_Position = vec4(2., 2., 2., 1.); gl_PointSize = 1.; vCol = vec4(0.); return; }
  vec2 ndc = v.xy * uProj.x / z;
  ndc.x /= uProj.w;
  gl_Position = vec4((ndc - uTile.xy) * uTile.zw, 0., 1.);

  // Gaussian splat: grows out of focus (circle of confusion) while keeping its energy
  float size = uDot.x * (uProj.y / z) * (1. + abs(z - uProj.y) * uDot.y);
  float e = uDot.z;
  if (hash(aSeed + 31.) < .03) { size *= 7.; e *= uDot.w * 2.5; }   // a few dots become soft halos: glow
  float drawn = clamp(size, 1., uCol.w);
  gl_PointSize = drawn;
  e *= min(size * size, 1.) / (drawn * drawn) * (size > uCol.w ? uCol.w * uCol.w / (size * size) * 4. : 1.);

  float t = c * uCol.y + uCol.x;
  vec3 col = uPal[0] + uPal[1] * cos(TAU * (uPal[2] * t + uPal[3]));
  if (uCol.z > .003) {
    float u = fract(t) * 2.;
    vec3 cam = u < 1. ? mix(uCam[0], uCam[1], u) : mix(uCam[1], uCam[2], u - 1.);
    col = mix(col, cam * 1.3 + .05, uCol.z);
  }
  col *= mix(1.25, .45, clamp((z - uProj.y) * .22 + .5, 0., 1.));   // far dots are dimmer
  vCol = vec4(max(col, 0.) * e, e);
}`;

export const POINT_FRAG = /* glsl */ `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec4 vCol;
void main() {
  vec2 d = gl_PointCoord - .5;
  gl_FragColor = vCol * exp(-dot(d, d) * 14.);
}`;
