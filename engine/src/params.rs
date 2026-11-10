#![allow(dead_code)]
//! The parameter table is the single source of truth shared by the simulation,
//! the synthesizer, the chat parser and (via `describe_json`) the TypeScript UI.
//! Every parameter is normalised to 0..1. A parameter with `options` is a
//! selector: its value is `index / (options - 1)`.

pub struct ParamDef {
    pub key: &'static str,
    pub label: &'static str,
    pub group: &'static str,
    pub default: f32,
    pub options: &'static [&'static str],
    /// Words / phrases the chat parser recognises for this parameter.
    pub words: &'static [&'static str],
}

macro_rules! table {
    ($( $id:ident = $k:expr, $l:expr, $g:expr, $d:expr, [$($o:expr),*], [$($w:expr),*]; )*) => {
        table!(@consts 0usize; $($id,)*);
        pub const PARAMS: &[ParamDef] = &[
            $( ParamDef { key: $k, label: $l, group: $g, default: $d, options: &[$($o),*], words: &[$($w),*] }, )*
        ];
    };
    (@consts $n:expr; $id:ident, $($rest:ident,)*) => {
        pub const $id: usize = $n;
        table!(@consts $n + 1usize; $($rest,)*);
    };
    (@consts $n:expr;) => { pub const NP: usize = $n; };
}

table! {
    SPEED = "speed", "Speed", "World", 0.5, [], ["speed", "motion speed", "walking speed", "pace"];
    STORM = "storm", "Lightning", "World", 0.55, [], ["lightning", "storm", "thunder", "thunderstorm", "bolts", "strikes", "intensity", "energy", "power", "rage"];
    WIND = "wind", "Wind", "World", 0.5, [], ["wind", "gusts", "gale", "breeze"];
    RAIN = "rain", "Rain", "World", 0.5, [], ["rain", "rainfall", "downpour", "drizzle"];
    SAND = "sand", "Blowing sand", "World", 0.4, [], ["sand", "blowing sand", "sandstorm", "dust", "fog", "haze", "mist", "atmosphere"];
    ORBIT = "orbit", "Auto orbit", "World", 0.15, [], ["orbit", "auto orbit", "rotation", "spin", "camera speed", "camera rotation"];
    ZOOM = "zoom", "Zoom", "World", 0.62, [], ["zoom", "camera distance", "distance"];

    WARP = "warp", "Hyper lens", "4D", 0.12, [], ["hyper lens", "warp", "4d warp", "lens", "distortion", "distort", "bend", "wobble"];
    WSPEED = "wspeed", "4D drift", "4D", 0.3, [], ["4d drift", "drift", "4d speed", "fourth dimension", "w speed", "evolution"];
    TESS = "tess", "Tesseract", "4D", 0.35, [], ["tesseract", "hypercube", "4d cube", "hyper cube", "cube"];
    FOLD = "fold", "Dune fold", "4D", 0.25, [], ["dune fold", "fold", "folding", "morph", "dune morph", "terrain morph"];

    HUE = "hue", "Hue shift", "Look", 0.0, [], ["hue", "hue shift", "color shift", "colour shift"];
    SATURATION = "saturation", "Saturation", "Look", 0.55, [], ["saturation", "vibrance", "colors", "colours", "color amount"];
    BRIGHTNESS = "brightness", "Brightness", "Look", 0.5, [], ["brightness", "exposure", "light", "gain"];
    CONTRAST = "contrast", "Contrast", "Look", 0.5, [], ["contrast"];
    BLOOM = "bloom", "Bloom", "Look", 0.5, [], ["bloom", "glare", "glow", "halo", "shine"];

    ROUTE = "route", "FX routing", "Psychedelic FX", 0.0, ["Serial", "Parallel"], ["fx routing", "visual routing", "routing", "signal", "signal flow", "signal path"];
    KALEIDO = "kaleido", "Kaleidoscope", "Psychedelic FX", 0.0, [], ["kaleidoscope", "kaleido", "mirror", "mirrors", "symmetry"];
    KSEG = "kseg", "\u{21b3} segments", "Psychedelic FX", 0.35, [], ["segments", "kaleidoscope segments", "mirror count", "slices", "petals"];
    KSPIN = "kspin", "\u{21b3} spin", "Psychedelic FX", 0.2, [], ["kaleidoscope spin", "mirror spin", "kaleidoscope rotation", "kaleidoscope speed"];
    FEEDBACK = "feedback", "Trails", "Psychedelic FX", 0.0, [], ["trails", "trail", "feedback", "smear", "ghosting", "persistence", "echo trails"];
    FBZOOM = "fbzoom", "\u{21b3} zoom", "Psychedelic FX", 0.55, [], ["trail zoom", "feedback zoom", "trails zoom"];
    FBROT = "fbrot", "\u{21b3} twist", "Psychedelic FX", 0.55, [], ["trail twist", "feedback twist", "trail rotation", "feedback rotation", "twist", "swirl"];
    FBHUE = "fbhue", "\u{21b3} colour cycle", "Psychedelic FX", 0.0, [], ["trail colour", "trail color", "feedback colour", "feedback color", "colour cycle", "color cycle", "rainbow trails"];
    TUNNEL = "tunnel", "Tunnel", "Psychedelic FX", 0.0, [], ["tunnel", "vortex", "wormhole", "infinite zoom", "droste"];
    TUNSPEED = "tunspeed", "\u{21b3} speed", "Psychedelic FX", 0.4, [], ["tunnel speed", "vortex speed", "wormhole speed"];
    LIQUID = "liquid", "Liquid", "Psychedelic FX", 0.0, [], ["liquid", "melt", "melting", "ripple", "ripples", "waves", "wavy", "fluid"];
    LIQSCALE = "liqscale", "\u{21b3} scale", "Psychedelic FX", 0.4, [], ["liquid scale", "ripple size", "wave size", "ripple scale"];
    ACID = "acid", "Spectrum", "Psychedelic FX", 0.0, [], ["spectrum", "acid", "rainbow", "thermal", "false colour", "false color", "palette"];
    ACIDCYC = "acidcyc", "\u{21b3} bands", "Psychedelic FX", 0.35, [], ["spectrum bands", "rainbow bands", "bands", "colour bands", "color bands"];
    ACIDSPEED = "acidspeed", "\u{21b3} flow", "Psychedelic FX", 0.3, [], ["spectrum flow", "spectrum speed", "rainbow speed", "colour flow", "color flow"];
    EDGE = "edge", "Neon edges", "Psychedelic FX", 0.0, [], ["neon edges", "edges", "neon", "outline", "outlines", "edge glow", "wireframe"];
    RGB = "rgb", "RGB split", "Psychedelic FX", 0.1, [], ["rgb split", "rgb", "chromatic", "chromatic aberration", "colour split", "color split", "prism"];
    POSTER = "poster", "Posterize", "Psychedelic FX", 0.0, [], ["posterize", "poster", "solarize", "cartoon", "banding"];
    GLITCH = "glitch", "Glitch", "Psychedelic FX", 0.0, [], ["glitch", "glitches", "corruption", "datamosh"];
    REACT = "react", "Audio react", "Psychedelic FX", 0.6, [], ["audio react", "audio reactivity", "reactivity", "reactive", "react"];

    CAMMIX = "cammix", "Camera mix", "Mix", 0.6, [], ["camera mix", "webcam mix", "cam mix", "camera opacity", "camera level"];
    VIDMIX = "vidmix", "Video mix", "Mix", 0.6, [], ["video mix", "screen mix", "capture mix", "video opacity", "video level"];

    VOLUME = "volume", "Volume", "Sound", 0.7, [], ["volume", "loudness", "master", "master volume", "sound level"];
    KEY = "key", "Key", "Sound", 0.1818, ["C", "C\u{266f}", "D", "E\u{266d}", "E", "F", "F\u{266f}", "G", "A\u{266d}", "A", "B\u{266d}", "B"], ["key", "tonic", "root note", "transpose"];
    TEMPER = "temper", "Temperament", "Sound", 0.0, ["Werckmeister III", "Kirnberger III", "Vallotti", "Young II", "Equal"], ["temperament", "tuning", "tune"];
    AROUTE = "aroute", "Audio FX routing", "Sound", 0.0, ["Serial", "Parallel"], ["audio routing", "sound routing", "audio fx routing", "audio signal"];
    ORGAN = "organ", "Organ chords", "Sound", 0.55, [], ["organ", "chords", "chord", "harmony", "pad", "pipes"];
    HARMONICS = "harmonics", "Harmonics", "Sound", 0.35, [], ["harmonics", "overtones", "brightness of sound", "timbre", "stops", "mixture"];
    DRONE = "drone", "Bass drone", "Sound", 0.5, [], ["drone", "bass", "sub", "low end", "bass drone", "pedal"];
    CUTOFF = "cutoff", "Filter", "Sound", 0.5, [], ["filter", "cutoff", "filter cutoff", "tone", "treble"];
    RESONANCE = "resonance", "Resonance", "Sound", 0.3, [], ["resonance", "res"];
    MELODY = "melody", "Melody", "Sound", 0.5, [], ["melody", "notes", "harpsichord", "sequencer", "arpeggio", "arp", "music"];
    TEMPO = "tempo", "Tempo", "Sound", 0.3, [], ["tempo", "bpm", "beat"];
    TEXTURE = "texture", "Ambience", "Sound", 0.6, [], ["ambience", "ambient", "ambient sound", "wind sound", "rain sound", "background sound", "weather sound"];
    IMPACT = "impact", "Impacts", "Sound", 0.75, [], ["impacts", "impact", "thunder volume", "footsteps", "footstep", "hits", "sound effects", "sfx"];
    REVERB = "reverb", "Reverb", "Sound", 0.6, [], ["reverb", "space", "room", "hall", "cathedral"];
    DELAY = "delay", "Echo", "Sound", 0.3, [], ["echo", "delay", "echoes"];
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

pub fn choice_value(id: usize, index: usize) -> f32 {
    let n = PARAMS[id].options.len().max(2);
    index.min(n - 1) as f32 / (n - 1) as f32
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
