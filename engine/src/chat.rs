//! Natural-language command parser for the chat bot. It turns free text such as
//! "more lightning and a bit less fog, then turn on the camera" into a JSON list
//! of actions that the TypeScript shell executes. Everything runs locally: no
//! network, no model download.

use crate::params::*;
use crate::rng::Rng;

/// Approximate dominant hue of each scene, used to translate colour names into a hue rotation.
const SCENE_HUE: [f32; NSCENES] = [0.62, 0.52, 0.05, 0.55];

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

const SCENE_WORDS: [&[&str]; NSCENES] = [
    &["storm", "lightning", "thunderstorm", "dune", "dunes", "desert", "sand"],
    &["underwater", "ocean", "sea", "abyss", "deep sea", "creatures", "jellyfish", "aquatic", "water", "deep"],
    &["volcano", "dragon", "lava", "island", "volcanic", "dragons"],
    &["titan", "skeleton", "city", "giant", "colossus", "bones"],
];

const UP: [&str; 22] = [
    "taller", "larger", "greater", "denser", "wilder", "more", "increase", "raise", "higher", "up", "add", "boost", "stronger", "bigger", "crank", "intensify", "extra",
    "heavier", "thicker", "deeper", "longer", "plus",
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
const SWITCHW: [&str; 14] = [
    "go to", "switch", "load", "show", "take me", "change to", "preset", "scene", "open", "start", "jump", "visit",
    "want", "give me",
];

/// (trigger words, [(param, amount, absolute?)])
type Mood = (&'static [&'static str], &'static [(usize, f32, bool)]);

const PHRASES: [Mood; 24] = [
    (&["two dragons", "2 dragons", "both dragons", "second dragon", "another dragon", "twin dragons"], &[(DENSITY, 0.8, true)]),
    (&["one dragon", "single dragon", "1 dragon"], &[(DENSITY, 0.4, true)]),
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
    (&["brighter", "lighter"], &[(BRIGHTNESS, 0.15, false)]),
    (&["foggy", "foggier", "misty", "hazy", "smoky", "dusty"], &[(FOG, 0.25, false)]),
    (&["clear", "clearer", "crisp"], &[(FOG, -0.25, false)]),
    (&["black and white", "monochrome", "grayscale", "greyscale", "desaturate"], &[(SATURATION, 0.0, true)]),
    (&["colorful", "colourful", "vivid", "vibrant", "saturated"], &[(SATURATION, 0.2, false)]),
    (&["higher pitch", "pitch up", "transpose up"], &[(PITCH, 0.12, false)]),
    (&["lower pitch", "pitch down", "transpose down"], &[(PITCH, -0.12, false)]),
    (&["original colors", "original colours", "natural colors", "natural colours", "normal colors", "normal colours"], &[(HUE, 0.0, true)]),
    (&["clean", "cleaner", "no effects", "no fx", "remove effects"], &[(GLITCH, 0.0, true), (FEEDBACK, 0.0, true), (KALEIDO, 0.0, true)]),
    (&["glitchy", "glitchier", "broken", "corrupted", "corrupt"], &[(GLITCH, 0.35, false)]),
];

const MOODS: [Mood; 12] = [
    (
        &["calm", "calmer", "chill", "peaceful", "gentle", "relax", "relaxed", "relaxing", "quiet", "serene", "soothing", "meditative"],
        &[(SPEED, -0.18, false), (INTENSITY, -0.3, false), (GLITCH, 0.0, true), (TEMPO, -0.15, false), (IMPACT, -0.25, false)],
    ),
    (
        &["intense", "chaos", "chaotic", "crazy", "wild", "insane", "aggressive", "angry", "violent", "epic", "furious", "brutal", "apocalyptic", "apocalypse", "stormy", "stormier", "extreme", "harder", "hardcore"],
        &[(INTENSITY, 0.35, false), (SPEED, 0.12, false), (BLOOM, 0.12, false), (IMPACT, 0.2, false), (TEMPO, 0.12, false)],
    ),
    (
        &["trippy", "trippier", "psychedelic", "acid", "lsd", "hallucination", "hallucinate", "surreal", "weird", "weirder", "strange"],
        &[(WARP, 0.35, false), (FEEDBACK, 0.4, false), (WSPEED, 0.3, false), (KALEIDO, 0.3, false), (HUE, 0.12, false)],
    ),
    (
        &["dreamy", "dream", "dreamlike", "ethereal", "heavenly", "floaty", "soft"],
        &[(REVERB, 0.25, false), (BLOOM, 0.2, false), (FEEDBACK, 0.3, false), (SPEED, -0.1, false), (CONTRAST, -0.08, false)],
    ),
    (
        &["cinematic", "movie", "film", "dramatic"],
        &[(CONTRAST, 0.14, false), (BLOOM, 0.15, false), (SATURATION, -0.08, false), (ORBIT, 0.15, true), (FOG, 0.1, false)],
    ),
    (
        &["dark", "scary", "horror", "creepy", "sinister", "evil", "nightmare", "spooky", "ominous"],
        &[(BRIGHTNESS, -0.14, false), (FOG, 0.15, false), (CUTOFF, -0.15, false), (PITCH, -0.1, false), (CONTRAST, 0.08, false)],
    ),
    (
        &["bright", "happy", "sunny", "cheerful", "uplifting"],
        &[(BRIGHTNESS, 0.15, false), (CUTOFF, 0.15, false), (FOG, -0.1, false), (PITCH, 0.08, false)],
    ),
    (
        &["4d", "four dimensional", "hyper", "hyperspace", "tesseract", "fourth dimension"],
        &[(WARP, 0.3, false), (WSPEED, 0.3, false)],
    ),
    (
        &["rave", "party", "club", "dance", "techno", "energetic"],
        &[(TEMPO, 0.3, false), (MELODY, 0.3, false), (REACT, 0.3, false), (GLITCH, 0.15, false), (SPEED, 0.15, false)],
    ),
    (
        &["ambient", "minimal", "drone only", "spacious"],
        &[(MELODY, -0.3, false), (REVERB, 0.25, false), (DRONE, 0.15, false), (TEMPO, -0.15, false)],
    ),
    (
        &["heavy", "massive", "huge", "bassy", "thunderous"],
        &[(DRONE, 0.2, false), (IMPACT, 0.25, false), (CUTOFF, -0.1, false), (BLOOM, 0.1, false)],
    ),
    (
        &["metallic", "robotic", "industrial", "alien"],
        &[(FM, 0.35, false), (RESONANCE, 0.2, false), (GLITCH, 0.12, false)],
    ),
];

const BLENDS: [(&str, &str); 12] = [
    ("screen", "screen"),
    ("lighten", "lighten"),
    ("difference", "difference"),
    ("overlay", "overlay"),
    ("multiply", "multiply"),
    ("hard light", "hard-light"),
    ("soft light", "soft-light"),
    ("exclusion", "exclusion"),
    ("color dodge", "color-dodge"),
    ("dodge", "color-dodge"),
    ("add", "plus-lighter"),
    ("normal", "normal"),
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

/// Lower-case a clause and pad it with spaces so whole-word matching is a substring search.
fn clean(clause: &str) -> String {
    let mut o = String::from(" ");
    let mut last_space = true;
    for c in clause.chars() {
        let c = c.to_ascii_lowercase();
        let keep = c.is_alphanumeric() || c == '.' || c == '%';
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
    // "0.7." or "fog." -> strip sentence dots that are not part of a number
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

fn scene_from(s: &str) -> Option<usize> {
    for (i, words) in SCENE_WORDS.iter().enumerate() {
        if any(s, words) {
            return Some(i);
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

struct Out {
    actions: Vec<String>,
    notes: Vec<String>,
    p: [f32; NP],
    scene: usize,
}

impl Out {
    fn set(&mut self, id: usize, v: f32) {
        let v = v.clamp(0.0, 1.0);
        self.p[id] = v;
        self.actions.push(format!("{{\"t\":\"set\",\"k\":\"{}\",\"v\":{:.4}}}", PARAMS[id].key, v));
        let note = format!("{} {}%", PARAMS[id].label, (v * 100.0).round() as i32);
        // Keep only the latest note per parameter.
        let prefix = format!("{} ", PARAMS[id].label);
        self.notes.retain(|n| !n.starts_with(&prefix) || !n.ends_with('%'));
        self.notes.push(note);
    }
    fn nudge(&mut self, id: usize, d: f32) {
        let v = self.p[id] + d;
        self.set(id, v);
    }
    fn act(&mut self, json: String, note: &str) {
        self.actions.push(json);
        if !note.is_empty() {
            self.notes.push(note.to_string());
        }
    }
    fn scene(&mut self, i: usize) {
        self.scene = i;
        self.p = scene_defaults(i);
        self.actions.push(format!("{{\"t\":\"scene\",\"i\":{}}}", i));
        self.notes.push(format!("Preset {}: {}", i + 1, SCENE_NAMES[i]));
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
            out.set(id, amt);
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
    let adjust = up || down || num.is_some() || any(&s, &MAXW) || any(&s, &["half", "set", "minimum", "min", "zero"]);
    let off = any(&s, &OFFW);
    let mag = magnitude(&s);

    // ---- help / status --------------------------------------------------------
    if any(&s, &["help", "commands", "what can you do", "what can i say", "how do i", "how does this work", "instructions"]) {
        out.notes.push(
            "Talk to me in plain language. Try: \"take me to the volcano\", \"more lightning, a lot less fog\", \
             \"make it trippy and slower\", \"set bloom to 80%\", \"turn it blue\", \"turn on the camera\" / \"mic on\" / \"share screen\", \
             paste a YouTube link then \"blend difference\", \"randomize\", \"reset\", \"save as my show\", \"load my show\", \"export\". \
             Keys A-K play notes, 1-5 switch presets, drag to orbit, pinch or scroll to zoom."
                .to_string(),
        );
        return true;
    }
    if any(&s, &["hi", "hello", "hey", "yo", "sup", "good morning", "good evening"]) && s.split(' ').filter(|w| !w.is_empty()).count() <= 3 {
        out.notes.push(format!("Hello! You are in \"{}\". Tell me how it should look and sound, or type \"help\".", SCENE_NAMES[out.scene]));
        return true;
    }
    if any(&s, &["thanks", "thank you", "thx", "nice", "cool", "awesome", "great", "love it", "beautiful"]) && s.split(' ').filter(|w| !w.is_empty()).count() <= 4 {
        out.notes.push("Glad you like it. Want it wilder, calmer, or somewhere else entirely?".to_string());
        return true;
    }
    if any(&s, &["status", "current settings", "what are the settings", "show settings", "values"]) {
        let mut t = format!("Scene: {}.", SCENE_NAMES[out.scene]);
        for (i, p) in PARAMS.iter().enumerate() {
            t.push_str(&format!(" {} {}%", p.label, (out.p[i] * 100.0).round() as i32));
            t.push(if i + 1 < NP { ',' } else { '.' });
        }
        out.notes.push(t);
        return true;
    }

    // ---- blend mode for the YouTube layer ---------------------------------------
    if any(&s, &["blend", "blending", "blend mode", "mix mode", "composite"]) {
        for (w, mode) in BLENDS.iter() {
            if has(&s, w) {
                out.act(format!("{{\"t\":\"blend\",\"mode\":\"{}\"}}", mode), &format!("Blend mode: {}", w));
                return true;
            }
        }
        out.notes.push("Blend modes: screen, lighten, difference, overlay, multiply, hard light, soft light, exclusion, dodge, add, normal.".to_string());
        return true;
    }

    // ---- YouTube transport --------------------------------------------------------
    if any(&s, &["youtube", "yt", "video", "clip"]) && !any(&s, &["mix", "opacity", "level", "file"]) {
        if has(&s, "volume") {
            if let Some((v, _)) = num {
                let v = if v <= 1.0 { v * 100.0 } else { v }.clamp(0.0, 100.0);
                out.act(format!("{{\"t\":\"ytvol\",\"v\":{}}}", v.round()), &format!("YouTube volume {}%", v.round()));
                return true;
            }
        }
        let cmd = if any(&s, &["unmute"]) {
            "unmute"
        } else if any(&s, &["mute"]) {
            "mute"
        } else if any(&s, &["pause", "hold"]) {
            "pause"
        } else if any(&s, &["play", "resume", "continue"]) {
            "play"
        } else if off || any(&s, &["clear", "unload", "eject"]) {
            "off"
        } else {
            ""
        };
        if !cmd.is_empty() {
            out.act(format!("{{\"t\":\"yt\",\"cmd\":\"{}\"}}", cmd), &format!("YouTube: {}", cmd));
            return true;
        }
        if any(&s, &["youtube", "yt"]) && !adjust {
            out.notes.push("Paste a YouTube link (or video id) here and I will mix it under the visuals.".to_string());
            return true;
        }
    }

    // ---- devices ------------------------------------------------------------------
    if !any(&s, &["mix", "opacity", "level", "speed", "rotation", "distance"]) {
        let dev = if any(&s, &["camera", "webcam", "cam", "selfie"]) {
            Some(("camera", "Camera"))
        } else if any(&s, &["mic", "microphone", "audio input", "listen"]) {
            Some(("mic", "Microphone"))
        } else if any(&s, &["screen share", "screenshare", "share screen", "share my screen", "tab capture", "screen capture", "capture screen", "capture tab", "screen"]) {
            Some(("screen", "Screen capture"))
        } else if any(&s, &["video file", "local video", "file", "upload"]) {
            Some(("file", "Video file"))
        } else if any(&s, &["xy pad", "xy", "touch synth", "theremin", "touch pad", "play pad"]) {
            Some(("xy", "XY synth pad"))
        } else {
            None
        };
        if let Some((d, label)) = dev {
            let on = !off;
            out.act(
                format!("{{\"t\":\"device\",\"d\":\"{}\",\"on\":{}}}", d, on),
                &format!("{} {}", label, if on { "on" } else { "off" }),
            );
            return true;
        }
    }

    // ---- utility commands ---------------------------------------------------------
    if any(&s, &["export", "download preset", "download"]) {
        out.act("{\"t\":\"export\"}".to_string(), "Exporting the current look as a preset file");
        return true;
    }
    if any(&s, &["import", "upload preset"]) {
        out.act("{\"t\":\"import\"}".to_string(), "Choose a preset file to import");
        return true;
    }
    if any(&s, &["list presets", "my presets", "saved presets", "list"]) {
        out.act("{\"t\":\"list\"}".to_string(), "");
        return true;
    }
    if any(&s, &["fullscreen", "full screen"]) {
        out.act("{\"t\":\"fullscreen\"}".to_string(), "Toggling fullscreen");
        return true;
    }
    if any(&s, &["hide ui", "hide interface", "hide panels", "hide controls", "hide the ui", "hide everything", "clean view"]) {
        out.act("{\"t\":\"ui\",\"on\":false}".to_string(), "Interface hidden (press Tab or tap the corner button to bring it back)");
        return true;
    }
    if any(&s, &["show ui", "show interface", "show panels", "show controls", "show the ui"]) {
        out.act("{\"t\":\"ui\",\"on\":true}".to_string(), "Interface shown");
        return true;
    }
    if any(&s, &["random", "randomize", "randomise", "surprise", "surprise me", "shuffle", "dice", "anything"]) {
        for id in [SPEED, INTENSITY, DENSITY, ORBIT, WARP, WSPEED, FOG, HUE, BLOOM, PITCH, CUTOFF, MELODY, TEMPO, REVERB, DELAY, FM] {
            out.set(id, rng.range(0.1, 0.9));
        }
        out.set(FEEDBACK, if rng.f() < 0.4 { rng.range(0.2, 0.8) } else { 0.0 });
        out.set(KALEIDO, if rng.f() < 0.25 { rng.range(0.2, 0.7) } else { 0.0 });
        out.set(GLITCH, if rng.f() < 0.25 { rng.range(0.1, 0.5) } else { 0.0 });
        out.notes.clear();
        out.notes.push("Rolled the dice on motion, look and sound.".to_string());
        return true;
    }
    if any(&s, &["reset", "default", "defaults", "start over", "undo everything"]) {
        let scene = out.scene;
        out.scene(scene);
        out.notes.pop();
        out.notes.push("Back to this scene's defaults.".to_string());
        return true;
    }

    // ---- preset / scene switching -------------------------------------------------
    if any(&s, &["preset", "scene", "number", "world"]) || s.trim().len() == 1 {
        if let Some((v, _)) = num {
            let n = v.round() as i32;
            if (1..=4).contains(&n) {
                out.scene((n - 1) as usize);
                return true;
            }
            if n == 5 {
                out.act("{\"t\":\"custom\"}".to_string(), "Preset 5: your custom slot");
                return true;
            }
        }
        if any(&s, &["next"]) {
            out.scene((out.scene + 1) % NSCENES);
            return true;
        }
        if any(&s, &["previous", "prev", "last", "back"]) {
            out.scene((out.scene + NSCENES - 1) % NSCENES);
            return true;
        }
        if any(&s, &["custom", "mine", "my"]) {
            out.act("{\"t\":\"custom\"}".to_string(), "Preset 5: your custom slot");
            return true;
        }
    }
    if let Some(sc) = scene_from(&s) {
        let words = s.split(' ').filter(|w| !w.is_empty()).count();
        if !adjust && (any(&s, &SWITCHW) || sc != out.scene || words <= 1) && !any(&s, &["two dragons", "both dragons", "one dragon"]) {
            out.scene(sc);
            return true;
        }
    }

    // ---- fixed phrases ("zoom in", "slow down", "mute"...) ---------------------------
    for m in PHRASES.iter() {
        if any(&s, m.0) {
            apply_mood(out, m, 1.0, mag);
            break;
        }
    }

    // ---- direct parameter control ---------------------------------------------------
    let mut direct = false;
    if out.actions.len() + out.notes.len() == before {
        if let Some(id) = find_param(&s) {
            direct = true;
            if let Some((v, pct)) = num {
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
            } else {
                out.notes.push(format!(
                    "{} is at {}%. Say \"more {}\", \"less {}\" or \"set {} to 70%\".",
                    PARAMS[id].label,
                    (out.p[id] * 100.0).round() as i32,
                    PARAMS[id].key,
                    PARAMS[id].key,
                    PARAMS[id].key
                ));
            }
        }
    }

    // ---- colours ------------------------------------------------------------------
    for (name, hue) in COLORS.iter() {
        if has(&s, name) {
            let mut h = hue - SCENE_HUE[out.scene];
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
    let sign = if any(&s, &["less", "not", "not so", "fewer", "isnt", "dont"]) { -1.0 } else { 1.0 };
    for m in MOODS.iter() {
        if !direct && any(&s, m.0) {
            apply_mood(out, m, sign, mag);
        }
    }

    out.actions.len() + out.notes.len() > before
}

pub fn parse(input: &str, params: &[f32; NP], scene: usize, seed: u32) -> String {
    let mut rng = Rng::new(seed);
    let mut out = Out { actions: Vec::new(), notes: Vec::new(), p: *params, scene };
    let mut text = String::new();
    let mut understood = false;

    // Pull out a YouTube / http link before any lower-casing (video ids are case sensitive).
    for tok in input.split_whitespace() {
        let low = tok.to_ascii_lowercase();
        if low.contains("youtu.be/") || low.contains("youtube.com/") || low.starts_with("http://") || low.starts_with("https://") {
            let url = tok.trim_matches(|c: char| c == '"' || c == '\'' || c == '<' || c == '>' || c == ',' || c == ')' || c == '(');
            out.act(format!("{{\"t\":\"youtube\",\"url\":\"{}\"}}", esc(url)), "Loading the YouTube video into the mix");
            understood = true;
        } else {
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(tok);
        }
    }
    let lower = text.to_lowercase();
    let trimmed = lower.trim();

    // Whole-line commands that carry a free-form name.
    let mut handled_line = false;
    if trimmed.starts_with("save") {
        let name = after(&text, &lower, &["save preset as ", "save it as ", "save this as ", "save as ", "save preset ", "save "])
            .unwrap_or("")
            .to_string();
        let name = if name.is_empty() || name == "preset" || name == "it" || name == "this" { String::new() } else { name };
        out.act(
            format!("{{\"t\":\"save\",\"name\":\"{}\"}}", esc(&name)),
            &if name.is_empty() { "Saved to your custom preset".to_string() } else { format!("Saved custom preset \"{}\"", name) },
        );
        handled_line = true;
    } else if trimmed.starts_with("delete ") || trimmed.starts_with("remove preset ") {
        let name = after(&text, &lower, &["delete preset ", "remove preset ", "delete "]).unwrap_or("").to_string();
        out.act(format!("{{\"t\":\"delete\",\"name\":\"{}\"}}", esc(&name)), &format!("Deleted preset \"{}\"", name));
        handled_line = true;
    } else if trimmed.starts_with("load ") || trimmed.starts_with("recall ") || trimmed.starts_with("open preset ") {
        let name = after(&text, &lower, &["load preset ", "open preset ", "recall preset ", "load ", "recall "])
            .unwrap_or("")
            .to_string();
        let c = clean(&name);
        let is_builtin = scene_from(&c).is_some() || number(&c).is_some() || any(&c, &["next", "previous", "custom"]);
        if !is_builtin && !name.is_empty() {
            out.act(format!("{{\"t\":\"load\",\"name\":\"{}\"}}", esc(&name)), &format!("Looking for your preset \"{}\"", name));
            handled_line = true;
        }
    }

    if handled_line {
        understood = true;
    } else {
        // Split into clauses so "more fog and less bloom, then faster" becomes three commands.
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
        "Done.".to_string()
    } else {
        "I did not catch that. Try \"more lightning\", \"less fog\", \"make it trippy\", \"go underwater\", \"camera on\" or type \"help\".".to_string()
    };

    format!(
        "{{\"ok\":{},\"reply\":\"{}\",\"actions\":[{}]}}",
        understood,
        esc(&reply),
        out.actions.join(",")
    )
}
