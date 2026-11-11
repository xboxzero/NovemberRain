//! NovemberRain engine. Compiled to a plain `wasm32-unknown-unknown` module with a
//! C ABI (no JS glue), so the very same binary can be instantiated on the main
//! thread (simulation + fractal flame) and inside an AudioWorklet (synthesizer).

mod flame;
mod params;
mod rng;
mod sim;
mod synth;

use flame::Flame;
use params::{defaults, NP};
use sim::Sim;
use synth::Synth;

struct Engine {
    params: [f32; NP],
    sim: Sim,
    synth: Synth,
    flame: Option<Flame>,
    seed: u32,
    defaults: [f32; NP],
    describe: String,
}

impl Engine {
    fn new(seed: u32, sample_rate: f32) -> Self {
        Engine {
            params: defaults(),
            sim: Sim::new(seed),
            synth: Synth::new(seed, sample_rate),
            flame: None,
            seed,
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

/// Height of the dune surface, so the camera can stand on the sand.
#[no_mangle]
pub extern "C" fn ground(x: f32, z: f32) -> f32 {
    let e = eng();
    sim::dune(x, z, e.params[params::FOLD], e.sim.w())
}

/// Throw a lightning bolt right now; `to_titan` != 0 aims it at the skull.
#[no_mangle]
pub extern "C" fn strike(to_titan: u32) {
    let e = eng();
    let fold = e.params[params::FOLD];
    e.sim.strike(1.0, to_titan != 0, fold);
}

// ---- fractal flame -------------------------------------------------------------------

/// Advance the fractal flame by `iters` chaos-game iterations and return a pointer
/// to its RGBA8 image (`flame_size()` squared pixels).
#[no_mangle]
pub extern "C" fn flame_render(iters: usize, dt: f32, energy: f32) -> *const u8 {
    let e = eng();
    let seed = e.seed;
    let p = e.params;
    let w = e.sim.w();
    let f = e.flame.get_or_insert_with(|| Flame::new(seed));
    f.render(iters.min(2_000_000), dt, p[params::FLAMEVAR], p[params::FLAMESYM], p[params::FLAMESPEED], w, p[params::HUE], energy);
    f.rgba.as_ptr()
}

#[no_mangle]
pub extern "C" fn flame_size() -> usize {
    flame::SIZE
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
