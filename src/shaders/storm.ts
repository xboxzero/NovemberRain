import { COMMON } from './common';

// Preset 1: multi-lightning storm over sand dunes.
export const STORM = COMMON + /* glsl */ `
float dune(vec2 p) {
  vec2 q = p * .055;
  float n = noise2(q * .6 + 3.);
  float crest = 1. - abs(sin(q.x * 1.9 + 2.6 * noise2(q * .7) + q.y * .35));
  float h = 3.6 * pow(crest, 1.5) * (.35 + .65 * n);
  h += 1.3 * noise2(q * 2.3 + 11.);
  return h;
}
float duneFine(vec2 p) {
  return dune(p) + .03 * sin(p.x * 5. + 3. * noise2(p * .35) + p.y * .8);
}

void main() {
  vec3 ro;
  vec3 rd = camRay(gl_FragCoord.xy, ro);
  ro.y = max(ro.y, dune(ro.xz) + 1.3);

  float t = .4;
  bool hit = false;
  for (int i = 0; i < 96; i++) {
    vec3 p = ro + rd * t;
    float d = p.y - dune(p.xz);
    if (d < .003 * t) { hit = true; break; }
    t += max(.06, d * .55);
    if (t > 170.) break;
  }
  if (!hit) t = 170.;

  float flash = 0.;
  for (int b = 0; b < 5; b++) flash += uD[60 + b].w;

  vec3 col;
  if (hit) {
    vec3 p = ro + rd * t;
    float e = .04 + .003 * t;
    float h0 = duneFine(p.xz);
    vec3 n = normalize(vec3(h0 - duneFine(p.xz + vec2(e, 0)), e, h0 - duneFine(p.xz + vec2(0, e))));
    vec3 alb = mix(vec3(.60, .42, .25), vec3(.78, .60, .38), noise2(p.xz * .2));
    vec3 lit = vec3(.022, .027, .05) + vec3(.09, .11, .17) * max(dot(n, normalize(vec3(.4, .35, -.3))), 0.);
    for (int b = 0; b < 5; b++) {
      vec4 s = uD[60 + b];
      if (s.w < .004) continue;
      vec3 l = s.xyz + vec3(0, 7, 0) - p;
      float d2 = dot(l, l);
      lit += vec3(.72, .82, 1.) * s.w * (max(dot(n, normalize(l)), 0.) * 300. / (d2 + 70.) + .22 * max(n.y, 0.));
    }
    col = alb * lit;
  } else {
    // Storm ceiling: rolling clouds lit from inside by each strike.
    vec2 cuv = rd.xz / (abs(rd.y) + .12);
    float c = fbm3(vec3(cuv * .8 + vec2(T * .07, T * .02), uW * .25));
    col = mix(vec3(.010, .014, .03), vec3(.11, .12, .17), smoothstep(.25, .8, c));
    float lit = 0.;
    for (int b = 0; b < 5; b++) {
      float I = uD[60 + b].w;
      if (I < .004) continue;
      vec3 bd = normalize(uD[b * 12].xyz - ro);
      lit += I * (.16 + 1.6 * pow(max(dot(rd, bd), 0.), 5.));
    }
    col += vec3(.52, .6, .9) * lit * (.25 + c);
    col = mix(col, vec3(.05, .045, .05), exp(-abs(rd.y) * 9.));
  }

  // Blowing sand + storm haze.
  float fogAmt = 1. - exp(-t * (.002 + uP.z * .017));
  if (hit) fogAmt *= .7 + .6 * noise3(vec3((ro + rd * t).xz * .07 - vec2(T * .7, 0.), T * .2));
  vec3 fogCol = vec3(.022, .021, .026) + vec3(.035, .026, .016) * uP.z + vec3(.5, .56, .72) * flash * .2;
  col = mix(col, fogCol, clamp(fogAmt, 0., 1.));

  // Lightning channels: glow measured as angular distance from the ray to each segment.
  vec3 glow = vec3(0.);
  for (int b = 0; b < 5; b++) {
    if (uD[60 + b].w < .004) continue;
    for (int i = 0; i < 11; i++) {
      vec4 A = uD[b * 12 + i];
      if (A.w <= 0.) continue;
      float tr;
      float d = segDist(ro, rd, A.xyz, uD[b * 12 + i + 1].xyz, tr);
      if (tr > t) continue;
      float a = d / max(tr, 1.);
      glow += A.w * (.000022 / (a * a + .000004) + .0016 / (a * a + .0016)) * vec3(.62, .72, 1.);
    }
  }
  col += glow;

  // Rain streaks.
  float rain = 0.;
  for (int l = 0; l < 2; l++) {
    float fl = float(l);
    vec2 r = gl_FragCoord.xy / uRes.y * (9. + 7. * fl);
    r.x += r.y * .2;
    float cx = floor(r.x * 6.);
    float h = hash11(cx + fl * 37.);
    float y = fract(r.y * .16 + T * (2.6 + h * 2.) + h * 10.);
    rain += smoothstep(.8, 1., y) * step(1. - uP.y * .8, h) * smoothstep(.22, .0, abs(fract(r.x * 6.) - .5));
  }
  col += rain * (vec3(.012, .014, .02) + flash * .12);
  col += uAudio.x * vec3(.02, .025, .05);

  fragColor = vec4(max(col, 0.), 1.);
}`;
