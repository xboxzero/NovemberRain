#![allow(dead_code)]
//! The parameter table is the single source of truth shared by the simulation,
//! the synthesizer, the chat parser and (via `params_json`) the TypeScript UI.
//! Every parameter is normalised to 0..1.

pub struct ParamDef {
    pub key: &'static str,
    pub label: &'static str,
    pub group: &'static str,
    pub default: f32,
    /// Words / phrases the chat parser recognises for this parameter.
    pub words: &'static [&'static str],
}

pub const NP: usize = 32;

pub const SPEED: usize = 0;
pub const INTENSITY: usize = 1;
pub const DENSITY: usize = 2;
pub const ORBIT: usize = 3;
pub const ZOOM: usize = 4;
pub const WARP: usize = 5;
pub const WSPEED: usize = 6;
pub const FOG: usize = 7;
pub const HUE: usize = 8;
pub const SATURATION: usize = 9;
pub const BRIGHTNESS: usize = 10;
pub const CONTRAST: usize = 11;
pub const BLOOM: usize = 12;
pub const FEEDBACK: usize = 13;
pub const KALEIDO: usize = 14;
pub const GLITCH: usize = 15;
pub const REACT: usize = 16;
pub const CAMMIX: usize = 17;
pub const VIDMIX: usize = 18;
pub const YTMIX: usize = 19;
pub const VOLUME: usize = 20;
pub const PITCH: usize = 21;
pub const CUTOFF: usize = 22;
pub const RESONANCE: usize = 23;
pub const DRONE: usize = 24;
pub const TEXTURE: usize = 25;
pub const MELODY: usize = 26;
pub const TEMPO: usize = 27;
pub const REVERB: usize = 28;
pub const DELAY: usize = 29;
pub const FM: usize = 30;
pub const IMPACT: usize = 31;

macro_rules! p {
    ($k:expr, $l:expr, $g:expr, $d:expr, [$($w:expr),*]) => {
        ParamDef { key: $k, label: $l, group: $g, default: $d, words: &[$($w),*] }
    };
}

pub const PARAMS: [ParamDef; NP] = [
    p!("speed", "Speed", "Motion", 0.5, ["speed", "motion speed", "animation speed", "pace"]),
    p!("intensity", "Intensity", "Motion", 0.55, ["intensity", "energy", "power", "strength", "lightning", "storm", "thunder", "bolts", "glow", "bioluminescence", "lava", "eruption", "eruptions", "fire", "flames", "rage", "shake", "stomp"]),
    p!("density", "Density", "Motion", 0.6, ["density", "amount", "count", "creatures", "creature", "fish", "jellyfish", "jellies", "dragons", "buildings", "skyscrapers", "towers", "rain", "dunes", "population"]),
    p!("orbit", "Auto orbit", "Motion", 0.3, ["orbit", "auto orbit", "rotation", "spin", "camera speed", "camera rotation"]),
    p!("zoom", "Zoom", "Motion", 0.5, ["zoom", "camera distance", "distance"]),
    p!("warp", "4D warp", "Motion", 0.15, ["warp", "4d warp", "4d", "distortion", "distort", "morph", "bend", "wobble"]),
    p!("wspeed", "4D drift", "Motion", 0.3, ["4d drift", "drift", "4d speed", "fourth dimension", "w speed", "evolution", "morph speed"]),
    p!("fog", "Fog", "Look", 0.4, ["fog", "mist", "haze", "smoke", "dust", "sandstorm", "murk", "atmosphere"]),
    p!("hue", "Hue shift", "Look", 0.0, ["hue", "hue shift", "color shift", "colour shift"]),
    p!("saturation", "Saturation", "Look", 0.55, ["saturation", "color amount", "colour amount", "vibrance", "colors", "colours"]),
    p!("brightness", "Brightness", "Look", 0.5, ["brightness", "exposure", "light", "gain"]),
    p!("contrast", "Contrast", "Look", 0.5, ["contrast"]),
    p!("bloom", "Bloom", "FX", 0.45, ["bloom", "glare", "shine", "halo"]),
    p!("feedback", "Trails", "FX", 0.0, ["trails", "trail", "feedback", "echo trails", "smear", "ghosting", "persistence"]),
    p!("kaleido", "Kaleidoscope", "FX", 0.0, ["kaleidoscope", "kaleido", "mirror", "mirrors", "symmetry"]),
    p!("glitch", "Glitch", "FX", 0.0, ["glitch", "glitches", "noise fx", "corruption", "datamosh", "rgb split", "chromatic"]),
    p!("react", "Audio react", "FX", 0.6, ["audio react", "audio reactivity", "reactivity", "reactive", "sound reaction", "music reaction", "react"]),
    p!("cammix", "Camera mix", "Mix", 0.6, ["camera mix", "webcam mix", "cam mix", "camera opacity", "camera level", "webcam level"]),
    p!("vidmix", "Video mix", "Mix", 0.6, ["video mix", "screen mix", "capture mix", "video opacity", "video level"]),
    p!("ytmix", "YouTube mix", "Mix", 0.8, ["youtube mix", "youtube opacity", "youtube level", "yt mix", "youtube"]),
    p!("volume", "Volume", "Sound", 0.7, ["volume", "loudness", "sound level", "master", "master volume", "audio level"]),
    p!("pitch", "Pitch", "Sound", 0.5, ["pitch", "key", "tuning", "root note", "transpose"]),
    p!("cutoff", "Filter", "Sound", 0.5, ["filter", "cutoff", "filter cutoff", "tone", "brightness of sound", "treble"]),
    p!("resonance", "Resonance", "Sound", 0.3, ["resonance", "res", "q"]),
    p!("drone", "Drone", "Sound", 0.6, ["drone", "bass", "pad", "sub", "bass drone", "low end"]),
    p!("texture", "Ambience", "Sound", 0.6, ["ambience", "ambient", "ambient sound", "wind", "bubbles", "rumble", "texture", "atmosphere sound", "background sound"]),
    p!("melody", "Melody", "Sound", 0.45, ["melody", "notes", "sequencer", "sequence", "arpeggio", "arp", "bells", "music"]),
    p!("tempo", "Tempo", "Sound", 0.4, ["tempo", "bpm", "rhythm speed", "beat"]),
    p!("reverb", "Reverb", "Sound", 0.55, ["reverb", "space", "room", "hall"]),
    p!("delay", "Echo", "Sound", 0.35, ["echo", "delay", "echoes"]),
    p!("fm", "FM", "Sound", 0.2, ["fm", "fm amount", "metallic", "harmonics", "modulation"]),
    p!("impact", "Impacts", "Sound", 0.7, ["impacts", "impact", "thunder volume", "footsteps", "footstep", "roar", "roars", "hits", "sound effects", "sfx"]),
];

pub const NSCENES: usize = 4;
pub const SCENE_KEYS: [&str; NSCENES] = ["storm", "abyss", "volcano", "titan"];
pub const SCENE_NAMES: [&str; NSCENES] = [
    "Multi-lightning storm over the sand dunes",
    "Underwater abyss with deep sea creatures",
    "Volcano island with a Chinese dragon",
    "Titan skeleton walking through the city",
];

/// Default parameter set for a scene (the four built-in presets).
pub fn scene_defaults(scene: usize) -> [f32; NP] {
    let mut d = [0.0f32; NP];
    for (i, p) in PARAMS.iter().enumerate() {
        d[i] = p.default;
    }
    match scene {
        0 => {
            d[INTENSITY] = 0.6;
            d[FOG] = 0.45;
            d[BLOOM] = 0.55;
            d[TEMPO] = 0.3;
            d[ORBIT] = 0.25;
        }
        1 => {
            d[SPEED] = 0.4;
            d[FOG] = 0.5;
            d[BLOOM] = 0.6;
            d[ORBIT] = 0.2;
            d[REVERB] = 0.75;
            d[MELODY] = 0.4;
            d[CUTOFF] = 0.42;
            d[WARP] = 0.25;
        }
        2 => {
            d[INTENSITY] = 0.6;
            d[DENSITY] = 0.45;
            d[BLOOM] = 0.55;
            d[FOG] = 0.35;
            d[TEMPO] = 0.45;
            d[MELODY] = 0.55;
        }
        _ => {
            d[SPEED] = 0.45;
            d[FOG] = 0.5;
            d[ORBIT] = 0.12;
            d[CUTOFF] = 0.4;
            d[MELODY] = 0.3;
            d[TEMPO] = 0.25;
            d[WARP] = 0.05;
        }
    }
    d
}

pub fn find_key(key: &str) -> Option<usize> {
    PARAMS.iter().position(|p| p.key == key)
}

/// JSON description of parameters and scenes for the UI.
pub fn describe_json() -> String {
    let mut s = String::from("{\"params\":[");
    for (i, p) in PARAMS.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            "{{\"id\":{},\"key\":\"{}\",\"label\":\"{}\",\"group\":\"{}\",\"default\":{}}}",
            i, p.key, p.label, p.group, p.default
        ));
    }
    s.push_str("],\"scenes\":[");
    for i in 0..NSCENES {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!("{{\"id\":{},\"key\":\"{}\",\"name\":\"{}\"}}", i, SCENE_KEYS[i], SCENE_NAMES[i]));
    }
    s.push_str("]}");
    s
}
