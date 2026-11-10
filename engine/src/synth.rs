//! Sound synthesizer, built around historical well temperaments.
//!
//! Every pitch in the engine goes through `Synth::freq`, which looks the note up
//! in a 12-tone circulating temperament (Werckmeister III by default) instead of
//! equal temperament. Because those tunings give each key its own colour, the
//! music is deliberately tonal: a pipe-organ style chord progression in a minor
//! key, a pedal bass and a harpsichord-like melody that outlines the chords.
//! Changing `Key` transposes the piece and audibly changes the size of its thirds
//! and fifths. Weather and impacts (wind, rain, thunder, footfalls, the electric
//! crack when the titan is struck) are layered on top.
//!
//! The effect section can be wired in series (dry -> echo -> reverb) or in
//! parallel (echo and reverb both fed from the dry signal).

use crate::params::*;
use crate::rng::Rng;

const PI: f32 = core::f32::consts::PI;
const TAU: f32 = PI * 2.0;
pub const MAX_FRAMES: usize = 1024;
const NV: usize = 10;

/// Cents above C for each pitch class.
const TEMPERAMENTS: [[f32; 12]; 5] = [
    // Werckmeister III (1691)
    [0.0, 90.225, 192.18, 294.135, 390.225, 498.045, 588.27, 696.09, 792.18, 888.27, 996.09, 1092.18],
    // Kirnberger III
    [0.0, 90.225, 193.157, 294.135, 386.314, 498.045, 590.224, 696.578, 792.18, 889.735, 996.09, 1088.269],
    // Vallotti
    [0.0, 94.135, 196.09, 298.045, 392.18, 501.955, 592.18, 698.045, 796.09, 894.135, 1000.0, 1090.225],
    // Young II (1799)
    [0.0, 90.225, 196.09, 294.135, 392.18, 498.045, 588.27, 698.045, 792.18, 894.135, 996.09, 1090.225],
    // Equal temperament, for comparison
    [0.0, 100.0, 200.0, 300.0, 400.0, 500.0, 600.0, 700.0, 800.0, 900.0, 1000.0, 1100.0],
];

/// Chord progression in a minor key: i VI III VII i iv V i (semitones above the tonic).
const CHORDS: [[f32; 3]; 8] = [
    [0.0, 3.0, 7.0],
    [8.0, 0.0, 3.0],
    [3.0, 7.0, 10.0],
    [10.0, 2.0, 5.0],
    [0.0, 3.0, 7.0],
    [5.0, 8.0, 0.0],
    [7.0, 11.0, 2.0],
    [0.0, 3.0, 7.0],
];
const MINOR: [f32; 7] = [0.0, 2.0, 3.0, 5.0, 7.0, 8.0, 10.0];

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

/// Plucked voice (harpsichord-like two-operator FM).
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
    index: f32,
    ienv: f32,
    idec: f32,
    dec: f32,
    sus: f32,
    rel: f32,
    pan: f32,
}

/// One rank of the organ: a sustained additive voice that cross-fades between chords.
#[derive(Clone, Copy, Default)]
struct Pipe {
    ph: f32,
    inc: f32,
    next: f32,
    amp: f32,
    pan: f32,
}

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
    rng: Rng,
    pub out_l: [f32; MAX_FRAMES],
    pub out_r: [f32; MAX_FRAMES],
    vol: f32,
    // harmony
    pipes: [Pipe; 4],
    chord: usize,
    chord_seen: i32,
    key_seen: i32,
    temper_seen: i32,
    // bass
    b_ph: [f32; 2],
    b_sub: f32,
    b_inc: f32,
    b_fl: Svf,
    b_fr: Svf,
    lfo1: f32,
    lfo2: f32,
    // weather
    wx_a: Svf,
    wx_b: Svf,
    wx_lp: [f32; 3],
    // melody
    voices: [Voice; NV],
    seq_clock: f32,
    seq_step: u32,
    seq_deg: i32,
    // impacts
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
    zp_env: f32,
    zp_ph: f32,
    zp_lp: f32,
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
        let mut pipes = [Pipe::default(); 4];
        for (i, pipe) in pipes.iter_mut().enumerate() {
            pipe.pan = [-0.5, 0.2, 0.55, -0.15][i];
        }
        Synth {
            sr,
            p: defaults(),
            rng: Rng::new(seed ^ 0x51F1_5EED),
            out_l: [0.0; MAX_FRAMES],
            out_r: [0.0; MAX_FRAMES],
            vol: 0.0,
            pipes,
            chord: 0,
            chord_seen: -1,
            key_seen: -1,
            temper_seen: -1,
            b_ph: [0.0, 0.5],
            b_sub: 0.0,
            b_inc: 0.001,
            b_fl: Svf::default(),
            b_fr: Svf::default(),
            lfo1: 0.0,
            lfo2: 0.0,
            wx_a: Svf::default(),
            wx_b: Svf::default(),
            wx_lp: [0.0; 3],
            voices: [Voice::default(); NV],
            seq_clock: 0.0,
            seq_step: 0,
            seq_deg: 7,
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
            zp_env: 0.0,
            zp_ph: 0.0,
            zp_lp: 0.0,
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

    /// Frequency of a MIDI note in the selected temperament, with A4 = 440 Hz.
    fn freq(&self, midi: f32) -> f32 {
        let table = &TEMPERAMENTS[choice(&self.p, TEMPER).min(4)];
        let n = midi.round();
        let pc = n.rem_euclid(12.0) as usize;
        let octave = ((n - pc as f32) / 12.0).round() - 5.0; // octave of C4 = MIDI 60 is 0
        let cents = octave * 1200.0 + table[pc] - (table[9] - 900.0) - 900.0;
        // A4 (pc 9, octave 0) -> cents = table[9] - table[9] = 0
        440.0 * 2f32.powf(cents / 1200.0)
    }

    /// MIDI note of the tonic in the bass register (between A-flat 1 and G 2).
    fn tonic(&self) -> f32 {
        let k = choice(&self.p, KEY) as f32;
        if k >= 8.0 {
            24.0 + k
        } else {
            36.0 + k
        }
    }

    fn pluck(&mut self, note: f32, vel: f32, pan: f32, held: bool) {
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
        self.voices[slot] = Voice {
            on: true,
            held,
            note,
            inc: self.freq(note) / sr,
            pc: 0.0,
            pm: 0.0,
            env: 0.0,
            stage: 0,
            vel,
            index: 2.5 + self.p[HARMONICS] * 6.0,
            ienv: 1.0,
            idec: (-1.0 / (0.09 * sr)).exp(),
            dec: (-1.0 / (0.45 * sr)).exp(),
            sus: if held { 0.4 } else { 0.0 },
            rel: (-1.0 / (0.2 * sr)).exp(),
            pan,
        };
    }

    /// Keyboard note: semitones above the tonic, two octaves up. Chromatic, so every
    /// interval of the temperament can be auditioned.
    pub fn note_on(&mut self, note: f32, vel: f32) {
        let n = self.tonic() + 24.0 + note;
        self.release(n);
        self.pluck(n, vel.clamp(0.05, 1.0) * 0.5, (note * 0.37).sin() * 0.5, true);
    }

    pub fn note_off(&mut self, note: f32) {
        let n = self.tonic() + 24.0 + note;
        self.release(n);
    }

    fn release(&mut self, n: f32) {
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
                self.zp_env = a;
            }
            _ => {}
        }
    }

    /// Scale degree -> semitones above the tonic (harmonic minor over the dominant).
    fn degree(&self, deg: i32) -> f32 {
        let d = deg.rem_euclid(7) as usize;
        let mut s = MINOR[d];
        if d == 6 && self.chord == 6 {
            s = 11.0;
        }
        s + 12.0 * deg.div_euclid(7) as f32
    }

    fn sequencer_tick(&mut self) {
        let step = self.seq_step;
        self.seq_step = self.seq_step.wrapping_add(1);
        self.chord = ((step / 32) % 8) as usize;
        let accent = if step % 8 == 0 {
            1.0
        } else if step % 4 == 0 {
            0.7
        } else if step % 2 == 0 {
            0.45
        } else {
            0.22
        };
        if self.rng.f() > self.p[MELODY] * accent * 1.15 {
            return;
        }
        let jump = (self.rng.next() % 5) as i32 - 2;
        self.seq_deg = (self.seq_deg + jump).clamp(0, 16);
        // On strong beats land on a chord tone, so the harmony (and the temperament) stays clear.
        if accent >= 0.7 {
            let ch = CHORDS[self.chord];
            'search: for off in [0, 1, -1, 2, -2] {
                let s = self.degree(self.seq_deg + off).rem_euclid(12.0);
                for c in ch.iter() {
                    if (s - c).abs() < 0.5 {
                        self.seq_deg += off;
                        break 'search;
                    }
                }
            }
        }
        let note = self.tonic() + 24.0 + self.degree(self.seq_deg);
        let vel = self.rng.range(0.14, 0.3) * (0.6 + 0.4 * accent);
        let pan = self.rng.s() * 0.6;
        self.pluck(note, vel, pan, false);
    }

    pub fn render(&mut self, frames: usize) {
        let n = frames.min(MAX_FRAMES);
        let sr = self.sr;
        let p = self.p;

        // ---- control rate: harmony ---------------------------------------------
        let tonic = self.tonic();
        let key = choice(&p, KEY) as i32;
        let temper = choice(&p, TEMPER) as i32;
        if self.chord as i32 != self.chord_seen || key != self.key_seen || temper != self.temper_seen {
            self.chord_seen = self.chord as i32;
            self.key_seen = key;
            self.temper_seen = temper;
            let ch = CHORDS[self.chord];
            for k in 0..4 {
                let semis = if k < 3 { ch[k].rem_euclid(12.0) + 24.0 } else { ch[0].rem_euclid(12.0) + 36.0 };
                self.pipes[k].next = self.freq(tonic + semis) / sr;
            }
        }
        let root = CHORDS[self.chord][0];
        let bass_note = tonic + if root > 7.5 { root - 12.0 } else { root };
        let bass_target = self.freq(bass_note) / sr;

        self.lfo1 += TAU * 0.07 * n as f32 / sr;
        self.lfo2 += TAU * 0.031 * n as f32 / sr;
        if self.lfo1 > TAU {
            self.lfo1 -= TAU;
        }
        if self.lfo2 > TAU {
            self.lfo2 -= TAU;
        }
        let cut_hz = 70.0 * 2f32.powf(p[CUTOFF] * 7.0 + 0.5 * self.lfo1.sin());
        let f_g = svf_g(cut_hz, sr);
        let f_k = 2.0 - 1.85 * p[RESONANCE];
        let drone_amp = p[DRONE] * 0.2;
        let organ_amp = p[ORGAN] * 0.085;
        let h = p[HARMONICS];
        let partials = [1.0, 0.5, 0.22 + 0.3 * h, 0.5 * h, 0.35 * h * h];
        let tex = p[TEXTURE];
        let wind_amt = tex * (0.05 + p[WIND] * 0.3);
        let rain_amt = tex * p[RAIN] * 0.05;
        let wind_g = svf_g(300.0 + 240.0 * self.lfo1.sin() + 170.0 * (self.lfo2 * 2.3).sin() + 300.0 * p[WIND], sr);
        let wind_g2 = svf_g(480.0 + 280.0 * (self.lfo1 * 1.7 + 1.0).sin() + 300.0 * p[WIND], sr);
        let lp_rain = pole(4200.0, sr);
        let lp_rumble = pole(90.0, sr);
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
        let zp_dec = (-1.0 / (0.16 * sr)).exp();
        let zp_lp = pole(900.0, sr);
        // xy voice, quantised to the minor scale of the current key
        let xi = (self.xy_x * 14.0).floor() as i32;
        let xy_target = self.freq(tonic + 24.0 + self.degree(xi)) / sr;
        let xy_g = svf_g(200.0 * 2f32.powf(self.xy_y * 5.0), sr);
        let xy_gate = if self.xy_down { 1.0 } else { 0.0 };
        // fx
        let dlen = self.dl.len();
        let dly_samples = ((step_len * 3.0) as usize).clamp(64, dlen - 1);
        let dly_send = p[DELAY] * 0.6;
        let dly_fb = 0.35 + p[DELAY] * 0.3;
        let rev = p[REVERB];
        let rev_fb = 0.8 + rev * 0.17;
        let serial = choice(&p, AROUTE) == 0;
        let vol_target = p[VOLUME] * p[VOLUME] * 1.6;

        for i in 0..n {
            self.vol += (vol_target - self.vol) * 0.0006;
            let mut l = 0.0f32;
            let mut r = 0.0f32;
            let mut send = 0.0f32;
            let white = self.rng.s();
            let white2 = self.rng.s();

            // ---- sequencer ---------------------------------------------------------
            self.seq_clock += 1.0;
            if self.seq_clock >= step_len {
                self.seq_clock -= step_len;
                self.sequencer_tick();
            }

            // ---- organ: four additive pipes ----------------------------------------
            if organ_amp > 0.0003 {
                for pipe in self.pipes.iter_mut() {
                    // Fade out, retune at silence, fade back in: no glides between chords.
                    let retune = (pipe.inc - pipe.next).abs() > 1e-9;
                    let gate = if retune { 0.0 } else { 1.0 };
                    pipe.amp += (gate - pipe.amp) * 0.0004;
                    if retune && pipe.amp < 0.02 {
                        pipe.inc = pipe.next;
                    }
                    pipe.ph += pipe.inc;
                    if pipe.ph >= 1.0 {
                        pipe.ph -= 1.0;
                    }
                    let w = pipe.ph * TAU;
                    let s = (w.sin() * partials[0]
                        + (w * 2.0).sin() * partials[1]
                        + (w * 3.0).sin() * partials[2]
                        + (w * 4.0).sin() * partials[3]
                        + (w * 6.0).sin() * partials[4])
                        * pipe.amp
                        * organ_amp;
                    l += s * (1.0 - pipe.pan);
                    r += s * (1.0 + pipe.pan);
                }
            }

            // ---- pedal bass --------------------------------------------------------
            if drone_amp > 0.0005 {
                self.b_inc += (bass_target - self.b_inc) * 0.0008;
                let a = saw(&mut self.b_ph[0], self.b_inc);
                let b = saw(&mut self.b_ph[1], self.b_inc * 2.0);
                self.b_sub += self.b_inc;
                if self.b_sub >= 1.0 {
                    self.b_sub -= 1.0;
                }
                let sub = (self.b_sub * TAU).sin() * 1.4;
                let (ll, _, _) = self.b_fl.run(a * 0.8 + b * 0.25, f_g, f_k);
                let (rr, _, _) = self.b_fr.run(a * 0.25 + b * 0.8, f_g, f_k);
                l += (ll + sub) * drone_amp;
                r += (rr + sub) * drone_amp;
            }

            // ---- weather: wind through the dunes, rain, distant rumble -------------
            if tex > 0.001 {
                let (_, wl, _) = self.wx_a.run(white, wind_g, 0.7);
                let (_, wr, _) = self.wx_b.run(white2, wind_g2, 0.7);
                self.wx_lp[0] += lp_rain * (white - self.wx_lp[0]);
                let rain = (white - self.wx_lp[0]) * rain_amt;
                self.wx_lp[1] += lp_rumble * (white2 - self.wx_lp[1]);
                let rumble = self.wx_lp[1] * 0.6 * tex * p[STORM];
                l += wl * wind_amt + rain + rumble;
                r += wr * wind_amt + rain + rumble;
            }

            // ---- plucked voices ----------------------------------------------------
            for v in self.voices.iter_mut() {
                if !v.on {
                    continue;
                }
                match v.stage {
                    0 => {
                        v.env += 0.02;
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
                v.pm += v.inc * 3.0;
                if v.pc >= 1.0 {
                    v.pc -= 1.0;
                }
                if v.pm >= 1.0 {
                    v.pm -= 1.0;
                }
                let s = (v.pc * TAU + v.index * (0.15 + v.ienv) * (v.pm * TAU).sin()).sin() * v.env * v.vel;
                l += s * (1.0 - v.pan) * 0.5;
                r += s * (1.0 + v.pan) * 0.5;
            }

            // ---- xy pad ------------------------------------------------------------
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

            // ---- impacts -----------------------------------------------------------
            if impact > 0.001 {
                let mut ev_l = 0.0;
                let mut ev_r = 0.0;
                if self.th_env > 0.0004 {
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
                if self.zp_env > 0.0004 {
                    // lightning hitting bone: a buzzing electric crack
                    self.zp_ph += 97.0 / sr;
                    if self.zp_ph >= 1.0 {
                        self.zp_ph -= 1.0;
                    }
                    let buzz = if self.zp_ph < 0.5 { 1.0 } else { 0.25 };
                    self.zp_lp += zp_lp * (white - self.zp_lp);
                    let s = (white - self.zp_lp) * self.zp_env * buzz * 0.7;
                    self.zp_env *= zp_dec;
                    ev_l += s;
                    ev_r += s;
                }
                l += ev_l * impact;
                r += ev_r * impact;
                send += (ev_l + ev_r) * 0.35 * impact;
            }

            // ---- echo and reverb, in series or in parallel -------------------------
            let rd = (self.d_i + dlen - dly_samples) % dlen;
            let dl_out = self.dl[rd];
            let dr_out = self.dr[rd];
            self.dl[self.d_i] = (l + r) * 0.5 * dly_send + dr_out * dly_fb;
            self.dr[self.d_i] = dl_out * dly_fb;
            self.d_i += 1;
            if self.d_i >= dlen {
                self.d_i = 0;
            }
            let dry = (l + r) * 0.5;
            let rin = if serial { dry + (dl_out + dr_out) * 0.5 + send } else { dry + send } * 0.03;
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
            l += dl_out + wl * rev * 1.6;
            r += dr_out + wr * rev * 1.6;

            self.out_l[i] = (l * self.vol).tanh();
            self.out_r[i] = (r * self.vol).tanh();
        }
    }
}
