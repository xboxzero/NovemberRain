#![allow(dead_code)]
//! The parameter table is the single source of truth shared by the evolution
//! engine, the synthesizer and (via `describe_json`) the TypeScript UI.
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
    EVOLVE = "evolve", "Evolution speed", "Life", 0.5, [];
    MUTATION = "mutation", "Mutation", "Life", 0.4, [];
    SYMMETRY = "symmetry", "Symmetry", "Life", 0.0, ["Evolved", "1", "2", "3", "4", "5", "6", "7", "8"];

    DIM = "dim", "4th dimension", "Space", 0.5, [];
    ORBIT = "orbit", "Spin", "Space", 0.3, [];
    ZOOM = "zoom", "Zoom", "Space", 0.5, [];

    DOTS = "dots", "Dots", "Dots", 0.7, [];
    SOFT = "soft", "Softness", "Dots", 0.35, [];
    GLOW = "glow", "Glow", "Dots", 0.4, [];

    HUE = "hue", "Colour", "Colour", 0.0, [];
    PSY = "psy", "Psychedelia", "Colour", 0.45, [];
    TRAILS = "trails", "Trails", "Colour", 0.5, [];
    BRIGHTNESS = "brightness", "Brightness", "Colour", 0.5, [];

    REACT = "react", "Sound reaction", "Senses", 0.6, [];
    CAMCOL = "camcol", "Camera colours", "Senses", 0.8, [];
    EARTH = "earth", "Earth influence", "Senses", 0.6, [];

    VOLUME = "volume", "Volume", "Sound", 0.6, [];
    KEY = "key", "Key", "Sound", 0.1818, ["C", "C\u{266f}", "D", "E\u{266d}", "E", "F", "F\u{266f}", "G", "A\u{266d}", "A", "B\u{266d}", "B"];
    TEMPER = "temper", "Temperament", "Sound", 0.0, ["Werckmeister III", "Kirnberger III", "Vallotti", "Young II", "Equal"];
    AROUTE = "aroute", "Effect routing", "Sound", 0.0, ["Serial", "Parallel"];
    ORGAN = "organ", "Organ chords", "Sound", 0.5, [];
    HARMONICS = "harmonics", "Harmonics", "Sound", 0.35, [];
    DRONE = "drone", "Bass drone", "Sound", 0.45, [];
    CUTOFF = "cutoff", "Filter", "Sound", 0.5, [];
    RESONANCE = "resonance", "Resonance", "Sound", 0.3, [];
    MELODY = "melody", "Melody", "Sound", 0.5, [];
    TEMPO = "tempo", "Tempo", "Sound", 0.3, [];
    TEXTURE = "texture", "Wind", "Sound", 0.35, [];
    REVERB = "reverb", "Reverb", "Sound", 0.7, [];
    DELAY = "delay", "Echo", "Sound", 0.35, [];
}

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
    let mut s = String::from("{\"params\":[");
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
