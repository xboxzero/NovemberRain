//! NovemberRain engine. Compiled to a plain `wasm32-unknown-unknown` module with a
//! C ABI (no JS glue), so the very same binary can be instantiated on the main
//! thread (simulation + chat parser) and inside an AudioWorklet (synthesizer).

mod chat;
mod params;
mod rng;
mod sim;
mod synth;

use params::{defaults, NP};
use rng::Rng;
use sim::Sim;
use synth::Synth;

struct Engine {
    params: [f32; NP],
    sim: Sim,
    synth: Synth,
    rng: Rng,
    text: String,
    defaults: [f32; NP],
    describe: String,
}

impl Engine {
    fn new(seed: u32, sample_rate: f32) -> Self {
        Engine {
            params: defaults(),
            sim: Sim::new(seed),
            synth: Synth::new(seed, sample_rate),
            rng: Rng::new(seed ^ 0xC0FF_EE11),
            text: String::new(),
            defaults: defaults(),
            describe: params::describe_json(),
        }
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

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

/// # Safety
/// `ptr`/`len` must come from a previous `alloc(len)` call.
#[no_mangle]
pub unsafe extern "C" fn free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
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
pub extern "C" fn param_count() -> usize {
    NP
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

/// Pointer to the default parameter values (NP floats) of preset 1.
#[no_mangle]
pub extern "C" fn defaults_ptr() -> *const f32 {
    eng().defaults.as_ptr()
}

// ---- simulation --------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn step(dt: f32, bass: f32, mid: f32, high: f32) {
    let e = eng();
    let p = e.params;
    e.sim.step(dt, &p, bass.clamp(0.0, 1.0), mid.clamp(0.0, 1.0), high.clamp(0.0, 1.0));
}

#[no_mangle]
pub extern "C" fn data_ptr() -> *const f32 {
    eng().sim.data.as_ptr()
}

#[no_mangle]
pub extern "C" fn data_len() -> usize {
    sim::ND * 4
}

#[no_mangle]
pub extern "C" fn events_ptr() -> *const f32 {
    eng().sim.events.as_ptr()
}

#[no_mangle]
pub extern "C" fn events_len() -> usize {
    eng().sim.n_events
}

/// Throw a lightning bolt right now; `to_titan` != 0 aims it at the skull.
#[no_mangle]
pub extern "C" fn strike(to_titan: u32) {
    let e = eng();
    let fold = e.params[params::FOLD];
    e.sim.strike(1.0, to_titan != 0, fold);
}

// ---- chat ----------------------------------------------------------------------------

/// Parse a UTF-8 chat message. Returns a pointer to a JSON string; its length is `text_len()`.
///
/// # Safety
/// `ptr`/`len` must describe valid memory inside this instance.
#[no_mangle]
pub unsafe extern "C" fn chat(ptr: *const u8, len: usize) -> *const u8 {
    let e = eng();
    let bytes = core::slice::from_raw_parts(ptr, len);
    let input = String::from_utf8_lossy(bytes);
    let seed = e.rng.next();
    e.text = chat::parse(&input, &e.params, seed);
    e.text.as_ptr()
}

#[no_mangle]
pub extern "C" fn text_len() -> usize {
    eng().text.len()
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

#[no_mangle]
pub extern "C" fn max_frames() -> usize {
    synth::MAX_FRAMES
}
