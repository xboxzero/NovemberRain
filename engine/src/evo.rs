//! The living part: a population of 4D fractal "organisms" bred by an
//! evolutionary algorithm.
//!
//! An organism is an iterated function system in four dimensions: four maps,
//! each an affine transform of (x, y, z, w) followed by a blend of non-linear
//! variations, plus a rotational symmetry and a colour palette. Its genome is a
//! flat array of floats which the GPU reads directly as uniforms.
//!
//! Evolution is steady-state: two parents are chosen by tournament, crossed
//! over map by map, mutated with Gaussian noise, and the child is scored by an
//! automatic fitness function that samples the attractor on the CPU and rewards
//! shapes that are bounded, neither collapsed nor a formless cloud, genuinely
//! four-dimensional and fractal (box-counting dimension near 2). The viewer can
//! bias selection by loving or skipping what is on screen. The picture morphs
//! continuously from each parent generation to the next.

use crate::rng::Rng;

pub const MAPS: usize = 4;
const MAP_LEN: usize = 26; // 16 matrix (column-major) + 4 translation + 4 variation weights + colour + probability
const G_SYM: usize = MAPS * MAP_LEN;
const G_SYMZW: usize = G_SYM + 1;
const G_PAL: usize = G_SYM + 2; // 12 floats: offset, amplitude, frequency, phase (rgb each)
const G_ROT: usize = G_PAL + 12; // 3 rotation speeds in the xw, yw, zw planes
const G_PERSP: usize = G_ROT + 3;
pub const GLEN: usize = 124;
const POP: usize = 10;
const TAU: f32 = core::f32::consts::PI * 2.0;

pub type Genome = [f32; GLEN];

fn rot_plane(m: &mut [f32], i: usize, j: usize, a: f32) {
    // post-multiply a column-major 4x4 by a rotation in the (i, j) plane
    let (s, c) = a.sin_cos();
    for r in 0..4 {
        let (x, y) = (m[i * 4 + r], m[j * 4 + r]);
        m[i * 4 + r] = x * c + y * s;
        m[j * 4 + r] = -x * s + y * c;
    }
}

fn random_genome(rng: &mut Rng) -> Genome {
    let mut g = [0.0f32; GLEN];
    for m in 0..MAPS {
        let o = m * MAP_LEN;
        // random 4D rotation (six plane angles) times anisotropic contraction
        for k in 0..4 {
            g[o + k * 4 + k] = rng.range(0.38, 0.88);
        }
        for (i, j) in [(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)] {
            rot_plane(&mut g[o..o + 16], i, j, rng.s() * 3.1416);
        }
        for k in 0..4 {
            g[o + 16 + k] = rng.s() * 0.9;
        }
        // variation weights: linear, sinusoidal, spherical, swirl
        let kind = rng.next() % 5;
        let mut v = [rng.f() * 0.6 + 0.2, rng.f() * 0.5, rng.f() * 0.4, rng.f() * 0.4];
        if kind < 4 {
            v[kind as usize] += 0.8;
        }
        g[o + 20..o + 24].copy_from_slice(&v);
        g[o + 24] = rng.f();
        g[o + 25] = rng.range(0.5, 1.5);
    }
    g[G_SYM] = [1.0, 1.0, 2.0, 3.0, 3.0, 4.0, 5.0, 6.0, 8.0][(rng.next() % 9) as usize];
    g[G_SYMZW] = (rng.next() % 3) as f32;
    for k in 0..3 {
        g[G_PAL + k] = rng.range(0.45, 0.6);
        g[G_PAL + 3 + k] = rng.range(0.35, 0.5);
        g[G_PAL + 6 + k] = rng.range(0.6, 1.6);
        g[G_PAL + 9 + k] = rng.f();
        g[G_ROT + k] = rng.s();
    }
    g[G_PERSP] = rng.range(0.4, 1.0);
    repair(&mut g);
    g
}

/// Keep a genome inside the region where the system is a contraction on average.
fn repair(g: &mut Genome) {
    for m in 0..MAPS {
        let o = m * MAP_LEN;
        let fro: f32 = g[o..o + 16].iter().map(|v| v * v).sum::<f32>().sqrt();
        let k = if fro > 1.7 { 1.7 / fro } else if fro < 0.7 { 0.7 / fro.max(1e-3) } else { 1.0 };
        for v in g[o..o + 16].iter_mut() {
            *v *= k;
        }
        for v in g[o + 16..o + 20].iter_mut() {
            *v = v.clamp(-1.6, 1.6);
        }
        let mut sum = 0.0;
        for v in g[o + 20..o + 24].iter_mut() {
            *v = v.max(0.0);
            sum += *v;
        }
        if sum < 1e-3 {
            g[o + 20] = 1.0;
            sum = 1.0;
        }
        for v in g[o + 20..o + 24].iter_mut() {
            *v /= sum;
        }
        g[o + 24] = g[o + 24].rem_euclid(1.0);
        g[o + 25] = g[o + 25].clamp(0.2, 2.0);
    }
    g[G_SYM] = g[G_SYM].round().clamp(1.0, 8.0);
    g[G_SYMZW] = g[G_SYMZW].round().clamp(0.0, 2.0);
    for k in 0..3 {
        g[G_PAL + k] = g[G_PAL + k].clamp(0.35, 0.65);
        g[G_PAL + 3 + k] = g[G_PAL + 3 + k].clamp(0.25, 0.55);
        g[G_PAL + 6 + k] = g[G_PAL + 6 + k].clamp(0.3, 2.5);
        g[G_ROT + k] = g[G_ROT + k].clamp(-1.5, 1.5);
    }
    g[G_PERSP] = g[G_PERSP].clamp(0.2, 1.1);
}

/// One step of the chaos game. MUST match `iterate()` in the vertex shader.
#[inline]
fn apply(g: &Genome, m: usize, p: [f32; 4], h: f32) -> [f32; 4] {
    let o = m * MAP_LEN;
    let a = &g[o..o + 16];
    let mut q = [0.0f32; 4];
    for r in 0..4 {
        q[r] = a[r] * p[0] + a[4 + r] * p[1] + a[8 + r] * p[2] + a[12 + r] * p[3] + g[o + 16 + r];
    }
    let r2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] + 1e-4;
    let v = &g[o + 20..o + 24];
    let (s, c) = r2.sin_cos();
    let sw = [q[0] * s - q[1] * c, q[0] * c + q[1] * s, q[2] * s - q[3] * c, q[2] * c + q[3] * s];
    let inv = 1.0 / r2.max(0.06);
    let mut f = [0.0f32; 4];
    for r in 0..4 {
        f[r] = v[0] * q[r] + v[1] * (q[r] * 2.0).sin() + v[2] * q[r] * inv + v[3] * sw[r];
    }
    let k = 1.0 / (1.0 + 0.03 * (f[0] * f[0] + f[1] * f[1] + f[2] * f[2] + f[3] * f[3]));
    // rotational symmetry in the xy plane, coupled to the zw plane
    let n = g[G_SYM];
    let ang = TAU * (h * n).floor() / n;
    let (s1, c1) = ang.sin_cos();
    let (s2, c2) = (ang * g[G_SYMZW]).sin_cos();
    [(f[0] * c1 - f[1] * s1) * k, (f[0] * s1 + f[1] * c1) * k, (f[2] * c2 - f[3] * s2) * k, (f[2] * s2 + f[3] * c2) * k]
}

fn pick_map(g: &Genome, r: f32) -> usize {
    let total: f32 = (0..MAPS).map(|m| g[m * MAP_LEN + 25]).sum();
    let mut acc = 0.0;
    for m in 0..MAPS {
        acc += g[m * MAP_LEN + 25] / total;
        if r < acc {
            return m;
        }
    }
    MAPS - 1
}

/// Automatic aesthetic fitness in 0..1, from a CPU sample of the attractor.
pub fn fitness(g: &Genome, rng: &mut Rng) -> f32 {
    const N: usize = 5000;
    let mut p = [rng.s() * 0.5, rng.s() * 0.5, rng.s() * 0.5, rng.s() * 0.5];
    let mut coarse = [0u64; 27]; // 12^3 occupancy bitset
    let mut fine = [0u64; 216]; // 24^3 occupancy bitset
    let mut inside = 0usize;
    let mut mean = [0.0f32; 4];
    let mut var = [0.0f32; 4];
    for i in 0..N + 30 {
        p = apply(g, pick_map(g, rng.f()), p, rng.f());
        if !(p[0].is_finite() && p[1].is_finite() && p[2].is_finite() && p[3].is_finite()) {
            return 0.0;
        }
        if i < 30 {
            continue;
        }
        let r2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2] + p[3] * p[3];
        if r2 < 9.0 {
            inside += 1;
        }
        for k in 0..4 {
            mean[k] += p[k];
            var[k] += p[k] * p[k];
        }
        let cell = |v: f32, n: f32| -> Option<usize> {
            let u = (v + 2.0) * 0.25 * n;
            if u >= 0.0 && u < n {
                Some(u as usize)
            } else {
                None
            }
        };
        if let (Some(x), Some(y), Some(z)) = (cell(p[0], 12.0), cell(p[1], 12.0), cell(p[2], 12.0)) {
            let id = (z * 12 + y) * 12 + x;
            coarse[id >> 6] |= 1 << (id & 63);
        }
        if let (Some(x), Some(y), Some(z)) = (cell(p[0], 24.0), cell(p[1], 24.0), cell(p[2], 24.0)) {
            let id = (z * 24 + y) * 24 + x;
            fine[id >> 6] |= 1 << (id & 63);
        }
    }
    let bounded = inside as f32 / N as f32;
    let n12: u32 = coarse.iter().map(|b| b.count_ones()).sum();
    let n24: u32 = fine.iter().map(|b| b.count_ones()).sum();
    if n12 < 4 {
        return 0.0;
    }
    // how much of space is touched: tiny = collapsed to a point, huge = formless cloud
    let fill = n12 as f32 / 1728.0;
    let bell = |x: f32, centre: f32, width: f32| (-((x - centre) / width).powi(2)).exp();
    let s_fill = bell(fill.ln(), (0.12f32).ln(), 1.1);
    // box-counting dimension between the two grids
    let dim = (n24 as f32 / n12 as f32).log2();
    let s_dim = bell(dim, 2.0, 0.55);
    // all four axes must be used: this is what makes it a 4D object
    let mut vmin = f32::MAX;
    let mut vmax: f32 = 0.0;
    for k in 0..4 {
        let m = mean[k] / N as f32;
        let v = (var[k] / N as f32 - m * m).max(0.0);
        vmin = vmin.min(v);
        vmax = vmax.max(v);
    }
    let s_aniso = (vmin / vmax.max(1e-6) * 6.0).min(1.0).sqrt();
    let s_size = bell(vmax.sqrt(), 0.8, 0.6);
    (bounded.powi(4) * s_fill * s_dim * s_aniso * (0.4 + 0.6 * s_size)).clamp(0.0, 1.0)
}

struct Member {
    g: Genome,
    fit: f32,
    loved: bool,
}

pub struct Evolution {
    rng: Rng,
    pop: Vec<Member>,
    from: Genome,
    to: Genome,
    to_index: usize,
    t: f32,
    pub out: Genome,
    pub generation: u32,
    /// (generation, fitness of the form being approached, morph progress, population mean fitness, loved count, born flag)
    pub info: [f32; 6],
    pub io: Genome,
    kick: f32,
    hurry: bool,
}

impl Evolution {
    pub fn new(seed: u32) -> Self {
        let mut rng = Rng::new(seed ^ 0x0E70_1F3D);
        // Seed the gene pool: sample many random organisms, keep the fittest.
        let mut cands: Vec<Member> = (0..48)
            .map(|_| {
                let g = random_genome(&mut rng);
                let fit = fitness(&g, &mut rng);
                Member { g, fit, loved: false }
            })
            .collect();
        cands.sort_by(|a, b| b.fit.partial_cmp(&a.fit).unwrap_or(core::cmp::Ordering::Equal));
        cands.truncate(POP);
        let from = cands[0].g;
        let to = cands[1].g;
        let mut e = Evolution { rng, pop: cands, from, to, to_index: 1, t: 0.0, out: from, generation: 1, info: [0.0; 6], io: from, kick: 0.0, hurry: false };
        e.write_info(false);
        e
    }

    fn tournament(&mut self) -> usize {
        let mut best = (self.rng.next() as usize) % self.pop.len();
        for _ in 0..2 {
            let c = (self.rng.next() as usize) % self.pop.len();
            let score = |m: &Member| m.fit * if m.loved { 2.5 } else { 1.0 };
            if score(&self.pop[c]) > score(&self.pop[best]) {
                best = c;
            }
        }
        best
    }

    fn breed(&mut self, mutation: f32) -> (Genome, f32) {
        let sigma = 0.015 + mutation * mutation * 0.45;
        let mut best: Option<(Genome, f32)> = None;
        for _ in 0..6 {
            let (ia, ib) = (self.tournament(), self.tournament());
            let a = self.pop[ia].g;
            let b = self.pop[ib].g;
            let mut c = a;
            // crossover: whole maps are the genes; palette and symmetry come from either parent
            for m in 0..MAPS {
                if self.rng.f() < 0.5 {
                    c[m * MAP_LEN..(m + 1) * MAP_LEN].copy_from_slice(&b[m * MAP_LEN..(m + 1) * MAP_LEN]);
                }
            }
            if self.rng.f() < 0.5 {
                c[G_PAL..G_PAL + 12].copy_from_slice(&b[G_PAL..G_PAL + 12]);
            }
            if self.rng.f() < 0.5 {
                c[G_SYM] = b[G_SYM];
                c[G_SYMZW] = b[G_SYMZW];
            }
            // Gaussian mutation
            for (i, v) in c.iter_mut().enumerate().take(G_PERSP + 1) {
                if i == G_SYM || i == G_SYMZW {
                    continue;
                }
                if self.rng.f() < 0.6 {
                    *v += self.rng.gauss() * sigma;
                }
            }
            if self.rng.f() < 0.06 + mutation * 0.2 {
                c[G_SYM] = 1.0 + (self.rng.next() % 8) as f32;
            }
            if self.rng.f() < 0.05 + mutation * 0.15 {
                c[G_SYMZW] = (self.rng.next() % 3) as f32;
            }
            // occasional macro-mutation: a brand new map (immigration keeps the pool diverse)
            if self.rng.f() < mutation * 0.25 {
                let fresh = random_genome(&mut self.rng);
                let m = (self.rng.next() as usize) % MAPS;
                c[m * MAP_LEN..(m + 1) * MAP_LEN].copy_from_slice(&fresh[m * MAP_LEN..(m + 1) * MAP_LEN]);
            }
            repair(&mut c);
            let f = fitness(&c, &mut self.rng);
            if best.map(|b| f > b.1).unwrap_or(true) {
                best = Some((c, f));
            }
        }
        best.unwrap()
    }

    fn next_generation(&mut self, mutation: f32) {
        let (child, fit) = self.breed((mutation + self.kick).min(1.0));
        self.kick = 0.0;
        // steady-state replacement: the child takes the place of the weakest unloved member
        let mut worst = 0;
        let mut wf = f32::MAX;
        for (i, m) in self.pop.iter().enumerate() {
            if !m.loved && i != self.to_index && m.fit < wf {
                wf = m.fit;
                worst = i;
            }
        }
        self.pop[worst] = Member { g: child, fit, loved: false };
        self.from = self.out;
        self.to = child;
        self.to_index = worst;
        self.t = 0.0;
        self.generation += 1;
        self.write_info(true);
    }

    fn write_info(&mut self, born: bool) {
        let mean = self.pop.iter().map(|m| m.fit).sum::<f32>() / self.pop.len() as f32;
        let loved = self.pop.iter().filter(|m| m.loved).count() as f32;
        self.info = [self.generation as f32, self.pop[self.to_index].fit, self.t, mean, loved, if born { 1.0 } else { 0.0 }];
    }

    /// Advance the morph. `speed` and `mutation` are 0..1; `kick` adds a one-off mutation impulse
    /// (a loud sound, an earthquake on the feed).
    pub fn step(&mut self, dt: f32, speed: f32, mutation: f32, kick: f32) {
        self.kick = (self.kick + kick).min(1.0);
        let dur = if self.hurry { 1.2 } else { 3.0 + (1.0 - speed).powi(2) * 60.0 };
        self.info[5] = 0.0;
        if speed > 0.004 || self.hurry {
            self.t += dt.clamp(0.0, 0.2) / dur;
        }
        if self.t >= 1.0 {
            self.hurry = false;
            self.out = self.to;
            self.next_generation(mutation);
        }
        let u = self.t * self.t * (3.0 - 2.0 * self.t);
        for i in 0..GLEN {
            self.out[i] = self.from[i] + (self.to[i] - self.from[i]) * u;
        }
        // discrete genes switch half-way
        let src = if u < 0.5 { &self.from } else { &self.to };
        self.out[G_SYM] = src[G_SYM];
        self.out[G_SYMZW] = src[G_SYMZW];
        self.info[2] = self.t;
    }

    /// The viewer likes what is forming: protect it and favour it as a parent.
    pub fn love(&mut self) {
        self.pop[self.to_index].loved = true;
        self.pop[self.to_index].fit = self.pop[self.to_index].fit.max(0.5);
        self.write_info(false);
    }

    /// The viewer dislikes it: remove it from the gene pool's favour and move on quickly.
    pub fn skip(&mut self) {
        self.pop[self.to_index].loved = false;
        self.pop[self.to_index].fit *= 0.15;
        self.hurry = true;
        self.write_info(false);
    }

    /// Replace the whole gene pool with fresh random organisms.
    pub fn reseed(&mut self) {
        let seed = self.rng.next();
        let gen = self.generation;
        let out = self.out;
        *self = Evolution::new(seed);
        self.from = out;
        self.generation = gen + 1;
        self.hurry = true;
        self.write_info(true);
    }

    /// Adopt the genome in `io` (a loaded preset) as a loved member and morph to it.
    pub fn adopt(&mut self) {
        let mut g = self.io;
        if g.iter().any(|v| !v.is_finite()) {
            return;
        }
        repair(&mut g);
        let fit = fitness(&g, &mut self.rng).max(0.5);
        let slot = (self.to_index + 1) % self.pop.len();
        self.pop[slot] = Member { g, fit, loved: true };
        self.from = self.out;
        self.to = g;
        self.to_index = slot;
        self.t = 0.0;
        self.hurry = true;
        self.generation += 1;
        self.write_info(true);
    }
}
