import { COMMON } from './common';

// The world: a titan skeleton walking across sand dunes under a thunderstorm.
// Terrain, skeleton, lightning, dust and the 4D tesseract all read the state
// integrated by the Rust simulation (uD).
export const WORLD = COMMON + /* glsl */ `
const vec3 MOON = vec3(-.3162, .4743, -.8222);
float gT;         // distance along the view ray, used to fade sub-pixel detail
vec3 gKeyDir;     // direction of the shadow-casting light
float gKeyI;      // brightness of the strongest lightning strike
int gKey;

// Must stay identical to dune() in engine/src/sim.rs: the titan's feet are planted on it.
float dune(vec2 p) {
  vec2 q = p * .05;
  float warp = sin(q.y * .9 + 1.3) * 1.2 + sin(q.x * .37 + q.y * .61) * .8 + uQ.y * 1.4 * sin(uW * .3 + q.y * .5);
  float a = q.x * 1.7 + warp;
  float crest = 1. - abs(sin(a + .45 * sin(2. * a)));
  float amp = .55 + .45 * sin(q.x * .31 - q.y * .43 + 2.);
  return 4.2 * pow(max(crest, 0.), 1.5) * amp + 1.1 * sin(q.x * .83 + .5) * sin(q.y * .71 + 1.7);
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
  vec2 wd = normalize(uD[110].xy + vec2(1e-3, 0.));
  // ripples fade out before they become smaller than a pixel (no moire at any resolution)
  float px = gT / uRes.y;
  h += .034 * sin(dot(p, wd) * 4.6 + 2.6 * noise2(p * .31)) * smoothstep(.07, .02, px);
  h += .012 * sin(dot(p, wd) * 17. + 4. * noise2(p * .9)) * smoothstep(.02, .005, px);
  return h + .04 * noise2(p * 1.9);
}

float bone(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.);
  float k = 2. * h - 1.;
  k *= k;
  return length(pa - ba * h) - r * (.7 + .55 * k * k);
}

float titan(vec3 p) {
  vec3 J0 = uD[0].xyz, J1 = uD[1].xyz, J2 = uD[2].xyz, J3 = uD[3].xyz, J4 = uD[4].xyz;
  float d = bone(p, J0, J1, .55);
  d = min(d, bone(p, J1, J2, .55));
  d = min(d, bone(p, J2, J3, .45));
  d = min(d, sdCapsule(p, J3, J4, .4));
  d -= .1 * smoothstep(.6, 0., d) * abs(sin(p.y * 3.2));   // vertebrae
  for (int s = 0; s < 2; s++) {
    int a = 5 + s * 3, l = 11 + s * 3;
    // paired forearm / shin bones (radius + ulna, tibia + fibula)
    vec3 off = vec3(.26, 0., 0.);
    d = min(d, bone(p, uD[a].xyz, uD[a + 1].xyz, .45));
    d = min(d, bone(p, uD[a + 1].xyz + off, uD[a + 2].xyz + off, .25));
    d = min(d, bone(p, uD[a + 1].xyz - off, uD[a + 2].xyz - off, .25));
    vec3 hq = p - uD[a + 2].xyz - vec3(0, -.5, .1);
    d = min(d, length(hq) - .55);
    hq.x = abs(hq.x);
    d = min(d, sdCapsule(hq, vec3(.12, -.3, 0.), vec3(.2, -1.5, .25), .11));
    d = min(d, sdCapsule(hq, vec3(.38, -.2, 0.), vec3(.52, -1.25, .2), .1));
    d = min(d, bone(p, uD[l].xyz, uD[l + 1].xyz, .6));
    d = min(d, bone(p, uD[l + 1].xyz + off, uD[l + 2].xyz + off, .34));
    d = min(d, bone(p, uD[l + 1].xyz - off, uD[l + 2].xyz - off * 1.2, .22));
    d = min(d, sdCapsule(p, uD[l + 2].xyz, uD[l + 2].xyz + vec3(0., -.25, 2.), .5));
  }
  d = min(d, sdCapsule(p, uD[5].xyz, uD[8].xyz, .32));
  vec3 q = p - J0;
  float pel = (length(q / vec3(2.4, 1.15, 1.25)) - 1.) * 1.1;
  pel = max(pel, -(length(q - vec3(0., .5, .9)) - 1.25));
  d = min(d, pel);
  // rib cage: an ellipsoid shell sliced into ribs
  vec3 c = mix(J1, J2, .75);
  q = p - c;
  float e = length(q / vec3(2.7, 3., 1.9));
  float ribs = abs(e - 1.) * 1.9 - .17;
  ribs = max(ribs, abs(mod(q.y + .5, 1.1) - .55) - .27);
  ribs = max(ribs, -q.y - 2.7);
  d = min(d, ribs);
  d = min(d, sdCapsule(q, vec3(0., 2.2, 1.85), vec3(0., -.9, 1.8), .28));
  // skull
  q = p - J4;
  float sk = length(q * vec3(1., .92, .9)) - 1.75;
  vec3 q2 = vec3(abs(q.x), q.y, q.z);
  sk = max(sk, -(length(q2 - vec3(.68, .05, 1.45)) - .54));
  sk = max(sk, -(length(q - vec3(0., -.6, 1.62)) - .26));
  vec3 jq = q - vec3(0., -1.5 - .12 * uAudio.x, .45);
  float jaw = length(jq * vec3(1., 1.5, .95)) - 1.05;
  d = min(d, min(sk, jaw));
  return d;
}

vec2 map(vec3 p) {
  float dT = p.y > 7.5 ? p.y - 6.5 : (p.y - dune(p.xz)) * .6;
  vec2 res = vec2(dT, 0.);
  vec4 bs = uD[17];
  float bd = length(p - bs.xyz) - bs.w;
  if (bd > 1.) { if (bd < res.x) res.x = bd; }
  else { float d = titan(p); if (d < res.x) res = vec2(d, 1.); }
  return res;
}

// Soft shadow of the titan (the only tall occluder) toward the key light.
float shadow(vec3 p, vec3 l, float maxd) {
  vec4 bs = uD[17];
  vec3 oc = p - bs.xyz;
  float b = dot(oc, l), h = b * b - dot(oc, oc) + bs.w * bs.w;
  if (h < 0.) return 1.;
  h = sqrt(h);
  float t = max(-b - h, .4), t1 = min(-b + h, maxd);
  float res = 1.;
  for (int i = 0; i < 24; i++) {
    if (t > t1) break;
    float d = titan(p + l * t);
    if (d < .02) return 0.;
    res = min(res, 10. * d / t);
    t += clamp(d, .25, 3.);
  }
  return clamp(res, 0., 1.);
}

vec3 shade(vec3 p, vec3 n, vec3 rd, vec3 alb, float gloss, float sh) {
  vec3 c = alb * vec3(.020, .026, .046);
  c += alb * vec3(.10, .12, .18) * max(dot(n, MOON), 0.) * (gKey < 0 ? sh : 1.);
  for (int b = 0; b < 5; b++) {
    vec4 s = uD[105 + b];
    if (s.w < .004) continue;
    vec3 l = s.xyz + vec3(0, 10, 0) - p;
    float d2 = dot(l, l);
    vec3 ln = l * inversesqrt(d2);
    float vis = b == gKey ? sh : 1.;
    vec3 hv = normalize(ln - rd);
    vec3 lc = vec3(.72, .82, 1.) * s.w;
    c += lc * vis * (440. / (d2 + 90.)) * (alb * max(dot(n, ln), 0.) + gloss * pow(max(dot(n, hv), 0.), 48.));
    c += lc * alb * .16 * (n.y * .5 + .5);   // flash bouncing off the cloud deck
  }
  return c;
}

vec3 sky(vec3 rd, vec3 ro) {
  vec2 cuv = rd.xz / (abs(rd.y) + .12);
  vec2 wind = uD[110].xy * .004;
  float c = fbm3(vec3(cuv * .8 + wind * T + vec2(T * .02, 0.), uW * .25));
  float c2 = fbm3(vec3(cuv * 2.1 - wind * T, uW * .4 + 3.));
  float dens = smoothstep(.28, .8, c * .75 + c2 * .35);
  vec3 col = mix(vec3(.010, .014, .03), vec3(.105, .115, .16), dens);
  float mo = max(dot(rd, MOON), 0.);
  col += vec3(.5, .55, .7) * (pow(mo, 40.) * .5 + pow(mo, 600.) * 2.) * (1. - dens * .92);
  float lit = 0.;
  for (int b = 0; b < 5; b++) {
    float I = uD[105 + b].w;
    if (I < .004) continue;
    vec3 bd = normalize(uD[45 + b * 12].xyz - ro);
    lit += I * (.10 + 1.2 * pow(max(dot(rd, bd), 0.), 5.));
  }
  col += vec3(.52, .6, .9) * lit * (.2 + dens);
  return mix(col, vec3(.045, .042, .05), exp(-abs(rd.y) * 9.));
}

void main() {
  vec3 ro;
  vec3 rd = camRay(gl_FragCoord.xy, ro);
  ro.y = max(ro.y, dune(ro.xz) + 1.5);
  float storm = uP.x, rainAmt = uP.y, sand = uP.z;
  float charge = uD[18].y;

  // Pick the light that casts the titan's shadow: the brightest strike, else the moon.
  gKey = -1; gKeyI = .03; gKeyDir = MOON;
  vec3 keyPos = vec3(0.);
  float flash = 0.;
  for (int b = 0; b < 5; b++) {
    vec4 s = uD[105 + b];
    flash += s.w;
    if (s.w > gKeyI) { gKeyI = s.w; gKey = b; keyPos = s.xyz + vec3(0, 10, 0); }
  }

  float t = .3;
  vec2 m = vec2(0.);
  bool hit = false;
  for (int i = 0; i < 150; i++) {
    vec3 p = ro + rd * t;
    m = map(p);
    if (m.x < .0012 * t + .002) { hit = true; break; }
    t += m.x;
    if (t > 340.) break;
  }
  if (!hit) t = 340.;

  vec3 col = sky(rd, ro);
  if (hit) {
    vec3 p = ro + rd * t;
    gT = t;
    vec3 n, alb;
    float gloss;
    if (m.y < .5) {
      float e = .03 + .0022 * t;
      float h0 = duneFine(p.xz);
      n = normalize(vec3(h0 - duneFine(p.xz + vec2(e, 0)), e, h0 - duneFine(p.xz + vec2(0, e))));
      float grain = noise2(p.xz * .2);
      alb = mix(vec3(.60, .42, .25), vec3(.80, .62, .40), grain);
      // darker damp sand in the troughs and under rain; glittering quartz on the crests
      float wet = rainAmt * (.35 + .65 * smoothstep(3., 0., p.y));
      alb *= mix(1., .55, wet);
      gloss = wet * .5 + .5 * step(.992, hash21(floor(p.xz * 55.))) * smoothstep(.06, .01, t / uRes.y);
    } else {
      vec2 e = vec2(.01 + .0012 * t, 0.);
      n = normalize(vec3(titan(p + e.xyy) - titan(p - e.xyy), titan(p + e.yxy) - titan(p - e.yxy), titan(p + e.yyx) - titan(p - e.yyx)));
      float grime = fbm3(p * 1.4);
      alb = vec3(.80, .76, .65) * (.5 + .65 * grime);
      alb *= .55 + .45 * smoothstep(-.4, .5, titan(p + n * .5));   // cavity occlusion
      gloss = .2 + rainAmt * .35;
    }
    vec3 ld = gKey < 0 ? MOON : normalize(keyPos - p);
    float sh = shadow(p + n * .08, ld, gKey < 0 ? 80. : length(keyPos - p));
    col = shade(p, n, rd, alb, gloss, sh);
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

  // Blowing sand hugging the ground + storm haze, lit from inside by every strike.
  float fogAmt = 1. - exp(-t * (.0014 + sand * .011));
  vec3 pe = ro + rd * min(t, 120.);
  float low = exp(-max(pe.y - dune(pe.xz), 0.) * .22);
  fogAmt = clamp(fogAmt * (.75 + .9 * low * noise3(vec3(pe.xz * .06 - uD[110].xy * T * .02, T * .15))), 0., 1.);
  vec3 fogCol = vec3(.020, .020, .026) + vec3(.045, .033, .02) * sand;
  for (int b = 0; b < 5; b++) {
    float I = uD[105 + b].w;
    if (I < .004) continue;
    vec3 bd = normalize(uD[105 + b].xyz + vec3(0, 12, 0) - ro);
    fogCol += vec3(.5, .56, .74) * I * (.03 + .28 * pow(max(dot(rd, bd), 0.), 4.));
  }
  col = mix(col, fogCol, fogAmt);

  // Dust thrown up by footfalls and ground strikes (ballistic puffs advected by wind).
  float dens = 0.;
  for (int i = 0; i < 20; i++) {
    vec4 D = uD[25 + i];
    if (D.w < .01) continue;
    float size = 1.3 + (1. - D.w) * 5.;
    float tr;
    float d = pointDist(ro, rd, D.xyz, tr);
    if (tr < t + size) dens += D.w * exp(-d * d / (size * size)) * (.6 + .6 * noise3((ro + rd * tr) * .6 + T * .5));
  }
  col = mix(col, vec3(.13, .10, .07) * (1. + flash * 5.) + fogCol, clamp(dens * .55, 0., .9));

  // Lightning: stepped leaders and return strokes, as angular distance from the ray.
  vec3 glow = vec3(0.);
  for (int b = 0; b < 5; b++) {
    for (int i = 0; i < 11; i++) {
      vec4 A = uD[45 + b * 12 + i];
      if (A.w <= 0.) continue;
      float tr;
      float d = segDist(ro, rd, A.xyz, uD[46 + b * 12 + i].xyz, tr);
      if (tr > t) continue;
      float a = d / max(tr, 1.);
      glow += A.w * (.000022 / (a * a + .000004) + .0009 / (a * a + .0014)) * vec3(.62, .72, 1.);
    }
  }
  col += glow;

  // Tesseract: 32 edges of a hypercube, rotated in 4D by the simulation.
  if (uQ.x > .01) {
    vec3 tg = vec3(0.);
    for (int i = 0; i < 16; i++) {
      for (int b = 0; b < 4; b++) {
        if (((i >> b) & 1) != 0) continue;
        vec4 A = uD[112 + i], B = uD[112 + (i | (1 << b))];
        float tr;
        float d = segDist(ro, rd, A.xyz, B.xyz, tr);
        float a = d / max(tr, 1.);
        float occ = tr < t ? 1. : .12;
        float wv = (A.w + B.w) * .5;
        vec3 tc = mix(vec3(.15, .9, 1.), vec3(1., .2, .9), wv * .35 + .5);
        tg += tc * occ * (.000012 / (a * a + .0000035) + .00010 / (a * a + .0005));
      }
    }
    col += tg * uQ.x * (.55 + flash * .6 + charge * 2. + uAudio.y);
  }

  // Burning eye sockets.
  float tr;
  for (int s = 0; s < 2; s++) {
    vec3 eye = uD[4].xyz + vec3(s == 0 ? .68 : -.68, .05, 1.2);
    float d = pointDist(ro, rd, eye, tr);
    vec3 ec = mix(vec3(1., .2, .03), vec3(.5, .7, 1.), clamp(charge, 0., 1.));
    if (tr < t + 1.2) col += ec * (.5 + storm * 2. + uAudio.x * 1.5 + charge * 4.) * (.03 / (.02 + d * d) + .03 / (1. + d * d * .25));
  }

  // Rain, slanted by the wind as seen from this camera.
  if (rainAmt > .01) {
    vec3 f = normalize(uCamTgt - uCamPos);
    vec3 rgt = normalize(cross(f, vec3(0, 1, 0)));
    float slant = clamp(dot(uD[110].xy, rgt.xz) * .04, -.9, .9);
    float rain = 0.;
    for (int l = 0; l < 3; l++) {
      float fl = float(l);
      vec2 r = gl_FragCoord.xy / uRes.y * (8. + 7. * fl);
      r.x += r.y * slant;
      float cx = floor(r.x * 6.);
      float h = hash11(cx + fl * 37.);
      float y = fract(r.y * .16 + T * (2.6 + h * 2.) + h * 10.);
      rain += smoothstep(.8, 1., y) * step(1. - rainAmt * .85, h) * smoothstep(.2, 0., abs(fract(r.x * 6.) - .5));
    }
    col += rain * (vec3(.012, .014, .02) + flash * .12);
  }
  col += uAudio.x * vec3(.012, .016, .03);
  fragColor = vec4(max(col, 0.), 1.);
}`;
