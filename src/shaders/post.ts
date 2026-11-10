// Psychedelic FX chain and final grade.
//
// The chain has two stages, each of which can be wired in SERIAL (every effect
// feeds the next) or PARALLEL (every effect processes the clean signal and the
// results are summed like sends on a mixing desk):
//   coordinate stage: kaleidoscope -> tunnel -> liquid -> glitch
//   colour stage:     spectrum -> neon edges -> posterize
// Feedback trails are a loop around the whole chain.

export const COMPOSITE = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene, uPrev, uCam, uVid;
uniform vec2 uRes;
uniform float uTime, uRoute, uLod, uBloom, uRgb, uEdge, uPoster, uGlitch, uCamMix, uVidMix;
uniform vec3 uKal;    // amount, segments, spin
uniform vec4 uFb;     // amount, zoom, twist, colour cycle
uniform vec2 uTun;    // amount, speed
uniform vec2 uLiq;    // amount, scale
uniform vec3 uAcid;   // amount, bands, flow
uniform vec4 uAudio;
out vec4 fragColor;

#define TAU 6.2831853
float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 lin(vec3 c) { return c * c; }
float luma(vec3 c) { return dot(c, vec3(.299, .587, .114)); }
vec2 wrap(vec2 uv) { return 1. - abs(1. - mod(uv, 2.)); }
vec3 hueRot(vec3 c, float a) {
  const vec3 k = vec3(.57735);
  float ca = cos(a), sa = sin(a);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1. - ca);
}
float asp;

// ---- coordinate effects: each maps a uv to a new uv ------------------------------
vec2 fxKal(vec2 uv) {
  vec2 c = uv - .5; c.x *= asp;
  float n = floor(2. + uKal.y * 14.);
  float seg = TAU / n;
  float a = atan(c.y, c.x) + uTime * (uKal.z - .2) * .6;
  a = abs(mod(a, seg) - seg * .5);
  vec2 k = vec2(cos(a), sin(a)) * length(c); k.x /= asp;
  return k + .5;
}
vec2 fxTun(vec2 uv) {
  vec2 c = uv - .5; c.x *= asp;
  float r = length(c) + 1e-4;
  // log-polar: equal steps in log(r) are equal zoom factors, so the picture recurses forever
  return vec2(atan(c.y, c.x) / TAU * 2. + .5 + sin(uTime * .1) * .1, .35 * log(r) - uTime * (uTun.y - .15) * .35);
}
vec2 fxLiq(vec2 uv) {
  float sc = 2. + uLiq.y * 16.;
  float t = uTime * .6;
  vec2 d = vec2(sin(uv.y * sc + t * 1.3) + .5 * sin(uv.y * sc * 2.3 - t + uv.x * 3.),
                cos(uv.x * sc * 1.1 - t * 1.1) + .5 * cos(uv.x * sc * 2.1 + t * .7 + uv.y * 4.));
  return uv + d * .035 * (1. + uAudio.x);
}
vec2 fxGli(vec2 uv) {
  float row = floor(uv.y * 24.), tick = floor(uTime * 14.);
  float h = h21(vec2(row, tick));
  if (h < .4) uv.x += (h21(vec2(tick, row)) - .5) * .3;
  return uv;
}

vec3 tap(vec2 uv) {
  uv = wrap(uv);
  vec2 ca = (uv - .5) * (.002 + uRgb * .05 + uGlitch * .02);
  vec3 col = vec3(texture(uScene, uv + ca).r, texture(uScene, uv).g, texture(uScene, uv - ca).b);
  vec3 bl = textureLod(uScene, uv, 2.5 + uLod).rgb * .5 + textureLod(uScene, uv, 4. + uLod).rgb * .3
          + textureLod(uScene, uv, 5.5 + uLod).rgb * .2 + textureLod(uScene, uv, 7. + uLod).rgb * .15;
  return col + max(bl - .06, 0.) * uBloom * 1.5;
}

// ---- colour effects ----------------------------------------------------------------
vec3 fxAcid(vec3 c) {
  float l = luma(c); l = l / (1. + l);
  vec3 pal = .5 + .5 * cos(TAU * (l * (1. + uAcid.y * 9.) + uTime * (uAcid.z - .1) * .5 + vec3(0., .33, .67)));
  return pal * (.15 + 2.2 * l);
}
vec3 fxEdge(vec3 c, vec2 uv) {
  vec2 px = 1.5 / uRes * (1. + uRes.y / 1080.);
  float l0 = luma(texture(uScene, wrap(uv + vec2(px.x, 0.))).rgb), l1 = luma(texture(uScene, wrap(uv - vec2(px.x, 0.))).rgb);
  float l2 = luma(texture(uScene, wrap(uv + vec2(0., px.y))).rgb), l3 = luma(texture(uScene, wrap(uv - vec2(0., px.y))).rgb);
  vec2 g = vec2(l0 - l1, l2 - l3);
  float e = length(g) / (.02 + .5 * (l0 + l1 + l2 + l3));
  vec3 neon = .5 + .5 * cos(atan(g.y, g.x) + uTime * .7 + vec3(0., 2.1, 4.2));
  return c * .12 + neon * smoothstep(.15, .9, e) * 1.6;
}
vec3 fxPost(vec3 c) {
  float levels = mix(9., 2.5, uPoster);
  vec3 q = c / (1. + c);
  q = floor(q * levels + .5) / levels;
  q = mix(q, abs(sin(q * 3.14159 * 1.5)), uPoster * .6);   // solarise
  return q / max(1. - q, .08);
}

void main() {
  asp = uRes.x / uRes.y;
  vec2 uv0 = vUv;
  float gl = uGlitch * (.6 + uAudio.x);
  bool parallel = uRoute > .5;
  vec3 col;
  vec2 uv = uv0;

  if (!parallel) {
    // SERIAL: one signal, each effect feeds the next.
    uv = mix(uv, fxKal(uv), smoothstep(0., .15, uKal.x));
    if (uTun.x > .003) uv = mix(uv, fxTun(uv), uTun.x);
    if (uLiq.x > .003) uv = mix(uv, fxLiq(uv), uLiq.x);
    if (gl > .01) uv = mix(uv, fxGli(uv), step(.5, gl + h21(vec2(floor(uTime * 9.), 3.)) * .6));
    col = tap(uv);
    if (uAcid.x > .003) col = mix(col, fxAcid(col), uAcid.x);
    if (uEdge > .003) col = mix(col, fxEdge(col, uv), uEdge);
    if (uPoster > .003) col = mix(col, fxPost(col), uPoster);
  } else {
    // PARALLEL: every effect gets the clean signal; outputs are summed and normalised.
    vec3 dry = tap(uv0);
    col = dry;
    float wsum = 1.;
    if (uKal.x > .003) { col += tap(fxKal(uv0)) * uKal.x * 1.5; wsum += uKal.x * 1.5; }
    if (uTun.x > .003) { col += tap(fxTun(uv0)) * uTun.x * 1.5; wsum += uTun.x * 1.5; }
    if (uLiq.x > .003) { col += tap(fxLiq(uv0)) * uLiq.x * 1.5; wsum += uLiq.x * 1.5; }
    if (gl > .01) { col += tap(fxGli(uv0)) * gl; wsum += gl; }
    if (uAcid.x > .003) { col += fxAcid(dry) * uAcid.x * 1.5; wsum += uAcid.x * 1.5; }
    if (uEdge > .003) { col += fxEdge(dry, uv0) * uEdge * 1.5; wsum += uEdge * 1.5; }
    if (uPoster > .003) { col += fxPost(dry) * uPoster * 1.5; wsum += uPoster * 1.5; }
    col /= mix(wsum, sqrt(wsum), .5);   // keep some of the summed energy: layers glow
  }

  // Live camera and video / screen-capture layers.
  if (uCamMix > .001) col = mix(col, lin(texture(uCam, vec2(1. - uv.x, uv.y)).rgb) + col * .65, uCamMix);
  if (uVidMix > .001) col = mix(col, lin(texture(uVid, wrap(uv)).rgb) + col * .65, uVidMix);

  // Feedback loop: the previous frame, zoomed, twisted and colour-cycled.
  if (uFb.x > .005) {
    vec2 p = vUv - .5; p.x *= asp;
    float a = (uFb.z - .5) * .12 + .01 * uAudio.y;
    p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p * (1. - (uFb.y - .5) * .08 - .012 * uAudio.x);
    p.x /= asp;
    vec3 prev = texture(uPrev, p + .5).rgb;
    if (uFb.w > .003) prev = max(hueRot(prev, uFb.w * .5), 0.);
    col = max(col, prev * (.6 + .395 * uFb.x));
  }
  fragColor = vec4(min(col, 40.), 1.);
}`;

export const FINAL = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uTime, uHue, uSat, uBright, uContrast, uGlitch;
out vec4 fragColor;

float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.); }
vec3 hueRot(vec3 c, float a) {
  const vec3 k = vec3(.57735);
  float ca = cos(a), sa = sin(a);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1. - ca);
}

void main() {
  vec3 col = texture(uTex, vUv).rgb;
  col *= pow(2., (uBright - .5) * 4.);
  col = aces(col);
  col = pow(col, vec3(1. / 2.2));
  if (uHue > .002) col = max(hueRot(col, uHue * 6.2831853), 0.);
  float l = dot(col, vec3(.299, .587, .114));
  col = mix(vec3(l), col, uSat * 2.);
  col = (col - .5) * (.4 + uContrast * 1.2) + .5;
  vec2 v = vUv - .5;
  col *= 1. - dot(v, v) * .55;
  col += (h21(gl_FragCoord.xy + fract(uTime) * 91.) - .5) * (.014 + uGlitch * .12);
  col *= 1. - uGlitch * .25 * step(.5, fract(gl_FragCoord.y * .5));
  fragColor = vec4(clamp(col, 0., 1.), 1.);
}`;
