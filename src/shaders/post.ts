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

// Develops the accumulated dots like a fractal flame: brightness is the logarithm
// of the density, colour is the average colour of the dots that landed there.
// Then the feedback loop: the previous frame, zoomed, twisted and colour-cycled.
export const DEVELOP = PRECISION + /* glsl */ `
varying vec2 vUv;
uniform sampler2D uAcc, uPrev;
uniform vec4 uTone;   // exposure, gain, saturation boost, low-dynamic-range flag
uniform vec4 uFb;     // persistence, zoom, twist, colour cycle
uniform float uAsp;

vec3 hueRot(vec3 c, float a) {
  const vec3 k = vec3(.57735);
  float ca = cos(a), sa = sin(a);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1. - ca);
}

void main() {
  vec4 a = texture2D(uAcc, vUv);
  float d = a.a;
  vec3 col = vec3(0.);
  if (d > 1e-6) {
    float l = log(1. + d * uTone.x) * uTone.y;
    col = a.rgb / d * l;
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
    // blend toward the running average (denser, calmer image) and keep bright echoes
    col = max(mix(col, prev, uFb.x * .6), prev * uFb.x * .985);
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
  col += (h21(floor(fuv * uOut) + fract(uTime) * 91.) - .5) * .01;
  gl_FragColor = vec4(clamp(col, 0., 1.), 1.);
}`;
