//! World simulation: a titan skeleton walking across sand dunes in a thunderstorm.
//!
//! Everything that matters is integrated in time rather than keyframed:
//!   * the dune height field is shared with the shader, so feet are planted on the
//!     real terrain with two-bone IK and the pelvis rides a spring-damper;
//!   * arms are driven, damped pendulums that get kicked by every heel strike;
//!   * lightning grows as a stepped leader, then fires a return stroke, prefers the
//!     tallest conductor (the titan) and its thunder arrives late by distance / speed of sound;
//!   * footfalls throw ballistic dust that is dragged along by a gusting wind field.
//!
//! State is written to a flat buffer of `ND` vec4s read by the shader as `uD[ND]`
//! (kept small so it fits the uniform budget of WebGL1 hardware):
//!   0..17   skeleton joints         17 bounding box centre    18 (shake, charge, step age, lean)
//!   19..25  footprints (x, z, age, depth)
//!   25..37  dust puffs (xyz, opacity)
//!   37..77  four bolts x 10 points (xyz, brightness; 0 = break)
//!   77..81  strike light (xyz, brightness)
//!   81      wind (x, z, gust, rain)
//!   82      (sim time, w coordinate, 0, 0)      83 (camera target xyz, base distance)

use crate::params::*;
use crate::rng::Rng;

pub const ND: usize = 84;
pub const MAX_EVENTS: usize = 16;

pub const EV_THUNDER: f32 = 1.0;
pub const EV_THUD: f32 = 2.0;
pub const EV_ZAP: f32 = 3.0;

const PI: f32 = core::f32::consts::PI;
const TAU: f32 = PI * 2.0;
const SOUND_SPEED: f32 = 55.0;
const N_DUST: usize = 12;
const N_BOLT: usize = 4;
const BOLT_PTS: usize = 10;
const N_PRINTS: usize = 6;

type V3 = [f32; 3];

#[inline]
fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
#[inline]
fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
fn mul(a: V3, s: f32) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
#[inline]
fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
fn len(a: V3) -> f32 {
    dot(a, a).sqrt()
}
#[inline]
fn norm(a: V3) -> V3 {
    let l = len(a);
    if l > 1e-6 {
        mul(a, 1.0 / l)
    } else {
        [0.0, 1.0, 0.0]
    }
}

/// Dune height. MUST stay identical to `dune()` in the fragment shader.
///
/// Transverse dunes with the real cross-section: a long, gentle windward slope,
/// a sharp crest and a short slip face near the angle of repose (about 33 degrees),
/// flat interdune corridors, sinuous crest lines and varying heights.
pub fn dune(x: f32, z: f32, fold: f32, w: f32) -> f32 {
    let qx = x * 0.03;
    let qz = z * 0.03;
    let warp = 1.3 * (qx * 1.1 + 1.3).sin() + 0.6 * (qx * 2.3 + qz * 0.7 + 0.4).sin() + fold * 1.2 * (w * 0.3 + qx * 0.9).sin();
    let a = qz * 2.4 + warp;
    // phase-skewed sine: slow rise, fast fall
    let prof = 0.5 + 0.5 * (a + 0.6 * a.cos()).sin();
    let amp = 0.6 + 0.4 * (qx * 0.7 - qz * 0.5 + 2.0).sin();
    8.0 * amp * prof.max(0.0).powf(1.4) + 1.2 * (qx * 0.9 + 0.5).sin() * (qz * 0.6 + 1.7).sin()
}

#[derive(Clone, Copy)]
struct Bolt {
    life: f32,
    leader: f32,
    dur: f32,
    power: f32,
    to_titan: bool,
    landed: bool,
    pts: [V3; BOLT_PTS],
}

#[derive(Clone, Copy)]
struct Dust {
    p: V3,
    v: V3,
    age: f32,
}

pub struct Sim {
    pub data: [f32; ND * 4],
    pub events: [f32; MAX_EVENTS * 4],
    pub n_events: usize,
    rng: Rng,
    t: f32,
    w: f32,
    // weather
    wind_ang: f32,
    wind: [f32; 2],
    gust: f32,
    bolts: [Bolt; N_BOLT],
    bolt_timer: f32,
    pending: [[f32; 3]; 8], // delayed thunder: (time left, power, pan)
    // titan
    started: bool,
    walk_phase: f32,
    walk_z: f32,
    pelvis_y: f32,
    pelvis_vy: f32,
    arm_th: [f32; 2],
    arm_om: [f32; 2],
    shake: f32,
    charge: f32,
    step_age: f32,
    head: V3,
    prints: [[f32; 3]; N_PRINTS],
    print_i: usize,
    dust: [Dust; N_DUST],
    dust_i: usize,
}

impl Sim {
    pub fn new(seed: u32) -> Self {
        Sim {
            data: [0.0; ND * 4],
            events: [0.0; MAX_EVENTS * 4],
            n_events: 0,
            rng: Rng::new(seed ^ 0xA5A5_1234),
            t: 0.0,
            w: 0.0,
            wind_ang: 0.6,
            wind: [0.0; 2],
            gust: 0.5,
            bolts: [Bolt { life: 99.0, leader: 0.2, dur: 0.5, power: 0.0, to_titan: false, landed: true, pts: [[0.0; 3]; BOLT_PTS] }; N_BOLT],
            bolt_timer: 0.6,
            pending: [[-1.0, 0.0, 0.0]; 8],
            started: false,
            walk_phase: 0.0,
            walk_z: 0.0,
            pelvis_y: 12.0,
            pelvis_vy: 0.0,
            arm_th: [0.0; 2],
            arm_om: [0.0; 2],
            shake: 0.0,
            charge: 0.0,
            step_age: 9.0,
            head: [0.0, 24.0, 0.0],
            prints: [[0.0, 0.0, 999.0]; N_PRINTS],
            print_i: 0,
            dust: [Dust { p: [0.0; 3], v: [0.0; 3], age: 1.0 }; N_DUST],
            dust_i: 0,
        }
    }

    /// Current position along the 4th dimension.
    pub fn w(&self) -> f32 {
        self.w
    }

    #[inline]
    fn put(&mut self, i: usize, x: f32, y: f32, z: f32, w: f32) {
        let o = i * 4;
        self.data[o] = x;
        self.data[o + 1] = y;
        self.data[o + 2] = z;
        self.data[o + 3] = w;
    }

    fn emit(&mut self, kind: f32, a: f32, b: f32, c: f32) {
        if self.n_events < MAX_EVENTS {
            let o = self.n_events * 4;
            self.events[o] = kind;
            self.events[o + 1] = a;
            self.events[o + 2] = b;
            self.events[o + 3] = c;
            self.n_events += 1;
        }
    }

    fn puff(&mut self, p: V3, v: V3) {
        self.dust[self.dust_i] = Dust { p, v, age: 0.0 };
        self.dust_i = (self.dust_i + 1) % N_DUST;
    }

    /// Start a lightning discharge. `to_titan` aims it at the skull.
    pub fn strike(&mut self, power: f32, to_titan: bool, fold: f32) {
        let mut slot = 0;
        let mut best = -1.0;
        for (i, b) in self.bolts.iter().enumerate() {
            let u = b.life / (b.leader + b.dur);
            if u > best {
                best = u;
                slot = i;
            }
        }
        let (top, end, dist) = if to_titan {
            let h = self.head;
            ([h[0] + self.rng.s() * 9.0, self.rng.range(38.0, 44.0), h[2] + self.rng.s() * 9.0], add(h, [0.0, 1.6, 0.0]), 6.0)
        } else {
            let a = self.rng.f() * TAU;
            let r = self.rng.range(14.0, 60.0);
            let x = a.cos() * r;
            let z = self.walk_z + a.sin() * r;
            let ex = x + self.rng.s() * 8.0;
            let ez = z + self.rng.s() * 8.0;
            ([x, self.rng.range(36.0, 44.0), z], [ex, dune(ex, ez, fold, self.w), ez], r)
        };
        // 7 points of main channel (6 segments) + a 3-point fork.
        let mut pts = [[0.0f32; 3]; BOLT_PTS];
        for i in 0..7 {
            let u = i as f32 / 6.0;
            let jag = if i == 0 || i == 6 { 0.0 } else { 3.0 };
            pts[i] = [
                top[0] + (end[0] - top[0]) * u + self.rng.s() * jag,
                top[1] + (end[1] - top[1]) * u + self.rng.s() * jag * 0.35,
                top[2] + (end[2] - top[2]) * u + self.rng.s() * jag,
            ];
        }
        let k = 1 + (self.rng.next() % 4) as usize;
        let dir = [self.rng.s(), 0.0, self.rng.s()];
        pts[7] = pts[k];
        pts[8] = add(pts[k], [dir[0] * 5.0 + self.rng.s(), -4.0, dir[2] * 5.0 + self.rng.s()]);
        pts[9] = add(pts[8], [dir[0] * 4.0 + self.rng.s() * 2.0, -4.5, dir[2] * 4.0 + self.rng.s() * 2.0]);
        let leader = self.rng.range(0.14, 0.26);
        self.bolts[slot] = Bolt { life: 0.0, leader, dur: self.rng.range(0.5, 1.0), power, to_titan, landed: false, pts };
        // Thunder leaves at the return stroke and travels at the speed of sound.
        let pan = ((end[0]) / 50.0).clamp(-1.0, 1.0);
        for q in self.pending.iter_mut() {
            if q[0] < 0.0 {
                *q = [leader + dist / SOUND_SPEED, power, pan];
                break;
            }
        }
    }

    pub fn step(&mut self, dt_real: f32, p: &[f32; NP], bass: f32, mid: f32, high: f32) {
        self.n_events = 0;
        let dt_real = dt_real.clamp(0.0, 0.1);
        let dt = dt_real * (0.15 + p[SPEED] * 1.7);
        self.t += dt;
        self.w += dt_real * p[WSPEED] * 0.8 * (1.0 + mid);
        let fold = p[FOLD];
        let w = self.w;

        // ---- wind: wandering direction, breathing gusts -------------------------
        self.wind_ang += dt_real * 0.08 * (self.t * 0.21).sin();
        self.gust = 0.55 + 0.45 * (self.t * 0.37).sin() * (self.t * 0.13 + 1.0).sin() + 0.25 * bass;
        let ws = p[WIND] * self.gust * 13.0;
        self.wind = [self.wind_ang.cos() * ws, self.wind_ang.sin() * ws];

        self.step_titan(dt, dt_real, p, bass, fold, w);
        self.step_lightning(dt_real, p, bass, high, fold);
        self.step_dust(dt_real, fold, w);
        self.put(81, self.wind[0], self.wind[1], self.gust, p[RAIN]);
        self.put(82, self.t, self.w, 0.0, 0.0);
    }

    // ------------------------------------------------------------------ titan

    fn step_titan(&mut self, dt: f32, dt_real: f32, p: &[f32; NP], bass: f32, fold: f32, w: f32) {
        const STRIDE: f32 = 9.0;
        const L1: f32 = 6.3;
        const L2: f32 = 6.3;
        let freq = 0.42;
        let prev = self.walk_phase;
        self.walk_phase += dt * freq;
        self.walk_z += dt * freq * 2.0 * STRIDE;
        if self.walk_phase >= 1.0 {
            self.walk_phase -= 1.0;
        }
        let ph = self.walk_phase;
        let z = self.walk_z;
        let s2 = (ph * TAU).sin();
        let c2 = (ph * TAU).cos();

        // Foot placement on the terrain.
        let mut feet = [[0.0f32; 3]; 2];
        let mut ground = [0.0f32; 2];
        for side in 0..2 {
            let sx = if side == 0 { -1.0 } else { 1.0 };
            let lp = if side == 0 { ph } else { (ph + 0.5) % 1.0 };
            let (fz, lift) = if lp < 0.5 {
                (STRIDE * 0.5 - STRIDE * (lp / 0.5), 0.0)
            } else {
                let u = (lp - 0.5) / 0.5;
                let sm = u * u * (3.0 - 2.0 * u);
                (-STRIDE * 0.5 + STRIDE * sm, 3.0 * (PI * u).sin())
            };
            let fx = sx * 1.5;
            let g = dune(fx, z + fz, fold, w);
            ground[side] = g;
            feet[side] = [fx, g + 0.7 + lift, z + fz];
        }

        // Heel strikes: impulse into the pelvis spring, dust, a footprint and a thud.
        let left = ph < prev;
        let right = prev < 0.5 && ph >= 0.5;
        if left || right {
            let side = if left { 0 } else { 1 };
            let f = feet[side];
            let force = 0.6 + 0.4 * p[STORM];
            self.shake = force;
            self.step_age = 0.0;
            self.pelvis_vy -= 2.2;
            self.arm_om[0] += self.rng.s() * 0.5;
            self.arm_om[1] += self.rng.s() * 0.5;
            self.prints[self.print_i] = [f[0], f[2] + 0.9, 0.0];
            self.print_i = (self.print_i + 1) % N_PRINTS;
            for k in 0..7 {
                let a = k as f32 / 7.0 * TAU + self.rng.f();
                let sp = self.rng.range(2.5, 6.5);
                let vy = self.rng.range(2.5, 7.0);
                self.puff(
                    [f[0] + a.cos() * 1.2, ground[side] + 0.4, f[2] + 0.9 + a.sin() * 1.2],
                    [a.cos() * sp, vy, a.sin() * sp + 2.0],
                );
            }
            self.emit(EV_THUD, force, if left { -0.5 } else { 0.5 }, 0.0);
        }
        self.shake *= (-dt_real * 3.2).exp();
        self.charge *= (-dt_real * 1.1).exp();
        self.step_age += dt_real;
        for q in self.prints.iter_mut() {
            q[2] += dt_real;
        }

        // Pelvis: spring-damper riding above the lower foot so both legs can reach.
        let target = ground[0].min(ground[1]) + 10.7 - 0.4 * (ph * 2.0 * TAU).cos().abs() + bass * 0.2;
        if !self.started {
            self.started = true;
            self.pelvis_y = target;
        }
        let sub_n = 4;
        let h = dt_real / sub_n as f32;
        for _ in 0..sub_n {
            let acc = (target - self.pelvis_y) * 70.0 - self.pelvis_vy * 11.0;
            self.pelvis_vy += acc * h;
            self.pelvis_y += self.pelvis_vy * h;
        }
        let sway = 0.55 * s2;
        let slope = (dune(0.0, z + 3.0, fold, w) - dune(0.0, z - 3.0, fold, w)) / 6.0;
        // lean into the climb, sit back on the descent
        let lean = 0.9 + slope * 2.6 + self.wind[1] * 0.02;
        let pelvis = [sway, self.pelvis_y, z];
        let spine = [sway * 0.7, pelvis[1] + 3.4, z + lean * 0.3];
        let chest = [sway * 0.4 + self.wind[0] * 0.012, pelvis[1] + 7.0, z + lean * 0.8];
        let neck = [chest[0] * 0.9, pelvis[1] + 9.3, z + lean * 1.1];
        let head = [chest[0] * 0.9 + 0.15 * s2, pelvis[1] + 11.4, z + lean * 1.6];
        self.head = head;
        self.put(0, pelvis[0], pelvis[1], pelvis[2], 1.0);
        self.put(1, spine[0], spine[1], spine[2], 1.0);
        self.put(2, chest[0], chest[1], chest[2], 1.0);
        self.put(3, neck[0], neck[1], neck[2], 1.0);
        self.put(4, head[0], head[1], head[2], 1.0);

        for side in 0..2 {
            let sx = if side == 0 { -1.0 } else { 1.0 };
            // Leg: two-bone IK from hip to the planted / swinging foot.
            let hip = [pelvis[0] + sx * 2.1, pelvis[1] - 0.4, z];
            let d = sub(feet[side], hip);
            let dl = len(d).clamp(0.5, L1 + L2 - 0.02);
            let dn = norm(d);
            let foot = add(hip, mul(dn, dl));
            let a = (L1 * L1 - L2 * L2 + dl * dl) / (2.0 * dl);
            let hh = (L1 * L1 - a * a).max(0.0).sqrt();
            let fwd = [0.0, 0.0, 1.0];
            let bend = norm(sub(fwd, mul(dn, dot(fwd, dn))));
            let knee = add(add(hip, mul(dn, a)), mul(bend, hh));
            let b = 11 + side * 3;
            self.put(b, hip[0], hip[1], hip[2], 1.0);
            self.put(b + 1, knee[0], knee[1], knee[2], 1.0);
            self.put(b + 2, foot[0], foot[1], foot[2], 1.0);

            // Arm: a driven, damped pendulum (gravity + shoulder motor + wind + step kicks).
            let motor = -sx * 0.55 * s2 + self.wind[1] * 0.012;
            for _ in 0..sub_n {
                let th = self.arm_th[side];
                let acc = -3.0 * th.sin() + 16.0 * (motor - th) - 2.4 * self.arm_om[side];
                self.arm_om[side] += acc * h;
                self.arm_th[side] += self.arm_om[side] * h;
            }
            let th = self.arm_th[side].clamp(-1.4, 1.4);
            let sh = [chest[0] + sx * 3.5, chest[1] + 1.4, chest[2] - 0.4 - sx * 0.3 * c2];
            let elbow = add(sh, [sx * 0.7, -th.cos() * 5.2, th.sin() * 5.2]);
            // The forearm trails the upper arm like the second link of a double pendulum.
            let th2 = th + 0.4 - self.arm_om[side].clamp(-2.0, 2.0) * 0.12;
            let hand = add(elbow, [sx * 0.1, -th2.cos() * 5.0, th2.sin() * 5.0]);
            let b = 5 + side * 3;
            self.put(b, sh[0], sh[1], sh[2], 1.0);
            self.put(b + 1, elbow[0], elbow[1], elbow[2], 1.0);
            self.put(b + 2, hand[0], hand[1], hand[2], 1.0);
        }
        self.put(17, pelvis[0], pelvis[1] + 1.2, z + 0.6, 0.0);
        self.put(18, self.shake, self.charge, self.step_age, lean);
        for i in 0..N_PRINTS {
            let q = self.prints[i];
            self.put(19 + i, q[0], q[1], q[2], (-q[2] * 0.06).exp());
        }
        self.put(83, 0.0, pelvis[1] + 1.0, z, 46.0);
    }

    // -------------------------------------------------------------- lightning

    fn step_lightning(&mut self, dt_real: f32, p: &[f32; NP], bass: f32, high: f32, fold: f32) {
        let s = p[STORM];
        let rate = 0.1 + s * s * 4.0 + bass * 3.0;
        self.bolt_timer -= dt_real * rate;
        if self.bolt_timer <= 0.0 {
            self.bolt_timer = self.rng.range(0.35, 1.6);
            let power = self.rng.range(0.55, 1.0) * (0.6 + 0.5 * s);
            // The titan is the tallest conductor for miles.
            let to_titan = self.rng.f() < 0.12 + 0.2 * s;
            self.strike(power, to_titan, fold);
            if self.rng.f() < 0.2 + s * 0.45 {
                self.strike(power * 0.8, false, fold);
            }
            if self.rng.f() < s * 0.3 {
                self.strike(power * 0.7, false, fold);
            }
        }
        for b in 0..N_BOLT {
            let mut bolt = self.bolts[b];
            bolt.life += dt_real;
            let mut seg = [0.0f32; BOLT_PTS];
            let mut light = 0.0;
            if bolt.life < bolt.leader {
                // Stepped leader: a faint channel creeping toward the ground.
                let prog = bolt.life / bolt.leader * 6.0;
                for i in 0..6 {
                    if (i as f32) < prog {
                        let tip = if (i as f32 + 1.0) >= prog { 3.0 } else { 1.0 };
                        seg[i] = 0.05 * bolt.power * tip;
                    }
                }
                if prog > 4.0 {
                    seg[7] = 0.04 * bolt.power;
                    seg[8] = 0.04 * bolt.power;
                }
            } else {
                // Return stroke with decaying re-strikes.
                let u = (bolt.life - bolt.leader) / bolt.dur;
                if u < 1.0 {
                    let env = (-2.2 * u).exp() * (1.0 - u);
                    let restrike = 0.55 + 0.45 * (u * 31.0 + b as f32).sin().abs();
                    let flicker = 0.75 + 0.25 * self.rng.f();
                    light = bolt.power * env * restrike * flicker * (1.0 + high);
                    for i in 0..6 {
                        seg[i] = light;
                    }
                    seg[7] = light * 0.5;
                    seg[8] = light * 0.5;
                }
                if !bolt.landed {
                    bolt.landed = true;
                    let e = bolt.pts[6];
                    if bolt.to_titan {
                        self.charge = 1.0;
                        self.emit(EV_ZAP, bolt.power, 0.0, 0.0);
                    } else {
                        for _ in 0..2 {
                            let v = [self.rng.s() * 4.0, self.rng.range(4.0, 8.0), self.rng.s() * 4.0];
                            self.puff(add(e, [0.0, 0.5, 0.0]), v);
                        }
                    }
                }
            }
            self.bolts[b] = bolt;
            for i in 0..BOLT_PTS {
                let q = bolt.pts[i];
                self.put(37 + b * BOLT_PTS + i, q[0], q[1], q[2], seg[i]);
            }
            let e = bolt.pts[6];
            self.put(77 + b, e[0], e[1], e[2], light);
        }
        // Thunder that is still on its way.
        for i in 0..self.pending.len() {
            if self.pending[i][0] >= 0.0 {
                self.pending[i][0] -= dt_real;
                if self.pending[i][0] < 0.0 {
                    let q = self.pending[i];
                    self.emit(EV_THUNDER, q[1], q[2], 0.0);
                }
            }
        }
    }

    // ------------------------------------------------------------------- dust

    fn step_dust(&mut self, dt: f32, fold: f32, w: f32) {
        for i in 0..N_DUST {
            let mut d = self.dust[i];
            if d.age < 1.0 {
                d.age += dt / 3.6;
                // gravity (dust is light), drag toward the local wind velocity
                d.v[1] -= 5.0 * dt;
                d.v[0] += (self.wind[0] - d.v[0]) * 0.9 * dt;
                d.v[2] += (self.wind[1] - d.v[2]) * 0.9 * dt;
                d.v[1] *= 1.0 - 0.8 * dt;
                d.p = add(d.p, mul(d.v, dt));
                let g = dune(d.p[0], d.p[2], fold, w) + 0.5;
                if d.p[1] < g {
                    d.p[1] = g;
                    d.v[1] = d.v[1].abs() * 0.15;
                }
                self.dust[i] = d;
            }
            let a = if d.age < 1.0 { (1.0 - d.age).powf(1.5) * (d.age * 10.0).min(1.0) } else { 0.0 };
            self.put(25 + i, d.p[0], d.p[1], d.p[2], a);
        }
    }
}
