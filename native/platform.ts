// The game's data and the StarHermit platform, on the runtime's modules:
// - progress (journey stars, dailies, bests, achievements) is the game's save
//   (starhermit:storage `saves`, the document { v: 1, progress }): on the
//   device and in the player's cloud slot, two devices' progress merged on a
//   conflict (BSSession.mergeProgress). The slot the browser build wrote (the
//   JS SDK's zipped save.json, the same document) shows as foreign and is
//   merged in and replaced once;
// - the game's own settings (captions, left-handed tray, hold-to-drop, the
//   perfect-window marker, haptics) are `settings` (game.<key>, synced with
//   the account); the browser build's settings keys are migrated and removed;
// - the score chase and daily boards stay on the device (`storage`
//   bs.boards.v1, as the browser build kept them in localStorage);
// - a finished ranked round's total goes to the high-score board through
//   score-script.js: a practice session whose socket carries
//   { type: 'result', scores }, as the JS SDK's submitScores did.
import type { JsonValue } from "starhermit:engine";
import { connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, profile, sessions } from "starhermit:platform";
import { saves, settings, storage } from "starhermit:storage";
import { Migrate, Session, type Envelope, type Progress } from "./classic.ts";

// --- progress -------------------------------------------------------------------------
const listeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { listeners.add(fn); }
function merged(): void { for (const fn of listeners) fn(); }

let lastSavedAt = 0;
let saving = false;
function persist(): void {
  try { saves.save(Migrate.saveDoc(Session.progress) as unknown as JsonValue, { schema: 1 }); }
  catch (e) { console.warn(`save: ${String(e)}`); }
}
/** Takes progress into the session (merged with what it has); whether it changed. */
function adopt(p: Progress | null): boolean {
  if (!p) return false;
  const before = JSON.stringify(Session.progress);
  const next = Session.mergeProgress(p, Session.progress);
  if (JSON.stringify(next) === before) return false;
  saving = true; // adoptProgress writes the device cache only
  Session.adoptProgress(next);
  saving = false;
  return true;
}

/** Reads the device's save and wires the session's progress to it (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  if (adopt(Migrate.progressFromSave(cur?.data))) persist();
  else if (!cur) persist();
  Session.on("progress", () => { if (!saving) persist(); });
  if (saves.state() === "foreign") migrateForeign();
  initSettings();
  refreshInvite();
}

saves.onConflict((local, remote) => ({
  merged: Migrate.saveDoc(Session.mergeProgress(Migrate.progressFromSave(remote.data), Migrate.progressFromSave(local?.data))) as unknown as JsonValue,
}));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(Migrate.progressFromSave(cur.data))) { persist(); merged(); }
  }
});

/** The browser build's cloud save: merged with this device's progress, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const fromBrowser = Migrate.progressFromBrowserSave(old.text);
  const changed = adopt(fromBrowser);
  try { saves.save(Migrate.saveDoc(Session.progress) as unknown as JsonValue, { schema: 1, replaceForeign: true }); }
  catch (e) { console.warn(`save migration: ${String(e)}`); }
  if (changed) merged();
}

/** For the title's account line: offline (a guest) | saving | synced | error. */
export function syncState(): "offline" | "saving" | "synced" | "error" {
  if (!player()) return "offline";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading" || st === "uploading" || st === "foreign" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- the game's settings -----------------------------------------------------------------
const settingsListeners = new Set<() => void>();
export function onSettingsChange(fn: () => void): void { settingsListeners.add(fn); }
function settingsChanged(): void { for (const fn of settingsListeners) fn(); }
function readSetting(key: string): void {
  let v: JsonValue | undefined;
  try { v = settings.get(key); } catch { return; }
  if (typeof v === "boolean") Session.settings[key] = v;
}
function initSettings(): void {
  for (const k of Migrate.GAME_SETTING_KEYS) readSetting(k);
  Session.saveSettings();
  settings.onChange((key) => {
    if (!Migrate.GAME_SETTING_KEYS.includes(key)) return;
    readSetting(key);
    Session.saveSettings();
    settingsChanged();
  });
  settings.onLegacy(importLegacy);
  importLegacy();
}
/** Changes one of the game's settings (device and account). */
export function setSetting(key: string, value: boolean): void {
  Session.settings[key] = value;
  Session.saveSettings();
  try { settings.set(key, value); } catch (e) { console.warn(`setting ${key}: ${String(e)}`); }
  settingsChanged();
}
// The browser build's per-player settings: kept where the game still has the
// setting (unless this game set it since), then removed from the account.
function importLegacy(): void {
  const keys = settings.legacyKeys();
  if (!keys) return;
  let changed = false;
  for (const key of keys) {
    if (!Migrate.BROWSER_SETTING_KEYS.includes(key)) continue;
    const v = Migrate.migrateSetting(key, settings.legacy(key));
    if (v !== undefined && settings.get(key) === undefined) {
      try { settings.set(key, v); Session.settings[key] = v; changed = true; } catch { /* keep the device's */ }
    }
    settings.removeLegacy(key);
  }
  if (changed) { Session.saveSettings(); settingsChanged(); }
}

// --- the player -----------------------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
function anonId(): string {
  try {
    let id = storage.getText("bs.playerId");
    if (!id) {
      id = "p-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      storage.set("bs.playerId", id);
    }
    return id;
  } catch { return "p-anon"; }
}
/** The account id when signed in, else the device's anonymous id (board rows). */
export function playerId(): string { return player()?.userId ?? anonId(); }
export function displayName(): string | null { return player()?.displayName ?? null; }
const names = new Map<string, string>();
/** A board row's player name: the profile's (cached) when signed in, else null. */
export function nameFor(id: string): string | null {
  if (!player() || id.startsWith("p-")) return null;
  if (id === player()!.userId) return player()!.displayName;
  if (!names.has(id)) {
    names.set(id, "");
    profile(id).then((p) => { names.set(id, p.displayName); }, () => { /* the fallback stays */ });
  }
  return names.get(id) || null;
}
let invite: string | null = null;
function refreshInvite(): void {
  invite = null;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
onPlayerChange(() => refreshInvite());

// --- device boards (daily and score chase) -----------------------------------------------------
export interface BoardRow { playerId: string; score: number; drops: number; durationSec: number; at: number }
interface Boards { score: BoardRow[]; daily: Record<string, BoardRow[]> }
const BOARD_KEY = "bs.boards.v1";
const BOARD_MAX = 100;
function readBoards(): Boards {
  try {
    const b = JSON.parse(storage.getText(BOARD_KEY) ?? "null") as Boards | null;
    if (b && Array.isArray(b.score) && b.daily && typeof b.daily === "object") return b;
  } catch { /* fresh */ }
  return { score: [], daily: {} };
}
function writeBoards(b: Boards): void {
  try { storage.set(BOARD_KEY, JSON.stringify(b)); } catch (e) { console.warn(`boards: ${String(e)}`); }
}
function boardSort(a: BoardRow, b: BoardRow): number {
  return b.score - a.score || (a.drops || 0) - (b.drops || 0) || (a.durationSec || 0) - (b.durationSec || 0) || a.at - b.at;
}
function record(rows: BoardRow[], env: Envelope, onePerPlayer: boolean): { rank: number; total: number } | null {
  let row: BoardRow = {
    playerId: playerId(), score: Number(env.result.score.total) || 0, drops: env.result.drops || 0,
    durationSec: env.result.durationSec || 0, at: Date.now(),
  };
  if (onePerPlayer) {
    const i = rows.findIndex((x) => x.playerId === row.playerId);
    if (i >= 0) { if (boardSort(row, rows[i]!) < 0) rows[i] = row; else row = rows[i]!; }
    else rows.push(row);
  } else rows.push(row);
  rows.sort(boardSort);
  rows.length = Math.min(rows.length, BOARD_MAX);
  const rank = rows.indexOf(row) + 1;
  return rank > 0 ? { rank, total: rows.length } : null;
}
/** Records a ranked round on this device's board; its rank there. */
export function recordRanked(mode: string, env: Envelope): { rank: number; total: number } | null {
  const b = readBoards();
  let out: { rank: number; total: number } | null;
  if (mode === "daily" && env.date) out = record(b.daily[env.date] ??= [], env, true);
  else out = record(b.score, env, false);
  writeBoards(b);
  return out;
}
export function scoreBoard(): BoardRow[] { return readBoards().score.slice(); }
export function dailyBoard(date: string): BoardRow[] { return (readBoards().daily[date] ?? []).slice(); }

// --- the StarHermit high-score board -------------------------------------------------------------
async function highScoreBoard(): Promise<{ id: string } | null> {
  const list = await leaderboards.list();
  return list.find((b) => b.key === "high-score") ?? null;
}
/** Signed in only: post a ranked round's total through score-script.js; { posted, rank }. Never rejects. */
export async function postLeaderboard(total: number): Promise<{ posted: boolean; rank: number | null }> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": total } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const board = await highScoreBoard();
    if (!board) return { posted: true, rank: null };
    const r = await leaderboards.entries(board.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
