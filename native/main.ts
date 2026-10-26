// Balance Spire on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules, content and round runner are the
// browser build's unchanged js/*.js (classic.ts); this module is what
// js/ui.js and js/bootstrap.js did around them — the screen flow (title →
// mode select → setup → countdown → play ↔ paused → results, with settings,
// help and the board), input routing (actions, playfield taps), the HUD
// state, announcements and captions, results and progression, lifecycle —
// with the screens drawn by screens.ts (starhermit:ui) and the spire by
// render.ts (starhermit:scene).
//
// The round clock is the runtime's fixed steps (60 a second, the rules' tick
// rate): ticks advance only while the round is active and the game runs, so
// pausing, a hidden window and a slow frame never move the slab.
import { frame, onFixedUpdate, onQuit, onRender, onResume, onStart, onSuspend, onUpdate, onPreferencesChange, preferences, setFixedRate } from "starhermit:engine";
import { bindingLabel, onAction, onPointerButton, onTouch, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onPlayerChange, onSessionEnded } from "starhermit:platform";
import { Content, RNG, Rules, Session, type Cfg, type Lesson, type Results, type Round, type RulesEvent, type State } from "./classic.ts";
import * as audio from "./audio.ts";
import { t } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens, loadBackdrop } from "./screens.ts";
import { initStyles } from "./style.ts";

export type ScreenName = "title" | "mode-select" | "setup" | "paused" | "results" | "settings" | "help" | "board";
export interface SetupItem { cfg: Cfg; lesson?: Lesson | null; unlocked: boolean; label: string; right: string; current?: boolean }
export interface LbLine { pending?: boolean; posted?: boolean; rank?: number | null }

export const app = {
  /** The open screen; null while playing (the HUD and tray show). */
  screen: "title" as ScreenName | null,
  stack: [] as ScreenName[],
  /** Frame the screen opened on (the action that opened it must not also close it). */
  openedFrame: 0,
  setupMode: "" as string,
  setupItems: [] as SetupItem[],
  setupPage: 0,
  pendingSetup: null as { mode: string; cfg: Cfg } | null,
  results: null as (Results & { localRank: { rank: number; total: number } | null; lb: LbLine | null }) | null,
  boardDate: "",
  toast: null as { text: string; until: number } | null,
  caption: null as { text: string; until: number } | null,
  countdown: "" as string,
  hintFlashUntil: 0,
  signedOut: false,
  focusNext: null as string | null,
};
export const SETUP_PAGE_SIZE = 8;

// ------------------------------------------------------------------ the clock
let steps = 0;
let interp = 0;
Session.setClock(() => (steps * 1000) / 60);
/** The round's tick as a float (the fixed steps plus the frame's interpolation), for drawing. */
function tickFloat(round: Round): number {
  const wallBase = (round as unknown as { wallBase: number }).wallBase;
  return Math.max(round.state.tick, (((steps + interp) * 1000) / 60 - wallBase) * 60 / 1000);
}
const now = (): number => frame().time * 1000;

// ------------------------------------------------------------------ helpers
export function stageName(cfg: Cfg | null | undefined): string {
  if (!cfg) return "";
  if (cfg.kind === "journey") return t("j." + cfg.id, null, cfg.name);
  if (cfg.kind === "challenge") return t("ch." + cfg.id, null, cfg.name);
  if (cfg.kind === "practice") return t("pr." + cfg.id, null, cfg.name);
  if (cfg.kind === "score") return t("score.name", null, cfg.name);
  if (cfg.kind === "daily") return t("daily.name", { date: cfg.date ?? "" }, cfg.name);
  return cfg.name || "";
}
function stageIntro(cfg: Cfg): string {
  if (!cfg.intro) return "";
  if (cfg.kind === "journey") return t("ji." + cfg.id, null, cfg.intro);
  if (cfg.kind === "challenge") return t("chi." + cfg.id, null, cfg.intro);
  if (cfg.kind === "score") return t("score.intro", null, cfg.intro);
  if (cfg.kind === "daily") return t("daily.intro", null, cfg.intro);
  return cfg.intro;
}
export const lessonTitle = (l: Lesson | null | undefined): string => (l ? t("lt." + l.id, null, l.title) : "");
export const lessonText = (l: Lesson | null | undefined): string => (l ? t("lx." + l.id, null, l.text) : "");
export function achievementName(key: string): string {
  const def = Content.ACHIEVEMENTS.find((a) => a.key === key);
  return def ? t("ach." + key, null, def.name) : key;
}
export const terminalText = (reason: string): string => t("why." + reason, null, reason);
export const today = (): string => Content.utcDateString(Date.now());
export const journeyDone = (): number => Object.keys(Session.progress.journeyStars).filter((k) => (Session.progress.journeyStars[k] ?? 0) > 0).length;

/** A key name as the browser build's tray hints and Keyboard card showed it. */
export function keyName(action: string): string {
  const raw = bindingLabel(action, "keyboard");
  if (!raw) return "";
  const named: Record<string, string> = { Space: t("key.Space"), " ": t("key.Space"), Escape: "Esc", NumpadEnter: "Num Enter", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };
  // Natively the label is the code ("KeyD"), in browsers the key ("d"): one form.
  const first = raw.split(/\s*[,/]\s*|\s+or\s+/)[0]!;
  const n = named[first] ?? first.replace(/^Key/, "").replace(/^Digit/, "");
  return n.length === 1 ? n.toUpperCase() : n;
}

export function announce(msg: string, assertive = false): void {
  if (msg) ui.announce(msg, { politeness: assertive ? "assertive" : "polite" });
}
export function toast(text: string): void { app.toast = { text, until: now() + 2600 }; }
function showCaption(text: string): void {
  if (!Session.settings.captions || !text) return;
  const m = /^achievement: (.*)$/.exec(text);
  app.caption = { text: m ? t("cap.achievement", { name: m[1]! }) : t("cap." + text, null, text), until: now() + 1800 };
}
function haptic(ms: number): void { if (Session.settings.haptics) vibrate(ms); }

// ------------------------------------------------------------------ screens
export function showScreen(name: ScreenName | null, push = true): void {
  if (push && app.screen && app.screen !== name) app.stack.push(app.screen);
  app.screen = name;
  app.openedFrame = frame().frame;
  app.focusNext = name ? "first" : null;
  if (!name) ui.setFocus(null);
}
export function back(): void {
  const prev = app.stack.pop() ?? "title";
  app.screen = prev;
  app.openedFrame = frame().frame;
  app.focusNext = "first";
}

export function openModes(): void { audio.unlock(); showScreen("mode-select"); }
export function openHelp(): void { showScreen("help"); }
export function openSettings(): void { showScreen("settings"); }
export function openBoards(): void { app.boardDate = today(); showScreen("board"); }

export function openSetup(mode: string): void {
  audio.unlock();
  app.setupMode = mode;
  fillSetup(mode, true);
  showScreen("setup");
}
/** The setup screen's items for a mode; `fresh` also picks the starting page. */
export function fillSetup(mode: string, fresh = false): void {
  app.pendingSetup = null;
  let list: SetupItem[] = [];
  const p = Session.progress;
  if (mode === "journey") {
    list = Content.JOURNEY.map((cfg, i) => {
      const unlocked = i === 0 || (p.journeyStars[Content.JOURNEY[i - 1]!.id] ?? 0) > 0;
      const stars = p.journeyStars[cfg.id] ?? 0;
      return { cfg, unlocked, label: `${i + 1}. ${stageName(cfg)}`, right: "★".repeat(stars) + "☆".repeat(3 - stars), current: unlocked && !stars };
    });
  } else if (mode === "daily") {
    app.pendingSetup = { mode: "daily", cfg: Content.dailyConfig(today()) };
  } else if (mode === "practice") {
    list = Content.PRACTICE.map((cfg) => ({ cfg, unlocked: true, label: stageName(cfg), right: cfg.endless ? t("setup.endless") : t("setup.goal", { n: cfg.goalHeight }) }));
  } else if (mode === "challenge") {
    list = Content.CHALLENGES.map((cfg) => ({
      cfg, unlocked: true, label: stageName(cfg),
      right: (cfg.dropLimit ? t("setup.drops", { n: cfg.dropLimit }) + " " : "") + (cfg.timeLimitSec ? t("setup.secs", { n: cfg.timeLimitSec }) : ""),
    }));
  } else if (mode === "score") {
    app.pendingSetup = { mode: "score", cfg: Content.SCORE_CHASE };
  } else if (mode === "learn") {
    list = Content.tutorialLessons().map((lesson) => ({ cfg: lesson.cfg, lesson, unlocked: true, label: lessonTitle(lesson), right: "" }));
  }
  app.setupItems = list;
  if (fresh) {
    const cur = list.findIndex((item) => item.current);
    app.setupPage = cur > 0 ? Math.floor(cur / SETUP_PAGE_SIZE) : 0;
  }
}
export function setupHeading(mode: string): string {
  return ({ journey: t("journey"), daily: t("daily"), practice: t("mode.practice"), challenge: t("mode.challenge"), score: t("mode.score"), learn: t("learn") } as Record<string, string>)[mode] ?? t("setup.title");
}
export function setupInfo(mode: string): string {
  if (mode === "daily") {
    const cfg = app.pendingSetup?.cfg ?? Content.dailyConfig(today());
    return t("setup.daily", {
      seed: cfg.seed, goal: cfg.goalHeight, date: cfg.date ?? today(),
      drops: cfg.dropLimit ? t("setup.dailyDrops", { n: cfg.dropLimit }) : "",
      clock: cfg.timeLimitSec ? t("setup.dailyClock", { n: cfg.timeLimitSec }) : "",
    });
  }
  return t("setup." + mode);
}

function themeFor(cfg: Cfg): { palette: Record<string, number> } {
  return Content.THEMES.find((th) => th.id === (cfg.theme || "dawn")) ?? Content.THEMES[0]!;
}

export function commitStart(setup: { mode: string; cfg: Cfg; lesson?: Lesson | null }): void {
  audio.unlock();
  audio.setSeed(setup.cfg.seed);
  Session.startRound(setup.cfg, { mode: setup.mode, lesson: setup.lesson ?? null });
  render.setTheme(themeFor(setup.cfg).palette, RNG.derive(setup.cfg.seed, RNG.STREAM_DECOR));
  Session.startCountdown();
  app.stack = [];
  showScreen(null, false);
  app.results = null;
  app.countdown = "";
  if (setup.lesson || setup.cfg.intro) announce(setup.lesson ? lessonText(setup.lesson) : stageIntro(setup.cfg), true);
  if (setup.lesson) toast(lessonTitle(setup.lesson) + " — " + lessonText(setup.lesson));
  else if (setup.cfg.intro) toast(stageIntro(setup.cfg));
}

export function nextJourneyLevel(): Cfg | null {
  const r = Session.round;
  if (!r || r.mode !== "journey") return null;
  const idx = Content.JOURNEY.findIndex((c) => c.id === r.cfg.id);
  return idx >= 0 && idx < Content.JOURNEY.length - 1 ? Content.JOURNEY[idx + 1]! : null;
}

export function restartRound(): void {
  const r = Session.round;
  if (!r) return;
  Session.restart();
  render.setTheme(themeFor(r.cfg).palette, RNG.derive(r.cfg.seed, RNG.STREAM_DECOR));
  Session.startCountdown();
  app.stack = [];
  app.results = null;
  app.countdown = "";
  showScreen(null, false);
}
export function leaveRound(): void { Session.resign(); /* the results screen opens via onResults */ }
export function replayTutorial(): void {
  Session.progress.tutorialDone = false;
  Session.saveProgress();
  openSetup("learn");
}

// ------------------------------------------------------------------ play
let holdTimer: ReturnType<typeof setTimeout> | null = null;
export function doDrop(): void {
  const r = Session.round;
  if (!r || r.phase !== "active") return;
  audio.unlock();
  if (Session.settings.holdToDrop) {
    if (holdTimer) return;
    holdTimer = setTimeout(() => { holdTimer = null; Session.drop(); audio.event("ack"); }, 180);
    return;
  }
  Session.drop();
  audio.event("ack");
}
export function doHint(): void {
  const h = Session.hint();
  if (!h) return;
  audio.event("hint");
  app.hintFlashUntil = now() + 1600;
  announce(t("an.hint"));
}
export function doUndo(): void { if (Session.undo()) audio.event("undo"); }
export function canHint(): boolean { return !!Session.round?.cfg.mechanics.hint; }
export function canUndo(): boolean { return !!Session.round?.cfg.mechanics.undo && !Session.isRanked(); }

export function pauseGame(): void {
  const r = Session.round;
  if (!r || r.phase !== "active") return;
  Session.pause();
  audio.event("pause");
  showScreen("paused", false);
  app.stack = [];
}
export function resumeGame(): void {
  Session.resume();
  app.stack = [];
  showScreen(null, false);
}
function refocusCamera(): void {
  const r = Session.round;
  if (!r) return;
  render.syncState(r.state, 0);
  announce(t("an.camera"));
}

/** Perfect-window band: the timing-assist setting shows it where the ruleset allows hints; a hint flashes it. */
function updateAssist(): void {
  const r = Session.round;
  render.setHintVisible(!!(r && r.phase === "active" && !r.state.terminal && r.cfg.mechanics.hint &&
    (Session.settings.timingAssist || now() < app.hintFlashUntil)));
}

/** The concise board model the browser build's screen-reader mirror held. */
function mirror(state: State): string {
  const top = Rules.topSlab(state);
  return t("mirror", {
    h: Rules.height(state), goal: state.cfg.goalHeight || t("mirror.unlimited"),
    axis: state.pending.axis.toUpperCase(), w: (Math.max(top.w, top.d) / 1000).toFixed(1), score: state.score.total,
  });
}

// ------------------------------------------------------------------ session events
Session.on("phase", (phase) => {
  if (phase === "active") {
    app.countdown = "";
    audio.event("go");
    announce(t("an.go"));
  }
});
Session.on("countdown", (left) => {
  const n = left as number;
  app.countdown = n > 0 ? String(n) : t("count.go");
  audio.event("count", n);
});
Session.on("state", (s, evs) => {
  const state = s as State;
  const events = evs as RulesEvent[];
  render.syncState(state, 0);
  render.playEvents(events);
  audio.setMusicIntensity(state.streak);
  let polite = "";
  for (const e of events) {
    if (e.type === "place") {
      audio.event(e.perfect ? "perfect" : "place");
      haptic(e.perfect ? 30 : 12);
      polite = e.perfect ? t("an.perfect", { n: state.streak }) : t("an.placed", { n: Rules.height(state) });
    } else if (e.type === "trim") {
      audio.event("trim");
    } else if (e.type === "miss") {
      audio.event("miss");
      announce(t("an.missed") + ((e.livesLeft ?? 0) > 0 ? t("an.spare", { n: e.livesLeft! }) : ""), true);
      haptic(60);
    } else if (e.type === "undo") {
      polite = t("an.undone");
    }
  }
  if (!state.terminal) announce([polite, mirror(state)].filter(Boolean).join(" "));
});
Session.on("invalid", (reason) => {
  announce(t("invalid", { reason: t("reason." + String(reason), null, String(reason)) }));
  audio.event("ack");
});
Session.on("lesson-done", (lesson) => {
  const l = lesson as Lesson;
  toast(t("toast.lesson", { name: lessonTitle(l) }));
  announce(t("an.lesson", { name: lessonTitle(l) }));
  audio.event("lesson");
  Session.progress.tutorialDone = true;
  Session.saveProgress();
});
Session.on("achievement", (key) => {
  const k = String(key);
  if (!Content.ACHIEVEMENTS.some((a) => a.key === k)) return;
  toast(t("toast.achievement", { name: achievementName(k) }));
  audio.event("achievement", achievementName(k));
});
Session.on("results", (res) => {
  const r = res as Results;
  const s = r.state;
  app.results = { ...r, localRank: null, lb: null };
  audio.event(r.won ? "win" : "lose");
  render.setHintVisible(false);
  const headline = resultsHeadline();
  announce(headline + t("an.total", { n: s.score.total }), true);
  app.stack = [];
  showScreen("results", false);
  if (Session.isRanked()) {
    app.results.localRank = platform.recordRanked(Session.round!.mode, r.replay);
    // Signed in, the total also goes to the StarHermit high-score board.
    if (platform.signedIn()) {
      const mine = app.results;
      mine.lb = { pending: true };
      void platform.postLeaderboard(s.score.total).then((lb) => { mine.lb = lb; });
    }
  }
});
export function resultsHeadline(): string {
  const r = app.results;
  if (!r) return "";
  const s = r.state;
  return (r.won ? t("res.stands") : t("res.fell", { why: terminalText(s.terminal?.reason ?? "") })) +
    t("res.height", { h: Rules.height(s) + (s.cfg.goalHeight ? " / " + s.cfg.goalHeight : "") }) +
    (r.stars ? " · " + "★".repeat(r.stars) : "");
}
audio.setOnCaption(showCaption);

// ------------------------------------------------------------------ input
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  const r = Session.round;
  const active = !!r && r.phase === "active";
  const paused = !!r && r.phase === "paused";
  switch (e.action) {
    case "drop":
      // Only while playing with no screen open, so it never fires from a focused menu button.
      if (active && !app.screen) { if (ui.focused()) ui.setFocus(null); doDrop(); }
      break;
    case "pause":
      if (active) pauseGame();
      else if (paused && frame().frame !== app.openedFrame) resumeGame();
      break;
    case "back":
      if (frame().frame === app.openedFrame) break;
      if (active) pauseGame();
      else if (paused && app.screen === "paused") resumeGame();
      else if (app.screen === "settings" || app.screen === "help" || app.screen === "board" || app.screen === "setup" || app.screen === "mode-select") back();
      break;
    case "undo":
      if (active) doUndo();
      break;
    case "hint":
      if (active) doHint();
      break;
    case "camera":
      refocusCamera();
      break;
  }
});

// Playfield taps drop the slab (a tap: under 500 ms and 24 px of travel; a
// drag is not one). Touch and the mouse can both report one tap: a pointer
// press right after a touch is skipped.
let down: { at: number; x: number; y: number } | null = null;
let lastTouch = -1e9;
function playfieldDown(x: number, y: number): void {
  down = !app.screen && !ui.pointerOver() ? { at: now(), x, y } : null;
}
function playfieldUp(x: number, y: number): void {
  const d = down;
  down = null;
  if (!d || app.screen) return;
  const f = frame();
  if (now() - d.at < 500 && Math.hypot(x - d.x, y - d.y) < 24 * f.scale) doDrop();
}
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 600) return;
  if (e.pressed) playfieldDown(e.x, e.y); else playfieldUp(e.x, e.y);
});
onTouch((e) => {
  if (!e.primary) return;
  lastTouch = now();
  if (e.phase === "start") playfieldDown(e.x, e.y);
  else if (e.phase === "end") playfieldUp(e.x, e.y);
  else if (e.phase === "cancel") down = null;
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const key = `${f.quality}:${f.levelIndex}`;
  if (key === lookKey) return;
  lookKey = key;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  audio.setCaptions(Session.settings.captions);
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  render.setTheme(Content.THEMES[0]!.palette, null);
  loadBackdrop();
  // Resume an interrupted round (the last safe snapshot), paused.
  const resumed = Session.loadSnapshot();
  if (resumed) {
    render.setTheme(themeFor(resumed.cfg).palette, RNG.derive(resumed.cfg.seed, RNG.STREAM_DECOR));
    render.syncState(resumed.state, 0);
    toast(t("toast.restored"));
    showScreen("paused", false);
  } else showScreen("title", false);
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onSettingsChange(() => audio.setCaptions(Session.settings.captions));
platform.onProgressMerged(() => { if (app.screen === "setup") fillSetup(app.setupMode); });
onSessionEnded(() => { app.signedOut = true; toast(t("acct.signedOut")); });
onPlayerChange((p) => { if (p) app.signedOut = false; });
onSuspend(() => {
  // Backgrounding pauses the round and keeps a snapshot.
  if (Session.round?.phase === "active") pauseGame();
  Session.saveSnapshot();
  platform.flush();
});
onResume(() => { /* stays paused; Resume continues */ });
onQuit(() => { Session.saveSnapshot(); });

onFixedUpdate(() => {
  steps++;
  Session.update(); // countdown + time-limit watchdog
});
let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  audio.update();
  const t0 = now();
  if (app.toast && t0 > app.toast.until) app.toast = null;
  if (app.caption && t0 > app.caption.until) app.caption = null;
});
onRender((alpha) => {
  interp = alpha;
  const r = Session.round;
  if (r && r.state) {
    const a = r.phase === "active" ? Math.max(0, tickFloat(r) - r.state.tick) : 0;
    render.syncState(r.state, a);
  } else render.clearRound();
  updateAssist();
  render.frame(frameDt);
  drawScreens();
});
