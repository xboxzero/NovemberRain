//! NovemberRain engine. Compiled to a plain `wasm32-unknown-unknown` module with a
//! C ABI (no JS glue), so the very same binary can be instantiated on the main
//! thread (evolution) and inside an AudioWorklet (synthesizer).

mod evo;
mod params;
mod rng;
mod synth;

use evo::Evolution;
use params::{defaults, NP};
use synth::Synth;

struct Engine {
    params: [f32; NP],
    evo: Option<Evolution>,
    synth: Synth,
    seed: u32,
    defaults: [f32; NP],
    describe: String,
}

impl Engine {
    fn new(seed: u32, sample_rate: f32) -> Self {
        Engine { params: defaults(), evo: None, synth: Synth::new(seed, sample_rate), seed, defaults: defaults(), describe: params::describe_json() }
    }
    fn evo(&mut self) -> &mut Evolution {
        let seed = self.seed;
        self.evo.get_or_insert_with(|| Evolution::new(seed))
    }
}

static mut ENGINE: *mut Engine = core::ptr::null_mut();

fn eng() -> &'static mut Engine {
    // SAFETY: wasm instances are single threaded; every instance owns its own engine.
    unsafe {
        if ENGINE.is_null() {
            ENGINE = Box::into_raw(Box::new(Engine::new(1, 48000.0)));
        }
        &mut *ENGINE
    }
}

#[no_mangle]
pub extern "C" fn init(seed: u32, sample_rate: f32) {
    unsafe {
        if !ENGINE.is_null() {
            drop(Box::from_raw(ENGINE));
        }
        ENGINE = Box::into_raw(Box::new(Engine::new(seed, sample_rate)));
    }
}

// ---- description / parameters ----------------------------------------------------

#[no_mangle]
pub extern "C" fn describe_ptr() -> *const u8 {
    eng().describe.as_ptr()
}

#[no_mangle]
pub extern "C" fn describe_len() -> usize {
    eng().describe.len()
}

#[no_mangle]
pub extern "C" fn set_param(id: usize, v: f32) {
    let e = eng();
    if id < NP {
        e.params[id] = v.clamp(0.0, 1.0);
        e.synth.set_param(id, v);
    }
}

#[no_mangle]
pub extern "C" fn get_param(id: usize) -> f32 {
    if id < NP {
        eng().params[id]
    } else {
        0.0
    }
}

#[no_mangle]
pub extern "C" fn params_ptr() -> *const f32 {
    eng().params.as_ptr()
}

#[no_mangle]
pub extern "C" fn defaults_ptr() -> *const f32 {
    eng().defaults.as_ptr()
}

// ---- evolution -----------------------------------------------------------------------

/// Advance the evolving organism and return a pointer to its current (morphing) genome.
#[no_mangle]
pub extern "C" fn evolve(dt: f32, kick: f32) -> *const f32 {
    let e = eng();
    let (speed, mutation) = (e.params[params::EVOLVE], e.params[params::MUTATION]);
    let ev = e.evo();
    ev.step(dt, speed, mutation, kick.clamp(0.0, 1.0));
    ev.out.as_ptr()
}

#[no_mangle]
pub extern "C" fn genome_len() -> usize {
    evo::GLEN
}

/// (generation, fitness, morph progress, mean fitness of the pool, loved count, born-this-step flag)
#[no_mangle]
pub extern "C" fn info_ptr() -> *const f32 {
    eng().evo().info.as_ptr()
}

#[no_mangle]
pub extern "C" fn love() {
    eng().evo().love();
}

#[no_mangle]
pub extern "C" fn skip() {
    eng().evo().skip();
}

#[no_mangle]
pub extern "C" fn reseed() {
    eng().evo().reseed();
}

/// Scratch genome: write `genome_len()` floats here, then call `adopt()` to load them.
#[no_mangle]
pub extern "C" fn io_ptr() -> *mut f32 {
    eng().evo().io.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn adopt() {
    eng().evo().adopt();
}

// ---- synthesizer -------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn note_on(note: f32, vel: f32) {
    eng().synth.note_on(note, vel);
}

#[no_mangle]
pub extern "C" fn note_off(note: f32) {
    eng().synth.note_off(note);
}

#[no_mangle]
pub extern "C" fn xy(x: f32, y: f32, down: u32) {
    eng().synth.xy(x, y, down != 0);
}

#[no_mangle]
pub extern "C" fn trigger(kind: u32, a: f32, b: f32) {
    eng().synth.trigger(kind, a, b);
}

/// Render `frames` stereo samples. Returns a pointer to the left channel; the
/// right channel is at `render_right_ptr()`.
#[no_mangle]
pub extern "C" fn render(frames: usize) -> *const f32 {
    let e = eng();
    e.synth.render(frames);
    e.synth.out_l.as_ptr()
}

#[no_mangle]
pub extern "C" fn render_right_ptr() -> *const f32 {
    eng().synth.out_r.as_ptr()
}
