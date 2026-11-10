import { COMMON } from './common';

// Preset 3: volcano island with Chinese dragons flying around the crater.
export const VOLCANO = COMMON + /* glsl */ `
float gSeg;

float terr(vec2 p) {
  float r = length(p);
  float h = 12. * exp(-r * .15) - 1.5 - 5. * exp(-r * r / 2.2);
  h += (fbm2(p * .22) - .5) * 2.4 * smoothstep(20., 3., r) * smoothstep(0., 2.5, r);
  return h;
}

float dragon(vec3 p, int base) {
  float d = 1e5;
  for (int i = 0; i < 19; i++) {
    vec4 A = uD[base + i], B = uD[base + i + 1];
    vec3 pa = p - A.xyz, ba = B.xyz - A.xyz;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.);
    vec3 off = pa - ba * h;
    float lo = length(off);
    float upn = max(off.y / max(lo, 1e-3), 0.);
    // Body with a serrated mane running along the back.
    float dd = lo - mix(A.w, B.w, h) - .26 * upn * upn * (.55 + .45 * sin((float(i) + h) * 9.));
    if (dd < d) { d = dd; gSeg = float(i) + h; }
  }
  vec3 H = uD[base].xyz;
  vec3 f = normalize(H - uD[base + 1].xyz);
  vec3 rt = normalize(cross(f, vec3(0, 1, 0)));
  vec3 up = cross(rt, f);
  vec3 q = p - H;
  q = vec3(abs(dot(q, rt)), dot(q, up), dot(q, f));
  float jaw = .25 + .35 * uD[42].w;
  float head = sdTaper(q, vec3(0, .05, 0), vec3(0, .12, 1.7), .66, .3);
  head = min(head, sdTaper(q, vec3(0, -.2, .2), vec3(0, -.2 - jaw, 1.5), .3, .16));
  float horn = sdCapsule(q, vec3(.3, .5, -.1), vec3(.78, 1.5, -1.5), .09);
  horn = min(horn, sdCapsule(q, vec3(.55, 1.0, -.8), vec3(.95, 1.75, -.55), .06));
  float whisk = sdCapsule(q, vec3(.25, 0., 1.55), vec3(1.25 + .25 * sin(T * 3.), -.55, 2.7), .04);
  float hd = min(smin(head, horn, .1), whisk);
  if (hd < d + .3) { float s = smin(d, hd, .3); if (hd < d) gSeg = -1.; d = s; }
  return d * .8;
}

vec2 map(vec3 p) {
  float dT = p.y > 13.5 ? p.y - 12.5 : (p.y - terr(p.xz)) * .45;
  vec2 res = vec2(dT, 0.);
  for (int k = 0; k < 2; k++) {
    vec4 bs = uD[40 + k];
    if (bs.y < -100.) continue;
    float bd = length(p - bs.xyz) - bs.w;
    if (bd > .8) { if (bd < res.x) res.x = bd; continue; }
    float d = dragon(p, k * 20);
    if (d < res.x) res = vec2(d, 1. + float(k));
  }
  return res;
}

vec3 sky(vec3 rd) {
  float y = max(rd.y, 0.);
  vec3 c = mix(vec3(.13, .04, .025), vec3(.008, .009, .024), pow(y, .3));
  vec2 cuv = rd.xz / (abs(rd.y) + .15);
  float cl = fbm3(vec3(cuv * .6 + T * .01, uW * .2));
  float under = exp(-length(rd.xz) * 1.8) * (1.2 + uD[42].x * 3.);
  c = mix(c, vec3(.05, .035, .04) + vec3(.9, .32, .08) * under * .25, smoothstep(.42, .8, cl) * .8);
  vec2 sp = rd.xz / (rd.y + .3) * 60.;
  c += step(.994, hash21(floor(sp))) * smoothstep(.1, .5, rd.y) * .5 * (1. - smoothstep(.3, .6, cl));
  vec3 md = normalize(vec3(-.55, .38, -.6));
  float mo = dot(rd, md);
  c += vec3(1., .82, .62) * (smoothstep(.9972, .9978, mo) * 1.2 + pow(max(mo, 0.), 60.) * .15);
  return c;
}

void main() {
  vec3 ro;
  vec3 rd = camRay(gl_FragCoord.xy, ro);
  ro.y = max(ro.y, max(terr(ro.xz), 0.) + 1.);
  float erupt = uD[42].x;
  float heatK = .45 + uP.x * 1.3 + uAudio.x * .8;

  float t = .3;
  vec2 m = vec2(0.);
  bool hit = false;
  float seg = 0.;
  for (int i = 0; i < 88; i++) {
    m = map(ro + rd * t);
    if (m.x < .002 * t + .003) { hit = true; seg = gSeg; break; }
    t += m.x;
    if (t > 130.) break;
  }
  if (!hit) t = 130.;
  float tSea = rd.y < -.0005 ? -ro.y / rd.y : 1e5;
  bool sea = tSea < t;
  if (sea) { t = tSea; hit = true; m = vec2(0., 5.); }

  vec3 col = sky(rd);
  vec3 craterL = vec3(1., .36, .07) * (1.4 + erupt * 6.) * heatK;
  if (hit) {
    vec3 p = ro + rd * t;
    if (m.y > 4.5) {
      // Night sea: reflected sky plus the glow of the island.
      vec2 w = p.xz * .5 + T * .15;
      vec3 n = normalize(vec3(noise2(w) - .5, 5., noise2(w + 13.) - .5));
      vec3 rr = reflect(rd, n);
      float fres = .04 + .96 * pow(1. - max(dot(n, -rd), 0.), 4.);
      col = vec3(.004, .012, .022) + sky(rr) * fres;
      float r = length(p.xz);
      col += craterL * .05 * exp(-r * .045) * (.5 + noise2(p.xz * 1.3 + T * .4));
      float shore = smoothstep(-.9, -.05, terr(p.xz));
      col += shore * (.08 + .25 * noise2(p.xz * 2.5 + T * .5)) * vec3(.5, .45, .42);
    } else {
      vec2 e = vec2(.02 + .002 * t, 0.);
      vec3 n = normalize(vec3(map(p + e.xyy).x - map(p - e.xyy).x, map(p + e.yxy).x - map(p - e.yxy).x, map(p + e.yyx).x - map(p - e.yyx).x));
      vec3 toC = vec3(0., 7.6, 0.) - p;
      float cl = max(dot(n, normalize(toC)), 0.) * 26. / (dot(toC, toC) + 14.);
      vec3 moon = vec3(.14, .13, .17) * max(dot(n, normalize(vec3(-.55, .38, -.6))), 0.);
      if (m.y < .5) {
        float r = length(p.xz), a = atan(p.z, p.x);
        float ch = abs(sin(a * 2.5 + 1.8 * noise2(p.xz * .25) + 3. * noise2(vec2(r * .3, a))));
        float lava = smoothstep(.17, 0., ch) * smoothstep(14.5, 2., r);
        lava = max(lava, smoothstep(6.0, 5.75, p.y) * step(r, 2.3));
        float fl = noise4(vec3(p.xz * 1.3 - normalize(p.xz + 1e-3) * T * .6, r * .5), uW);
        float heat = lava * (.35 + .95 * fl) * heatK;
        vec3 rock = vec3(.05, .043, .042) * (.5 + noise2(p.xz * 3.)) * (1. - .7 * lava);
        rock = mix(rock, vec3(.03, .05, .025), smoothstep(.5, .0, p.y) * .0 + smoothstep(10., 13., r) * .6);
        col = rock * (vec3(.03, .03, .05) + moon + craterL * cl * .6);
        col += vec3(1., .33, .05) * heat * 3. + vec3(1., .85, .4) * heat * heat * heat * 2.2;
      } else {
        // Dragon: red scales, gold belly, mane and horns.
        float scl = .5 + .5 * sin(seg * 13.) * sin(p.y * 9. + p.x * 7.);
        vec3 body = mix(vec3(.55, .03, .02), vec3(.85, .12, .03), scl);
        vec3 gold = vec3(1., .62, .12);
        float belly = smoothstep(-.1, -.6, n.y);
        float mane = smoothstep(.55, .9, n.y);
        vec3 alb = mix(body, gold, max(belly * .8, mane));
        if (seg < 0.) alb = mix(body, gold, smoothstep(.2, .7, n.y) * .7 + .2);
        float fres = pow(1. - max(dot(n, -rd), 0.), 3.);
        col = alb * (vec3(.06, .05, .07) + moon * 2. + craterL * cl * 2.2 + vec3(1., .4, .1) * max(-n.y, 0.) * .35 * heatK);
        col += gold * fres * .25 + alb * uD[42].w * .5;
      }
    }
  }
  float fogAmt = 1. - exp(-t * (.001 + uP.z * .011));
  col = mix(col, vec3(.055, .024, .02) + craterL * .008, fogAmt);

  // Eyes and fire breath.
  for (int k = 0; k < 2; k++) {
    if (uD[40 + k].y < -100.) continue;
    vec3 H = uD[k * 20].xyz;
    vec3 f = normalize(H - uD[k * 20 + 1].xyz);
    vec3 rt = normalize(cross(f, vec3(0, 1, 0)));
    vec3 up = cross(rt, f);
    float tr;
    for (int s = 0; s < 2; s++) {
      vec3 eye = H + f * .75 + up * .42 + rt * (s == 0 ? .4 : -.4);
      float d = pointDist(ro, rd, eye, tr);
      if (tr < t + .6) col += vec3(1., .75, .2) * .006 / (.003 + d * d);
    }
    float breath = uD[42].w * (k == 0 ? 1. : .0);
    if (breath > .02) {
      vec3 M = H + f * 1.9 - up * .2;
      float d = segDist(ro, rd, M, M + f * 8. - up * 1.5, tr);
      if (tr < t) {
        vec3 c = ro + rd * tr;
        float along = clamp(dot(c - M, f) / 8., 0., 1.);
        float w = .25 + along * 1.5;
        float fire = exp(-d * d / (w * w)) * (.5 + noise3(c * 1.3 - f * T * 9.)) * (1. - along * .7);
        col += vec3(1., .42, .08) * fire * breath * 3.5 + vec3(1., .9, .5) * fire * fire * breath * 2.;
      }
    }
  }

  // Smoke column and eruption fountain above the crater.
  {
    float a = dot(rd.xz, rd.xz), b = dot(ro.xz, rd.xz), c = dot(ro.xz, ro.xz) - 81.;
    float disc = b * b - a * c;
    if (disc > 0. && a > 1e-5) {
      float sq = sqrt(disc);
      float t0 = max((-b - sq) / a, 0.), t1 = min((-b + sq) / a, t);
      if (t1 > t0) {
        float trans = 1.;
        vec3 acc = vec3(0.);
        float dt = (t1 - t0) / 14.;
        for (int i = 0; i < 14; i++) {
          vec3 q = ro + rd * (t0 + dt * (float(i) + hash21(gl_FragCoord.xy + float(i) * 1.7)));
          float hh = q.y - 6.2;
          if (hh < 0. || hh > 34.) continue;
          float rr = length(q.xz - vec2(sin(hh * .12 + T * .1), cos(hh * .1)) * hh * .08);
          float width = .9 + hh * .26;
          float dens = smoothstep(width, 0., rr) * fbm3(q * .42 - vec3(0., T * .9, 0.) + uW * .1) * smoothstep(34., 14., hh);
          dens *= .5 + uP.z * .6 + erupt;
          vec3 sc = mix(vec3(1., .4, .08) * (1.2 + erupt * 5.) * heatK, vec3(.055, .045, .05), smoothstep(0., 5.5, hh));
          float spark = pow(noise3(vec3(q.xz * 2.4, q.y * 1.1 - uD[42].y * 9.)), 9.) * erupt * smoothstep(11., 0., hh) * smoothstep(width * 1.5, 0., rr);
          sc += vec3(1., .55, .12) * spark * 260.;
          float al = 1. - exp(-dens * dt * .9);
          acc += sc * al * trans;
          trans *= 1. - al;
        }
        col = col * trans + acc;
      }
    }
  }

  // Drifting embers.
  float emb = specks(gl_FragCoord.xy, 11., vec2(T * .12, -T * .35), .8) + specks(gl_FragCoord.xy, 19., vec2(-T * .08, -T * .22), .82) * .7;
  col += vec3(1., .45, .1) * emb * (.25 + heatK * .45);
  fragColor = vec4(max(col, 0.), 1.);
}`;
