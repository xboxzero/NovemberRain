import { PRECISION } from './common';

// Colour stage of the FX chain (spectrum -> neon edges -> posterize, serial or
// parallel), fractal flame layer, bloom, live inputs and the feedback loop.
// Works on plain 8-bit buffers. The same shader serves the live view and the
// tiles of a high-resolution still: uTile maps this buffer into the full image,
// and wide-radius lookups (bloom, colour fringes) go to the low-resolution frame.
export const COMPOSITE = PRECISION + /* glsl */ `
varying vec2 vUv;
uniform sampler2D uScene, uLow, uPrev, uCam, uVid, uFlame;
uniform vec2 uTexel;    // one pixel of uScene
uniform vec4 uTile;     // offset.xy, scale.zw of this buffer inside the full image
uniform float uAsp, uTime, uRoute, uBloom, uRgb, uEdge, uPoster, uGlitch, uCamMix, uVidMix;
uniform vec4 uFb;       // amount, zoom, twist, colour cycle
uniform vec3 uAcid;     // amount, bands, flow
uniform vec2 uFlameP;   // amount, size
uniform vec4 uAudio;

#define TAU 6.2831853
float luma(vec3 c) { return dot(c, vec3(.299, .587, .114)); }
vec3 hueRot(vec3 c, float a) {
  const vec3 k = vec3(.57735);
  float ca = cos(a), sa = sin(a);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1. - ca);
}
vec3 fxAcid(vec3 c) {
  float l = luma(c);
  vec3 pal = .5 + .5 * cos(TAU * (l * (1. + uAcid.y * 9.) + uTime * (uAcid.z - .1) * .5 + vec3(0., .33, .67)));
  return pal * (.2 + 1.1 * l);
}
vec3 fxEdge(vec3 c, vec2 uv) {
  vec2 px = uTexel * 1.5;
  float l0 = luma(texture2D(uScene, uv + vec2(px.x, 0.)).rgb), l1 = luma(texture2D(uScene, uv - vec2(px.x, 0.)).rgb);
  float l2 = luma(texture2D(uScene, uv + vec2(0., px.y)).rgb), l3 = luma(texture2D(uScene, uv - vec2(0., px.y)).rgb);
  vec2 g = vec2(l0 - l1, l2 - l3);
  float e = length(g) / (.03 + .5 * (l0 + l1 + l2 + l3));
  vec3 neon = .5 + .5 * cos(atan(g.y, g.x + 1e-5) + uTime * .7 + vec3(0., 2.1, 4.2));
  return c * .12 + neon * smoothstep(.08, .6, e) * 1.3;
}
vec3 fxPost(vec3 c) {
  float levels = mix(9., 2.5, uPoster);
  vec3 q = floor(c * levels + .5) / levels;
  return mix(q, abs(sin(q * 3.14159 * 1.5)), uPoster * .6);   // + solarise
}

void main() {
  vec2 uv = vUv;
  vec2 fuv = uTile.xy + uv * uTile.zw;   // position in the full image
  vec3 col = texture2D(uScene, uv).rgb;

  // RGB split: fringes come from the low-res frame, detail from this buffer.
  float split = uRgb * .05 + uGlitch * .02;
  if (split > .0005) {
    vec2 ca = (fuv - .5) * split;
    vec3 low = texture2D(uLow, fuv).rgb;
    col = vec3(texture2D(uLow, fuv + ca).r + col.r - low.r, col.g, texture2D(uLow, fuv - ca).b + col.b - low.b);
  }

  // Colour stage, serial or parallel.
  if (uRoute < .5) {
    if (uAcid.x > .003) col = mix(col, fxAcid(col), uAcid.x);
    if (uEdge > .003) col = mix(col, fxEdge(col, uv), uEdge);
    if (uPoster > .003) col = mix(col, fxPost(col), uPoster);
  } else {
    vec3 dry = col;
    float wsum = 1.;
    if (uAcid.x > .003) { col += fxAcid(dry) * uAcid.x * 1.5; wsum += uAcid.x * 1.5; }
    if (uEdge > .003) { col += fxEdge(dry, uv) * uEdge * 1.5; wsum += uEdge * 1.5; }
    if (uPoster > .003) { col += fxPost(dry) * uPoster * 1.5; wsum += uPoster * 1.5; }
    col /= mix(wsum, sqrt(wsum), .5);   // keep some of the summed energy: layers glow
  }

  // Fractal flame, rendered by the Rust chaos game.
  if (uFlameP.x > .003) {
    vec2 f = (fuv - .5) * vec2(uAsp, 1.) / (.35 + uFlameP.y * 1.3) + .5;
    vec3 fl = texture2D(uFlame, f).rgb * step(abs(f.x - .5), .5) * step(abs(f.y - .5), .5);
    col += fl * fl * uFlameP.x * (1.6 + uAudio.x * 2.);
  }

  // Bloom: a wide spiral of taps on the low-res frame, weighted toward highlights.
  if (uBloom > .003) {
    vec3 bl = vec3(0.);
    for (int i = 0; i < 12; i++) {
      float fi = float(i);
      vec2 o = vec2(cos(fi * 2.4), sin(fi * 2.4)) * (.006 + .0055 * fi) * vec2(1. / uAsp, 1.);
      vec3 s = texture2D(uLow, fuv + o).rgb;
      bl += s * s * max(s.r, max(s.g, s.b));
    }
    col += bl * uBloom * .13;
  }

  // Live camera and video / screen-capture layers.
  if (uCamMix > .001) col = mix(col, texture2D(uCam, vec2(1. - fuv.x, fuv.y)).rgb + col * .65, uCamMix);
  if (uVidMix > .001) col = mix(col, texture2D(uVid, fuv).rgb + col * .65, uVidMix);

  // Feedback loop: the previous frame, zoomed, twisted and colour-cycled.
  if (uFb.x > .005) {
    vec2 p = fuv - .5; p.x *= uAsp;
    float a = (uFb.z - .5) * .12 + .01 * uAudio.y;
    p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p * (1. - (uFb.y - .5) * .08 - .012 * uAudio.x);
    p.x /= uAsp;
    vec3 prev = texture2D(uPrev, p + .5).rgb;
    if (uFb.w > .003) prev = max(hueRot(prev, uFb.w * .5), 0.);
    col = max(col, prev * (.6 + .392 * uFb.x));
  }
  gl_FragColor = vec4(clamp(col, 0., 1.), 1.);
}`;

// Final pass: contrast-adaptive sharpening (so a low internal resolution still
// looks crisp when stretched to the display), grade, vignette, grain.
export const FINAL = PRECISION + /* glsl */ `
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;    // one pixel of uTex
uniform vec4 uCrop;     // offset.xy, scale.zw inside uTex
uniform vec4 uTile;     // position of the output inside the full image
uniform vec2 uOut;      // full output resolution
uniform float uTime, uSharp, uHue, uSat, uContrast, uGlitch;

float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 hueRot(vec3 c, float a) {
  const vec3 k = vec3(.57735);
  float ca = cos(a), sa = sin(a);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1. - ca);
}

void main() {
  vec2 uv = uCrop.xy + vUv * uCrop.zw;
  vec3 col = texture2D(uTex, uv).rgb;
  if (uSharp > .01) {
    vec3 n = texture2D(uTex, uv + vec2(0., uTexel.y)).rgb, s = texture2D(uTex, uv - vec2(0., uTexel.y)).rgb;
    vec3 e = texture2D(uTex, uv + vec2(uTexel.x, 0.)).rgb, w = texture2D(uTex, uv - vec2(uTexel.x, 0.)).rgb;
    vec3 mn = min(col, min(min(n, s), min(e, w))), mx = max(col, max(max(n, s), max(e, w)));
    col = clamp(col + (col * 4. - n - s - e - w) * uSharp, mn, mx);   // never overshoots: no halos
  }
  if (uHue > .002) col = max(hueRot(col, uHue * 6.2831853), 0.);
  float l = dot(col, vec3(.299, .587, .114));
  col = mix(vec3(l), col, uSat * 2.);
  col = (col - .5) * (.4 + uContrast * 1.2) + .5;
  vec2 fuv = uTile.xy + vUv * uTile.zw;
  vec2 v = fuv - .5;
  col *= 1. - dot(v, v) * .55;
  vec2 gp = floor(fuv * uOut);
  col += (h21(gp + fract(uTime) * 91.) - .5) * (.012 + uGlitch * .12);
  col *= 1. - uGlitch * .25 * step(.5, fract(gp.y * .5));
  gl_FragColor = vec4(clamp(col, 0., 1.), 1.);
}`;
