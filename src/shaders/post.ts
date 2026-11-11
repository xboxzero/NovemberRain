export const VERT = /* glsl */ `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * .5 + .5;
  gl_Position = vec4(aPos, 0., 1.);
}`;

const PRECISION = /* glsl */ `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

// Plain copy, used to blend each frame's dots into the running average.
export const COPY = PRECISION + /* glsl */ `
varying vec2 vUv;
uniform sampler2D uTex;
void main() { gl_FragColor = texture2D(uTex, vUv); }`;

// Development. The buffer holds, per pixel, sums over the dots that landed there of
// (palette index, depth, 1, radius) x energy. From it we recover:
//   * density  -> brightness on a logarithmic scale, as in a fractal flame;
//   * mean palette index and radius -> colour;
//   * mean depth -> a surface normal (screen-space gradient), from which the swarm
//     is lit, given ambient occlusion and depth haze: this is what makes it read
//     as a body in space instead of a flat picture.
// Then the colour effects (serial or parallel) and the echo feedback loop.
export const DEVELOP = PRECISION + /* glsl */ `
varying vec2 vUv;
uniform sampler2D uAcc, uPrev;
uniform vec2 uOff;      // sampling radius for normals, in uv
uniform vec4 uTone;     // exposure, gain, saturation, 3D light amount
uniform vec4 uFb;       // persistence, zoom, twist, colour cycle
uniform vec4 uColr;     // palette phase shift, palette spread, camera palette mix, loop phase
uniform vec4 uFxC;      // spectrum, contours, posterize, routing
uniform vec3 uPal[4];   // cosine palette: offset, amplitude, frequency, phase
uniform vec3 uCam[3];   // colours sampled from the camera
uniform float uAsp;

#define TAU 6.2831853
vec3 hueRot(vec3 c, float a) {
  const vec3 k = vec3(.57735);
  float ca = cos(a), sa = sin(a);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1. - ca);
}
vec3 palette(float t) {
  vec3 col = uPal[0] + uPal[1] * cos(TAU * (uPal[2] * t + uPal[3] + uColr.x));
  if (uColr.z > .003) {
    float u = fract(t + uColr.x) * 2.;
    vec3 cam = u < 1. ? mix(uCam[0], uCam[1], u) : mix(uCam[1], uCam[2], u - 1.);
    col = mix(col, cam * 1.3 + .05, uColr.z);
  }
  return max(col, 0.);
}
float depthAt(vec2 uv, float fallback) {
  vec4 s = texture2D(uAcc, uv);
  return s.b > 1e-5 ? s.g / s.b : fallback;
}
vec3 fxSpectrum(float l, float z) {
  // density and depth read as a spectrum: equal densities share a colour
  return (.5 + .5 * cos(TAU * (l * 2.2 + z * 1.5 + uColr.w / TAU + vec3(0., .33, .67)))) * (.25 + l);
}
vec3 fxContour(vec3 c, float z, float l) {
  // contour lines of equal depth, like a survey map of the form
  float line = smoothstep(.12, 0., abs(fract(z * 26. + uColr.w / TAU * 2.) - .5) - .04);
  return c * .25 + (.5 + .5 * cos(TAU * (z * 3. + vec3(.0, .2, .45)))) * line * min(l * 1.5, 1.2);
}
vec3 fxPoster(vec3 c) {
  vec3 q = floor(c * 4. + .5) / 4.;
  return mix(q, abs(sin(q * 3.14159 * 1.5)), .5);
}

void main() {
  vec4 a = texture2D(uAcc, vUv);
  float e = a.b;
  vec3 col = vec3(0.);
  if (e > 1e-5) {
    float c = a.r / e, z = a.g / e, rad = a.a / e;
    float l = log(1. + e * uTone.x) * uTone.y;
    vec3 base = palette(c * uColr.y + rad * .22);

    // surface normal from the gradient of the mean depth
    float zx = depthAt(vUv + vec2(uOff.x, 0.), z) - depthAt(vUv - vec2(uOff.x, 0.), z);
    float zy = depthAt(vUv + vec2(0., uOff.y), z) - depthAt(vUv - vec2(0., uOff.y), z);
    vec3 n = normalize(vec3(-zx, -zy, .012));
    vec3 L = normalize(vec3(-.5, .62, .6));
    float diff = dot(n, L) * .5 + .5;
    float spec = pow(max(dot(n, normalize(L + vec3(0., 0., 1.))), 0.), 28.);
    // ambient occlusion: darker where the neighbourhood is nearer than this point
    float ao = 0.;
    vec2 r = uOff * 4.5;
    ao += clamp((z - depthAt(vUv + r, z)) * 16., 0., 1.);
    ao += clamp((z - depthAt(vUv - r, z)) * 16., 0., 1.);
    ao += clamp((z - depthAt(vUv + vec2(r.x, -r.y), z)) * 16., 0., 1.);
    ao += clamp((z - depthAt(vUv + vec2(-r.x, r.y), z)) * 16., 0., 1.);
    float shade = (.3 + 1.05 * diff * diff) * (1. - .16 * ao) * (1.35 - .95 * z);   // near is bright, far sinks into haze
    float k3 = uTone.w;
    col = base * l * mix(1., shade, k3) + vec3(1., .95, .85) * spec * l * .5 * k3;

    // colour effects, in series or in parallel
    if (uFxC.w < .5) {
      if (uFxC.x > .003) col = mix(col, fxSpectrum(l, z) * mix(1., shade, k3), uFxC.x);
      if (uFxC.y > .003) col = mix(col, fxContour(col, z, l), uFxC.y);
      if (uFxC.z > .003) col = mix(col, fxPoster(col), uFxC.z);
    } else {
      vec3 dry = col;
      float w = 1.;
      if (uFxC.x > .003) { col += fxSpectrum(l, z) * mix(1., shade, k3) * uFxC.x * 1.5; w += uFxC.x * 1.5; }
      if (uFxC.y > .003) { col += fxContour(dry, z, l) * uFxC.y * 1.5; w += uFxC.y * 1.5; }
      if (uFxC.z > .003) { col += fxPoster(dry) * uFxC.z * 1.5; w += uFxC.z * 1.5; }
      col /= mix(w, sqrt(w), .5);
    }

    float m = dot(col, vec3(.333));
    col = max(mix(vec3(m), col, uTone.z), 0.);
    col = col / (1. + col * .35);          // soft shoulder instead of clipping
    col = pow(col, vec3(.82));
  }
  if (uFb.x > .003) {
    vec2 p = vUv - .5; p.x *= uAsp;
    float ang = uFb.z;
    p = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * p * (1. - uFb.y);
    p.x /= uAsp;
    vec3 prev = texture2D(uPrev, p + .5).rgb;
    if (uFb.w > .001) prev = max(hueRot(prev, uFb.w), 0.);
    col = max(col, prev * uFb.x);
  }
  gl_FragColor = vec4(clamp(col, 0., 1.), 1.);
}`;

// Final pass: contrast-adaptive sharpening (so a low internal resolution still looks
// crisp when stretched to the display), vignette and a little grain.
export const FINAL = PRECISION + /* glsl */ `
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;    // one pixel of uTex
uniform vec4 uCrop;     // offset.xy, scale.zw inside uTex
uniform vec4 uTile;     // position of the output inside the full image
uniform vec2 uOut;      // full output resolution
uniform float uTime, uSharp, uBright;

float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

void main() {
  vec2 uv = uCrop.xy + vUv * uCrop.zw;
  vec3 col = texture2D(uTex, uv).rgb;
  if (uSharp > .01) {
    vec3 n = texture2D(uTex, uv + vec2(0., uTexel.y)).rgb, s = texture2D(uTex, uv - vec2(0., uTexel.y)).rgb;
    vec3 e = texture2D(uTex, uv + vec2(uTexel.x, 0.)).rgb, w = texture2D(uTex, uv - vec2(uTexel.x, 0.)).rgb;
    vec3 mn = min(col, min(min(n, s), min(e, w))), mx = max(col, max(max(n, s), max(e, w)));
    col = clamp(col + (col * 4. - n - s - e - w) * uSharp, mn, mx);   // never overshoots: no halos
  }
  col *= uBright;
  vec2 fuv = uTile.xy + vUv * uTile.zw;
  vec2 v = fuv - .5;
  col *= 1. - dot(v, v) * .5;
  col += (h21(floor(fuv * uOut) + fract(uTime) * 91.) - .5) * .008;
  gl_FragColor = vec4(clamp(col, 0., 1.), 1.);
}`;
