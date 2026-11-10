// Compositing (feedback trails, bloom, kaleidoscope, glitch, camera / video mixing)
// and the final grade to the screen.

export const COMPOSITE = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene, uPrev, uCam, uVid;
uniform vec2 uRes;
uniform float uTime, uFeedback, uBloom, uKaleido, uGlitch, uCamMix, uVidMix;
uniform vec4 uAudio;
out vec4 fragColor;

float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 lin(vec3 c) { return c * c; }

void main() {
  vec2 uv = vUv;
  float asp = uRes.x / uRes.y;
  if (uKaleido > .01) {
    vec2 c = uv - .5; c.x *= asp;
    float a = atan(c.y, c.x) + uTime * .05, r = length(c);
    float seg = 6.2831853 / floor(3. + uKaleido * 9.);
    a = abs(mod(a, seg) - seg * .5);
    vec2 k = vec2(cos(a), sin(a)) * r; k.x /= asp;
    uv = mix(uv, k + .5, smoothstep(0., .12, uKaleido));
    uv = 1. - abs(1. - mod(uv, 2.));
  }
  float gl = uGlitch * (.6 + uAudio.x);
  if (gl > .01) {
    float row = floor(uv.y * 24.), tick = floor(uTime * 14.);
    float h = h21(vec2(row, tick));
    if (h < gl * .35) uv.x = fract(uv.x + (h21(vec2(tick, row)) - .5) * .25 * gl);
  }
  vec2 ca = (uv - .5) * (.004 + gl * .03);
  vec3 col = vec3(texture(uScene, uv + ca).r, texture(uScene, uv).g, texture(uScene, uv - ca).b);

  // Bloom from the HDR mip chain.
  vec3 bl = textureLod(uScene, uv, 2.5).rgb * .5 + textureLod(uScene, uv, 4.).rgb * .3 + textureLod(uScene, uv, 5.5).rgb * .2 + textureLod(uScene, uv, 7.).rgb * .15;
  col += max(bl - .06, 0.) * uBloom * 1.5;

  // Live camera and video / screen-capture layers.
  if (uCamMix > .001) {
    vec3 cam = lin(texture(uCam, vec2(1. - uv.x, uv.y)).rgb);
    col = mix(col, cam + col * .65, uCamMix);
  }
  if (uVidMix > .001) {
    vec3 vid = lin(texture(uVid, uv).rgb);
    col = mix(col, vid + col * .65, uVidMix);
  }

  // Feedback trails: the previous frame, slightly zoomed and rotated.
  if (uFeedback > .005) {
    vec2 p = vUv - .5; p.x *= asp;
    float a = .004 + .01 * uAudio.y;
    p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p * (.992 - .012 * uAudio.x);
    p.x /= asp;
    vec3 prev = texture(uPrev, p + .5).rgb;
    col = max(col, prev * (.6 + .39 * uFeedback));
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
  col += (h21(gl_FragCoord.xy + fract(uTime) * 91.) - .5) * (.018 + uGlitch * .12);
  col *= 1. - uGlitch * .25 * step(.5, fract(gl_FragCoord.y * .5));
  fragColor = vec4(clamp(col, 0., 1.), 1.);
}`;
