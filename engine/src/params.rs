#![allow(dead_code)]
//! The parameter table is the single source of truth shared by the simulation,
//! the synthesizer and (via `describe_json`) the TypeScript UI.
//! Every parameter is normalised to 0..1. A parameter with `options` is a
//! selector: its value is `index / (options - 1)`.

pub struct ParamDef {
    pub key: &'static str,
    pub label: &'static str,
    pub group: &'static str,
    pub default: f32,
    pub options: &'static [&'static str],
}

macro_rules! table {
    ($( $id:ident = $k:expr, $l:expr, $g:expr, $d:expr, [$($o:expr),*]; )*) => {
        table!(@consts 0usize; $($id,)*);
        pub const PARAMS: &[ParamDef] = &[
            $( ParamDef { key: $k, label: $l, group: $g, default: $d, options: &[$($o),*] }, )*
        ];
    };
    (@consts $n:expr; $id:ident, $($rest:ident,)*) => {
        pub const $id: usize = $n;
        table!(@consts $n + 1usize; $($rest,)*);
    };
    (@consts $n:expr;) => { pub const NP: usize = $n; };
}

table! {
    SPEED = "speed", "Speed", "World", 0.5, [];
    STORM = "storm", "Lightning", "World", 0.55, [];
    WIND = "wind", "Wind", "World", 0.5, [];
    RAIN = "rain", "Rain", "World", 0.45, [];
    SAND = "sand", "Blowing sand", "World", 0.35, [];

    ORBIT = "orbit", "Auto orbit", "Camera", 0.15, [];
    ZOOM = "zoom", "Distance", "Camera", 0.3, [];
    EYE = "eye", "Eye height", "Camera", 0.06, [];
    LENS = "lens", "Lens (wide \u{2192} tele)", "Camera", 0.3, [];
    SHIFT = "shift", "Lens shift", "Camera", 0.5, [];

    WARP = "warp", "Hyper lens", "4D", 0.0, [];
    WSPEED = "wspeed", "4D drift", "4D", 0.3, [];
    FOLD = "fold", "Dune fold", "4D", 0.2, [];

    HUE = "hue", "Hue shift", "Look", 0.0, [];
    SATURATION = "saturation", "Saturation", "Look", 0.55, [];
    BRIGHTNESS = "brightness", "Brightness", "Look", 0.5, [];
    CONTRAST = "contrast", "Contrast", "Look", 0.5, [];
    BLOOM = "bloom", "Bloom", "Look", 0.45, [];

    ROUTE = "route", "FX routing", "Psychedelic FX", 0.0, ["Serial", "Parallel"];
    FLAME = "flame", "Fractal flame", "Psychedelic FX", 0.0, [];
    FLAMEVAR = "flamevar", "\u{21b3} variation", "Psychedelic FX", 0.35, [];
    FLAMESYM = "flamesym", "\u{21b3} symmetry", "Psychedelic FX", 0.3, [];
    FLAMESPEED = "flamespeed", "\u{21b3} morph", "Psychedelic FX", 0.4, [];
    FLAMEZOOM = "flamezoom", "\u{21b3} size", "Psychedelic FX", 0.5, [];
    KALEIDO = "kaleido", "Kaleidoscope", "Psychedelic FX", 0.0, [];
    KSEG = "kseg", "\u{21b3} segments", "Psychedelic FX", 0.35, [];
    KSPIN = "kspin", "\u{21b3} spin", "Psychedelic FX", 0.2, [];
    FEEDBACK = "feedback", "Trails", "Psychedelic FX", 0.0, [];
    FBZOOM = "fbzoom", "\u{21b3} zoom", "Psychedelic FX", 0.55, [];
    FBROT = "fbrot", "\u{21b3} twist", "Psychedelic FX", 0.55, [];
    FBHUE = "fbhue", "\u{21b3} colour cycle", "Psychedelic FX", 0.0, [];
    TUNNEL = "tunnel", "Tunnel", "Psychedelic FX", 0.0, [];
    TUNSPEED = "tunspeed", "\u{21b3} speed", "Psychedelic FX", 0.4, [];
    LIQUID = "liquid", "Liquid", "Psychedelic FX", 0.0, [];
    LIQSCALE = "liqscale", "\u{21b3} scale", "Psychedelic FX", 0.4, [];
    ACID = "acid", "Spectrum", "Psychedelic FX", 0.0, [];
    ACIDCYC = "acidcyc", "\u{21b3} bands", "Psychedelic FX", 0.35, [];
    ACIDSPEED = "acidspeed", "\u{21b3} flow", "Psychedelic FX", 0.3, [];
    EDGE = "edge", "Neon edges", "Psychedelic FX", 0.0, [];
    RGB = "rgb", "RGB split", "Psychedelic FX", 0.0, [];
    POSTER = "poster", "Posterize", "Psychedelic FX", 0.0, [];
    GLITCH = "glitch", "Glitch", "Psychedelic FX", 0.0, [];
    REACT = "react", "Audio react", "Psychedelic FX", 0.6, [];

    CAMMIX = "cammix", "Camera mix", "Mix", 0.6, [];
    VIDMIX = "vidmix", "Video mix", "Mix", 0.6, [];

    VOLUME = "volume", "Volume", "Sound", 0.7, [];
    KEY = "key", "Key", "Sound", 0.1818, ["C", "C\u{266f}", "D", "E\u{266d}", "E", "F", "F\u{266f}", "G", "A\u{266d}", "A", "B\u{266d}", "B"];
    TEMPER = "temper", "Temperament", "Sound", 0.0, ["Werckmeister III", "Kirnberger III", "Vallotti", "Young II", "Equal"];
    AROUTE = "aroute", "Audio FX routing", "Sound", 0.0, ["Serial", "Parallel"];
    ORGAN = "organ", "Organ chords", "Sound", 0.55, [];
    HARMONICS = "harmonics", "Harmonics", "Sound", 0.35, [];
    DRONE = "drone", "Bass drone", "Sound", 0.5, [];
    CUTOFF = "cutoff", "Filter", "Sound", 0.5, [];
    RESONANCE = "resonance", "Resonance", "Sound", 0.3, [];
    MELODY = "melody", "Melody", "Sound", 0.5, [];
    TEMPO = "tempo", "Tempo", "Sound", 0.3, [];
    TEXTURE = "texture", "Ambience", "Sound", 0.6, [];
    IMPACT = "impact", "Impacts", "Sound", 0.75, [];
    REVERB = "reverb", "Reverb", "Sound", 0.6, [];
    DELAY = "delay", "Echo", "Sound", 0.3, [];
}

pub const WORLD_NAME: &str = "Titan skeleton walking through sand dunes in a thunderstorm";

pub fn defaults() -> [f32; NP] {
    let mut d = [0.0f32; NP];
    for (i, p) in PARAMS.iter().enumerate() {
        d[i] = p.default;
    }
    d
}

/// Index of the selected option of a selector parameter.
pub fn choice(p: &[f32; NP], id: usize) -> usize {
    let n = PARAMS[id].options.len().max(2);
    ((p[id].clamp(0.0, 1.0) * (n - 1) as f32).round() as usize).min(n - 1)
}

/// JSON description of the parameters for the UI.
pub fn describe_json() -> String {
    let mut s = String::from("{\"world\":\"");
    s.push_str(WORLD_NAME);
    s.push_str("\",\"params\":[");
    for (i, p) in PARAMS.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            "{{\"id\":{},\"key\":\"{}\",\"label\":\"{}\",\"group\":\"{}\",\"default\":{},\"options\":[",
            i, p.key, p.label, p.group, p.default
        ));
        for (k, o) in p.options.iter().enumerate() {
            if k > 0 {
                s.push(',');
            }
            s.push('"');
            s.push_str(o);
            s.push('"');
        }
        s.push_str("]}");
    }
    s.push_str("]}");
    s
}
