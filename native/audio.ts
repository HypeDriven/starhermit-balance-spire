// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, the event table of sfx/manifest.txt) on the runtime's
// mixer, the synthesized transients (filtered-noise thocks, sine chimes) as
// the fallback while a clip loads or if it fails, the skyline ambience loop
// over a low-passed noise pad, and the generative pad music whose voices
// follow the streak. Pitch variants come from the seeded AV stream, reseeded
// per round. Every meaningful sound also emits a caption (onCaption).
//
// The browser build's four buses become the runtime's (Options › Audio owns
// the volumes, the mute and the voice limit): music → "music", effects and
// ambience → "effects", the input click and the voice cues (countdown, go,
// achievement, lesson) → "interface". The old default bus levels (music 40 %,
// effects 80 %, ambience 35 %, voice 60 %) are folded into each sound's gain.
import { context, loadClip, play as playClip, type AudioClip, type Bus, type GainNode, type AudioBufferSourceNode, type Sound } from "starhermit:audio";
import { RNG, type RngStream } from "./classic.ts";

const LEVEL = { music: 0.4, effects: 0.8, ambience: 0.35, voice: 0.6 };
type OldBus = keyof typeof LEVEL;
const BUS: Record<OldBus, Bus> = { music: "music", effects: "effects", ambience: "effects", voice: "interface" };

// Basenames mirror sfx/manifest.json (clips live at sfx/<name>.opus).
const SAMPLE_BY_EVENT: Record<string, string> = {
  ack: "ui-ack", place: "slab-place", perfect: "perfect-chime", trim: "overhang-trim", miss: "slab-miss",
  win: "stage-win", lose: "round-lose", undo: "drop-undo", hint: "hint-ping", count: "count-tick", go: "count-go",
  achievement: "achievement-chime", lesson: "lesson-complete", pause: "pause-hush",
};
// Which old bus each event's clip played through (the interface ones: the click and the voice cues).
const CLIP_BUS: Record<string, OldBus> = { ack: "voice", count: "voice", go: "voice", achievement: "voice", lesson: "voice" };
const clips = new Map<string, AudioClip>();
let ambienceClip: AudioClip | null = null;
let avRng: RngStream = RNG.derive(1, RNG.STREAM_AV);
let onCaption: ((text: string) => void) | null = null;
let captionsOn = true;

/** Loads every clip at the start (a browser hands them to its mixer at the
 * player's first press); one that fails keeps its synthesized fallback. */
export function loadSfx(): void {
  for (const name of new Set(Object.values(SAMPLE_BY_EVENT))) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
  }
  loadClip("sfx/ambience-skyline.opus").then((c) => { ambienceClip = c; startAmbienceSample(); }, () => { /* keep the pad */ });
}

export function setSeed(seed: number): void { avRng = RNG.derive(seed >>> 0, RNG.STREAM_AV); }
export function setCaptions(on: boolean): void { captionsOn = on; }
export function setOnCaption(cb: (text: string) => void): void { onCaption = cb; }
function caption(text: string): void { if (captionsOn && onCaption && text) onCaption(text); }

function playSample(name: string, bus: OldBus): boolean {
  const clip = clips.get(name);
  if (!clip) return false;
  try { playClip(clip, { bus: BUS[bus], gain: LEVEL[bus] }); return true; }
  catch { clips.delete(name); return false; } // a clip the mixer lost: synthesize from now on
}

// -- synthesized transients -------------------------------------------------------
function out(bus: OldBus, gain: number): GainNode {
  const g = context.createGain();
  g.gain.value = gain * LEVEL[bus];
  g.connect(context.bus(BUS[bus]));
  return g;
}
function blip(bus: OldBus, freq: number, dur: number, type: "sine" | "square" | "sawtooth" | "triangle", gain: number, slide?: number): void {
  try {
    const t = context.currentTime;
    const o = context.createOscillator();
    const g = out(bus, 1);
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, slide), t + dur);
    g.gain.setValueAtTime(gain * LEVEL[bus], t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.02);
    o.onended = () => { g.release(); };
  } catch { /* the graph is full: stay silent */ }
}
function thock(bus: OldBus, dur: number, gain: number, cutoff: number): void {
  try {
    const len = Math.max(1, Math.floor(context.sampleRate * dur));
    const buf = context.createBuffer(1, len, context.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (avRng.next() * 2 - 1) * (1 - i / len);
    buf.copyToChannel(d, 0);
    const src = context.createBufferSource();
    src.buffer = buf;
    const f = context.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = cutoff;
    const g = out(bus, gain);
    src.connect(f).connect(g);
    src.start();
    src.onended = () => { f.release(); g.release(); };
  } catch { /* stay silent */ }
}
function chime(freqs: number[], bus: OldBus, gain: number): void {
  freqs.forEach((fq, i) => { setTimeout(() => blip(bus, fq, 0.35, "sine", gain), i * 70); });
}

// -- event mapping ------------------------------------------------------------------
/** Plays an event's clip (else its synthesized fallback) and emits its caption. */
export function event(name: string, detail?: string | number): void {
  const sample = SAMPLE_BY_EVENT[name];
  const sampled = sample ? playSample(sample, CLIP_BUS[name] ?? "effects") : false;
  switch (name) {
    case "ack":
      if (!sampled) blip("voice", 660 + avRng.next() * 60, 0.06, "triangle", 0.15);
      break;
    case "place":
      if (!sampled) { thock("effects", 0.12, 0.5, 700 + avRng.next() * 300); blip("effects", 180, 0.12, "sine", 0.3, 90); }
      caption("slab placed");
      break;
    case "perfect":
      if (!sampled) { thock("effects", 0.1, 0.4, 900); chime([880, 1174, 1568], "effects", 0.16); }
      caption("perfect placement");
      break;
    case "trim":
      if (!sampled) thock("effects", 0.2, 0.35, 500);
      caption("overhang trimmed");
      break;
    case "miss":
      if (!sampled) blip("effects", 220, 0.4, "sawtooth", 0.2, 60);
      caption("slab missed");
      break;
    case "win":
      if (!sampled) chime([523, 659, 784, 1046, 1318], "music", 0.22);
      caption("stage complete");
      break;
    case "lose":
      if (!sampled) chime([392, 311, 233], "music", 0.2);
      caption("round over");
      break;
    case "undo":
      if (!sampled) blip("effects", 500, 0.12, "sine", 0.2, 750);
      caption("drop undone");
      break;
    case "hint":
      if (!sampled) blip("effects", 1046, 0.15, "sine", 0.14);
      caption("perfect window marked");
      break;
    case "count":
      if (!sampled) blip("voice", 440, 0.12, "square", 0.12);
      caption(String(detail ?? ""));
      break;
    case "go":
      if (!sampled) blip("voice", 880, 0.25, "square", 0.14);
      caption("go");
      break;
    case "achievement":
      if (!sampled) chime([784, 988, 1175], "voice", 0.18);
      caption(`achievement: ${detail ?? ""}`);
      break;
    case "lesson":
      if (!sampled) chime([523, 659, 784], "voice", 0.16);
      caption("lesson complete");
      break;
    case "pause":
      if (!sampled) blip("effects", 300, 0.1, "sine", 0.12, 200);
      break;
  }
}

// -- ambience: a quiet filtered-noise pad, then the authored skyline loop ----------------
let pad: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
let skylineLoop: Sound | null = null;
let started = false;
function startAmbience(): void {
  if (pad) return;
  try {
    const src = context.createBufferSource();
    src.buffer = context.createNoiseBuffer(2, "white");
    src.loop = true;
    const f = context.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 240;
    const g = out("ambience", 0.6 * 0.3);
    src.connect(f).connect(g);
    src.start();
    pad = { src, gain: g };
  } catch (e) { console.warn(`ambience: ${String(e)}`); }
  startAmbienceSample();
}
/** The authored loop fades in over the pad once decoded; if it fails the pad stays. */
function startAmbienceSample(): void {
  if (!started || !ambienceClip || skylineLoop) return;
  try {
    skylineLoop = playClip(ambienceClip, { bus: BUS.ambience, gain: 0, loop: true });
    skylineLoop.fade(0.9 * LEVEL.ambience, 1.5);
    if (pad) pad.gain.gain.linearRampToValueAtTime(0, context.currentTime + 1.5);
  } catch { skylineLoop = null; }
}

// -- adaptive music: a slow pad, voices follow the streak ---------------------------------
const MUS_SCALE = [261.6, 311.1, 392.0, 466.2, 523.3];
let musicIntensity = 0;
let musicStep = 0;
let nextNote = 0;
export function setMusicIntensity(streak: number): void { musicIntensity = Math.max(0, Math.min(4, streak | 0)); }

/** The beds start with the first gesture (the browser build's audio unlock). */
export function unlock(): void {
  if (started) return;
  started = true;
  startAmbience();
}

/** Each frame: the pad's next notes every 1.4 s of mixer time. */
export function update(): void {
  if (!started || context.state !== "running") return;
  const now = context.currentTime;
  if (now < nextNote) return;
  nextNote = now + 1.4;
  const n = 1 + Math.min(3, musicIntensity);
  for (let i = 0; i < n; i++) {
    blip("music", MUS_SCALE[(musicStep + i * 2) % MUS_SCALE.length]!, 1.6, "sine", 0.05 + 0.02 * musicIntensity);
  }
  musicStep++;
}
