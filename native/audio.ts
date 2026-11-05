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
// here both are the same graphs rendered once, natively, into clips
// (OfflineAudioContext), and the synthesized stand-ins it played while a sample loaded are not
// ported: the engine's browser runtime drops clip loads and plays while a
// synthesis graph changes (the arrow-exodus port's finding). Every clip loads
// at onStart (the engine queues them and each reaches the mixer, natively and
// in a browser); the beds start once the mixer runs (in a browser, after the
// first press).
import { OfflineAudioContext, context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";

const RATE = 11025;
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

/** Loads every clip at once (onStart); a cue whose clip is still loading is skipped. */
export function loadSfx(): void {
  for (const name of new Set(Object.values(SAMPLE_BY_EVENT))) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
  }
  loadClip("sfx/ambience-skyline.opus").then((c) => { skylineClip = c; }, () => { /* keep the pad */ });
  renderPad().then((c) => { padClip = c; }, (e: unknown) => console.warn(`pad: ${String(e)}`));
  Promise.all(MUS_SCALE.map(renderNote)).then((c) => { notes = c; }, (e: unknown) => console.warn(`music: ${String(e)}`));
}

export function setCaptions(on: boolean): void { captionsOn = on; }
export function setOnCaption(cb: (text: string) => void): void { onCaption = cb; }
function caption(text: string): void { if (captionsOn && onCaption && text) onCaption(text); }

/** Plays an event's clip and emits its caption. */
export function event(name: string, detail?: string | number): void {
  const file = SAMPLE_BY_EVENT[name];
  const clip = file ? clips.get(file) : undefined;
  if (clip) {
    const bus: OldBus = VOICE.has(name) ? "voice" : "effects";
    try { playClip(clip, { bus: BUS[bus], gain: LEVEL[bus] }); } catch { /* the mixer is full this frame: skip it */ }
  }
  if (name === "count") caption(String(detail ?? ""));
  else if (name === "achievement") caption(`achievement: ${detail ?? ""}`);
  else caption(CAPTION[name] ?? "");
}

// -- rendered beds ------------------------------------------------------------------------
/** The pad under the ambience: white noise (±0.3) lowpassed at 240 Hz. The noise
 * loops every 2 s, so once the filter settles the output does too: one period of it is a seamless loop. */
async function renderPad(): Promise<AudioClip> {
  const n = 2 * RATE, settle = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, settle + n, RATE);
  const noise = off.createNoise({ seed: 7, seconds: 2 });
  const lowpass = off.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 240;
  const gain = off.createGain();
  gain.gain.value = 0.3;
  noise.connect(lowpass).connect(gain).connect(off.destination);
  noise.start();
  const rendered = await off.startRendering();
  return createClip([rendered.getChannelData(0).slice(settle)], RATE);
}
/** One music voice: a sine falling exponentially to silence over 1.6 s (gain 1; scaled when played). */
async function renderNote(freq: number): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(1.62 * RATE), RATE);
  const osc = off.createOscillator();
  osc.frequency.value = freq;
  const gain = off.createGain();
  gain.gain.setValueAtTime(1, 0);
  gain.gain.exponentialRampToValueAtTime(0.0001, 1.6);
  osc.connect(gain).connect(off.destination);
  osc.start();
  return createClip(await off.startRendering());
}

let started = false;
let ambience = 0; // 0 nothing yet, 1 the pad, 2 the authored loop too
let pad: Sound | null = null;
let skyline: Sound | null = null;
let skylineClip: AudioClip | null = null;
let padClip: AudioClip | null = null;
const MUS_SCALE = [261.6, 311.1, 392.0, 466.2, 523.3];
let notes: AudioClip[] = [];
let musicIntensity = 0;
let musicStep = 0;
let nextNote = 0;
export function setMusicIntensity(streak: number): void { musicIntensity = Math.max(0, Math.min(4, streak | 0)); }

/** The beds start with the first gesture (the browser build's audio unlock). */
export function unlock(): void { started = true; }

/** Each frame once the mixer runs: the beds as their clips are ready, then
 * the pad music's next voices every 1.4 s of mixer time. */
export function update(): void {
  if (context.state !== "running" || !started) return;
  try {
    if (ambience === 0 && padClip) {
      ambience = 1;
      pad = playClip(padClip, { bus: BUS.ambience, gain: 0.6 * LEVEL.ambience, loop: true });
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
    if (!notes.length) return;
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
