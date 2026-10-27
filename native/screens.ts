// The browser build's DOM shell (index.html + css/style.css) as starhermit:ui,
// built every frame: the HUD (objective and stage, Height / Score / Streak and
// the ruleset's Drops left / Time / Spare slabs), the action tray (Drop, Hint,
// Undo, Pause with their keys), the countdown numeral, the caption strip and
// the toast over the spire, and the full-window screens (title over its key
// art, mode cards, setup with its paged stage list, pause, results with the
// score table, settings, help, the device board). The browser's media
// queries are the layouts picked by the window's logical size: wide, phone
// (≤ 640 px: the HUD stacked, the tray edge to edge with equal buttons and no
// key hints) and short landscape (≤ 480 px tall: the tray a column at the
// right).
import { frame, openMenu, clipboard } from "starhermit:engine";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { requestSignIn } from "starhermit:platform";
import { TextureLoader, type Texture } from "starhermit:scene";
import { Rules, Session, type Cfg } from "./classic.ts";
import { t } from "./i18n.ts";
import * as platform from "./platform.ts";
import {
  SETUP_PAGE_MAX, achievementName, app, back, canHint, canUndo, commitStart, doDrop, doHint, doUndo, fillSetup,
  journeyDone, keyName, leaveRound, lessonTitle, nextJourneyLevel, openBoards, openHelp, openModes, openSettings,
  openSetup, pauseGame, replayTutorial, restartRound, resultsHeadline, resumeGame, setupHeading, setupInfo, showScreen,
  stageName, toast, today, type ScreenName,
} from "./main.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; narrow: boolean; shortLand: boolean; wide: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const shortLand = lw > lh && lh <= 480;
  return { lw, lh, sc, narrow: lw <= 640 && !shortLand, shortLand, wide: lw >= 1024 };
}

const lastHeight = new Map<string, number>();
const cw = (L: Layout, max: number): number => Math.max(120, Math.min(max, L.lw - 32));

/** Logical width of a styled button's face (padding included). */
function buttonWidth(text: string, style: readonly string[]): number {
  return ui.measureText(text, { kind: "button", style: [...style] }).width / ui.preferences().scale + 2;
}
function labelWidth(text: string, style: string): number {
  return ui.measureText(text, { style }).width / ui.preferences().scale;
}

interface Btn { id: string; text: string; style?: string[]; disabled?: boolean; act: () => void }
const PLAIN = ["btn"];

/** A button `width` wide (null: its text's); a label too long for it wraps inside. */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? PLAIN;
  const opts: ui.ButtonOptions = b.disabled ? { disabled: true } : {};
  const s: ui.Style = width != null ? { width } : {};
  if (width != null && buttonWidth(b.text, style) > width) {
    const inner = width - 36;
    const bold = style.includes("btn-primary");
    opts.content = () => { ui.paragraph(b.text, inner, bold ? { weight: "600" } : {}); };
  }
  if (ui.style(...style, s).id(b.id).button(b.text, opts)) b.act();
}
/** Buttons at their own widths in rows that wrap at `width` and centre (CSS flex-wrap). */
function flow(label: string, list: Btn[], width: number, gap = 8): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, buttonWidth(b.text, b.style ?? PLAIN));
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, buttonWidth(b.text, b.style ?? PLAIN) > width ? width : null);
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, align: "center" });
}
/** Labels as pills in rows that wrap (the results' achievement badges). */
function pills(label: string, texts: string[], width: number, style: string): void {
  const rows: string[][] = [[]];
  let used = 0;
  for (const tx of texts) {
    const w = labelWidth(tx, style) + 30;
    if (rows[rows.length - 1]!.length && used + 8 + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? 8 : 0) + w;
    rows[rows.length - 1]!.push(tx);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => { for (const tx of row) ui.style(style).label(tx); }, { spacing: 8 }));
  }, { spacing: 8, align: "center" });
}
/** Text up to `width` wide: one label when it fits (a column centres it),
 * else a paragraph, centred with `center` (the browser's text-align). */
function para(text: string, width: number, cls?: string, id?: string, center = false): void {
  if (!text) return;
  const styles: (string | ui.Style)[] = cls ? [cls] : [];
  if (center) styles.push({ text: { align: "center" } });
  let u = ui.style(...styles);
  if (id) u = u.id(id);
  if (ui.measureText(text, { style: styles }).width / ui.preferences().scale <= width) u.label(text);
  else u.paragraph(text, width);
}

/** A full-window screen (the browser's `.screen`): its content centred, and
 * scrolling from the top when taller than the window. */
function screen(key: string, cls: string, L: Layout, build: (width: number) => void, width = cw(L, 760), spacing = 16): void {
  const avail = L.lh - 32;
  const h = lastHeight.get(key) ?? 0;
  ui.place(`scr-${key}`, "top-start", () => {
    const body = (): void => {
      const r = ui.column(`${key}-body`, () => build(width), { width, align: "center", spacing });
      lastHeight.set(key, r.height / L.sc);
    };
    if (h > avail) ui.scrollArea(`${key}-scroll`, { width: Math.min(L.lw - 16, width + 16), height: avail }, body);
    else ui.column(`${key}-center`, body, { height: avail, justify: "center", align: "center" });
  }, { style: cls, width: L.lw, height: L.lh, align: "center" });
}

// ------------------------------------------------------------------ the title's key art
let backdrop: Texture | null = null;
export function loadBackdrop(): void {
  new TextureLoader().loadAsync("assets/title-backdrop.webp").then((tex) => { backdrop = tex; }, () => { /* the scrim alone */ });
}
const SCRIM: ui.Style = { background: { type: "linear", angle: 180, stops: ["#0a0812", "#0a0812"] } };
function drawBackdrop(): void {
  const f = frame();
  if (backdrop && backdrop.width > 0) {
    // background-size: cover, background-position: center bottom
    const k = Math.max(f.width / backdrop.width, f.height / backdrop.height);
    const w = backdrop.width * k, h = backdrop.height * k;
    draw.image(backdrop, (f.width - w) / 2, f.height - h, w, h);
    draw.box(0, 0, f.width, f.height, { background: { type: "linear", angle: 180, stops: ["#0a08128c", "#0a0812cc"] } });
  } else draw.box(0, 0, f.width, f.height, SCRIM);
}

// ------------------------------------------------------------------ the frame
// The first control of each screen, by label: ui.setFocus takes the widget's
// label (an ui.id() name does not match; engine 1.17.0).
function firstLabel(name: ScreenName): string | null {
  switch (name) {
    case "title": return t("play");
    case "mode-select": return t("mode.journey");
    case "setup": {
      const page = app.setupItems.slice(app.setupPage * app.setupPageSize, (app.setupPage + 1) * app.setupPageSize);
      const item = page.find((it) => it.current && it.unlocked) ?? page.find((it) => it.unlocked);
      return item ? item.label : app.pendingSetup ? t("start") : t("back");
    }
    case "paused": return t("resume");
    case "results": return t("retry");
    case "settings": return t("set.captions");
    case "help": case "board": return t("back");
  }
}

export function drawScreens(): void {
  const L = layoutNow();
  const r = Session.round;
  // A screen that just opened focuses its first control once its layout has
  // settled (a tall screen moves into its scroll area on its second frame).
  if (app.focusNext && app.screen && frame().frame - app.openedFrame >= 2) {
    const first = firstLabel(app.screen);
    if (first) ui.setFocus(first);
    app.focusNext = null;
  }
  if (app.screen === "title") drawBackdrop();
  const inRound = !!r && r.phase !== "ended";
  if (inRound && (!app.screen || r.phase === "paused")) hud(L);
  if (inRound && !app.screen) {
    tray(L);
    if (r.phase === "countdown") {
      const n = app.countdown || String(r.countdownLeft);
      ui.place("countdown", "center", () => { ui.style("countdown", L.narrow || L.shortLand ? "countdown-compact" : null).label(n); });
    }
    if (app.caption) {
      const y = L.shortLand ? 12 : L.narrow ? 92 : 76;
      ui.place("caption", { anchor: L.shortLand ? "bottom-start" : "bottom", x: L.shortLand ? 8 : 0, y }, () => {
        para(app.caption!.text, Math.min(L.lw * 0.8, 520), "caption", "caption-text");
      });
    }
  }
  if (app.toast) {
    ui.place("toast", { anchor: "top", x: 0, y: inRound && !app.screen ? (L.narrow ? 120 : 76) : 12 }, () => {
      const w = Math.min(34 * 16, L.lw * 0.92);
      if (labelWidth(app.toast!.text, "toast") + 40 <= w) ui.style("toast").label(app.toast!.text);
      else ui.style("toast").paragraph(app.toast!.text, w - 40);
    });
  }
  switch (app.screen) {
    case "title": titleScreen(L); break;
    case "mode-select": modesScreen(L); break;
    case "setup": setupScreen(L); break;
    case "paused": pauseScreen(L); break;
    case "results": resultsScreen(L); break;
    case "settings": settingsScreen(L); break;
    case "help": helpScreen(L); break;
    case "board": boardScreen(L); break;
    default: break;
  }
}

// ------------------------------------------------------------------ HUD
function hud(L: Layout): void {
  const r = Session.round!;
  const s = r.state, cfg = r.cfg;
  const stats: [string, string, string][] = [["hud-height", t("hud.height"), String(Rules.height(s))], ["hud-score", t("hud.score"), String(s.score.total)], ["hud-streak", t("hud.streak"), String(s.streak)]];
  if (cfg.dropLimit) stats.push(["hud-drops", t("hud.drops"), String(Math.max(0, cfg.dropLimit - s.drops))]);
  if (cfg.timeLimitSec) {
    const left = Math.max(0, cfg.timeLimitSec - Math.floor(Session.tickNow() / 60));
    stats.push(["hud-time", t("hud.time"), `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`]);
  }
  if (cfg.lives > 1) stats.push(["hud-lives", t("hud.lives"), String(s.livesLeft)]);
  const objective = cfg.endless ? t("hud.endless") : t("hud.goal", { n: cfg.goalHeight });
  const progress = r.lesson ? lessonTitle(r.lesson) : stageName(cfg);
  const margin = L.wide ? 16 : 8;
  const width = L.lw - margin * 2;
  // The stats' natural width decides whether the two boxes share a row (the browser's ≤ 640 px stacking).
  const statW = stats.reduce((n, [, label, v]) => n + Math.max(51, labelWidth(label, "hud-label"), labelWidth(v, "hud-value")) + 16, 8);
  const leftW = Math.max(labelWidth(objective, "hud-objective"), labelWidth(progress, "hud-progress")) + 30;
  const stacked = L.narrow || leftW + statW + 16 > width;
  const statsBox = (w: number | null): void => {
    ui.row("hud-right", () => {
      for (const [id, label, v] of stats) {
        ui.column(id, () => { ui.style("hud-label").label(label); ui.style("hud-value").id(`${id}-v`).label(v); }, { align: "center", spacing: 0, ...(w ? {} : { width: Math.max(51, labelWidth(label, "hud-label") + 4) }) });
      }
    }, { style: "hud-box", spacing: stacked ? 4 : 16, align: "center", ...(w ? { width: w, justify: "space-between" as const } : {}) });
  };
  const leftBox = (w: number | null): void => {
    ui.column("hud-left", () => {
      const inner = (w ?? Math.min(leftW, width * 0.6)) - 30;
      if (labelWidth(objective, "hud-objective") <= inner) ui.style("hud-objective").label(objective); else para(objective, inner, "hud-objective");
      if (progress) { if (labelWidth(progress, "hud-progress") <= inner) ui.style("hud-progress").label(progress); else para(progress, inner, "hud-progress"); }
    }, { style: "hud-box", spacing: 3, ...(w ? { width: w } : {}) });
  };
  ui.place("hud", { anchor: "top-start", x: margin, y: 8 }, () => {
    if (stacked) {
      ui.column("hud-stack", () => { leftBox(width); statsBox(width); }, { spacing: 6, width });
    } else {
      ui.row("hud-row", () => { leftBox(null); statsBox(null); }, { width, justify: "space-between", align: "start" });
    }
  });
}

// ------------------------------------------------------------------ tray
function tray(L: Layout): void {
  const r = Session.round!;
  const playing = r.phase === "active";
  const items: { id: string; text: string; key: string; primary?: boolean; disabled: boolean; act: () => void }[] = [
    { id: "btn-drop", text: t("tray.drop"), key: keyName("drop"), primary: true, disabled: !playing, act: doDrop },
    { id: "btn-hint", text: t("tray.hint"), key: keyName("hint"), disabled: !playing || !canHint(), act: doHint },
    { id: "btn-undo", text: t("tray.undo"), key: keyName("undo"), disabled: !playing || !canUndo(), act: doUndo },
    { id: "btn-pause", text: t("tray.pause"), key: keyName("pause"), disabled: !playing, act: pauseGame },
  ];
  if (Session.settings.leftHanded) items.reverse();
  const hints = !L.narrow;
  const avail = L.lw - 16;
  // Phones: the row spans the window, each button an equal share (Drop 1.25).
  const share = L.narrow ? (avail - 12 - 8 * (items.length - 1)) / (items.length + 0.25) : 0;
  const one = (b: (typeof items)[number], width: number | null): void => {
    const style = ["btn", "btn-tray", ...(b.primary ? ["btn-primary", "btn-big"] : []), ...(L.narrow ? ["btn-tray-compact"] : [])];
    const opts: ui.ButtonOptions = { disabled: b.disabled };
    if (hints && b.key) {
      opts.content = () => {
        ui.row(`${b.id}-face`, () => { ui.label(b.text, b.primary ? { weight: "600" } : {}); ui.style("kbd").label(b.key); }, { spacing: 8, align: "center" });
      };
    }
    const s: ui.Style = width != null ? { width, ...(b.primary ? {} : { minWidth: 64 }) } : (b.primary ? {} : { minWidth: 64 });
    if (ui.style(...style, s).id(b.id).button(b.text, opts)) { b.act(); ui.setFocus(null); }
  };
  if (L.shortLand) {
    ui.place("tray", { anchor: "bottom-end", x: 8, y: 8 }, () => {
      ui.column("tray-col", () => { for (const b of items) one(b, null); }, { spacing: 8, align: "stretch" });
    }, { style: "tray" });
  } else {
    ui.place("tray", { anchor: "bottom", x: 0, y: 8 }, () => {
      ui.row("tray-row", () => { for (const b of items) one(b, L.narrow ? Math.floor(share * (b.primary ? 1.25 : 1)) : null); }, { spacing: 8, align: "center" });
    }, { style: "tray", ...(L.narrow ? { width: avail } : {}) });
  }
}

// ------------------------------------------------------------------ screens
function accountLine(): string {
  if (app.signedOut) return t("acct.signedOut");
  const name = platform.displayName();
  if (!name) return t("net.local");
  const st = platform.syncState();
  return `${t("acct.playingAs", { name })} · ${st === "error" ? t("acct.syncOff") : st === "saving" ? t("acct.saving") : t("acct.synced")}`;
}

function titleScreen(L: Layout): void {
  screen("title", "title-screen", L, (w) => {
    ui.style("game-title", L.narrow || L.shortLand ? "game-title-compact" : null).label("Balance Spire");
    para(t("tagline"), w, "tagline", "tagline", true);
    button({ id: "btn-play", text: t("play"), style: ["btn", "btn-primary", "btn-big"], act: openModes });
    flow("title-row1", [
      { id: "btn-daily", text: t("daily"), act: () => openSetup("daily") },
      { id: "btn-journey", text: t("journey"), act: () => openSetup("journey") },
      { id: "btn-learn", text: t("learn"), act: () => openSetup("learn") },
    ], w);
    flow("title-row2", [
      { id: "btn-help", text: t("howto"), style: ["btn", "btn-subtle"], act: openHelp },
      { id: "btn-boards", text: t("boards"), style: ["btn", "btn-subtle"], act: openBoards },
      { id: "btn-settings", text: t("settings"), style: ["btn", "btn-subtle"], act: openSettings },
    ], w);
    const account: Btn[] = [];
    if (!platform.signedIn()) account.push({ id: "btn-sign-in", text: t("acct.signIn"), style: ["btn", "btn-subtle"], act: () => { void requestSignIn().catch(() => undefined); } });
    const link = platform.inviteLink();
    if (link) {
      account.push({
        id: "btn-invite", text: t("acct.invite"), style: ["btn", "btn-subtle"],
        act: () => { try { clipboard.writeText(link); toast(t("acct.inviteCopied")); } catch { toast(`${t("acct.inviteFailed")} ${link}`); } },
      });
    }
    if (account.length) flow("title-account", account, w);
    const p = Session.progress;
    if (p.stars > 0 || p.bestScore > 0) para(t("title.progress", { done: journeyDone(), stars: p.stars, best: p.bestScore }), w, "dim", "title-progress", true);
    para(accountLine(), w, "dim", "title-net", true);
  }, cw(L, 640), 10);
}

function modesScreen(L: Layout): void {
  const p = Session.progress;
  const daily = p.dailies[today()];
  const cards: [string, string, string, string][] = [
    ["journey", t("mode.journey"), t("mode.journeyDesc"), t("status.journey", { done: journeyDone(), stars: p.stars })],
    ["daily", t("mode.daily"), t("mode.dailyDesc"), daily ? t("status.dailyBest", { n: daily }) : t("status.dailyNone")],
    ["practice", t("mode.practice"), t("mode.practiceDesc"), ""],
    ["challenge", t("mode.challenge"), t("mode.challengeDesc"), ""],
    ["score", t("mode.score"), t("mode.scoreDesc"), p.bestScore ? t("status.best", { n: p.bestScore }) : ""],
    ["learn", t("mode.learn"), t("mode.learnDesc"), p.tutorialDone ? t("status.learnDone") : t("status.learn")],
  ];
  screen("modes", "screen", L, (w) => {
    ui.style("screen-title").heading(t("modes.title"));
    const cols = w >= 240 * 2 + 13 ? 2 : 1;
    const cardW = (w - 13 * (cols - 1)) / cols;
    ui.column("mode-cards", () => {
      for (let i = 0; i < cards.length; i += cols) {
        ui.row(`mode-row-${i}`, () => {
          for (const [mode, title, desc, status] of cards.slice(i, i + cols)) {
            const inner = cardW - 34;
            const clicked = ui.style("card", { width: cardW }).id(`card-${mode}`).button(title, {
              content: () => {
                ui.column(`card-${mode}-face`, () => {
                  ui.style("card-title").label(title);
                  ui.style("card-desc").paragraph(desc, inner);
                  if (status) ui.style("card-status").paragraph(status, inner);
                }, { spacing: 5, width: inner });
              },
            });
            if (clicked) openSetup(mode);
          }
        }, { spacing: 13, align: "stretch" });
      }
    }, { spacing: 13 });
    button({ id: "btn-modes-back", text: t("back"), style: ["btn", "btn-subtle"], act: back });
  }, cw(L, 640));
}

function setupScreen(L: Layout): void {
  const mode = app.setupMode;
  // Keep the list's text in the current language (and the stars current).
  fillSetup(mode);
  const items = app.setupItems;
  // As many rows as fit with the heading, the info panel, the pager and the
  // buttons (the browser build's list scrolled inside 50 % of the window).
  const fixed = 44 + (lastHeight.get("setup-info") ?? 60) + 62 + 66 + 16 * 4;
  const size = Math.max(3, Math.min(SETUP_PAGE_MAX, Math.floor((L.lh - 32 - fixed) / 48)));
  if (size !== app.setupPageSize) {
    app.setupPage = Math.floor((app.setupPage * app.setupPageSize) / size);
    app.setupPageSize = size;
  }
  const PAGE = app.setupPageSize;
  const pages = Math.max(1, Math.ceil(items.length / PAGE));
  app.setupPage = Math.min(Math.max(app.setupPage, 0), pages - 1);
  screen("setup", "screen", L, (w) => {
    ui.style("screen-title").heading(setupHeading(mode));
    const info = ui.column("setup-info", () => { para(setupInfo(mode), w - 34, undefined, "setup-info-text"); }, { style: "panel", width: w });
    lastHeight.set("setup-info", info.height / L.sc);
    if (items.length) {
      const listW = Math.min(w, 560);
      ui.column("setup-list", () => {
        items.slice(app.setupPage * PAGE, (app.setupPage + 1) * PAGE).forEach((item, i) => {
          const inner = listW - 32;
          const right = item.right;
          const rw = right ? labelWidth(right, "stars") + 12 : 0;
          const clicked = ui.style("list-btn", { width: listW }).id(`setup-${i}`).button(item.label, {
            disabled: !item.unlocked, selected: !!item.current,
            content: () => {
              ui.row(`setup-${i}-face`, () => {
                if (labelWidth(item.label, "list-btn") <= inner - rw) ui.label(item.label); else ui.paragraph(item.label, inner - rw);
                if (right) ui.style("stars").label(right);
              }, { width: inner, justify: "space-between", align: "center" });
            },
          });
          if (clicked) commitStart({ mode, cfg: item.cfg as Cfg, lesson: item.lesson ?? null });
        });
      }, { spacing: 4, width: listW });
      if (pages > 1) {
        ui.row("setup-pager", () => {
          button({ id: "setup-prev", text: t("prev"), style: ["btn", "btn-subtle"], disabled: app.setupPage === 0, act: () => { app.setupPage--; } });
          ui.style("dim", { minWidth: 64, text: { align: "center" } }).label(`${app.setupPage + 1} / ${pages}`);
          button({ id: "setup-next", text: t("next"), style: ["btn", "btn-subtle"], disabled: app.setupPage === pages - 1, act: () => { app.setupPage++; } });
        }, { spacing: 8, align: "center" });
      }
    }
    const row: Btn[] = [];
    const pending = app.pendingSetup;
    if (pending) row.push({ id: "btn-start", text: t("start"), style: ["btn", "btn-primary", "btn-big"], act: () => commitStart(pending) });
    row.push({ id: "btn-setup-back", text: t("back"), style: ["btn", "btn-subtle"], act: back });
    flow("setup-actions", row, w);
  }, cw(L, 640));
}

function pauseScreen(L: Layout): void {
  screen("pause", "sheet", L, (w) => {
    ui.style("screen-title").heading(t("paused"));
    const bw = Math.min(w, 340);
    ui.column("pause-col", () => {
      button({ id: "btn-resume", text: t("resume"), style: ["btn", "btn-primary", "btn-big"], act: resumeGame }, bw);
      button({ id: "btn-pause-settings", text: t("settings"), act: openSettings }, bw);
      button({ id: "btn-pause-help", text: t("howto"), act: openHelp }, bw);
      button({ id: "btn-restart", text: t("restart"), act: restartRound }, bw);
      button({ id: "btn-leave", text: t("leave"), style: ["btn", "btn-danger"], act: leaveRound }, bw);
    }, { spacing: 8 });
  }, cw(L, 480));
}

function resultsScreen(L: Layout): void {
  const res = app.results;
  if (!res) { showScreen("title", false); return; }
  const s = res.state;
  screen("results", "sheet", L, (w) => {
    ui.style("screen-title").heading(res.won ? t("results.won") : t("results.over"));
    para(resultsHeadline(), w, "headline", "results-headline");
    const tw = Math.min(w, 420);
    const rows: [string, number][] = [
      [t("row.height", { n: s.placed }), s.score.heightPoints],
      [t("row.perfect", { n: s.perfects }), s.score.perfectPoints],
      [t("row.streak", { n: s.bestStreak }), s.score.streakPoints],
      [t("row.goal"), s.score.goalBonus],
      [t("row.drops"), s.score.dropBonus],
      [t("row.time"), s.score.timeBonus],
    ];
    ui.column("score-table", () => {
      ui.style("score-caption").label(t("results.caption"));
      ui.grid("score-grid", () => {
        for (const [k, v] of rows) { ui.style("cell").label(k); ui.style("cell-num").label(String(v)); }
        ui.gridRow("score-total").style("cell-strong").label(t("total"));
        ui.style("cell-strong-num").id("score-total-v").label(String(s.score.total));
      }, { columns: [{ fr: 1 }, { width: "auto", align: "end" }], gap: 0, width: tw, rowStyle: "score-row" });
    }, { spacing: 4, width: tw });
    para(t("res.progress", { stars: Session.progress.stars, best: Session.progress.bestScore }), w, "dim", "results-progress");
    if (res.localRank) para(t("res.local", res.localRank), w, "dim", "results-board");
    if (res.lb) {
      const lb = res.lb;
      para(lb.pending ? t("acct.lbPosting") : !lb.posted ? t("acct.lbNotPosted") : lb.rank ? t("acct.lbRank", { rank: lb.rank }) : t("acct.lbPosted"), w, "dim", "results-lb");
    }
    if (res.achievements.length) pills("results-badges", res.achievements.map(achievementName), w, "badge");
    const next = res.won ? nextJourneyLevel() : null;
    const row: Btn[] = [{ id: "btn-retry", text: t("retry"), style: ["btn", "btn-primary"], act: restartRound }];
    if (next) row.push({ id: "btn-next", text: t("nextStage"), act: () => commitStart({ mode: "journey", cfg: next }) });
    row.push({ id: "btn-results-modes", text: t("modesBtn"), style: ["btn", "btn-subtle"], act: () => { app.stack = ["title"]; showScreen("mode-select", false); } });
    flow("results-actions", row, w);
  }, cw(L, 560));
}

function settingsScreen(L: Layout): void {
  const st = Session.settings;
  screen("settings", "sheet", L, (w) => {
    ui.style("screen-title").heading(t("settings"));
    const two = w >= 2 * 230 + 16;
    const fw = two ? (w - 16) / 2 : w;
    const check = (key: string, label: string): void => {
      const cur = !!st[key];
      const next = ui.id(`set-${key}`).checkbox(label, cur);
      if (next !== cur) platform.setSetting(key, next);
    };
    const audio = (): void => {
      ui.column("fs-audio", () => {
        ui.style("legend").label(t("set.audio"));
        check("captions", t("set.captions"));
      }, { style: "fieldset", width: fw, spacing: 9 });
    };
    const controls = (): void => {
      ui.column("fs-controls", () => {
        ui.style("legend").label(t("set.controls"));
        check("leftHanded", t("set.left"));
        check("holdToDrop", t("set.hold"));
        check("timingAssist", t("set.assist"));
        check("haptics", t("set.haptics"));
        button({ id: "btn-replay-tutorial", text: t("set.replay"), act: replayTutorial }, Math.min(fw - 34, buttonWidth(t("set.replay"), PLAIN)));
      }, { style: "fieldset", width: fw, spacing: 9 });
    };
    if (two) ui.row("settings-grid", () => { audio(); controls(); }, { spacing: 16, align: "stretch" });
    else ui.column("settings-grid", () => { audio(); controls(); }, { spacing: 16 });
    // Sound, graphics, language, controls and accessibility are the runtime's Options.
    button({ id: "btn-options", text: t("set.options"), act: () => openMenu() }, Math.min(w, buttonWidth(t("set.options"), PLAIN)));
    button({ id: "btn-settings-done", text: t("done"), style: ["btn", "btn-subtle"], act: back });
  }, cw(L, 760));
}

function helpScreen(L: Layout): void {
  const k = (a: string): string => keyName(a);
  const cards: [string, string][] = [
    [t("help.drop"), t("help.dropText")],
    [t("help.trim"), t("help.trimText")],
    [t("help.perfect"), t("help.perfectText")],
    [t("help.assists"), t("help.assistsText")],
    [t("help.limits"), t("help.limitsText")],
    [t("help.keyboard"), t("help.keyboardText", { drop: k("drop"), pause: k("pause"), undo: k("undo"), hint: k("hint"), camera: k("camera"), back: k("back") })],
  ];
  screen("help", "sheet", L, (w) => {
    ui.style("screen-title").heading(t("howto"));
    const cols = w >= 240 * 2 + 13 ? 2 : 1;
    const cardW = (w - 13 * (cols - 1)) / cols;
    ui.column("help-cards", () => {
      for (let i = 0; i < cards.length; i += cols) {
        ui.row(`help-row-${i}`, () => {
          for (const [title, text] of cards.slice(i, i + cols)) {
            ui.column(`help-${title}`, () => {
              ui.style("card-title").label(title);
              ui.style("card-desc").paragraph(text, cardW - 34);
            }, { style: "help-card", width: cardW, spacing: 5 });
          }
        }, { spacing: 13, align: "stretch" });
      }
    }, { spacing: 13 });
    button({ id: "btn-help-back", text: t("back"), style: ["btn", "btn-subtle"], act: back });
  }, cw(L, 640));
}

function boardLabel(pid: string): string {
  const name = platform.nameFor(pid) ?? t("board.playerId", { id: pid.replace(/^p-/, "").slice(0, 8) });
  return pid === platform.playerId() ? t("board.you", { name }) : name;
}
function boardScreen(L: Layout): void {
  const rows = platform.scoreBoard();
  const daily = platform.dailyBoard(app.boardDate);
  screen("board", "sheet", L, (w) => {
    ui.style("screen-title").heading(t("board.score"));
    const bw = Math.min(w, 520);
    const list = (key: string, list: platform.BoardRow[]): void => {
      ui.column(key, () => {
        list.slice(0, 20).forEach((row, i) => {
          ui.row(`${key}-${i}`, () => {
            ui.label(`${i + 1}. ${boardLabel(row.playerId)}`);
            ui.style("cell-strong-num").label(String(row.score));
          }, { width: bw - 34, justify: "space-between", align: "center" });
        });
      }, { style: "panel", width: bw, spacing: 2 });
    };
    if (rows.length) list("board-score", rows);
    else ui.column("board-empty", () => { para(t("board.empty"), bw - 34); }, { style: "panel", width: bw });
    if (daily.length) {
      ui.style("headline").heading(t("board.daily", { date: app.boardDate }));
      list("board-daily", daily);
    }
    button({ id: "btn-board-back", text: t("back"), style: ["btn", "btn-subtle"], act: back });
  }, cw(L, 560));
}
