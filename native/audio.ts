// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, the event table of sfx/manifest.txt) on the runtime's
// mixer, the skyline ambience loop over a low-passed noise pad, and the
// generative pad music whose voices follow the streak. Every meaningful
// sound also emits a caption (onCaption).
//
// The browser build's four buses become the runtime's (Options › Audio owns
// the volumes, the mute and the voice limit): music → "music", effects and
// ambience → "effects", the input click and the voice cues (countdown, go,
// achievement, lesson) → "interface". The old default bus levels (music 40 %,
// effects 80 %, ambience 35 %, voice 60 %) are folded into each sound's gain.
//
// The browser build made the noise pad and the music with Web Audio nodes;
// here both are rendered once into clips (createClip) with the same shapes,
// and the synthesized stand-ins it played while a sample loaded are not
// ported: the engine's browser runtime drops clip loads and plays while a
// synthesis graph changes (the arrow-exodus port's finding). Clips load once
// the mixer runs (natively at once, in a browser after the first press).
import { context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";

const LEVEL = { music: 0.4, effects: 0.8, ambience: 0.35, voice: 0.6 };
type OldBus = keyof typeof LEVEL;
const BUS: Record<OldBus, Bus> = { music: "music", effects: "effects", ambience: "effects", voice: "interface" };

// Basenames mirror sfx/manifest.json (clips live at sfx/<name>.opus).
const SAMPLE_BY_EVENT: Record<string, string> = {
  ack: "ui-ack", place: "slab-place", perfect: "perfect-chime", trim: "overhang-trim", miss: "slab-miss",
  win: "stage-win", lose: "round-lose", undo: "drop-undo", hint: "hint-ping", count: "count-tick", go: "count-go",
  achievement: "achievement-chime", lesson: "lesson-complete", pause: "pause-hush",
};
// The interface bus: the input click and the voice cues.
const VOICE = new Set(["ack", "count", "go", "achievement", "lesson"]);
const CAPTION: Record<string, string> = {
  place: "slab placed", perfect: "perfect placement", trim: "overhang trimmed", miss: "slab missed",
  win: "stage complete", lose: "round over", undo: "drop undone", hint: "perfect window marked", go: "go",
  lesson: "lesson complete",
};
const clips = new Map<string, AudioClip>();
let onCaption: ((text: string) => void) | null = null;
let captionsOn = true;

let wantClips = false;
function load(name: string): void {
  loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
}
/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }

export function setCaptions(on: boolean): void { captionsOn = on; }
export function setOnCaption(cb: (text: string) => void): void { onCaption = cb; }
function caption(text: string): void { if (captionsOn && onCaption && text) onCaption(text); }

/** Plays an event's clip and emits its caption. */
export function event(name: string, detail?: string | number): void {
  const file = SAMPLE_BY_EVENT[name];
  const clip = file ? clips.get(file) : undefined;
  if (clip) {
    const bus: OldBus = VOICE.has(name) ? "voice" : "effects";
    try { playClip(clip, { bus: BUS[bus], gain: LEVEL[bus] }); }
    catch { clips.delete(file!); load(file!); } // a clip the mixer lost: load it again
  }
  if (name === "count") caption(String(detail ?? ""));
  else if (name === "achievement") caption(`achievement: ${detail ?? ""}`);
  else caption(CAPTION[name] ?? "");
}

// -- rendered beds ------------------------------------------------------------------------
const RATE = 11025;
/** RBJ biquad lowpass over `x` in place (Web Audio's BiquadFilterNode, Q 1). */
function lowpass(x: Float32Array, freq: number, q = 1): void {
  const w = (2 * Math.PI * freq) / RATE, alpha = Math.sin(w) / (2 * q), c = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, b2 = b0, a1 = (-2 * c) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i]!;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    x[i] = y0;
  }
}
/** The pad under the ambience: white noise (±0.3) lowpassed at 240 Hz, a seamless 2 s loop. */
function padClip(): AudioClip {
  const n = 2 * RATE, fade = Math.round(0.25 * RATE);
  const raw = new Float32Array(n + fade);
  let seed = 7;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.3;
  }
  lowpass(raw, 240);
  const out = raw.slice(0, n);
  for (let i = 0; i < fade; i++) { const k = i / fade; out[i] = raw[n + i]! * (1 - k) + raw[i]! * k; }
  return createClip([out], RATE);
}
/** One music voice: a sine falling exponentially to silence over 1.6 s (gain 1; scaled when played). */
function noteClip(freq: number): AudioClip {
  const n = Math.round(1.62 * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    out[i] = Math.sin(2 * Math.PI * freq * t) * Math.pow(0.0001, Math.min(1, t / 1.6));
  }
  return createClip([out], RATE);
}

let started = false;
let ambience = 0; // 0 nothing yet, 1 the pad, 2 the authored loop too
let pad: Sound | null = null;
let skyline: Sound | null = null;
let skylineClip: AudioClip | null = null;
const MUS_SCALE = [261.6, 311.1, 392.0, 466.2, 523.3];
const notes: AudioClip[] = [];
let musicIntensity = 0;
let musicStep = 0;
let nextNote = 0;
export function setMusicIntensity(streak: number): void { musicIntensity = Math.max(0, Math.min(4, streak | 0)); }

/** The beds start with the first gesture (the browser build's audio unlock). */
export function unlock(): void { started = true; }

/** Each frame: what waited for the mixer, one rendered clip a frame, then
 * the pad music's next voices every 1.4 s of mixer time. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const name of new Set(Object.values(SAMPLE_BY_EVENT))) load(name);
    loadClip("sfx/ambience-skyline.opus").then((c) => { skylineClip = c; }, () => { /* keep the pad */ });
    return;
  }
  if (!started) return;
  try {
    if (ambience === 0) {
      ambience = 1;
      pad = playClip(padClip(), { bus: BUS.ambience, gain: 0.6 * LEVEL.ambience, loop: true });
      return;
    }
    if (ambience === 1 && skylineClip) {
      // The authored loop fades in over 1.5 s and the pad out.
      ambience = 2;
      skyline = playClip(skylineClip, { bus: BUS.ambience, gain: 0, loop: true });
      skyline.fade(0.9 * LEVEL.ambience, 1.5);
      pad?.fade(0, 1.5);
      return;
    }
    if (notes.length < MUS_SCALE.length) { notes.push(noteClip(MUS_SCALE[notes.length]!)); return; }
  } catch (e) { console.warn(`beds: ${String(e)}`); return; }
  const now = context.currentTime;
  if (now < nextNote) return;
  nextNote = now + 1.4;
  const n = 1 + Math.min(3, musicIntensity);
  for (let i = 0; i < n; i++) {
    try { playClip(notes[(musicStep + i * 2) % notes.length]!, { bus: BUS.music, gain: (0.05 + 0.02 * musicIntensity) * LEVEL.music }); } catch { /* the mixer is full */ }
  }
  musicStep++;
}
