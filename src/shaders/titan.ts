import { COMMON } from './common';

// Preset 4: a titan skeleton, taller than the towers, walking down the avenue.
export const TITAN = COMMON + /* glsl */ `
vec2 gCell;

float buildings(vec3 p) {
  if (p.y > 23.5) return p.y - 22.5;
  vec2 id = floor(p.xz / 8.);
  vec2 q = p.xz - (id + .5) * 8.;
  float edge = 4. - max(abs(q.x), abs(q.y)) + .25;
  if (id.x > -1.5 && id.x < .5) return edge;   // the avenue the titan walks along
  float h = hash21(id);
  float ht = 3. + (4. + 13. * uP.y) * h * h + 2. * h;
  if (hash21(id + 3.7) > .4 + uP.y * .7) ht = 1.2;
  // Towers standing in the sight line between camera and titan sink into the ground.
  vec2 c0 = (id + .5) * 8., sa = uCamPos.xz, sb = uCamTgt.xz - sa;
  float sl = length(c0 - sa - sb * clamp(dot(c0 - sa, sb) / dot(sb, sb), 0., 1.));
  ht *= smoothstep(6., 13., sl);
  if (ht < .05) return edge;
  vec2 hs = vec2(2.7 + .9 * hash21(id + 1.1), 2.7 + .9 * hash21(id + 2.2));
  vec3 d3 = abs(vec3(q.x, p.y - ht * .5, q.y)) - vec3(hs.x, ht * .5, hs.y);
  float box = length(max(d3, 0.)) + min(max(d3.x, max(d3.y, d3.z)), 0.);
  gCell = id;
  return min(box, edge);
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
  // vertebrae
  d -= .1 * smoothstep(.6, 0., d) * abs(sin(p.y * 3.2));
  for (int s = 0; s < 2; s++) {
    int a = 5 + s * 3, l = 11 + s * 3;
    d = min(d, bone(p, uD[a].xyz, uD[a + 1].xyz, .45));
    d = min(d, bone(p, uD[a + 1].xyz, uD[a + 2].xyz, .38));
    d = min(d, length(p - uD[a + 2].xyz - vec3(0, -.5, .1)) - .62);
    d = min(d, bone(p, uD[l].xyz, uD[l + 1].xyz, .6));
    d = min(d, bone(p, uD[l + 1].xyz, uD[l + 2].xyz, .48));
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
  vec2 res = vec2(p.y, 0.);
  float b = buildings(p);
  if (b < res.x) res = vec2(b, 1.);
  vec4 bs = uD[17];
  float bd = length(p - bs.xyz) - bs.w;
  if (bd > 1.) { if (bd < res.x) res.x = bd; }
  else { float d = titan(p); if (d < res.x) res = vec2(d, 2.); }
  return res;
}

vec3 sky(vec3 rd) {
  float y = max(rd.y, 0.);
  vec3 c = mix(vec3(.10, .075, .07), vec3(.008, .012, .028), pow(y, .35));
  vec3 md = normalize(vec3(-.22, .42, -1.));
  float mo = dot(rd, md);
  float disc = smoothstep(.9905, .9915, mo);
  vec2 mp = rd.xy * 40.;
  c += vec3(.95, .93, .82) * (disc * (.75 + .25 * noise2(mp)) + pow(max(mo, 0.), 22.) * .22);
  vec2 cuv = rd.xz / (abs(rd.y) + .2);
  float cl = fbm3(vec3(cuv * .7 + T * .012, uW * .2));
  c = mix(c, vec3(.045, .045, .06) + vec3(.4, .38, .33) * pow(max(mo, 0.), 6.) * .3, smoothstep(.45, .85, cl) * .75);
  vec2 sp = rd.xz / (rd.y + .3) * 70.;
  c += step(.995, hash21(floor(sp))) * smoothstep(.15, .5, rd.y) * .4 * (1. - disc);
  return c;
}

void main() {
  vec3 ro;
  vec3 rd = camRay(gl_FragCoord.xy, ro);
  ro.y = max(ro.y, .6);
  float rage = .5 + uP.x * 2. + uAudio.x * 1.5;

  float t = .2;
  vec2 m = vec2(0.);
  bool hit = false;
  vec2 cell = vec2(0.);
  for (int i = 0; i < 110; i++) {
    m = map(ro + rd * t);
    if (m.x < .0015 * t + .003) { hit = true; cell = gCell; break; }
    t += m.x;
    if (t > 280.) break;
  }
  if (!hit) t = 280.;

  vec3 moonD = normalize(vec3(-.22, .42, -1.));
  vec3 col = sky(rd);
  if (hit) {
    vec3 p = ro + rd * t;
    vec2 e = vec2(.01 + .0015 * t, 0.);
    vec3 n = normalize(vec3(map(p + e.xyy).x - map(p - e.xyy).x, map(p + e.yxy).x - map(p - e.yxy).x, map(p + e.yyx).x - map(p - e.yyx).x));
    float moon = max(dot(n, moonD), 0.);
    if (m.y < .5) {
      // street
      float road = step(abs(p.x), 8.);
      vec3 alb = mix(vec3(.03), vec3(.022, .024, .028), road);
      alb += road * step(abs(p.x), .14) * step(.5, fract(p.z * .12)) * vec3(.25, .22, .1);
      alb += road * step(abs(abs(p.x) - 6.4), .08) * .08;
      float lamp = exp(-pow(abs(abs(p.x) - 7.2), 2.) * .5) * (.35 + .65 * exp(-pow(mod(p.z, 16.) - 8., 2.) * .12));
      col = alb * (vec3(.05, .06, .09) + moon * vec3(.2, .22, .3)) + alb * vec3(1., .6, .25) * lamp * 2.2;
      // cracked ground under the last footfall
      vec2 fp = p.xz - uD[18].yz;
      float crater = exp(-dot(fp, fp) * .12) * exp(-uD[18].w * .4);
      col *= 1. - .6 * crater * smoothstep(.55, .45, noise2(p.xz * 2.2));
    } else if (m.y < 1.5) {
      vec3 wall = vec3(.035, .04, .05) * (.6 + .8 * hash21(cell + 9.));
      col = wall * (vec3(.08, .09, .13) + moon * vec3(.35, .38, .5));
      if (abs(n.y) < .5) {
        float u = abs(n.x) > .5 ? p.z : p.x;
        vec2 wg = vec2(u * 1.15, p.y * .95);
        vec2 wf = fract(wg), wi = floor(wg);
        float win = step(.22, wf.x) * step(wf.x, .78) * step(.28, wf.y) * step(wf.y, .8);
        float hv = hash21(wi + cell * 13.1);
        float on = step(.68, hv);
        vec3 wc = mix(vec3(1., .72, .36), vec3(.45, .68, 1.), step(.9, hv));
        col += win * on * wc * (.9 + .5 * sin(hv * 90.)) * 1.25;
        col += win * (1. - on) * sky(reflect(rd, n)) * .25;
      }
      col += vec3(1., .55, .22) * .012 * smoothstep(6., 0., p.y);
    } else {
      // bone
      float grime = fbm3(p * 1.4);
      vec3 alb = vec3(.80, .76, .65) * (.55 + .6 * grime);
      float fres = pow(1. - max(dot(n, -rd), 0.), 3.);
      float ao = smoothstep(-.4, .5, titan(p + n * .5));
      col = alb * (vec3(.05, .06, .09) + moon * vec3(.55, .58, .72) + max(-n.y, 0.) * vec3(.5, .26, .1) * .35) * (.35 + .65 * ao);
      col += vec3(.35, .4, .55) * fres * .22;
      vec3 he = p - uD[4].xyz;
      col += vec3(1., .22, .04) * rage * .5 / (1. + dot(he, he) * .6) * smoothstep(-.2, .6, n.z);
    }
  }

  // Haze: thicker near the ground, glowing with the city.
  float fogAmt = 1. - exp(-t * (.0035 + uP.z * .02) * (.5 + 1.2 * exp(-max(ro.y + rd.y * t * .5, 0.) * .06)));
  vec3 fogCol = mix(vec3(.10, .07, .06), vec3(.03, .04, .065), smoothstep(-.05, .35, rd.y));
  col = mix(col, fogCol, clamp(fogAmt, 0., 1.));

  // Burning eye sockets.
  float tr;
  for (int s = 0; s < 2; s++) {
    vec3 eye = uD[4].xyz + vec3(s == 0 ? .68 : -.68, .05, 1.2);
    float d = pointDist(ro, rd, eye, tr);
    if (tr < t + 1.2) col += vec3(1., .2, .03) * rage * (.03 / (.02 + d * d) + .25 / (1. + d * d * .25) * .12);
  }
  // Dust thrown up by each step.
  vec3 sp = vec3(uD[18].y, 1.2, uD[18].z);
  float dd = pointDist(ro, rd, sp, tr);
  if (tr < t) col += vec3(.16, .14, .12) * uD[18].x * exp(-dd * dd * .03) * (.5 + noise3((ro + rd * tr) * .5 + T));

  col += specks(gl_FragCoord.xy, 13., vec2(T * .1, T * .2), .75) * vec3(.2, .2, .22) * uP.z * .5;
  fragColor = vec4(max(col, 0.), 1.);
}`;
