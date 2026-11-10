//! Scene simulation. Each scene writes its animated state into a flat buffer of
//! `ND` vec4s that the fragment shaders read as `uniform vec4 uD[ND]`.
//!
//! Layouts (indices are vec4 slots):
//!   storm   : 0..60  five bolts x 12 points (xyz, w = segment brightness, 0 = break)
//!             60..65 strike position + brightness per bolt
//!   abyss   : 0..8   jellyfish (xyz, pulse phase)
//!             8..16  anglerfish pairs (pos, phase) (dir, scale)
//!             16..28 leviathan spine (xyz, radius)
//!   volcano : 0..20 dragon A spine, 20..40 dragon B spine (xyz, radius)
//!             40,41  bounding spheres, 42 eruption (env, clock, lava, breath)
//!   titan   : 0..17  skeleton joints, 17 bounding sphere,
//!             18 (shake, step x, step z, step age)
//!   common  : 78 (sim time, w coordinate, scene, 0), 79 (camera target xyz, base distance)

use crate::params::*;
use crate::rng::Rng;

pub const ND: usize = 80;
pub const MAX_EVENTS: usize = 16;

pub const EV_THUNDER: f32 = 1.0;
pub const EV_THUD: f32 = 2.0;
pub const EV_ROAR: f32 = 3.0;
pub const EV_ERUPT: f32 = 4.0;
pub const EV_WHALE: f32 = 5.0;

const PI: f32 = core::f32::consts::PI;
const TAU: f32 = PI * 2.0;

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

#[derive(Clone, Copy)]
struct Bolt {
    life: f32,
    dur: f32,
    power: f32,
    pts: [V3; 12],
}

#[derive(Clone, Copy)]
struct Swimmer {
    p: V3,
    yaw: f32,
    turn: f32,
    phase: f32,
    vy: f32,
    scale: f32,
}

pub struct Sim {
    pub data: [f32; ND * 4],
    pub events: [f32; MAX_EVENTS * 4],
    pub n_events: usize,
    rng: Rng,
    scene: usize,
    t: f32,
    w: f32,
    // storm
    bolts: [Bolt; 5],
    bolt_timer: f32,
    // abyss
    jellies: [Swimmer; 8],
    fish: [Swimmer; 4],
    whale_timer: f32,
    // volcano
    dragon_s: f32,
    erupt: f32,
    erupt_clock: f32,
    erupt_timer: f32,
    roar_timer: f32,
    breath: f32,
    // titan
    walk_phase: f32,
    walk_z: f32,
    shake: f32,
    step_pos: [f32; 2],
    step_age: f32,
}

impl Sim {
    pub fn new(seed: u32) -> Self {
        let mut s = Sim {
            data: [0.0; ND * 4],
            events: [0.0; MAX_EVENTS * 4],
            n_events: 0,
            rng: Rng::new(seed ^ 0xA5A5_1234),
            scene: 0,
            t: 0.0,
            w: 0.0,
            bolts: [Bolt { life: 9.0, dur: 0.3, power: 0.0, pts: [[0.0; 3]; 12] }; 5],
            bolt_timer: 0.4,
            jellies: [Swimmer { p: [0.0; 3], yaw: 0.0, turn: 0.0, phase: 0.0, vy: 0.0, scale: 1.0 }; 8],
            fish: [Swimmer { p: [0.0; 3], yaw: 0.0, turn: 0.0, phase: 0.0, vy: 0.0, scale: 1.0 }; 4],
            whale_timer: 6.0,
            dragon_s: 0.0,
            erupt: 0.0,
            erupt_clock: 0.0,
            erupt_timer: 3.0,
            roar_timer: 5.0,
            breath: 0.0,
            walk_phase: 0.0,
            walk_z: 0.0,
            shake: 0.0,
            step_pos: [0.0; 2],
            step_age: 9.0,
        };
        s.reset_creatures();
        s
    }

    fn reset_creatures(&mut self) {
        for i in 0..8 {
            let a = self.rng.f() * TAU;
            let r = self.rng.range(2.0, 11.0);
            self.jellies[i] = Swimmer {
                p: [a.cos() * r, self.rng.range(-1.0, 6.0), a.sin() * r],
                yaw: a,
                turn: 0.0,
                phase: self.rng.f() * TAU,
                vy: 0.0,
                scale: self.rng.range(0.7, 1.4),
            };
        }
        for i in 0..4 {
            let a = self.rng.f() * TAU;
            let r = self.rng.range(4.0, 10.0);
            self.fish[i] = Swimmer {
                p: [a.cos() * r, self.rng.range(0.0, 4.0), a.sin() * r],
                yaw: a + PI * 0.5,
                turn: 0.0,
                phase: self.rng.f() * TAU,
                vy: 0.0,
                scale: self.rng.range(0.8, 1.5),
            };
        }
    }

    pub fn set_scene(&mut self, scene: usize) {
        self.scene = scene.min(NSCENES - 1);
        self.data = [0.0; ND * 4];
        for b in self.bolts.iter_mut() {
            b.life = 9.0;
        }
        self.bolt_timer = 0.3;
        self.erupt_timer = 2.0;
        self.roar_timer = 4.0;
        self.whale_timer = 5.0;
        self.shake = 0.0;
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

    /// Advance the world. `bass/mid/high` are 0..1 audio band levels (already scaled by reactivity).
    pub fn step(&mut self, dt_real: f32, p: &[f32; NP], bass: f32, mid: f32, high: f32) {
        self.n_events = 0;
        let dt_real = dt_real.clamp(0.0, 0.1);
        let dt = dt_real * (0.15 + p[SPEED] * 1.7);
        self.t += dt;
        self.w += dt_real * p[WSPEED] * 0.8 * (1.0 + mid);
        match self.scene {
            0 => self.step_storm(dt, dt_real, p, bass, high),
            1 => self.step_abyss(dt, p, bass),
            2 => self.step_volcano(dt, dt_real, p, bass),
            _ => self.step_titan(dt, dt_real, p, bass),
        }
        self.put(78, self.t, self.w, self.scene as f32, 0.0);
    }

    // ------------------------------------------------------------------ storm

    fn spawn_bolt(&mut self, power: f32) {
        // Reuse the slot whose bolt is the most faded.
        let mut slot = 0;
        let mut best = -1.0;
        for (i, b) in self.bolts.iter().enumerate() {
            let u = b.life / b.dur;
            if u > best {
                best = u;
                slot = i;
            }
        }
        let a = self.rng.f() * TAU;
        let r = self.rng.range(10.0, 46.0);
        let top = [a.cos() * r, self.rng.range(17.0, 21.0), a.sin() * r];
        let end = [top[0] + self.rng.s() * 7.0, 0.3, top[2] + self.rng.s() * 7.0];
        let mut pts = [[0.0f32; 3]; 12];
        for i in 0..9 {
            let u = i as f32 / 8.0;
            let jag = if i == 0 { 0.0 } else if i == 8 { 0.5 } else { 1.9 };
            pts[i] = [
                top[0] + (end[0] - top[0]) * u + self.rng.s() * jag,
                top[1] + (end[1] - top[1]) * u + self.rng.s() * jag * 0.3,
                top[2] + (end[2] - top[2]) * u + self.rng.s() * jag,
            ];
        }
        // One fork leaving the main channel part-way down.
        let k = 2 + (self.rng.next() % 4) as usize;
        let dir = [self.rng.s(), 0.0, self.rng.s()];
        pts[9] = pts[k];
        pts[10] = add(pts[k], [dir[0] * 4.0 + self.rng.s(), -3.0, dir[2] * 4.0 + self.rng.s()]);
        pts[11] = add(pts[10], [dir[0] * 3.0 + self.rng.s() * 1.5, -3.5, dir[2] * 3.0 + self.rng.s() * 1.5]);
        self.bolts[slot] = Bolt { life: 0.0, dur: self.rng.range(0.45, 0.95), power, pts };
        self.emit(EV_THUNDER, power, (end[0] / 46.0).clamp(-1.0, 1.0), r);
    }

    fn step_storm(&mut self, dt: f32, dt_real: f32, p: &[f32; NP], bass: f32, high: f32) {
        let rate = 0.12 + p[INTENSITY] * p[INTENSITY] * 4.5 + bass * 3.0;
        self.bolt_timer -= dt_real * rate;
        if self.bolt_timer <= 0.0 {
            self.bolt_timer = self.rng.range(0.35, 1.6);
            let power = self.rng.range(0.55, 1.0) * (0.6 + 0.5 * p[INTENSITY]);
            self.spawn_bolt(power);
            // Multi-strike: storms throw clusters of bolts.
            if self.rng.f() < 0.25 + p[INTENSITY] * 0.45 {
                self.spawn_bolt(power * 0.8);
            }
            if self.rng.f() < p[INTENSITY] * 0.35 {
                self.spawn_bolt(power * 0.7);
            }
        }
        let _ = dt;
        for b in 0..5 {
            let mut bolt = self.bolts[b];
            bolt.life += dt_real;
            let u = bolt.life / bolt.dur;
            let mut bright = 0.0;
            if u < 1.0 {
                // Fast attack, decaying re-strikes and high-frequency flicker.
                let env = (-2.2 * u).exp() * (1.0 - u);
                let restrike = 0.55 + 0.45 * (u * 31.0 + b as f32).sin().abs();
                let flicker = 0.75 + 0.25 * self.rng.f();
                bright = bolt.power * env * restrike * flicker * (1.0 + high);
            }
            self.bolts[b] = bolt;
            for i in 0..12 {
                let q = bolt.pts[i];
                let seg = if i == 8 || i == 11 { 0.0 } else if i >= 9 { bright * 0.55 } else { bright };
                self.put(b * 12 + i, q[0], q[1], q[2], seg);
            }
            let e = bolt.pts[8];
            self.put(60 + b, e[0], e[1], e[2], bright);
        }
        self.put(79, 0.0, 3.0, 0.0, 24.0);
    }

    // ------------------------------------------------------------------ abyss

    fn step_abyss(&mut self, dt: f32, p: &[f32; NP], bass: f32) {
        let n_jelly = 2 + (p[DENSITY] * 6.01) as usize;
        let n_fish = 1 + (p[DENSITY] * 3.01) as usize;
        for i in 0..8 {
            let mut j = self.jellies[i];
            j.phase += dt * (1.6 + 0.3 * j.scale) * (1.0 + bass);
            if j.phase > TAU {
                j.phase -= TAU;
            }
            // Jellyfish swim in pulses and sink between them.
            let thrust = j.phase.sin().max(0.0);
            j.vy = thrust * 0.75 - 0.22;
            let r = (j.p[0] * j.p[0] + j.p[2] * j.p[2]).sqrt();
            let mut pull = 0.0;
            if r > 12.0 {
                pull = (r - 12.0) * 0.08;
            }
            j.yaw += dt * 0.12 * (i as f32 * 1.7).sin();
            j.p[0] += (j.yaw.cos() * 0.25 - j.p[0] / r.max(0.1) * pull) * dt;
            j.p[2] += (j.yaw.sin() * 0.25 - j.p[2] / r.max(0.1) * pull) * dt;
            j.p[1] += j.vy * dt;
            if j.p[1] > 7.5 {
                j.phase = PI + 0.2;
            }
            if j.p[1] < -1.2 {
                j.p[1] = -1.2;
            }
            self.jellies[i] = j;
            if i < n_jelly {
                self.put(i, j.p[0], j.p[1], j.p[2], j.phase);
            } else {
                self.put(i, 0.0, -999.0, 0.0, 0.0);
            }
        }
        for i in 0..4 {
            let mut f = self.fish[i];
            f.turn += self.rng.s() * dt * 1.4;
            f.turn *= 1.0 - dt * 0.8;
            let r = (f.p[0] * f.p[0] + f.p[2] * f.p[2]).sqrt();
            if r > 11.0 {
                // Steer back toward the centre of the arena.
                let home = (-f.p[2]).atan2(-f.p[0]);
                let mut d = home - f.yaw;
                while d > PI {
                    d -= TAU;
                }
                while d < -PI {
                    d += TAU;
                }
                f.yaw += d * dt * 0.9;
            }
            f.yaw += f.turn * dt;
            f.phase += dt * 5.0;
            let sp = 1.5 * f.scale;
            let dir = [f.yaw.cos(), ((self.t * 0.3 + i as f32 * 2.1).sin()) * 0.18, f.yaw.sin()];
            f.p = add(f.p, mul(dir, sp * dt));
            f.p[1] = f.p[1].clamp(-0.8, 5.5);
            self.fish[i] = f;
            if i < n_fish {
                self.put(8 + i * 2, f.p[0], f.p[1], f.p[2], f.phase);
                let d = norm(dir);
                self.put(9 + i * 2, d[0], d[1], d[2], f.scale);
            } else {
                self.put(8 + i * 2, 0.0, -999.0, 0.0, 0.0);
                self.put(9 + i * 2, 1.0, 0.0, 0.0, 1.0);
            }
        }
        // Leviathan: a huge serpent circling in the gloom.
        let s0 = self.t * 0.16;
        for i in 0..12 {
            let s = s0 - i as f32 * 0.085;
            let rr = 21.0 + 4.0 * (s * 0.6).sin();
            let wave = (i as f32 * 0.7 - self.t * 1.8).sin();
            let y = 4.5 + 3.0 * (s * 1.1).sin() + wave * 0.9;
            let rad = if p[DENSITY] > 0.25 { 1.25 * (1.0 - (i as f32 / 11.0).powf(1.6)) + 0.1 } else { 0.0 };
            let yy = if p[DENSITY] > 0.25 { y } else { -999.0 };
            self.put(16 + i, s.cos() * (rr + wave * 0.6), yy, s.sin() * (rr + wave * 0.6), rad);
        }
        self.whale_timer -= dt;
        if self.whale_timer <= 0.0 {
            self.whale_timer = self.rng.range(9.0, 22.0);
            let (a, b) = (self.rng.range(0.5, 1.0), self.rng.s());
            self.emit(EV_WHALE, a, b, 0.0);
        }
        self.put(79, 0.0, 2.2, 0.0, 15.0);
    }

    // ---------------------------------------------------------------- volcano

    fn dragon_point(&self, s: f32, i: usize, which: usize) -> [f32; 4] {
        let (dir, r0, y0, ph) = if which == 0 { (1.0, 12.0, 9.5, 0.0) } else { (-1.0, 17.0, 12.5, 2.4) };
        let a = dir * (s - i as f32 * 0.105) + ph;
        let rr = r0 + 4.5 * (a * 0.7 + ph).sin();
        let k = i as f32;
        let taper = (k / 19.0).min(1.0);
        let wave = k * 0.85 - self.t * 3.6;
        let y = y0 + 3.6 * (a * 1.3).sin() + 1.4 * (a * 2.9 + 1.0).sin() + wave.sin() * 0.75 * (0.25 + taper);
        let rad_wave = wave.cos() * 0.6 * (0.25 + taper);
        let radius = if i == 0 { 0.62 } else { 0.56 * (1.0 - taper.powf(1.5)) + 0.07 };
        [a.cos() * (rr + rad_wave), y, a.sin() * (rr + rad_wave), radius]
    }

    fn step_volcano(&mut self, dt: f32, dt_real: f32, p: &[f32; NP], bass: f32) {
        self.dragon_s += dt * 0.42;
        let two = p[DENSITY] > 0.5;
        for which in 0..2 {
            let active = which == 0 || two;
            let mut c = [0.0f32; 3];
            let mut pts = [[0.0f32; 4]; 20];
            for i in 0..20 {
                pts[i] = self.dragon_point(self.dragon_s * if which == 0 { 1.0 } else { 0.8 }, i, which);
                c = add(c, [pts[i][0], pts[i][1], pts[i][2]]);
            }
            c = mul(c, 1.0 / 20.0);
            let mut rad: f32 = 0.0;
            for i in 0..20 {
                rad = rad.max(len(sub([pts[i][0], pts[i][1], pts[i][2]], c)));
                if active {
                    self.put(which * 20 + i, pts[i][0], pts[i][1], pts[i][2], pts[i][3]);
                } else {
                    self.put(which * 20 + i, 0.0, -999.0, 0.0, 0.0);
                }
            }
            if active {
                self.put(40 + which, c[0], c[1], c[2], rad + 3.2);
            } else {
                self.put(40 + which, 0.0, -999.0, 0.0, 0.0);
            }
        }
        // Eruption bursts.
        self.erupt_timer -= dt_real * (0.25 + p[INTENSITY] * 1.6 + bass * 2.0);
        if self.erupt_timer <= 0.0 {
            self.erupt_timer = self.rng.range(2.5, 7.0);
            self.erupt = 1.0;
            self.erupt_clock = 0.0;
            self.emit(EV_ERUPT, 0.5 + 0.5 * p[INTENSITY], 0.0, 0.0);
        }
        self.erupt *= (-dt_real * 0.55).exp();
        self.erupt_clock += dt_real;
        // The dragon roars and breathes fire now and then.
        self.roar_timer -= dt_real;
        if self.roar_timer <= 0.0 {
            self.roar_timer = self.rng.range(7.0, 15.0);
            self.breath = 1.0;
            let hx = self.data[0];
            let a = self.rng.range(0.7, 1.0);
            self.emit(EV_ROAR, a, (hx / 16.0).clamp(-1.0, 1.0), 0.0);
        }
        self.breath *= (-dt_real * 0.7).exp();
        self.put(42, self.erupt, self.erupt_clock, p[INTENSITY], self.breath);
        self.put(79, 0.0, 6.5, 0.0, 32.0);
    }

    // ------------------------------------------------------------------ titan

    fn step_titan(&mut self, dt: f32, dt_real: f32, p: &[f32; NP], bass: f32) {
        const STRIDE: f32 = 9.0;
        const HIP_Y: f32 = 11.6;
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
        // Heel strikes: left foot at phase 0, right foot at phase 0.5.
        let left_strike = ph < prev;
        let right_strike = prev < 0.5 && ph >= 0.5;
        let z = self.walk_z;
        if left_strike || right_strike {
            let side = if left_strike { -1.0 } else { 1.0 };
            self.shake = 0.6 + 0.4 * p[INTENSITY];
            self.step_pos = [side * 1.9, z + STRIDE * 0.5];
            self.step_age = 0.0;
            self.emit(EV_THUD, 0.6 + 0.4 * p[INTENSITY], side * 0.5, 0.0);
        }
        self.shake *= (-dt_real * 3.2).exp();
        self.step_age += dt_real;

        let c2 = (ph * TAU).cos();
        let s2 = (ph * TAU).sin();
        let bob = -0.45 * (ph * 2.0 * TAU).cos().abs() + bass * 0.2;
        let sway = 0.55 * s2;
        let pelvis = [sway, HIP_Y + 0.5 + bob, z];
        let lean = 0.9;
        let twist = 0.5 * c2;
        let spine = [sway * 0.7, pelvis[1] + 3.4, z + lean * 0.3];
        let chest = [sway * 0.4, pelvis[1] + 7.0, z + lean * 0.8];
        let neck = [sway * 0.3, pelvis[1] + 9.3, z + lean * 1.1];
        let head = [sway * 0.3 + 0.15 * s2, pelvis[1] + 11.4, z + lean * 1.6];
        self.put(0, pelvis[0], pelvis[1], pelvis[2], 1.0);
        self.put(1, spine[0], spine[1], spine[2], 1.0);
        self.put(2, chest[0], chest[1], chest[2], 1.0);
        self.put(3, neck[0], neck[1], neck[2], 1.0);
        self.put(4, head[0], head[1], head[2], 1.0);

        for side in 0..2 {
            let sx = if side == 0 { -1.0 } else { 1.0 };
            let lp = if side == 0 { ph } else { (ph + 0.5) % 1.0 };
            // Leg: planted during stance, arcing forward during swing.
            let (fz, fy) = if lp < 0.5 {
                (STRIDE * 0.5 - STRIDE * (lp / 0.5), 0.0)
            } else {
                let u = (lp - 0.5) / 0.5;
                let sm = u * u * (3.0 - 2.0 * u);
                (-STRIDE * 0.5 + STRIDE * sm, 2.6 * (PI * u).sin())
            };
            let hip = [pelvis[0] + sx * 1.7, pelvis[1] - 0.4, z];
            let foot = [sx * 1.9, fy + 0.7, z + fz];
            let d = sub(foot, hip);
            let dl = len(d).clamp(0.5, L1 + L2 - 0.02);
            let dn = norm(d);
            let a = (L1 * L1 - L2 * L2 + dl * dl) / (2.0 * dl);
            let h = (L1 * L1 - a * a).max(0.0).sqrt();
            let fwd = [0.0, 0.0, 1.0];
            let bend = norm(sub(fwd, mul(dn, dot(fwd, dn))));
            let knee = add(add(hip, mul(dn, a)), mul(bend, h));
            let b = 11 + side * 3;
            self.put(b, hip[0], hip[1], hip[2], 1.0);
            self.put(b + 1, knee[0], knee[1], knee[2], 1.0);
            self.put(b + 2, foot[0], foot[1], foot[2], 1.0);

            // Arm swings opposite to the leg on the same side.
            let th = -sx * 0.55 * s2;
            let sh = [chest[0] + sx * 3.3, chest[1] + 0.9, chest[2] - sx * twist * 0.6];
            let elbow = add(sh, [sx * 0.7, -th.cos() * 5.2, th.sin() * 5.2]);
            let th2 = th + 0.45;
            let hand = add(elbow, [sx * 0.1, -th2.cos() * 5.0, th2.sin() * 5.0]);
            let b = 5 + side * 3;
            self.put(b, sh[0], sh[1], sh[2], 1.0);
            self.put(b + 1, elbow[0], elbow[1], elbow[2], 1.0);
            self.put(b + 2, hand[0], hand[1], hand[2], 1.0);
        }
        self.put(17, 0.0, 13.0, z + 0.5, 16.5);
        self.put(18, self.shake, self.step_pos[0], self.step_pos[1], self.step_age);
        self.put(79, 0.0, 12.5, z, 44.0);
    }
}
