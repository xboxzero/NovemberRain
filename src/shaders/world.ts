import { COMMON } from './common';

// The world: a titan skeleton walking across sand dunes under a thunderstorm.
// `#define TIER` (0 minimal, 1 lite, 2 full) is prepended by the renderer, which
// falls back to a lower tier when a GPU cannot compile or run the higher one.
export const WORLD = COMMON + /* glsl */ `
#if TIER == 2
#define STEPS 130
#define SHADOW_STEPS 18
#define OCT 4
#elif TIER == 1
#define STEPS 84
#define SHADOW_STEPS 10
#define OCT 3
#else
#define STEPS 52
#define OCT 2
#endif

const vec3 MOON = vec3(-.3162, .4743, -.8222);
float gT;   // distance along the view ray, used to fade sub-pixel detail

// Must stay identical to dune() in engine/src/sim.rs: the titan's feet are planted on it.
float dune(vec2 p) {
  vec2 q = p * .03;
  float warp = 1.3 * sin(q.x * 1.1 + 1.3) + .6 * sin(q.x * 2.3 + q.y * .7 + .4) + uP.w * 1.2 * sin(uW * .3 + q.x * .9);
  float a = q.y * 2.4 + warp;
  float prof = .5 + .5 * sin(a + .6 * cos(a));
  float amp = .6 + .4 * sin(q.x * .7 - q.y * .5 + 2.);
  return 8. * amp * pow(max(prof, 0.), 1.4) + 1.2 * sin(q.x * .9 + .5) * sin(q.y * .6 + 1.7);
}

// Shading detail on top of the simulated height: footprints, wind ripples, grain.
float duneFine(vec2 p) {
  float h = dune(p);
  for (int i = 0; i < 6; i++) {
    vec4 f = uD[19 + i];
    vec2 d = p - f.xy;
    float r = length(d * vec2(1.25, .8));
    h += f.w * (-.75 * exp(-r * r * .45) + .22 * exp(-(r - 2.2) * (r - 2.2) * 1.4));
  }
  vec2 wd = normalize(uD[81].xy + vec2(1e-3, 0.));
  // ripples fade out before they become smaller than a pixel: no moire, more detail at 8K
  float px = gT / uRes.y;
  h += .034 * sin(dot(p, wd) * 4.6 + 2.6 * noise2(p * .31)) * smoothstep(.07, .02, px);
#if TIER > 0
  h += .012 * sin(dot(p, wd) * 17. + 4. * noise2(p * .9)) * smoothstep(.02, .005, px);
#endif
  return h + .04 * noise2(p * 1.9);
}

float bone(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.);
  float k = 2. * h - 1.;
  k *= k;
  return length(pa - ba * h) - r * (.7 + .55 * k * k);   // flared epiphyses
}

#if TIER > 0
// Anatomical skeleton. Each region sits behind a cheap bounding test.
float titan(vec3 p) {
  vec3 J0 = uD[0].xyz, J1 = uD[1].xyz, J2 = uD[2].xyz, J3 = uD[3].xyz, J4 = uD[4].xyz;
  float d = 1e5;
  vec3 SB = vec3(0., 0., -1.15);   // the spine runs down the back of the torso

  float bt = sdCapsule(p, J0, J3, 5.8);
  if (bt < 1.) {
    // vertebral column: lumbar, thoracic, cervical
    float sp = min(bone(p, J0 + SB * .8, J1 + SB, .5), min(bone(p, J1 + SB, J2 + SB, .46), bone(p, J2 + SB, J3 + SB * .3, .4)));
    sp -= .11 * smoothstep(.5, 0., sp) * abs(sin(p.y * 3.6));
    d = sp;
    // rib cage: egg-shaped shell cut into ribs that slope down toward the sternum,
    // open at the costal arch
    vec3 c = mix(J1, J2, .7);
    vec3 q = p - c;
    float taper = 1. + .11 * q.y;
    float shell = abs(sdEll(vec3(q.x * taper, q.y, q.z * taper), vec3(2.9, 3.4, 2.1))) - .15;
    float ribs = max(shell, abs(mod(q.y + .34 * q.z + .5, .92) - .46) - .2);
    ribs = max(ribs, max(-q.y - 3.1, q.y - 3.2));
    ribs = max(ribs, -max(length(vec2(q.x * .85, q.y + 3.6)) - 2.3, -q.z));
    d = min(d, ribs);
    d = min(d, sdCapsule(q, vec3(0., 2.5, 1.95), vec3(0., -.7, 2.12), .27));   // sternum
    // shoulder girdle: clavicles and scapulae
    vec3 qm = vec3(abs(q.x), q.y, q.z);
    vec3 sh = uD[8].xyz - c;
    sh.x = abs(sh.x);
    d = min(d, sdCapsule(qm, vec3(.3, 2.6, 1.85), sh + vec3(-.3, .1, .3), .2));
    d = min(d, sdEll(qm - sh - vec3(-1.2, -1.5, -1.0), vec3(1.0, 1.5, .2)));
    // pelvis: iliac bowl, sacrum, pubic arch, hip sockets
    q = p - J0;
    qm = vec3(abs(q.x), q.y, q.z);
    float bowl = abs(sdEll(q - vec3(0., .2, -.1), vec3(2.9, 1.9, 1.7))) - .17;
    bowl = max(bowl, max(q.y - 1.7, -q.y - 1.0));
    bowl = max(bowl, -max(length(vec2(q.x * .8, q.y - 1.9)) - 1.7, -q.z));
    d = min(d, bowl);
    d = min(d, sdCapsule(q, vec3(0., 1.3, -1.5), vec3(0., -.9, -1.2), .5));
    d = min(d, sdCapsule(qm, vec3(0., -1.05, 1.25), vec3(1.6, -.8, .5), .26));
    d = min(d, length(qm - vec3(2.1, -.4, 0.)) - .75);
  } else d = min(d, bt);

  // skull
  float bs = length(p - J4) - 4.1;
  if (bs < 1.) {
    vec3 q = p - J4;
    vec3 qm = vec3(abs(q.x), q.y, q.z);
    d = min(d, sdCapsule(p, J3 + SB * .3, J4 + vec3(0., -1.2, -.5), .38));   // cervical spine
    float sk = sdEll(q - vec3(0., .25, -.25), vec3(1.55, 1.6, 1.9));          // cranium
    sk = smin(sk, sdEll(q - vec3(0., -.9, 1.0), vec3(1.05, .9, .75)), .3);    // maxilla
    sk = smin(sk, sdCapsule(qm, vec3(0., .2, 1.7), vec3(1.1, .1, 1.35), .22), .15);   // brow ridge
    sk = max(sk, -(length(qm - vec3(.62, -.2, 1.6)) - .48));                  // orbits
    sk = max(sk, -sdEll(q - vec3(0., -.8, 1.8), vec3(.22, .4, .3)));          // nasal aperture
    sk = min(sk, sdCapsule(qm, vec3(.95, -.6, 1.3), vec3(1.5, -.5, .2), .14)); // zygomatic arch
    float teeth = .05 * sin(atan(q.x, q.z - .5) * 24.);
    sk = min(sk, sdEll(q - vec3(0., -1.75, 1.15), vec3(.85, .22, .6)) + teeth);
    // mandible: chin arc and the two rami up to the jaw joint
    float j = .15 + .3 * uAudio.x;
    vec3 jq = vec3(qm.x, q.y + 2.25 + j, q.z - .9);
    float jaw = min(sdCapsule(jq, vec3(0., 0., .75), vec3(1.15, .2, -.6), .26), sdCapsule(jq, vec3(1.15, .2, -.6), vec3(1.3, 1.5 + j, -.9), .24));
    jaw = min(jaw, sdEll(jq - vec3(0., .32, .55), vec3(.8, .2, .5)) + teeth);
    d = min(d, min(sk, jaw));
  } else d = min(d, bs);

  for (int s = 0; s < 2; s++) {
    float sx = float(s) * 2. - 1.;
    // arm: humerus, radius + ulna, hand
    vec3 A = uD[5 + s * 3].xyz, B = uD[6 + s * 3].xyz, C = uD[7 + s * 3].xyz;
    vec3 u = normalize(C - B);
    float ba = min(sdCapsule(p, A, B, 2.), sdCapsule(p, B, C + u * 2.6, 2.));
    if (ba < 1.) {
      d = min(d, min(bone(p, A, B, .42), length(p - A) - .62));
      vec3 off = vec3(.27, 0., 0.);
      d = min(d, min(bone(p, B + off, C + off, .25), bone(p, B - off, C - off, .23)));
      vec3 hq = p - C;
      d = min(d, sdEll(hq - u * .7, vec3(.55, .8, .26)));                      // palm
      vec3 fq = vec3(abs(abs(hq.x) - .24) - .12, hq.y, hq.z);
      d = min(d, sdCapsule(fq, u * 1.3, u * 2.5 + vec3(0., 0., .3), .11));     // fingers
      d = min(d, sdCapsule(hq, u * .5 + vec3(sx * .5, 0., .1), u * 1.5 + vec3(sx * .9, 0., .4), .13));   // thumb
    } else d = min(d, ba);
    // leg: femur with neck and trochanter, patella, tibia + fibula, foot
    vec3 H = uD[11 + s * 3].xyz, K = uD[12 + s * 3].xyz, F = uD[13 + s * 3].xyz;
    float bl = min(min(sdCapsule(p, H, K, 2.1), sdCapsule(p, K, F, 1.9)), length(p - F - vec3(0., -.3, 1.2)) - 2.3);
    if (bl < 1.) {
      vec3 Tr = H + vec3(sx * .85, -.55, 0.);
      d = min(d, min(sdCapsule(p, H, Tr, .36), length(p - H) - .62));
      d = min(d, bone(p, Tr, K, .52));
      d = min(d, min(length(p - K) - .62, length(p - K - vec3(0., .05, .6)) - .36));
      d = min(d, bone(p, K, F, .42));
      d = min(d, bone(p, K + vec3(sx * .5, -.3, -.1), F + vec3(sx * .42, 0., -.05), .19));
      vec3 fq = p - F;
      d = min(d, length(fq - vec3(0., -.3, -.55)) - .48);                      // heel
      d = min(d, sdTaper(vec3(fq.x * .62, fq.y, fq.z), vec3(0., -.15, 0.), vec3(0., -.5, 2.0), .42, .3));   // arch
      vec3 tq = vec3(abs(abs(fq.x) - .3) - .15, fq.y, fq.z);
      d = min(d, sdCapsule(tq, vec3(0., -.55, 2.0), vec3(0., -.6, 2.85), .13)); // toes
    } else d = min(d, bl);
  }
  return d;
}
#else
// Minimal skeleton for weak GPUs.
float titan(vec3 p) {
  vec3 J0 = uD[0].xyz, J2 = uD[2].xyz, J4 = uD[4].xyz;
  float d = min(bone(p, J0, J2, .55), sdCapsule(p, J2, J4, .42));
  for (int s = 0; s < 2; s++) {
    d = min(d, min(bone(p, uD[5 + s * 3].xyz, uD[6 + s * 3].xyz, .45), bone(p, uD[6 + s * 3].xyz, uD[7 + s * 3].xyz, .38)));
    d = min(d, min(bone(p, uD[11 + s * 3].xyz, uD[12 + s * 3].xyz, .6), bone(p, uD[12 + s * 3].xyz, uD[13 + s * 3].xyz, .48)));
    d = min(d, sdCapsule(p, uD[13 + s * 3].xyz, uD[13 + s * 3].xyz + vec3(0., -.3, 2.), .5));
  }
  d = min(d, sdCapsule(p, uD[5].xyz, uD[8].xyz, .32));
  vec3 q = p - J0;
  d = min(d, (length(q / vec3(2.6, 1.2, 1.3)) - 1.) * 1.1);
  q = p - mix(uD[1].xyz, J2, .7);
  float ribs = abs(length(q / vec3(2.8, 3.2, 2.0)) - 1.) * 1.9 - .17;
  d = min(d, max(ribs, abs(mod(q.y + .5, 1.1) - .55) - .27));
  q = p - J4;
  float sk = length(q * vec3(1., .92, .85)) - 1.75;
  sk = max(sk, -(length(vec3(abs(q.x), q.y, q.z) - vec3(.66, -.1, 1.55)) - .5));
  return min(d, min(sk, length((q - vec3(0., -1.6, .5)) * vec3(1., 1.5, .95)) - 1.05));
}
#endif

float boundT(vec3 p) {
  return length(max(abs(p - uD[17].xyz) - vec3(7., 15., 8.), 0.));
}

vec2 map(vec3 p) {
  float dT = p.y > 10.6 ? p.y - 9.6 : (p.y - dune(p.xz)) * .7;
  vec2 res = vec2(dT, 0.);
  float bd = boundT(p);
  if (bd > 1.) { if (bd < res.x) res.x = bd; }
  else { float d = titan(p); if (d < res.x) res = vec2(d, 1.); }
  return res;
}

#ifdef SHADOW_STEPS
// Soft shadow of the titan (the only tall occluder) toward the key light.
float shadow(vec3 p, vec3 l, float maxd) {
  vec3 oc = p - uD[17].xyz;
  float b = dot(oc, l), h = b * b - dot(oc, oc) + 17. * 17.;
  if (h < 0.) return 1.;
  h = sqrt(h);
  float t = max(-b - h, .9), t1 = min(-b + h, maxd);
  float res = 1.;
  for (int i = 0; i < SHADOW_STEPS; i++) {
    if (t > t1) break;
    float d = titan(p + l * t);
    if (d < .008) return 0.;
    res = min(res, 9. * d / t);
    t += clamp(d, .3, 3.5);
  }
  return clamp(res, 0., 1.);
}
#endif

float clouds(vec2 p, float z) {
  float a = .5, s = 0.;
  for (int i = 0; i < OCT; i++) { s += a * noise3(vec3(p, z)); p = p * 2.03 + 7.1; a *= .5; }
  return s;
}

vec3 sky(vec3 rd, vec3 ro, float flash) {
  vec2 cuv = rd.xz / (abs(rd.y) + .12);
  float c = clouds(cuv * .8 + uD[81].xy * .004 * T + vec2(T * .02, 0.), uW * .25);
  float dens = smoothstep(.25, .72, c);
  vec3 col = mix(vec3(.010, .014, .03), vec3(.105, .115, .16), dens);
  float mo = max(dot(rd, MOON), 0.);
  col += vec3(.5, .55, .7) * (pow(mo, 40.) * .5 + pow(mo, 600.) * 2.) * (1. - dens * .92);
  float lit = 0.;
  for (int b = 0; b < 4; b++) {
    float I = uD[77 + b].w;
    vec3 bd = normalize(uD[37 + b * 10].xyz - ro);
    lit += I * (.10 + 1.2 * pow(max(dot(rd, bd), 0.), 5.));
  }
  col += vec3(.52, .6, .9) * lit * (.2 + dens);
  return mix(col, vec3(.045, .042, .05), exp(-abs(rd.y) * 9.));
}

void main() {
  vec2 fc = gl_FragCoord.xy + uOrigin;
  vec3 ro = uCamPos;
  vec3 rd = camRay(fc);
  float storm = uP.x, rainAmt = uP.y, sand = uP.z;
  float charge = uD[18].y;

  // Pick the light that casts the titan's shadow: the brightest strike, else the moon.
  float keyI = .03, flash = 0.;
  vec3 keyPos = vec3(0.);
  float keyB = -1.;
  for (int b = 0; b < 4; b++) {
    vec4 s = uD[77 + b];
    flash += s.w;
    if (s.w > keyI) { keyI = s.w; keyB = float(b); keyPos = s.xyz + vec3(0, 10, 0); }
  }

  float t = .3;
  vec2 m = vec2(0.);
  bool hit = false;
  for (int i = 0; i < STEPS; i++) {
    m = map(ro + rd * t);
    if (m.x < .0012 * t + .002) { hit = true; break; }
    t += m.x;
    if (t > 420.) break;
  }
  if (!hit) t = 420.;

  vec3 col = sky(rd, ro, flash);
  if (hit) {
    vec3 p = ro + rd * t;
    gT = t;
    vec3 n, alb;
    float gloss;
    if (m.y < .5) {
      float e = .03 + .0022 * t;
      float h0 = duneFine(p.xz);
      n = normalize(vec3(h0 - duneFine(p.xz + vec2(e, 0)), e, h0 - duneFine(p.xz + vec2(0, e))));
      alb = mix(vec3(.60, .42, .25), vec3(.80, .62, .40), noise2(p.xz * .2));
      // darker damp sand in the troughs and under rain; glittering quartz close up
      float wet = rainAmt * (.35 + .65 * smoothstep(3., 0., p.y));
      alb *= mix(1., .55, wet);
      gloss = wet * .5 + .5 * step(.992, hash21(floor(p.xz * 55.))) * smoothstep(.06, .01, t / uRes.y);
    } else {
      vec2 k = vec2(1., -1.) * (.012 + .0012 * t);
      n = normalize(k.xyy * titan(p + k.xyy) + k.yyx * titan(p + k.yyx) + k.yxy * titan(p + k.yxy) + k.xxx * titan(p + k.xxx));
      alb = vec3(.80, .76, .65) * (.72 + .22 * noise3(p * 1.4) + .12 * noise3(p * 5.3));   // weathered bone
#if TIER == 2
      alb *= .55 + .45 * smoothstep(-.4, .5, titan(p + n * .5));   // cavity occlusion
#endif
      gloss = .2 + rainAmt * .35;
    }
    float sh = 1.;
#ifdef SHADOW_STEPS
    vec3 ld = keyB < 0. ? MOON : normalize(keyPos - p);
    sh = shadow(p + n * .3, ld, keyB < 0. ? 80. : length(keyPos - p));
#endif
    vec3 c = alb * vec3(.030, .038, .066) * (.6 + .4 * n.y);
    c += alb * vec3(.16, .19, .28) * max(dot(n, MOON), 0.) * (keyB < 0. ? sh : 1.);
    for (int b = 0; b < 4; b++) {
      vec4 s = uD[77 + b];
      vec3 l = s.xyz + vec3(0, 10, 0) - p;
      float d2 = dot(l, l);
      vec3 ln = l * inversesqrt(d2);
      float vis = abs(float(b) - keyB) < .5 ? sh : 1.;
      vec3 lc = vec3(.72, .82, 1.) * s.w;
      c += lc * vis * (440. / (d2 + 90.)) * (alb * max(dot(n, ln), 0.) + gloss * pow(max(dot(n, normalize(ln - rd)), 0.), 48.));
      c += lc * alb * .16 * (n.y * .5 + .5);   // flash bouncing off the cloud deck
    }
    col = c;
    if (m.y > .5) {
      float fres = pow(1. - max(dot(n, -rd), 0.), 3.);
      col += vec3(.35, .4, .55) * fres * (.12 + flash * .5);
      vec3 he = p - uD[4].xyz;
      col += vec3(1., .22, .04) * (.5 + storm * 2. + uAudio.x * 1.5) * .5 / (1. + dot(he, he) * .6) * smoothstep(-.2, .6, n.z);
      // St. Elmo's fire: after a direct hit the charge crawls over the bones
      float arc = smoothstep(.62, .7, noise3(p * 1.7 + vec3(0., -T * 9., uW)));
      col += vec3(.45, .65, 1.) * charge * (fres * 2.5 + arc * 2.5);
    }
  }

  // Aerial perspective: blowing sand hugging the ground + storm haze, lit by every strike.
  float fogAmt = 1. - exp(-t * (.0012 + sand * .009));
  vec3 pe = ro + rd * min(t, 140.);
  float low = exp(-max(pe.y - dune(pe.xz), 0.) * .22);
  fogAmt = clamp(fogAmt * (.75 + .9 * low * noise3(vec3(pe.xz * .06 - uD[81].xy * T * .02, T * .15))), 0., 1.);
  vec3 fogCol = vec3(.020, .020, .026) + vec3(.045, .033, .02) * sand;
  for (int b = 0; b < 4; b++) {
    vec3 bd = normalize(uD[77 + b].xyz + vec3(0, 12, 0) - ro);
    fogCol += vec3(.5, .56, .74) * uD[77 + b].w * (.025 + .16 * pow(max(dot(rd, bd), 0.), 4.));
  }
  col = mix(col, fogCol, fogAmt);

  // Dust thrown up by footfalls and ground strikes (ballistic puffs advected by wind).
  float dens = 0.;
  float tr;
  for (int i = 0; i < 12; i++) {
    vec4 D = uD[25 + i];
    if (D.w < .01) continue;
    float size = 1.3 + (1. - D.w) * 5.;
    float d = pointDist(ro, rd, D.xyz, tr);
    if (tr < t + size) dens += D.w * exp(-d * d / (size * size)) * (.6 + .6 * noise3((ro + rd * tr) * .6 + T * .5));
  }
  col = mix(col, vec3(.10, .08, .055) * (1. + flash * 1.5) + fogCol * .6, clamp(dens * .4, 0., .7));

  // Lightning: stepped leaders and return strokes, as angular distance from the ray.
  vec3 glow = vec3(0.);
  for (int b = 0; b < 4; b++) {
    for (int i = 0; i < 9; i++) {
      vec4 A = uD[37 + b * 10 + i];
      if (A.w <= 0.) continue;
      float d = segDist(ro, rd, A.xyz, uD[38 + b * 10 + i].xyz, tr);
      if (tr > t) continue;
      float a = d / max(tr, 1.);
      glow += A.w * (.000022 / (a * a + .000004) + .00045 / (a * a + .001)) * vec3(.62, .72, 1.);
    }
  }
  col += glow;

  // Burning eye sockets.
  for (int s = 0; s < 2; s++) {
    vec3 eye = uD[4].xyz + vec3(float(s) * 1.24 - .62, -.2, 1.3);
    float d = pointDist(ro, rd, eye, tr);
    vec3 ec = mix(vec3(1., .2, .03), vec3(.5, .7, 1.), clamp(charge, 0., 1.));
    if (tr < t + 1.2) col += ec * (.5 + storm * 2. + uAudio.x * 1.5 + charge * 4.) * (.03 / (.02 + d * d) + .03 / (1. + d * d * .25));
  }

  // Rain, slanted by the wind as seen from this camera.
  if (rainAmt > .01) {
    float slant = clamp(dot(uD[81].xy, uCamR.xz) * .04, -.9, .9);
    float rain = 0.;
    for (int l = 0; l < 3; l++) {
      float fl = float(l);
      vec2 r = fc / uRes.y * (8. + 7. * fl);
      r.x += r.y * slant;
      float h = hash11(floor(r.x * 6.) + fl * 37.);
      float y = fract(r.y * .16 + T * (2.6 + h * 2.) + h * 10.);
      rain += smoothstep(.8, 1., y) * step(1. - rainAmt * .85, h) * smoothstep(.2, 0., abs(fract(r.x * 6.) - .5));
    }
    col += rain * (vec3(.012, .014, .02) + flash * .12);
  }
  col += uAudio.x * vec3(.012, .016, .03);

  // Expose, tone-map and encode here so every later buffer can be plain 8-bit.
  col = aces(max(col, 0.) * uP2.x);
  col = pow(col, vec3(1. / 2.2));
  col += (hash21(fc) - .5) / 255.;   // dither away banding
  gl_FragColor = vec4(col, 1.);
}`;
