import { COMMON } from './common';

// Preset 2: underwater abyss with bioluminescent deep sea creatures.
export const ABYSS = COMMON + /* glsl */ `
vec3 gGlow;
bool gAcc;

float seabed(vec2 p) {
  return -3.2 + 1.3 * noise2(p * .14) + .25 * noise2(p * .8) + 2.4 * smoothstep(.62, .9, noise2(p * .07 + 5.));
}
vec3 jellyCol(float i) { return .5 + .5 * cos(TAU * (i * .19 + vec3(.55, .78, .98))); }

float jelly(vec3 q, float ph, float idx) {
  float pulse = sin(ph);
  float rr = .62 * (1. + .12 * pulse);
  float bell = abs(length(q * vec3(1., 1.25 - .2 * pulse, 1.)) - rr) - .035;
  bell = max(bell, -q.y - .05);
  float a = atan(q.z, q.x), seg = TAU / 6.;
  a = mod(a + seg * .5, seg) - seg * .5;
  vec2 xz = length(q.xz) * vec2(cos(a), sin(a));
  float taper = clamp(1. + q.y / 2.6, 0., 1.);
  float tent = length(vec2(xz.x - .36 * (1. + .1 * pulse) - .09 * sin(q.y * 5. + ph), xz.y - .07 * sin(q.y * 4. + ph * 1.3))) - .03 * taper;
  tent = max(tent, max(q.y, -q.y - 2.5));
  float d = min(bell, tent) * .7;
  if (gAcc) gGlow += jellyCol(idx) * .005 / (.02 + d * d * 7.);
  return d;
}

float angler(vec3 p, vec4 P, vec4 F) {
  vec3 f = F.xyz, r = normalize(cross(vec3(0, 1, 0), f)), u = cross(f, r);
  vec3 q = p - P.xyz;
  q = vec3(dot(q, r), dot(q, u), dot(q, f)) / F.w;
  float d = (length(q / vec3(.42, .5, .8)) - 1.) * .42;
  d = max(d, -(length(q - vec3(0, -.14, .74)) - .34));
  float wag = .3 * sin(P.w);
  vec3 tq = q - vec3(wag * .5, 0., -1.05);
  d = min(d, (length(tq / vec3(.07, .42, .36)) - 1.) * .07);
  d = min(d, sdCapsule(q, vec3(0, .45, .4), vec3(0, .98, .95), .025));
  vec3 bulb = vec3(0, .98, 1.02);
  float dl = length(q - bulb);
  d = min(d, dl - .09);
  if (gAcc) {
    gGlow += vec3(.55, 1., .7) * .006 / (.004 + dl * dl * 3.);
    vec3 e = q; e.x = abs(e.x);
    float de = length(e - vec3(.3, .16, .5));
    gGlow += vec3(.5, .8, 1.) * .0012 / (.002 + de * de);
  }
  return d * F.w * .8;
}

vec2 map(vec3 p) {
  vec2 res = vec2((p.y - seabed(p.xz)) * .6, 0.);
  for (int i = 0; i < 8; i++) {
    vec4 J = uD[i];
    if (J.y < -100.) continue;
    vec3 q = p - J.xyz;
    float bd = length(q + vec3(0, 1.1, 0)) - 1.9;
    if (bd > .6) { if (bd < res.x) res.x = bd; continue; }
    float d = jelly(q, J.w, float(i));
    if (d < res.x) res = vec2(d, 1. + float(i) * .01);
  }
  for (int i = 0; i < 4; i++) {
    vec4 P = uD[8 + i * 2];
    if (P.y < -100.) continue;
    vec4 F = uD[9 + i * 2];
    float bd = length(p - P.xyz) - 1.6 * F.w;
    if (bd > .6) { if (bd < res.x) res.x = bd; continue; }
    float d = angler(p, P, F);
    if (d < res.x) res = vec2(d, 2.);
  }
  // Leviathan: only evaluated inside the ring it patrols.
  if (uD[16].y > -100.) {
    float ring = abs(length(p.xz) - 21.5) - 8.5;
    if (ring > .6) { if (ring < res.x) res.x = ring; }
    else {
      float d = 1e5;
      for (int i = 0; i < 11; i++) {
        vec4 A = uD[16 + i], B = uD[17 + i];
        d = min(d, sdTaper(p, A.xyz, B.xyz, A.w, B.w));
      }
      if (gAcc) gGlow += vec3(.05, .35, .8) * .006 / (.15 + d * d);
      if (d < res.x) res = vec2(d, 3.);
    }
  }
  return res;
}

vec3 water(vec3 rd) {
  vec3 c = mix(vec3(.0, .010, .026), vec3(.0, .075, .125), smoothstep(-.3, .9, rd.y));
  return c + vec3(.08, .22, .27) * pow(max(rd.y, 0.), 7.);
}

void main() {
  vec3 ro;
  vec3 rd = camRay(gl_FragCoord.xy, ro);
  ro.y = max(ro.y, seabed(ro.xz) + .8);
  gGlow = vec3(0.);
  gAcc = true;
  float t = .2;
  vec2 m = vec2(0.);
  bool hit = false;
  for (int i = 0; i < 72; i++) {
    m = map(ro + rd * t);
    if (m.x < .002 * t + .002) { hit = true; break; }
    t += m.x;
    if (t > 70.) break;
  }
  gAcc = false;
  vec3 glow = gGlow;
  if (!hit) t = 70.;
  vec3 col = water(rd);
  float bio = .35 + uP.x * 1.5 + uAudio.x;

  if (hit) {
    vec3 p = ro + rd * t;
    vec2 e = vec2(.012, -.012);
    vec3 n = normalize(e.xyy * map(p + e.xyy).x + e.yyx * map(p + e.yyx).x + e.yxy * map(p + e.yxy).x + e.xxx * map(p + e.xxx).x);
    float fres = pow(1. - max(dot(n, -rd), 0.), 2.5);
    if (m.y < .5) {
      float ca = noise4(vec3(p.xz * .9 + n.xz, T * .45), uW);
      ca = pow(1. - abs(ca * 2. - 1.), 6.);
      vec3 alb = mix(vec3(.05, .07, .08), vec3(.12, .12, .10), noise2(p.xz * 1.7));
      col = alb * (vec3(.02, .06, .08) + vec3(.25, .55, .6) * ca * max(n.y, 0.) * .8) + glow * .08 * alb;
    } else if (m.y < 1.5) {
      vec3 jc = jellyCol(fract(m.y) * 100.);
      col = jc * (.18 + 1.3 * fres) * bio;
    } else if (m.y < 2.5) {
      col = vec3(.012, .016, .02) + vec3(.1, .3, .35) * fres * .6 + glow * .05;
    } else {
      float spots = smoothstep(.72, .9, noise3(p * 1.4));
      col = vec3(.008, .012, .02) + vec3(.05, .2, .3) * fres + vec3(.1, .7, 1.) * spots * bio * .8;
    }
  }
  col = mix(water(rd), col, exp(-t * (.022 + uP.z * .11)));

  // Light shafts falling from the surface.
  float shafts = 0.;
  float tm = min(t, 26.);
  for (int i = 0; i < 10; i++) {
    float s = tm * (float(i) + hash21(gl_FragCoord.xy + float(i))) / 10.;
    vec3 q = ro + rd * s;
    float n = noise4(vec3(q.xz * .22 + q.y * .1, T * .06), uW * .3);
    shafts += smoothstep(.52, .85, n) * smoothstep(-3., 8., q.y) * exp(-s * .05);
  }
  col += vec3(.07, .3, .34) * shafts * .055;

  col += glow * bio * .6;
  // Marine snow.
  float snow = specks(gl_FragCoord.xy, 9., vec2(T * .05, T * .16), .55) + specks(gl_FragCoord.xy, 17., vec2(-T * .03, T * .1), .6) * .6;
  col += vec3(.35, .6, .65) * snow * .16 * (.4 + uP.y);
  fragColor = vec4(max(col, 0.), 1.);
}`;
