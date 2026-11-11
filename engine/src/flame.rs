//! Fractal flame generator (after Scott Draves' algorithm).
//!
//! An iterated function system of affine maps, each followed by a blend of
//! non-linear *variations*, is sampled with the chaos game. Every visited point
//! is splatted into a histogram together with a colour that is itself iterated
//! (each map pulls the colour index toward its own). The histogram is displayed
//! with log-density tone mapping, which is what gives flames their glow.
//!
//! The histogram decays a little every frame while the map coefficients drift,
//! so the flame animates instead of converging to a still image.

use crate::rng::Rng;

pub const SIZE: usize = 320;
const NX: usize = 3;
const TAU: f32 = core::f32::consts::PI * 2.0;

/// Cheap sine (parabolic approximation, error < 0.1%): the chaos game calls it millions of times.
#[inline]
fn fsin(x: f32) -> f32 {
    let mut t = x * (1.0 / TAU);
    t -= t.floor() + 0.5;
    let y = t * (8.0 - 16.0 * t.abs());
    -(y + 0.225 * (y * y.abs() - y))
}
#[inline]
fn fcos(x: f32) -> f32 {
    fsin(x + TAU * 0.25)
}

pub struct Flame {
    hist: Vec<f32>, // r, g, b, density per cell
    pub rgba: Vec<u8>,
    rng: Rng,
    pt: [f32; 2],
    col: f32,
    clock: f32,
}

impl Flame {
    pub fn new(seed: u32) -> Self {
        Flame { hist: vec![0.0; SIZE * SIZE * 4], rgba: vec![0; SIZE * SIZE * 4], rng: Rng::new(seed ^ 0xF1A3_E001), pt: [0.1, 0.1], col: 0.5, clock: 0.0 }
    }

    /// Run `iters` chaos-game steps and refresh the RGBA image.
    /// `variation`, `symmetry`, `speed` are 0..1 controls; `w` is the 4D coordinate, `hue` rotates the palette.
    pub fn render(&mut self, iters: usize, dt: f32, variation: f32, symmetry: f32, speed: f32, w: f32, hue: f32, energy: f32) {
        self.clock += dt * (0.02 + speed * 0.5);
        let t = self.clock + w * 0.15;

        // Three affine maps whose coefficients drift on incommensurate periods.
        let mut aff = [[0.0f32; 6]; NX];
        for (i, m) in aff.iter_mut().enumerate() {
            let k = i as f32;
            let ang = t * (0.31 + 0.17 * k) + k * 2.1;
            let sc = 0.62 + 0.2 * (t * 0.23 + k * 1.3).sin();
            let sh = 0.35 * (t * 0.19 + k * 0.7).sin();
            m[0] = ang.cos() * sc;
            m[1] = -ang.sin() * sc + sh;
            m[2] = ang.sin() * sc;
            m[3] = ang.cos() * sc - sh * 0.5;
            m[4] = 0.75 * (t * 0.27 + k * 2.4).cos();
            m[5] = 0.75 * (t * 0.21 + k * 1.9).sin();
        }
        // Variation weights: `variation` sweeps through six families, neighbouring ones cross-fade.
        // 0 linear, 1 sinusoidal, 2 spherical, 3 swirl, 4 horseshoe, 5 bubble
        let pos = variation.clamp(0.0, 1.0) * 5.0;
        let mut wv = [0.0f32; 6];
        for (j, v) in wv.iter_mut().enumerate() {
            *v = (1.0 - (pos - j as f32).abs()).max(0.0);
        }
        wv[0] += 0.12; // a little linear keeps every flame connected
        // Rotational symmetry as extra maps (standard flame practice).
        let sym = 1 + (symmetry.clamp(0.0, 1.0) * 7.0).round() as usize;
        let mut rot = [[1.0f32, 0.0]; 8];
        for (k, r) in rot.iter_mut().enumerate().take(sym) {
            let a = TAU * k as f32 / sym as f32;
            *r = [a.cos(), a.sin()];
        }
        // Palette: 256-entry cosine gradient.
        let mut pal = [[0.0f32; 3]; 256];
        for (i, c) in pal.iter_mut().enumerate() {
            let u = i as f32 / 255.0;
            for (ch, v) in c.iter_mut().enumerate() {
                *v = 0.5 + 0.5 * (TAU * (u * 1.2 + hue + t * 0.03 + [0.0, 0.33, 0.67][ch])).cos();
            }
        }

        // Fade the previous frame's histogram.
        let decay = 0.90 - speed * 0.12;
        for v in self.hist.iter_mut() {
            *v *= decay;
        }

        let half = SIZE as f32 * 0.5;
        let scale = half / 2.2;
        let (mut x, mut y) = (self.pt[0], self.pt[1]);
        let mut c = self.col;
        for _ in 0..iters {
            let r = self.rng.next();
            let i = (r % NX as u32) as usize;
            let m = &aff[i];
            let ax = m[0] * x + m[1] * y + m[4];
            let ay = m[2] * x + m[3] * y + m[5];
            let r2 = ax * ax + ay * ay + 1e-6;
            let mut nx = wv[0] * ax;
            let mut ny = wv[0] * ay;
            if wv[1] > 0.0 {
                nx += wv[1] * fsin(ax * 2.0) * 1.3;
                ny += wv[1] * fsin(ay * 2.0) * 1.3;
            }
            if wv[2] > 0.0 {
                let k = wv[2] / r2;
                nx += ax * k;
                ny += ay * k;
            }
            if wv[3] > 0.0 {
                let (s, co) = (fsin(r2), fcos(r2));
                nx += wv[3] * (ax * s - ay * co);
                ny += wv[3] * (ax * co + ay * s);
            }
            if wv[4] > 0.0 {
                let k = wv[4] / r2.sqrt();
                nx += k * (ax - ay) * (ax + ay);
                ny += k * 2.0 * ax * ay;
            }
            if wv[5] > 0.0 {
                let k = wv[5] * 4.0 / (r2 + 4.0);
                nx += ax * k;
                ny += ay * k;
            }
            // symmetry map
            let k = ((r >> 8) % sym as u32) as usize;
            x = nx * rot[k][0] - ny * rot[k][1];
            y = nx * rot[k][1] + ny * rot[k][0];
            if !(x.abs() < 1e4 && y.abs() < 1e4) {
                x = self.rng.s();
                y = self.rng.s();
            }
            c = (c + i as f32 * 0.5) * 0.5;
            let px = x * scale + half;
            let py = y * scale + half;
            if px >= 0.0 && py >= 0.0 && px < SIZE as f32 && py < SIZE as f32 {
                let o = (py as usize * SIZE + px as usize) * 4;
                let p = &pal[((c * 255.0) as usize).min(255)];
                self.hist[o] += p[0];
                self.hist[o + 1] += p[1];
                self.hist[o + 2] += p[2];
                self.hist[o + 3] += 1.0;
            }
        }
        self.pt = [x, y];
        self.col = c;

        // Log-density display. The curve is tabulated once per frame instead of calling
        // ln/pow for every cell; a small floor removes the speckle of rarely-hit cells.
        let norm = 1.0 / (1.0 + iters as f32 * 0.0009).ln();
        let gain = 0.75 + energy * 0.8;
        let curve = |n: f32| -> f32 {
            let a = (((1.0 + n).ln() * norm - 0.16).max(0.0) * 1.2).min(1.4) * gain;
            a.powf(0.8) * 255.0 / n
        };
        let mut lut = [0.0f32; 1024];
        for (i, v) in lut.iter_mut().enumerate().skip(1) {
            *v = curve(i as f32 * 0.125);
        }
        for (h, out) in self.hist.chunks_exact(4).zip(self.rgba.chunks_exact_mut(4)) {
            let n = h[3];
            let idx = (n * 8.0) as usize;
            let k = if idx < 1024 { lut[idx] } else { curve(n) };
            out[0] = (h[0] * k).min(255.0) as u8;
            out[1] = (h[1] * k).min(255.0) as u8;
            out[2] = (h[2] * k).min(255.0) as u8;
            out[3] = 255;
        }
    }
}
