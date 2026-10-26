// The browser build's pure game scripts, unchanged and shared with the Node
// tests: rng, rules, content and session (js/*.js, UMD) plus the string
// tables (js/i18n.js), evaluated as classic scripts so their globals
// (BSRNG, BSRules, BSContent, BSSession, BSI18n), and the browser build's
// account data as it migrates (js/migrate.js, BSMigrate), are this module's
// exports.
//
// js/session.js keeps its documents in `localStorage` (settings, progress,
// the crash-safe round snapshot): here that is a small shim over the
// device's starhermit:storage, installed before the script runs. Progress
// is also the game's save (platform.ts), which is the authority; the
// device copy is its cache, as in the browser build.
import { storage } from "starhermit:storage";
import { loadClassic } from "starhermit:script";

const shim = {
  getItem(key: string): string | null {
    try { return storage.getText(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    try { storage.set(key, String(value)); } catch (e) { console.warn(`storage ${key}: ${String(e)}`); }
  },
  removeItem(key: string): void {
    try { storage.remove(key); } catch { /* gone */ }
  },
};
(globalThis as unknown as { localStorage: typeof shim }).localStorage = shim;

for (const f of ["js/rng.js", "js/rules.js", "js/content.js", "js/i18n.js", "js/session.js", "js/migrate.js"]) loadClassic(f);

// -- The shapes this client reads -------------------------------------------------
export interface Slab { x: number; z: number; w: number; d: number; perfect?: boolean }
export interface Pending { axis: "x" | "z"; phase: number; spawnTick: number }
export interface Score {
  heightPoints: number; perfectPoints: number; streakPoints: number;
  goalBonus: number; dropBonus: number; timeBonus: number; total: number;
}
export interface Cfg {
  id: string; kind: string; name: string; seed: number; date?: string;
  base: { w: number; d: number }; speed: number; speedRamp: number;
  goalHeight: number; eps: number; dropLimit: number; timeLimitSec: number;
  par: { drops: number; timeSec: number } | null; lives: number;
  mechanics: { undo: boolean; hint: boolean }; endless: boolean;
  theme?: string; intro?: string; mastery?: boolean; index?: number;
}
export interface State {
  cfg: Cfg; tick: number; slabs: Slab[]; pending: Pending; streak: number; bestStreak: number;
  perfects: number; placed: number; drops: number; misses: number; livesLeft: number;
  score: Score; terminal: { reason: string; won: boolean } | null;
}
export interface RulesEvent {
  type: string; perfect?: boolean; streak?: number; livesLeft?: number;
  axis?: "x" | "z"; side?: number; size?: number; center?: number; level?: number;
}
export interface Lesson { id: string; title: string; text: string; goal: { event: string; count: number }; cfg: Cfg }
export interface Round {
  cfg: Cfg; mode: string; lesson: Lesson | null; state: State;
  phase: "countdown" | "active" | "paused" | "ended";
  countdownLeft: number; lessonDone: boolean; log: unknown[];
}
export interface Results { state: State; stars: number; won: boolean; achievements: string[]; replay: Envelope }
export interface Envelope {
  cfgId: string; date: string | null; seed: number; contentVersion: number; commands: unknown[];
  result: { score: Score; drops: number; durationSec: number; won: boolean; reason: string };
}
export interface Progress {
  v: 1; stars: number; journeyStars: Record<string, number>; tutorialDone: boolean;
  dailies: Record<string, number>; bestScore: number; bestHeight: number; perfectsTotal: number;
  achievements: Record<string, number>; themeUnlocksSeen: string[];
}
export interface GameSettings {
  captions: boolean; leftHanded: boolean; holdToDrop: boolean; timingAssist: boolean; haptics: boolean;
  [key: string]: unknown;
}
export interface Theme { id: string; name: string; palette: Record<string, number> }
export interface RngStream { next(): number; int(n: number): number }

interface RulesApi {
  TICKS_PER_SEC: number; MU: number;
  height(s: State): number;
  topSlab(s: State): Slab;
  hint(s: State): { window: { startTick: number; endTick: number }; axis: string } | null;
  slabPosAt(cfg: Cfg, pending: Pending, level: number, tick: number): number;
  perfectWindow(cfg: Cfg, pending: Pending, level: number, fromTick: number): { startTick: number; endTick: number } | null;
}
interface ContentApi {
  THEMES: Theme[]; JOURNEY: Cfg[]; CHALLENGES: Cfg[]; PRACTICE: Cfg[]; SCORE_CHASE: Cfg;
  ACHIEVEMENTS: { key: string; name: string; desc: string }[];
  dailyConfig(date: string): Cfg;
  utcDateString(nowMs?: number): string;
  tutorialLessons(): Lesson[];
}
type Listener = (a?: unknown, b?: unknown) => void;
interface SessionApi {
  on(evt: string, cb: Listener): void;
  readonly settings: GameSettings;
  saveSettings(): void;
  readonly progress: Progress;
  saveProgress(): void;
  mergeProgress(a: unknown, b: unknown): Progress;
  adoptProgress(p: unknown): boolean;
  DEFAULT_SETTINGS: GameSettings;
  setClock(fn: () => number): void;
  readonly round: Round | null;
  startRound(cfg: Cfg, opts: { mode: string; lesson?: Lesson | null }): Round;
  startCountdown(): void;
  tickNow(): number;
  update(): void;
  drop(): unknown;
  undo(): boolean;
  hint(): { window: { startTick: number; endTick: number } } | null;
  pause(): void;
  resume(): void;
  resign(): void;
  restart(): Round | null;
  isRanked(): boolean;
  saveSnapshot(): void;
  loadSnapshot(): Round | null;
}
interface RngApi { derive(seed: number, stream: number): RngStream; STREAM_DECOR: number; STREAM_AV: number }
interface I18nApi {
  t(key: string, vars?: Record<string, string | number> | null, fallback?: string): string;
  setLocale(tag: string): void;
  LOCALES: string[];
  readonly lang: string;
}

interface MigrateApi {
  GAME_SETTING_KEYS: string[];
  BROWSER_SETTING_KEYS: string[];
  progressFromSave(doc: unknown): Progress | null;
  progressFromBrowserSave(text: string | null): Progress | null;
  saveDoc(progress: Progress): { v: 1; progress: Progress };
  migrateSetting(key: string, value: unknown): boolean | undefined;
}

const g = globalThis as unknown as { BSRules: RulesApi; BSContent: ContentApi; BSSession: SessionApi; BSRNG: RngApi; BSI18n: I18nApi; BSMigrate: MigrateApi };
export const Rules = g.BSRules;
export const Content = g.BSContent;
export const Session = g.BSSession;
export const RNG = g.BSRNG;
export const I18n = g.BSI18n;
export const Migrate = g.BSMigrate;
