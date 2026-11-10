//! Natural-language command parser for the chat bot. It turns free text such as
//! "more lightning and a bit less rain, then run the effects in parallel" into a
//! JSON list of actions that the TypeScript shell executes. Everything runs
//! locally: no network, no model download.

use crate::params::*;
use crate::rng::Rng;

/// Approximate dominant hue of the scene, used to translate colour names into a hue rotation.
const SCENE_HUE: f32 = 0.6;

const COLORS: [(&str, f32); 14] = [
    ("red", 0.0),
    ("crimson", 0.98),
    ("orange", 0.07),
    ("gold", 0.12),
    ("golden", 0.12),
    ("yellow", 0.16),
    ("green", 0.33),
    ("teal", 0.48),
    ("cyan", 0.5),
    ("turquoise", 0.47),
    ("blue", 0.62),
    ("purple", 0.76),
    ("violet", 0.76),
    ("pink", 0.9),
];

const NOTES: [(&str, usize); 21] = [
    ("c#", 1), ("db", 1), ("d#", 3), ("eb", 3), ("f#", 6), ("gb", 6), ("g#", 8), ("ab", 8), ("a#", 10), ("bb", 10),
    ("c", 0), ("d", 2), ("e", 4), ("f", 5), ("g", 7), ("a", 9), ("b", 11),
    ("csharp", 1), ("fsharp", 6), ("eflat", 3), ("bflat", 10),
];

const TEMPERS: [(&str, usize); 12] = [
    ("werckmeister", 0),
    ("well temperament", 0),
    ("well tempered", 0),
    ("well temperaments", 0),
    ("bach", 0),
    ("kirnberger", 1),
    ("vallotti", 2),
    ("young", 3),
    ("equal temperament", 4),
    ("equal", 4),
    ("12tet", 4),
    ("modern tuning", 4),
];

const UP: [&str; 22] = [
    "taller", "larger", "greater", "denser", "wilder", "more", "increase", "raise", "higher", "up", "add", "boost",
    "stronger", "bigger", "crank", "intensify", "extra", "heavier", "thicker", "deeper", "longer", "plus",
];
const DOWN: [&str; 14] = [
    "less", "decrease", "lower", "reduce", "down", "fewer", "weaker", "smaller", "soften", "lighter", "thinner",
    "shorter", "minus", "drop",
];
const STRONG: [&str; 13] = [
    "a lot", "much", "way", "very", "super", "far", "lots", "massively", "really", "extremely", "hugely", "tons", "heavily",
];
const WEAK: [&str; 10] =
    ["a bit", "a little", "little", "slightly", "bit", "touch", "tiny", "somewhat", "subtle", "subtly"];
const MAXW: [&str; 8] = ["max", "maximum", "full", "fully", "all the way", "100%", "highest", "maxed"];
const MINW: [&str; 9] = ["min", "minimum", "none", "zero", "off", "no", "remove", "without", "kill"];
const OFFW: [&str; 10] = ["off", "disable", "stop", "disconnect", "close", "kill", "remove", "without", "no", "hide"];

/// (trigger words, [(param, amount, absolute?)])
type Mood = (&'static [&'static str], &'static [(usize, f32, bool)]);

const PHRASES: [Mood; 22] = [
    (&["zoom in", "closer", "get closer", "move closer", "close up"], &[(ZOOM, 0.2, false)]),
    (&["zoom out", "farther", "further", "move back", "wider", "wide shot", "pull back"], &[(ZOOM, -0.2, false)]),
    (&["speed up", "faster", "quicker", "hurry"], &[(SPEED, 0.2, false)]),
    (&["slow down", "slower", "slow", "slow motion", "slowmo"], &[(SPEED, -0.2, false)]),
    (&["freeze", "pause motion", "stop time", "hold still"], &[(SPEED, 0.0, true), (ORBIT, 0.0, true)]),
    (&["louder", "turn it up", "pump it up"], &[(VOLUME, 0.15, false)]),
    (&["quieter", "softer", "turn it down", "too loud"], &[(VOLUME, -0.15, false)]),
    (&["unmute", "sound on", "audio on"], &[(VOLUME, 0.7, true)]),
    (&["mute", "silence", "silent", "shut up", "sound off", "audio off"], &[(VOLUME, 0.0, true)]),
    (&["stop spinning", "stop rotating", "stop orbit", "still camera", "static camera"], &[(ORBIT, 0.0, true)]),
    (&["spin", "rotate", "spinning", "rotating", "orbit around"], &[(ORBIT, 0.25, false)]),
    (&["darker", "dim", "dimmer", "gloomy", "moody"], &[(BRIGHTNESS, -0.15, false)]),
    (&["brighter"], &[(BRIGHTNESS, 0.15, false)]),
    (&["foggy", "foggier", "misty", "hazy", "dusty", "dustier"], &[(SAND, 0.25, false)]),
    (&["clear", "clearer", "crisp", "clear sky", "clear air"], &[(SAND, -0.25, false)]),
    (&["black and white", "monochrome", "grayscale", "greyscale", "desaturate"], &[(SATURATION, 0.0, true)]),
    (&["colorful", "colourful", "vivid", "vibrant", "saturated"], &[(SATURATION, 0.2, false)]),
    (&["original colors", "original colours", "natural colors", "natural colours", "normal colors", "normal colours"], &[(HUE, 0.0, true), (ACID, 0.0, true)]),
    (
        &["clean", "cleaner", "no effects", "no fx", "remove effects", "effects off", "fx off", "sober", "realistic", "real"],
        &[(GLITCH, 0.0, true), (FEEDBACK, 0.0, true), (KALEIDO, 0.0, true), (TUNNEL, 0.0, true), (LIQUID, 0.0, true), (ACID, 0.0, true), (EDGE, 0.0, true), (POSTER, 0.0, true), (RGB, 0.05, true), (WARP, 0.0, true)],
    ),
    (&["glitchy", "glitchier", "broken", "corrupted", "corrupt"], &[(GLITCH, 0.35, false)]),
    (&["windy", "windier", "stormier wind"], &[(WIND, 0.25, false)]),
    (&["rainy", "rainier", "wet", "wetter", "pouring"], &[(RAIN, 0.3, false)]),
];

const MOODS: [Mood; 14] = [
    (
        &["calm", "calmer", "chill", "peaceful", "gentle", "relax", "relaxed", "relaxing", "quiet", "serene", "soothing", "meditative"],
        &[(SPEED, -0.15, false), (STORM, -0.3, false), (WIND, -0.2, false), (GLITCH, 0.0, true), (TEMPO, -0.1, false), (IMPACT, -0.25, false)],
    ),
    (
        &["intense", "chaos", "chaotic", "crazy", "wild", "insane", "aggressive", "angry", "violent", "epic", "furious", "brutal", "apocalyptic", "apocalypse", "stormy", "stormier", "extreme", "harder", "hardcore"],
        &[(STORM, 0.35, false), (WIND, 0.2, false), (RAIN, 0.15, false), (BLOOM, 0.1, false), (IMPACT, 0.2, false), (TEMPO, 0.1, false)],
    ),
    (
        &["trippy", "trippier", "psychedelic", "lsd", "hallucination", "hallucinate", "surreal", "weird", "weirder", "strange", "mind bending"],
        &[(WARP, 0.3, false), (FEEDBACK, 0.45, false), (FBHUE, 0.35, false), (LIQUID, 0.3, false), (ACID, 0.3, false), (WSPEED, 0.25, false), (TESS, 0.25, false)],
    ),
    (
        &["dmt", "ego death", "breakthrough", "full psychedelic", "melt my face", "total trip"],
        &[(KALEIDO, 0.8, true), (KSEG, 0.6, true), (TUNNEL, 0.5, true), (FEEDBACK, 0.75, true), (FBHUE, 0.6, true), (ACID, 0.6, true), (EDGE, 0.45, true), (WARP, 0.6, true), (TESS, 0.9, true), (ROUTE, 0.0, true)],
    ),
    (
        &["dreamy", "dream", "dreamlike", "ethereal", "heavenly", "floaty", "soft"],
        &[(REVERB, 0.25, false), (BLOOM, 0.2, false), (FEEDBACK, 0.3, false), (LIQUID, 0.15, false), (SPEED, -0.1, false), (CONTRAST, -0.08, false)],
    ),
    (
        &["cinematic", "movie", "film", "dramatic"],
        &[(CONTRAST, 0.14, false), (BLOOM, 0.15, false), (SATURATION, -0.08, false), (ORBIT, 0.15, true), (SAND, 0.1, false)],
    ),
    (
        &["dark", "scary", "horror", "creepy", "sinister", "evil", "nightmare", "spooky", "ominous"],
        &[(BRIGHTNESS, -0.14, false), (SAND, 0.15, false), (CUTOFF, -0.15, false), (CONTRAST, 0.08, false), (ORGAN, 0.15, false)],
    ),
    (&["bright", "happy", "cheerful", "uplifting"], &[(BRIGHTNESS, 0.15, false), (CUTOFF, 0.15, false), (SAND, -0.1, false)]),
    (
        &["4d", "four dimensional", "hyper", "hyperspace", "fourth dimension", "impossible", "illusion", "escher", "non euclidean"],
        &[(WARP, 0.3, false), (WSPEED, 0.3, false), (TESS, 0.4, false), (FOLD, 0.35, false)],
    ),
    (
        &["rave", "party", "club", "dance", "techno", "energetic"],
        &[(TEMPO, 0.3, false), (MELODY, 0.3, false), (REACT, 0.3, false), (GLITCH, 0.15, false), (ACID, 0.3, false)],
    ),
    (&["ambient", "minimal", "spacious"], &[(MELODY, -0.3, false), (REVERB, 0.25, false), (ORGAN, 0.15, false), (TEMPO, -0.15, false)]),
    (&["heavy", "massive", "huge", "bassy", "thunderous"], &[(DRONE, 0.2, false), (IMPACT, 0.25, false), (CUTOFF, -0.1, false)]),
    (&["baroque", "church", "cathedral organ", "gothic", "fugue"], &[(ORGAN, 0.3, false), (HARMONICS, 0.2, false), (REVERB, 0.3, false), (MELODY, 0.15, false)]),
    (&["electric", "neon", "cyber", "cyberpunk", "tron"], &[(EDGE, 0.5, false), (TESS, 0.3, false), (RGB, 0.2, false), (BLOOM, 0.15, false)]),
];

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' | '\t' => o.push(' '),
            c if (c as u32) < 0x20 => {}
            c => o.push(c),
        }
    }
    o
}

fn has(s: &str, phrase: &str) -> bool {
    let mut pat = String::with_capacity(phrase.len() + 2);
    pat.push(' ');
    pat.push_str(phrase);
    pat.push(' ');
    s.contains(&pat)
}

fn any(s: &str, list: &[&str]) -> bool {
    list.iter().any(|w| has(s, w))
}

fn words(s: &str) -> usize {
    s.split(' ').filter(|w| !w.is_empty()).count()
}

/// Lower-case a clause and pad it with spaces so whole-word matching is a substring search.
fn clean(clause: &str) -> String {
    let mut o = String::from(" ");
    let mut last_space = true;
    for c in clause.chars() {
        let c = c.to_ascii_lowercase();
        let keep = c.is_alphanumeric() || c == '.' || c == '%' || c == '#';
        if keep {
            o.push(c);
            last_space = false;
        } else if !last_space {
            o.push(' ');
            last_space = true;
        }
    }
    if !last_space {
        o.push(' ');
    }
    o.replace(". ", " ")
}

fn number(s: &str) -> Option<(f32, bool)> {
    for tok in s.split(' ') {
        if tok.is_empty() {
            continue;
        }
        let pct = tok.ends_with('%');
        let core = tok.trim_end_matches('%');
        if core.is_empty() || !core.chars().next().map(|c| c.is_ascii_digit() || c == '.').unwrap_or(false) {
            continue;
        }
        if let Ok(v) = core.parse::<f32>() {
            return Some((v, pct));
        }
    }
    None
}

/// Longest parameter alias present in the clause.
fn find_param(s: &str) -> Option<usize> {
    let mut best: Option<(usize, usize)> = None;
    for (i, p) in PARAMS.iter().enumerate() {
        for w in p.words.iter().chain(core::iter::once(&p.key)) {
            if has(s, w) && best.map(|b| w.len() > b.1).unwrap_or(true) {
                best = Some((i, w.len()));
            }
        }
    }
    best.map(|b| b.0)
}

/// "key of f#", "in d minor", "g sharp minor" -> pitch class.
fn find_key(s: &str) -> Option<usize> {
    let toks: Vec<&str> = s.split(' ').filter(|w| !w.is_empty()).collect();
    let note = |i: usize| -> Option<usize> {
        let t = *toks.get(i)?;
        let mut pc = NOTES.iter().find(|(n, _)| *n == t).map(|(_, v)| *v)?;
        match toks.get(i + 1).copied() {
            Some("sharp") => pc = (pc + 1) % 12,
            Some("flat") => pc = (pc + 11) % 12,
            _ => {}
        }
        Some(pc)
    };
    for (i, t) in toks.iter().enumerate() {
        if *t == "minor" || *t == "major" {
            let back = if i >= 1 && (toks[i - 1] == "sharp" || toks[i - 1] == "flat") { 2 } else { 1 };
            if i >= back {
                if let Some(pc) = note(i - back) {
                    return Some(pc);
                }
            }
        }
        if *t == "key" || *t == "tonic" || *t == "transpose" {
            for j in i + 1..(i + 4).min(toks.len()) {
                if toks[j] == "of" || toks[j] == "to" || toks[j] == "in" || toks[j] == "is" {
                    continue;
                }
                if let Some(pc) = note(j) {
                    return Some(pc);
                }
                break;
            }
        }
    }
    None
}

struct Out {
    actions: Vec<String>,
    notes: Vec<String>,
    p: [f32; NP],
}

impl Out {
    fn set(&mut self, id: usize, v: f32) {
        let v = v.clamp(0.0, 1.0);
        self.p[id] = v;
        self.actions.push(format!("{{\"t\":\"set\",\"k\":\"{}\",\"v\":{:.4}}}", PARAMS[id].key, v));
        let label = PARAMS[id].label.trim_start_matches('\u{21b3}').trim();
        let name = match id {
            KSEG | KSPIN => format!("Kaleidoscope {}", label),
            FBZOOM | FBROT | FBHUE => format!("Trails {}", label),
            TUNSPEED => format!("Tunnel {}", label),
            LIQSCALE => format!("Liquid {}", label),
            ACIDCYC | ACIDSPEED => format!("Spectrum {}", label),
            _ => label.to_string(),
        };
        let prefix = format!("{}: ", name);
        self.notes.retain(|n| !n.starts_with(&prefix));
        let opts = PARAMS[id].options;
        if opts.is_empty() {
            self.notes.push(format!("{}{}%", prefix, (v * 100.0).round() as i32));
        } else {
            self.notes.push(format!("{}{}", prefix, opts[choice(&self.p, id)]));
        }
    }
    fn pick(&mut self, id: usize, index: usize) {
        self.set(id, choice_value(id, index));
    }
    fn nudge(&mut self, id: usize, d: f32) {
        let v = self.p[id] + d;
        self.set(id, v);
    }
    fn act(&mut self, json: &str, note: &str) {
        self.actions.push(json.to_string());
        if !note.is_empty() {
            self.notes.push(note.to_string());
        }
    }
}

fn magnitude(s: &str) -> f32 {
    if any(s, &STRONG) {
        2.0
    } else if any(s, &WEAK) {
        0.45
    } else {
        1.0
    }
}

fn apply_mood(out: &mut Out, m: &Mood, sign: f32, mag: f32) {
    for &(id, amt, abs) in m.1.iter() {
        if abs {
            out.set(id, if sign < 0.0 { PARAMS[id].default } else { amt });
        } else {
            out.nudge(id, amt * sign * mag);
        }
    }
}

fn after<'a>(text: &'a str, lower: &str, keys: &[&str]) -> Option<&'a str> {
    for k in keys {
        if let Some(i) = lower.find(k) {
            let rest = text[i + k.len()..].trim();
            return Some(rest.trim_matches(|c: char| c == '"' || c == '\'' || c == '.' || c == '!' || c.is_whitespace()));
        }
    }
    None
}

fn clause(out: &mut Out, raw: &str, rng: &mut Rng) -> bool {
    let s = clean(raw);
    if s.trim().is_empty() {
        return true;
    }
    let before = out.actions.len() + out.notes.len();
    let num = number(&s);
    let up = any(&s, &UP);
    let down = any(&s, &DOWN);
    let off = any(&s, &OFFW);
    let mag = magnitude(&s);

    // ---- small talk / help / status --------------------------------------------
    if any(&s, &["help", "commands", "what can you do", "what can i say", "how do i", "how does this work", "instructions"]) {
        out.notes.push(
            "Talk to me in plain language. World: \"more lightning\", \"less rain\", \"windy\", \"strike the titan\". \
             4D: \"bigger tesseract\", \"more hyper lens\", \"make it 4d\". \
             Psychedelic: \"make it trippy\", \"kaleidoscope 70%\", \"more segments\", \"tunnel on\", \"rainbow trails\", \"neon edges\", \"dmt\", \"clean\". \
             Routing: \"effects in parallel\", \"audio serial\". \
             Sound: \"key of F sharp\", \"kirnberger tuning\", \"equal temperament\", \"more organ\", \"slower tempo\". \
             Output: \"8k\", \"4k\", \"auto resolution\", \"snapshot\". \
             Inputs: \"camera on\", \"mic on\", \"share screen\". Presets: \"save as my show\", \"load my show\", \"export\", \"reset\". \
             Keys A-K play notes, Space throws lightning at the titan."
                .to_string(),
        );
        return true;
    }
    if any(&s, &["hi", "hello", "hey", "yo", "good morning", "good evening"]) && words(&s) <= 3 {
        out.notes.push("Hello! A titan is walking through the storm. Tell me how it should look and sound, or type \"help\".".to_string());
        return true;
    }
    if any(&s, &["thanks", "thank you", "thx", "nice", "cool", "awesome", "great", "love it", "beautiful"]) && words(&s) <= 4 {
        out.notes.push("Glad you like it. Want it wilder, calmer, or further into the fourth dimension?".to_string());
        return true;
    }
    if any(&s, &["status", "current settings", "what are the settings", "show settings", "values"]) {
        let mut t = String::new();
        for (i, p) in PARAMS.iter().enumerate() {
            let label = p.label.trim_start_matches('\u{21b3}').trim();
            if p.options.is_empty() {
                t.push_str(&format!("{} {}%", label, (out.p[i] * 100.0).round() as i32));
            } else {
                t.push_str(&format!("{} {}", label, p.options[choice(&out.p, i)]));
            }
            t.push_str(if i + 1 < NP { ", " } else { "." });
        }
        out.notes.push(t);
        return true;
    }

    // ---- output resolution / snapshot ---------------------------------------------
    if any(&s, &["snapshot", "screenshot", "capture image", "save image", "save picture", "take a picture", "take a photo", "still image", "render image", "export image"]) {
        out.act("{\"t\":\"snap\"}", "Rendering an 8K still");
        return true;
    }
    for (w, v, label) in [("8k", "8k", "8K (7680 px wide)"), ("4k", "4k", "4K (3840 px wide)"), ("1440p", "1440p", "1440p"), ("2k", "1440p", "1440p"), ("1080p", "1080p", "1080p"), ("full hd", "1080p", "1080p"), ("hd", "1080p", "1080p")] {
        if has(&s, w) {
            out.act(&format!("{{\"t\":\"res\",\"v\":\"{}\"}}", v), &format!("Render resolution: {}", label));
            return true;
        }
    }
    if any(&s, &["auto resolution", "auto quality", "adaptive", "adaptive resolution", "automatic resolution", "auto res", "resolution auto"]) {
        out.act("{\"t\":\"res\",\"v\":\"auto\"}", "Render resolution: automatic");
        return true;
    }

    // ---- lightning on demand ------------------------------------------------------
    if any(&s, &["strike", "zap", "smite", "hit the titan", "hit him", "shock", "electrocute", "lightning now", "bolt now"]) && !up && !down && num.is_none() {
        out.act("{\"t\":\"strike\"}", "Lightning called down on the titan");
        return true;
    }

    // ---- signal routing -----------------------------------------------------------
    let ser = any(&s, &["serial", "series", "in a chain", "chained", "one after another", "sequential", "cascade"]);
    let par = any(&s, &["parallel", "side by side", "layered", "in layers", "stacked"]);
    if ser || par {
        let idx = if par { 1 } else { 0 };
        let audio = any(&s, &["audio", "sound", "synth", "reverb", "echo", "delay", "music"]);
        let visual = any(&s, &["visual", "visuals", "video", "picture", "image", "effects", "effect", "fx", "psychedelic"]);
        if audio || !visual {
            out.pick(AROUTE, idx);
        }
        if visual || !audio {
            out.pick(ROUTE, idx);
        }
        return true;
    }

    // ---- tuning and key -----------------------------------------------------------
    for (w, idx) in TEMPERS.iter() {
        if has(&s, w) && (*w != "equal" && *w != "young" || any(&s, &["temperament", "tuning", "tune", "tuned", "temper"])) {
            out.pick(TEMPER, *idx);
            return true;
        }
    }
    if any(&s, &["next tuning", "next temperament", "change tuning", "change temperament", "another tuning", "another temperament"]) {
        let n = PARAMS[TEMPER].options.len();
        let cur = choice(&out.p, TEMPER);
        out.pick(TEMPER, (cur + 1) % n);
        return true;
    }
    if let Some(pc) = find_key(&s) {
        out.pick(KEY, pc);
        return true;
    }
    if any(&s, &["key", "transpose", "pitch"]) && (up || down) {
        let cur = choice(&out.p, KEY) as i32;
        let step = num.map(|n| n.0.round() as i32).unwrap_or(1).clamp(1, 11);
        out.pick(KEY, (cur + if down { 12 - step } else { step }).rem_euclid(12) as usize);
        return true;
    }

    // ---- devices ------------------------------------------------------------------
    if !any(&s, &["mix", "opacity", "level", "speed", "rotation", "distance"]) {
        let dev = if any(&s, &["camera", "webcam", "cam", "selfie"]) {
            Some(("camera", "Camera"))
        } else if any(&s, &["mic", "microphone", "audio input", "listen"]) {
            Some(("mic", "Microphone"))
        } else if any(&s, &["screen share", "screenshare", "share screen", "share my screen", "tab capture", "screen capture", "capture screen", "capture tab", "screen"]) {
            Some(("screen", "Screen capture"))
        } else if any(&s, &["video file", "local video", "file", "upload", "video"]) {
            Some(("file", "Video file"))
        } else if any(&s, &["xy pad", "xy", "touch synth", "theremin", "touch pad", "play pad"]) {
            Some(("xy", "XY synth pad"))
        } else {
            None
        };
        if let Some((d, label)) = dev {
            let on = !off;
            out.act(&format!("{{\"t\":\"device\",\"d\":\"{}\",\"on\":{}}}", d, on), &format!("{} {}", label, if on { "on" } else { "off" }));
            return true;
        }
    }

    // ---- utility commands ---------------------------------------------------------
    if any(&s, &["export", "download preset", "download"]) {
        out.act("{\"t\":\"export\"}", "Exporting the current look as a preset file");
        return true;
    }
    if any(&s, &["import", "upload preset"]) {
        out.act("{\"t\":\"import\"}", "Choose a preset file to import");
        return true;
    }
    if any(&s, &["list presets", "my presets", "saved presets", "list"]) {
        out.act("{\"t\":\"list\"}", "");
        return true;
    }
    if any(&s, &["fullscreen", "full screen"]) {
        out.act("{\"t\":\"fullscreen\"}", "Toggling fullscreen");
        return true;
    }
    if any(&s, &["hide ui", "hide interface", "hide panels", "hide controls", "hide the ui", "hide everything", "clean view"]) {
        out.act("{\"t\":\"ui\",\"on\":false}", "Interface hidden (press Tab or tap the corner button to bring it back)");
        return true;
    }
    if any(&s, &["show ui", "show interface", "show panels", "show controls", "show the ui"]) {
        out.act("{\"t\":\"ui\",\"on\":true}", "Interface shown");
        return true;
    }
    if any(&s, &["random", "randomize", "randomise", "surprise", "surprise me", "shuffle", "dice", "anything"]) {
        for id in [SPEED, STORM, WIND, RAIN, SAND, ORBIT, WARP, WSPEED, TESS, FOLD, HUE, BLOOM, CUTOFF, MELODY, TEMPO, REVERB, DELAY, HARMONICS, KSEG, KSPIN, FBZOOM, FBROT, FBHUE, ACIDCYC, LIQSCALE] {
            out.set(id, rng.range(0.1, 0.9));
        }
        for id in [FEEDBACK, KALEIDO, TUNNEL, LIQUID, ACID, EDGE, POSTER, GLITCH] {
            out.set(id, if rng.f() < 0.35 { rng.range(0.2, 0.8) } else { 0.0 });
        }
        out.pick(ROUTE, (rng.next() % 2) as usize);
        out.pick(KEY, (rng.next() % 12) as usize);
        out.notes.clear();
        out.notes.push("Rolled the dice on the world, the effects and the music.".to_string());
        return true;
    }
    if any(&s, &["reset", "default", "defaults", "start over", "undo everything", "preset 1", "titan storm", "first preset"]) {
        out.p = defaults();
        out.act("{\"t\":\"preset\"}", "Back to preset 1: the titan in the dune storm");
        return true;
    }
    if any(&s, &["custom", "preset 2", "my preset", "second preset"]) {
        out.act("{\"t\":\"custom\"}", "Preset 2: your custom slot");
        return true;
    }

    // ---- fixed phrases ------------------------------------------------------------
    for m in PHRASES.iter() {
        if any(&s, m.0) {
            apply_mood(out, m, 1.0, mag);
            break;
        }
    }

    // ---- direct parameter control -------------------------------------------------
    let mut direct = false;
    if out.actions.len() + out.notes.len() == before {
        if let Some(id) = find_param(&s) {
            direct = true;
            let on_word = any(&s, &["on", "enable", "activate", "start", "engage", "give me", "turn on"]);
            if !PARAMS[id].options.is_empty() {
                let n = PARAMS[id].options.len();
                let cur = choice(&out.p, id);
                out.pick(id, (cur + 1) % n);
            } else if let Some((v, pct)) = num {
                let frac = if pct || v > 1.0 { v / 100.0 } else { v };
                if (up || down) && (has(&s, "by") || pct && !has(&s, "to")) {
                    out.nudge(id, if down { -frac } else { frac });
                } else {
                    out.set(id, frac);
                }
            } else if any(&s, &MAXW) {
                out.set(id, 1.0);
            } else if has(&s, "half") || has(&s, "medium") || has(&s, "middle") {
                out.set(id, 0.5);
            } else if up {
                out.nudge(id, 0.2 * mag);
            } else if down {
                out.nudge(id, -0.2 * mag);
            } else if any(&s, &MINW) {
                out.set(id, 0.0);
            } else if on_word || words(&s) <= 2 && out.p[id] < 0.05 {
                out.set(id, out.p[id].max(0.6));
            } else {
                let label = PARAMS[id].label.trim_start_matches('\u{21b3}').trim();
                out.notes.push(format!(
                    "{} is at {}%. Say \"more {}\", \"less {}\" or \"set {} to 70%\".",
                    label,
                    (out.p[id] * 100.0).round() as i32,
                    PARAMS[id].words[0],
                    PARAMS[id].words[0],
                    PARAMS[id].words[0]
                ));
            }
        }
    }

    // ---- colours ------------------------------------------------------------------
    for (name, hue) in COLORS.iter() {
        if has(&s, name) {
            let mut h = hue - SCENE_HUE;
            h -= h.floor();
            out.set(HUE, h);
            if out.p[SATURATION] < 0.5 {
                out.set(SATURATION, 0.6);
            }
            out.notes.push(format!("Shifted the palette toward {}", name));
            break;
        }
    }

    // ---- moods --------------------------------------------------------------------
    let sign = if any(&s, &["less", "not", "not so", "fewer", "isnt", "dont", "no", "stop"]) { -1.0 } else { 1.0 };
    for m in MOODS.iter() {
        if !direct && any(&s, m.0) {
            apply_mood(out, m, sign, mag);
        }
    }

    out.actions.len() + out.notes.len() > before
}

pub fn parse(input: &str, params: &[f32; NP], seed: u32) -> String {
    let mut rng = Rng::new(seed);
    let mut out = Out { actions: Vec::new(), notes: Vec::new(), p: *params };
    let text: String = input.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = text.to_lowercase();
    let trimmed = lower.trim();
    let mut understood = false;

    // Whole-line commands that carry a free-form name.
    let mut handled_line = false;
    if lower.len() == text.len() {
        if trimmed.starts_with("save") && !trimmed.starts_with("save image") && !trimmed.starts_with("save picture") {
            let name = after(&text, &lower, &["save preset as ", "save it as ", "save this as ", "save as ", "save preset ", "save "])
                .unwrap_or("")
                .to_string();
            let name = if name.is_empty() || name == "preset" || name == "it" || name == "this" { String::new() } else { name };
            out.act(
                &format!("{{\"t\":\"save\",\"name\":\"{}\"}}", esc(&name)),
                &if name.is_empty() { "Saved to your custom preset".to_string() } else { format!("Saved custom preset \"{}\"", name) },
            );
            handled_line = true;
        } else if trimmed.starts_with("delete ") || trimmed.starts_with("remove preset ") {
            let name = after(&text, &lower, &["delete preset ", "remove preset ", "delete "]).unwrap_or("").to_string();
            out.act(&format!("{{\"t\":\"delete\",\"name\":\"{}\"}}", esc(&name)), "");
            handled_line = true;
        } else if trimmed.starts_with("load ") || trimmed.starts_with("recall ") || trimmed.starts_with("open preset ") {
            let name = after(&text, &lower, &["load preset ", "open preset ", "recall preset ", "load ", "recall "]).unwrap_or("").to_string();
            let c = clean(&name);
            let builtin = any(&c, &["1", "2", "titan", "titan storm", "default", "custom", "defaults"]);
            if !builtin && !name.is_empty() {
                out.act(&format!("{{\"t\":\"load\",\"name\":\"{}\"}}", esc(&name)), "");
                handled_line = true;
            }
        }
    }

    if handled_line {
        understood = true;
    } else {
        // Split into clauses so "more rain and less bloom, then faster" becomes three commands.
        let mut marked = format!(" {} ", lower);
        for sep in [" and then ", " then ", " and ", " also ", " plus ", " but ", ";", ",", "!", "?", ". "] {
            marked = marked.replace(sep, " | ");
        }
        for part in marked.split('|') {
            if part.trim().is_empty() {
                continue;
            }
            if clause(&mut out, part, &mut rng) {
                understood = true;
            }
        }
    }

    let reply = if !out.notes.is_empty() {
        out.notes.join(" \u{00b7} ")
    } else if understood {
        String::new()
    } else {
        "I did not catch that. Try \"more lightning\", \"make it trippy\", \"effects in parallel\", \"key of G minor\", \"8k\" or type \"help\".".to_string()
    };

    format!("{{\"ok\":{},\"reply\":\"{}\",\"actions\":[{}]}}", understood, esc(&reply), out.actions.join(","))
}
