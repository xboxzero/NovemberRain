//! Generative sound synthesizer. Runs inside an AudioWorklet (one wasm instance
//! per audio thread). Every scene has its own drone tuning, scale, voice timbre
//! and ambience; visual events (thunder, footsteps, roars, eruptions, whale
//! calls) arrive through `trigger` so sound and image stay locked together.

use crate::params::*;
use crate::rng::Rng;

const PI: f32 = core::f32::consts::PI;
const TAU: f32 = PI * 2.0;
pub const MAX_FRAMES: usize = 1024;
const NV: usize = 10;

#[derive(Clone, Copy, Default)]
struct Svf {
    ic1: f32,
    ic2: f32,
}

impl Svf {
    /// Returns (lowpass, bandpass, highpass).
    #[inline]
    fn run(&mut self, x: f32, g: f32, k: f32) -> (f32, f32, f32) {
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        let a3 = g * a2;
        let v3 = x - self.ic2;
        let v1 = a1 * self.ic1 + a2 * v3;
        let v2 = self.ic2 + a2 * self.ic1 + a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;
        (v2, v1, x - k * v1 - v2)
    }
}

#[inline]
fn svf_g(freq: f32, sr: f32) -> f32 {
    (PI * freq.clamp(10.0, sr * 0.45) / sr).tan()
}

#[inline]
fn pole(freq: f32, sr: f32) -> f32 {
    1.0 - (-TAU * freq / sr).exp()
}

#[inline]
fn saw(ph: &mut f32, inc: f32) -> f32 {
    *ph += inc;
    if *ph >= 1.0 {
        *ph -= 1.0;
    }
    let t = *ph;
    let mut v = 2.0 * t - 1.0;
    if t < inc {
        let x = t / inc;
        v -= x + x - x * x - 1.0;
    } else if t > 1.0 - inc {
        let x = (t - 1.0) / inc;
        v -= x * x + x + x + 1.0;
    }
    v
}

#[inline]
fn midi_hz(n: f32) -> f32 {
    440.0 * 2f32.powf((n - 69.0) / 12.0)
}

#[derive(Clone, Copy, Default)]
struct Voice {
    on: bool,
    held: bool,
    note: f32,
    inc: f32,
    pc: f32,
    pm: f32,
    env: f32,
    stage: u8,
    vel: f32,
    ratio: f32,
    index: f32,
    ienv: f32,
    idec: f32,
    att: f32,
    dec: f32,
    sus: f32,
    rel: f32,
    pan: f32,
}

struct Timbre {
    ratio: f32,
    index: f32,
    idec: f32,
    att: f32,
    dec: f32,
    octave: f32,
}

const TIMBRES: [Timbre; NSCENES] = [
    Timbre { ratio: 3.5, index: 4.0, idec: 0.25, att: 0.002, dec: 1.6, octave: 2.0 },
    Timbre { ratio: 2.0, index: 1.2, idec: 1.0, att: 0.08, dec: 3.0, octave: 2.0 },
    Timbre { ratio: 1.0, index: 6.0, idec: 0.09, att: 0.001, dec: 1.0, octave: 2.0 },
    Timbre { ratio: 0.5, index: 3.0, idec: 0.6, att: 0.03, dec: 2.2, octave: 1.0 },
];

const SCALES: [&[f32]; NSCENES] = [
    &[0.0, 1.0, 3.0, 5.0, 7.0, 8.0, 10.0],  // phrygian: storm
    &[0.0, 2.0, 4.0, 6.0, 7.0, 9.0, 11.0],  // lydian: abyss
    &[0.0, 2.0, 4.0, 7.0, 9.0],             // Chinese pentatonic (gong): volcano
    &[0.0, 1.0, 3.0, 6.0, 7.0, 10.0],       // dark hexatonic: titan
];

/// Root notes (MIDI): D2, C2, A1, F1.
const ROOTS: [f32; NSCENES] = [38.0, 36.0, 33.0, 29.0];

struct Comb {
    buf: Vec<f32>,
    i: usize,
    store: f32,
}

impl Comb {
    fn new(n: usize) -> Self {
        Comb { buf: vec![0.0; n.max(8)], i: 0, store: 0.0 }
    }
    #[inline]
    fn run(&mut self, x: f32, fb: f32, damp: f32) -> f32 {
        let out = self.buf[self.i];
        self.store = out * (1.0 - damp) + self.store * damp;
        self.buf[self.i] = x + self.store * fb;
        self.i += 1;
        if self.i >= self.buf.len() {
            self.i = 0;
        }
        out
    }
}

struct Allpass {
    buf: Vec<f32>,
    i: usize,
}

impl Allpass {
    fn new(n: usize) -> Self {
        Allpass { buf: vec![0.0; n.max(8)], i: 0 }
    }
    #[inline]
    fn run(&mut self, x: f32) -> f32 {
        let b = self.buf[self.i];
        let out = b - x;
        self.buf[self.i] = x + b * 0.5;
        self.i += 1;
        if self.i >= self.buf.len() {
            self.i = 0;
        }
        out
    }
}

pub struct Synth {
    sr: f32,
    p: [f32; NP],
    scene: usize,
    rng: Rng,
    pub out_l: [f32; MAX_FRAMES],
    pub out_r: [f32; MAX_FRAMES],
    vol: f32,
    // drone
    d_ph: [f32; 3],
    d_sub: f32,
    d_fm_c: f32,
    d_fm_m: f32,
    d_fl: Svf,
    d_fr: Svf,
    lfo1: f32,
    lfo2: f32,
    root_hz: f32,
    // ambience
    tx_a: Svf,
    tx_b: Svf,
    tx_lp: [f32; 4],
    tx_ph: [f32; 3],
    bub_env: f32,
    bub_ph: f32,
    bub_f: f32,
    bub_pan: f32,
    bub_timer: f32,
    crk: Svf,
    // voices + sequencer
    voices: [Voice; NV],
    seq_clock: f32,
    seq_step: u32,
    seq_deg: i32,
    // events
    th_env: f32,
    th_cut: f32,
    th_lp: [f32; 2],
    th_pan: f32,
    th_mod: f32,
    th_crack: f32,
    td_env: f32,
    td_ph: f32,
    td_f: f32,
    td_n: f32,
    td_lp: f32,
    td_pan: f32,
    ro_t: f32,
    ro_ph: f32,
    ro_amp: f32,
    ro_pan: f32,
    ro_f1: Svf,
    ro_f2: Svf,
    wh_t: f32,
    wh_ph: f32,
    wh_amp: f32,
    wh_pan: f32,
    // xy pad voice
    xy_down: bool,
    xy_x: f32,
    xy_y: f32,
    xy_amp: f32,
    xy_inc: f32,
    xy_ph: f32,
    xy_sub: f32,
    xy_f: Svf,
    // fx
    dl: Vec<f32>,
    dr: Vec<f32>,
    d_i: usize,
    combs_l: Vec<Comb>,
    combs_r: Vec<Comb>,
    ap_l: Vec<Allpass>,
    ap_r: Vec<Allpass>,
}

impl Synth {
    pub fn new(seed: u32, sr: f32) -> Self {
        let sr = if sr < 8000.0 { 48000.0 } else { sr };
        let k = sr / 44100.0;
        let lens = [1116.0, 1188.0, 1277.0, 1356.0, 1422.0, 1491.0];
        let mut combs_l = Vec::new();
        let mut combs_r = Vec::new();
        for l in lens.iter() {
            combs_l.push(Comb::new((l * k) as usize));
            combs_r.push(Comb::new(((l + 23.0) * k) as usize));
        }
        let ap_l = vec![Allpass::new((556.0 * k) as usize), Allpass::new((441.0 * k) as usize)];
        let ap_r = vec![Allpass::new((579.0 * k) as usize), Allpass::new((464.0 * k) as usize)];
        Synth {
            sr,
            p: scene_defaults(0),
            scene: 0,
            rng: Rng::new(seed ^ 0x51F1_5EED),
            out_l: [0.0; MAX_FRAMES],
            out_r: [0.0; MAX_FRAMES],
            vol: 0.0,
            d_ph: [0.0, 0.33, 0.66],
            d_sub: 0.0,
            d_fm_c: 0.0,
            d_fm_m: 0.0,
            d_fl: Svf::default(),
            d_fr: Svf::default(),
            lfo1: 0.0,
            lfo2: 0.0,
            root_hz: 73.4,
            tx_a: Svf::default(),
            tx_b: Svf::default(),
            tx_lp: [0.0; 4],
            tx_ph: [0.0; 3],
            bub_env: 0.0,
            bub_ph: 0.0,
            bub_f: 500.0,
            bub_pan: 0.0,
            bub_timer: 0.5,
            crk: Svf::default(),
            voices: [Voice::default(); NV],
            seq_clock: 0.0,
            seq_step: 0,
            seq_deg: 4,
            th_env: 0.0,
            th_cut: 60.0,
            th_lp: [0.0; 2],
            th_pan: 0.0,
            th_mod: 0.0,
            th_crack: 0.0,
            td_env: 0.0,
            td_ph: 0.0,
            td_f: 40.0,
            td_n: 0.0,
            td_lp: 0.0,
            td_pan: 0.0,
            ro_t: 9.0,
            ro_ph: 0.0,
            ro_amp: 0.0,
            ro_pan: 0.0,
            ro_f1: Svf::default(),
            ro_f2: Svf::default(),
            wh_t: 9.0,
            wh_ph: 0.0,
            wh_amp: 0.0,
            wh_pan: 0.0,
            xy_down: false,
            xy_x: 0.5,
            xy_y: 0.5,
            xy_amp: 0.0,
            xy_inc: 0.0,
            xy_ph: 0.0,
            xy_sub: 0.0,
            xy_f: Svf::default(),
            dl: vec![0.0; (sr * 2.0) as usize],
            dr: vec![0.0; (sr * 2.0) as usize],
            d_i: 0,
            combs_l,
            combs_r,
            ap_l,
            ap_r,
        }
    }

    pub fn set_param(&mut self, id: usize, v: f32) {
        if id < NP {
            self.p[id] = v.clamp(0.0, 1.0);
        }
    }

    pub fn set_scene(&mut self, scene: usize) {
        self.scene = scene.min(NSCENES - 1);
        self.seq_deg = 4;
    }

    fn root_note(&self) -> f32 {
        ROOTS[self.scene] + ((self.p[PITCH] - 0.5) * 24.0).round()
    }

    fn start_voice(&mut self, note: f32, vel: f32, pan: f32, held: bool) {
        let t = &TIMBRES[self.scene];
        let mut slot = 0;
        let mut quiet = 1e9;
        for (i, v) in self.voices.iter().enumerate() {
            let score = if v.on { v.env + if v.held { 2.0 } else { 0.0 } } else { -1.0 };
            if score < quiet {
                quiet = score;
                slot = i;
            }
        }
        let sr = self.sr;
        let fm = 0.4 + self.p[FM] * 1.6;
        self.voices[slot] = Voice {
            on: true,
            held,
            note,
            inc: midi_hz(note) / sr,
            pc: 0.0,
            pm: 0.0,
            env: 0.0,
            stage: 0,
            vel,
            ratio: t.ratio,
            index: t.index * fm,
            ienv: 1.0,
            idec: (-1.0 / (t.idec * sr)).exp(),
            att: 1.0 / (t.att * sr).max(1.0),
            dec: (-1.0 / (t.dec * 0.35 * sr)).exp(),
            sus: if held { 0.45 } else { 0.0 },
            rel: (-1.0 / (0.25 * sr)).exp(),
            pan,
        };
    }

    /// Keyboard note. `note` is a semitone offset from the scene root (two octaves up).
    pub fn note_on(&mut self, note: f32, vel: f32) {
        let n = self.root_note() + 24.0 + note;
        for v in self.voices.iter_mut() {
            if v.on && v.held && v.note == n {
                v.held = false;
                v.stage = 2;
            }
        }
        let pan = ((note * 0.37).sin()) * 0.5;
        self.start_voice(n, vel.clamp(0.05, 1.0) * 0.5, pan, true);
    }

    pub fn note_off(&mut self, note: f32) {
        let n = self.root_note() + 24.0 + note;
        for v in self.voices.iter_mut() {
            if v.on && v.held && v.note == n {
                v.held = false;
                v.stage = 2;
            }
        }
    }

    pub fn xy(&mut self, x: f32, y: f32, down: bool) {
        self.xy_x = x.clamp(0.0, 1.0);
        self.xy_y = y.clamp(0.0, 1.0);
        self.xy_down = down;
    }

    pub fn trigger(&mut self, kind: u32, a: f32, b: f32) {
        let a = a.clamp(0.0, 1.5);
        let pan = b.clamp(-1.0, 1.0);
        match kind {
            1 => {
                self.th_env = self.th_env.max(a);
                self.th_cut = 2600.0;
                self.th_crack = a;
                self.th_pan = pan;
            }
            2 => {
                self.td_env = a;
                self.td_f = 95.0;
                self.td_ph = 0.0;
                self.td_n = a;
                self.td_pan = pan;
            }
            3 => {
                self.ro_t = 0.0;
                self.ro_amp = a;
                self.ro_pan = pan;
            }
            4 => {
                self.th_env = self.th_env.max(a * 1.1);
                self.th_cut = 700.0;
                self.th_crack = a * 0.3;
                self.th_pan = 0.0;
            }
            5 => {
                self.wh_t = 0.0;
                self.wh_amp = a;
                self.wh_pan = pan;
            }
            _ => {}
        }
    }

    fn sequencer_tick(&mut self) {
        let scale = SCALES[self.scene];
        let n = scale.len() as i32;
        let step = self.seq_step;
        self.seq_step = self.seq_step.wrapping_add(1);
        let accent = if step % 8 == 0 {
            1.0
        } else if step % 4 == 0 {
            0.7
        } else if step % 2 == 0 {
            0.45
        } else {
            0.22
        };
        if self.rng.f() > self.p[MELODY] * accent * 1.1 {
            return;
        }
        let jump = (self.rng.next() % 5) as i32 - 2;
        self.seq_deg = (self.seq_deg + jump).clamp(0, n * 2);
        if self.rng.f() < 0.08 {
            self.seq_deg = n;
        }
        let deg = self.seq_deg;
        let semis = scale[(deg % n) as usize] + 12.0 * (deg / n) as f32;
        let note = self.root_note() + 12.0 * TIMBRES[self.scene].octave + semis;
        let vel = self.rng.range(0.16, 0.34) * (0.6 + 0.4 * accent);
        let pan = self.rng.s() * 0.7;
        self.start_voice(note, vel, pan, false);
    }

    pub fn render(&mut self, frames: usize) {
        let n = frames.min(MAX_FRAMES);
        let sr = self.sr;
        let p = self.p;
        let scene = self.scene;

        // ---- control-rate values -------------------------------------------------
        let target_root = midi_hz(self.root_note());
        self.root_hz += (target_root - self.root_hz) * 0.08;
        let f0 = self.root_hz;
        self.lfo1 += TAU * 0.07 * n as f32 / sr;
        self.lfo2 += TAU * 0.031 * n as f32 / sr;
        if self.lfo1 > TAU {
            self.lfo1 -= TAU;
        }
        if self.lfo2 > TAU {
            self.lfo2 -= TAU;
        }
        let cut_hz = 70.0 * 2f32.powf(p[CUTOFF] * 7.0 + 0.6 * self.lfo1.sin());
        let d_g = svf_g(cut_hz, sr);
        let d_k = 2.0 - 1.85 * p[RESONANCE];
        let drone_amp = p[DRONE] * 0.2 * (0.85 + 0.15 * self.lfo2.sin());
        let fm_amt = p[FM];
        let inc = [f0 / sr, f0 * 1.006 / sr, f0 * 1.4983 / sr];
        let tex = p[TEXTURE];
        let wind_g = svf_g(320.0 + 260.0 * self.lfo1.sin() + 180.0 * (self.lfo2 * 2.3).sin(), sr);
        let wind_g2 = svf_g(520.0 + 300.0 * (self.lfo1 * 1.7 + 1.0).sin(), sr);
        let lp_rumble = pole(if scene == 2 { 75.0 } else { 120.0 }, sr);
        let lp_air = pole(420.0, sr);
        let lp_rain = pole(4200.0, sr);
        let crk_g = svf_g(2600.0, sr);
        let impact = p[IMPACT];
        let bpm = 40.0 + p[TEMPO] * 140.0;
        let step_len = sr * 60.0 / bpm / 4.0;
        let th_dec = (-1.0 / (1.1 * sr)).exp();
        let th_cut_dec = (-1.0 / (0.5 * sr)).exp();
        let td_dec = (-1.0 / (0.22 * sr)).exp();
        let td_fdec = (-1.0 / (0.07 * sr)).exp();
        let td_ndec = (-1.0 / (0.06 * sr)).exp();
        let td_lp = pole(380.0, sr);
        let th_mod_a = pole(7.0, sr);
        let bub_dec = (-1.0 / (0.05 * sr)).exp();
        // roar formants (control rate)
        let ro_u = (self.ro_t / 1.5).min(1.0);
        let ro_g1 = svf_g(380.0 + 520.0 * (PI * ro_u).sin(), sr);
        let ro_g2 = svf_g(1100.0 + 1300.0 * (PI * ro_u).sin(), sr);
        // xy voice
        let scale = SCALES[scene];
        let xi = (self.xy_x * (scale.len() as f32 * 2.0)).floor() as usize;
        let xy_note = self.root_note() + 24.0 + scale[xi % scale.len()] + 12.0 * (xi / scale.len()) as f32;
        let xy_target = midi_hz(xy_note) / sr;
        let xy_g = svf_g(200.0 * 2f32.powf(self.xy_y * 5.0), sr);
        let xy_gate = if self.xy_down { 1.0 } else { 0.0 };
        // fx
        let dly_samples = ((step_len * 3.0) as usize).clamp(64, self.dl.len() - 1);
        let dly_send = p[DELAY] * 0.6;
        let dly_fb = 0.35 + p[DELAY] * 0.3;
        let rev = p[REVERB];
        let rev_fb = 0.8 + rev * 0.17;
        let vol_target = p[VOLUME] * p[VOLUME] * 1.6;
        let dlen = self.dl.len();

        for i in 0..n {
            self.vol += (vol_target - self.vol) * 0.0006;
            let mut l = 0.0f32;
            let mut r = 0.0f32;
            let mut send = 0.0f32; // extra reverb send (impacts)
            let white = self.rng.s();
            let white2 = self.rng.s();

            // ---- drone -----------------------------------------------------------
            if drone_amp > 0.0005 {
                let a = saw(&mut self.d_ph[0], inc[0]);
                let b = saw(&mut self.d_ph[1], inc[1]);
                let c = saw(&mut self.d_ph[2], inc[2]) * 0.45;
                self.d_sub += inc[0] * 0.5;
                if self.d_sub >= 1.0 {
                    self.d_sub -= 1.0;
                }
                let sub = (self.d_sub * TAU).sin() * 1.3;
                self.d_fm_c += inc[0] * 2.0;
                self.d_fm_m += inc[0] * 3.01;
                if self.d_fm_c >= 1.0 {
                    self.d_fm_c -= 1.0;
                }
                if self.d_fm_m >= 1.0 {
                    self.d_fm_m -= 1.0;
                }
                let fmv = (self.d_fm_c * TAU + fm_amt * 5.0 * (self.d_fm_m * TAU).sin()).sin() * fm_amt;
                let (ll, _, _) = self.d_fl.run(a * 0.8 + b * 0.3 + c + fmv, d_g, d_k);
                let (rr, _, _) = self.d_fr.run(a * 0.3 + b * 0.8 + c + fmv, d_g, d_k);
                l += (ll + sub) * drone_amp;
                r += (rr + sub) * drone_amp;
            }

            // ---- ambience --------------------------------------------------------
            if tex > 0.001 {
                match scene {
                    0 => {
                        // wind through dunes + rain hiss
                        let (_, wl, _) = self.tx_a.run(white, wind_g, 0.7);
                        let (_, wr, _) = self.tx_b.run(white2, wind_g2, 0.7);
                        self.tx_lp[0] += lp_rain * (white - self.tx_lp[0]);
                        let rain = (white - self.tx_lp[0]) * 0.035 * p[DENSITY];
                        l += (wl * 0.22 + rain) * tex;
                        r += (wr * 0.22 + rain) * tex;
                    }
                    1 => {
                        // deep rumble + rising bubbles
                        self.tx_lp[0] += lp_rumble * (white - self.tx_lp[0]);
                        self.tx_lp[1] += lp_rumble * (white2 - self.tx_lp[1]);
                        l += self.tx_lp[0] * 1.6 * tex;
                        r += self.tx_lp[1] * 1.6 * tex;
                        self.bub_timer -= 1.0 / sr;
                        if self.bub_timer <= 0.0 {
                            self.bub_timer = self.rng.range(0.05, 0.7);
                            self.bub_env = self.rng.range(0.3, 1.0);
                            self.bub_f = self.rng.range(300.0, 1100.0);
                            self.bub_pan = self.rng.s();
                        }
                        self.bub_f *= 1.00016;
                        self.bub_ph += self.bub_f / sr;
                        if self.bub_ph >= 1.0 {
                            self.bub_ph -= 1.0;
                        }
                        self.bub_env *= bub_dec;
                        let bv = (self.bub_ph * TAU).sin() * self.bub_env * 0.07 * tex;
                        l += bv * (1.0 - self.bub_pan) * 0.5;
                        r += bv * (1.0 + self.bub_pan) * 0.5;
                        send += bv * 0.5;
                    }
                    2 => {
                        // magma rumble + crackle
                        self.tx_lp[0] += lp_rumble * (white - self.tx_lp[0]);
                        self.tx_lp[1] += lp_rumble * (white2 - self.tx_lp[1]);
                        let k = 2.6 * tex * (0.6 + p[INTENSITY]);
                        l += self.tx_lp[0] * k;
                        r += self.tx_lp[1] * k;
                        let imp = if self.rng.f() < 9.0 / sr * (0.5 + p[INTENSITY]) { self.rng.s() * 4.0 } else { 0.0 };
                        let (_, cb, _) = self.crk.run(imp, crk_g, 0.25);
                        let pan = (self.lfo1 * 9.0).sin();
                        l += cb * 0.12 * tex * (1.0 - pan * 0.6);
                        r += cb * 0.12 * tex * (1.0 + pan * 0.6);
                    }
                    _ => {
                        // city hum, air and a far siren
                        self.tx_ph[0] += 50.0 / sr;
                        self.tx_ph[1] += 100.3 / sr;
                        self.tx_ph[2] += (640.0 + 110.0 * (self.lfo1 * 5.0).sin()) / sr;
                        for q in self.tx_ph.iter_mut() {
                            if *q >= 1.0 {
                                *q -= 1.0;
                            }
                        }
                        let hum = ((self.tx_ph[0] * TAU).sin() + 0.5 * (self.tx_ph[1] * TAU).sin()) * 0.03;
                        self.tx_lp[0] += lp_air * (white - self.tx_lp[0]);
                        self.tx_lp[1] += lp_air * (white2 - self.tx_lp[1]);
                        let siren = (self.tx_ph[2] * TAU).sin() * 0.006 * (0.5 + 0.5 * self.lfo2.sin());
                        l += (hum + self.tx_lp[0] * 0.35 + siren * 0.4) * tex;
                        r += (hum + self.tx_lp[1] * 0.35 + siren) * tex;
                        send += siren * tex * 2.0;
                    }
                }
            }

            // ---- sequencer + voices ----------------------------------------------
            self.seq_clock += 1.0;
            if self.seq_clock >= step_len {
                self.seq_clock -= step_len;
                self.sequencer_tick();
            }
            for v in self.voices.iter_mut() {
                if !v.on {
                    continue;
                }
                match v.stage {
                    0 => {
                        v.env += v.att;
                        if v.env >= 1.0 {
                            v.env = 1.0;
                            v.stage = 1;
                        }
                    }
                    1 => {
                        v.env = v.sus + (v.env - v.sus) * v.dec;
                        if !v.held && v.env < 0.0008 {
                            v.on = false;
                        }
                    }
                    _ => {
                        v.env *= v.rel;
                        if v.env < 0.0008 {
                            v.on = false;
                        }
                    }
                }
                v.ienv *= v.idec;
                v.pc += v.inc;
                v.pm += v.inc * v.ratio;
                if v.pc >= 1.0 {
                    v.pc -= 1.0;
                }
                if v.pm >= 1.0 {
                    v.pm -= 1.0;
                }
                let s = (v.pc * TAU + v.index * v.ienv * (v.pm * TAU).sin()).sin() * v.env * v.vel;
                l += s * (1.0 - v.pan) * 0.5;
                r += s * (1.0 + v.pan) * 0.5;
            }

            // ---- xy pad (theremin-style lead) ------------------------------------
            self.xy_amp += (xy_gate - self.xy_amp) * 0.0015;
            if self.xy_amp > 0.0005 {
                self.xy_inc += (xy_target - self.xy_inc) * 0.002;
                let s = saw(&mut self.xy_ph, self.xy_inc);
                self.xy_sub += self.xy_inc * 0.5;
                if self.xy_sub >= 1.0 {
                    self.xy_sub -= 1.0;
                }
                let (lp, _, _) = self.xy_f.run(s + (self.xy_sub * TAU).sin() * 0.6, xy_g, 0.6);
                let s = lp * self.xy_amp * 0.22;
                let pan = self.xy_x * 2.0 - 1.0;
                l += s * (1.0 - pan * 0.5);
                r += s * (1.0 + pan * 0.5);
            }

            // ---- impacts ---------------------------------------------------------
            if impact > 0.001 {
                let mut ev_l = 0.0;
                let mut ev_r = 0.0;
                if self.th_env > 0.0004 {
                    // thunder / eruption: noise through a falling low-pass with a rolling amplitude
                    self.th_cut = 55.0 + (self.th_cut - 55.0) * th_cut_dec;
                    let a = (TAU * self.th_cut / sr).min(0.9);
                    self.th_lp[0] += a * (white - self.th_lp[0]);
                    self.th_lp[1] += a * (self.th_lp[0] - self.th_lp[1]);
                    self.th_mod += th_mod_a * (white2 - self.th_mod);
                    let roll = (1.0 + self.th_mod * 14.0).clamp(0.2, 2.2);
                    let body = self.th_lp[1] * self.th_env * 5.5 * roll;
                    let crack = white2 * self.th_crack * self.th_crack * 0.5;
                    self.th_crack *= 0.9992;
                    self.th_env *= th_dec;
                    let s = body + crack;
                    ev_l += s * (1.0 - self.th_pan * 0.6);
                    ev_r += s * (1.0 + self.th_pan * 0.6);
                }
                if self.td_env > 0.0004 {
                    // titan footstep: pitch-dropping sine + low noise burst
                    self.td_f = 33.0 + (self.td_f - 33.0) * td_fdec;
                    self.td_ph += self.td_f / sr;
                    if self.td_ph >= 1.0 {
                        self.td_ph -= 1.0;
                    }
                    self.td_lp += td_lp * (white * self.td_n - self.td_lp);
                    let s = (self.td_ph * TAU).sin() * self.td_env * 1.3 + self.td_lp * 2.2;
                    self.td_env *= td_dec;
                    self.td_n *= td_ndec;
                    ev_l += s * (1.0 - self.td_pan * 0.5);
                    ev_r += s * (1.0 + self.td_pan * 0.5);
                }
                if self.ro_t < 1.5 {
                    // dragon roar: rough saw through two sweeping formants
                    let u = self.ro_t / 1.5;
                    let env = (PI * u).sin().powf(0.7);
                    let f = 62.0 + 70.0 * (PI * u).sin();
                    let s = saw(&mut self.ro_ph, f / sr) + white * 0.5;
                    let rough = 0.65 + 0.35 * (self.ro_t * TAU * 29.0).sin();
                    let (_, b1, _) = self.ro_f1.run(s, ro_g1, 0.35);
                    let (_, b2, _) = self.ro_f2.run(s, ro_g2, 0.3);
                    let o = (b1 + b2 * 0.6) * env * rough * self.ro_amp * 0.75;
                    self.ro_t += 1.0 / sr;
                    ev_l += o * (1.0 - self.ro_pan * 0.6);
                    ev_r += o * (1.0 + self.ro_pan * 0.6);
                }
                if self.wh_t < 3.0 {
                    // whale-like call: slow glide with vibrato
                    let u = self.wh_t / 3.0;
                    let env = (PI * u).sin();
                    let f = 150.0 + 190.0 * (PI * u * 1.3).sin() + 6.0 * (self.wh_t * 31.0).sin();
                    self.wh_ph += f / sr;
                    if self.wh_ph >= 1.0 {
                        self.wh_ph -= 1.0;
                    }
                    let w = self.wh_ph * TAU;
                    let o = (w.sin() + 0.3 * (w * 2.0).sin()) * env * env * self.wh_amp * 0.12;
                    self.wh_t += 1.0 / sr;
                    ev_l += o * (1.0 - self.wh_pan * 0.7);
                    ev_r += o * (1.0 + self.wh_pan * 0.7);
                    send += o * 1.5;
                }
                l += ev_l * impact;
                r += ev_r * impact;
                send += (ev_l + ev_r) * 0.35 * impact;
            }

            // ---- delay (ping-pong) -----------------------------------------------
            let rd = (self.d_i + dlen - dly_samples) % dlen;
            let dl_out = self.dl[rd];
            let dr_out = self.dr[rd];
            self.dl[self.d_i] = (l + r) * 0.5 * dly_send + dr_out * dly_fb;
            self.dr[self.d_i] = dl_out * dly_fb;
            self.d_i += 1;
            if self.d_i >= dlen {
                self.d_i = 0;
            }
            l += dl_out;
            r += dr_out;

            // ---- reverb ----------------------------------------------------------
            let rin = ((l + r) * 0.5 + send) * 0.03;
            let mut wl = 0.0;
            let mut wr = 0.0;
            for c in self.combs_l.iter_mut() {
                wl += c.run(rin, rev_fb, 0.3);
            }
            for c in self.combs_r.iter_mut() {
                wr += c.run(rin, rev_fb, 0.3);
            }
            for a in self.ap_l.iter_mut() {
                wl = a.run(wl);
            }
            for a in self.ap_r.iter_mut() {
                wr = a.run(wr);
            }
            l += wl * rev * 1.6;
            r += wr * rev * 1.6;

            self.out_l[i] = (l * self.vol).tanh();
            self.out_r[i] = (r * self.vol).tanh();
        }
    }
}
