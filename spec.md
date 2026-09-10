# Balance Spire — Game Design Document (running spec)

Balance Spire is a one-input timing game: a luminous stone slab slides back and forth above a tower, you drop it, whatever hangs over the edge is sheared off, and the next slab arrives on the other axis over the narrower footprint. This document describes the game as it ships today. Anything not yet true of the code is confined to "Design intent not yet implemented".

## 1. Overview

| | |
|---|---|
| Pitch | Drop sliding slabs dead-centre to raise a glowing stone spire; every miss narrows the next landing. |
| Genre | Timing / stacking, single player, asynchronous ranked comparison. |
| Session | 1–3 minutes per journey stage; 2–6 minutes for a daily, challenge or endless run. |
| Platforms | Desktop and mobile browsers with WebGL (falls back to a fully operable DOM shell without 3D). |
| Rendering | Three.js scene (`vendor/three.module.min.js`, ES module) under a semantic HTML UI layer; the DOM is always the source of controls. |
| Determinism | Integer milli-units, 60 ticks/s, closed-form slab motion, seeded PRNG; every ranked run is replayed server-side. |

File map (all shipped unless marked dev):

| Path | Responsibility |
|---|---|
| `index.html` | DOM shell: playfield host, HUD, action tray, all screens, live regions, script load order. |
| `css/style.css` | Palette tokens, responsive layout (desktop / portrait / landscape), high-contrast and reduced-motion overrides. |
| `js/rng.js` | mulberry32 PRNG, FNV-1a string hash, three derived streams (rules / decor / AV). |
| `js/rules.js` | Pure rules engine: config normalisation, slab motion, drop resolution, scoring, terminal states, replay, hashing. |
| `js/content.js` | Versioned content: 5 themes, 40 journey stages, 6 challenges, 4 practice presets, score-chase ruleset, daily generator, 5 lessons, 9 achievements. |
| `js/session.js` | Round state machine, wall-clock→tick conversion, undo, lesson tracking, progression, achievements, replay envelope, snapshots. |
| `js/render.js` | Three.js scene: tower meshes, moving slab, ghost marker, hint band, debris, skyline, stars, camera spring, quality tiers. |
| `js/ui.js` | Screens, focus, input routing (pointer, keyboard, gamepad), HUD, results, settings binding, screen-reader mirror. |
| `js/audio.js` | Web Audio buses, authored Opus one-shots with synthesized fallbacks, ambience loop, adaptive pad music, captions. |
| `js/platform.js` | Same-origin `/api/v1` adapter: time sync, submissions, boards, achievements, activity, heartbeat. |
| `js/bootstrap.js` | WebGL detection, module wiring, main loop, adaptive quality, lifecycle, consent-gated funnel. |
| `server.js` | StarHermit Game Script: static host plus authoritative replay validation, boards, achievements, activity. |
| `assets/title-backdrop.webp`, `assets/slab-stone.webp` | Authored key art behind the title screen; limestone grain on slab materials. |
| `sfx/*.opus`, `sfx/manifest.txt` | 15 authored clips and the canonical event binding table (`manifest.json` drives regeneration). |
| `coverart.png`, `icon.png`, `favicon.svg` | Store cover (1200×675), launcher icon, tab icon. |
| `data/` | Server-side JSON store (boards, achievements, playtime, funnel counts); git-ignored, never served. |
| `tests/rules.test.js`, `tests/server.test.js`, `tests/e2e.mjs` | Dev only: rules/content properties, validation, and the Playwright playthrough. |
| `starhermit.txt` | `name=Balance Spire`, `launch=index.html`, `server=server.js`, `cover=coverart.png`. |

## 2. Vision and design pillars

**The spire is the score.** The tower itself is the running scoreboard: its width is your accuracy history, its glow marks perfects, its height is progress. This rules in emissive perfect slabs, visible trimmed debris and a camera that climbs with the tower; it rules out score popups, combo text or any HUD element that competes with the tower for attention.

**One press, total honesty.** There is exactly one gameplay verb (drop) and its consequence is decided by integer maths the player can learn: a perfect is `|offset| ≤ eps`, a trim keeps exactly the overlap, a miss is zero overlap. This rules in the hint band that shows the true window and a results table that sums to the total; it rules out hidden assists, rubber-banding, or cosmetic "near miss" forgiveness.

**Calm pressure.** Difficulty comes from speed, window width, foundation width, drop limits and clocks — never from surprises. Slab motion is a triangle wave with constant amplitude, so rhythm is learnable. This rules out random speed spikes, moving targets, or obstacles.

**Fair by construction.** Same seed, same commands, same tower, everywhere. Daily and score-chase runs are re-simulated on the server from the command log; the client's score claim is never trusted. This rules out client-side timers as authority and rules in an inspectable seed on the setup screen.

**Peaceful skyline.** A dawn-to-aurora palette of luminous stone, quiet ambience and soft chimes; failure is a slab sailing past into mist, not an explosion. This rules out alarms, red flashes, and shaking beyond a two-frame settle.

## 3. Player experience

Target player: someone who enjoys short precision loops (stacking, rhythm, golf-style par) on a phone or during a break, and returns for the daily seed and the 40-stage journey.

First 60 seconds (`js/ui.js`): the title screen shows Play, Daily challenge, Journey, Learn, How to play, Leaderboards, Settings. Play → mode cards (each states ranking, assists and length) → Journey list with only stage 1 unlocked. Starting "First Stone" toasts and announces its intro text ("Tap, click, or press Space when the sliding slab is over the tower. Anything hanging over the edge is trimmed away."), a 3-2-1 countdown ticks, and the moving slab is the only thing moving on screen. The first drop teaches trim by consequence; stage 3 introduces perfects ("Drop dead centre…"), stage 5 streaks, stage 8 the drop limit, stage 13 spare slabs, stage 15 the clock. Learn mode makes each rule a required action in five lessons. Help cards are available from title and pause.

Typical session: two or three journey stages, or the daily plus a retry. The emotional beat is the "held breath" between watching the slab approach centre and the chime of a perfect; the results table then turns that into stars and a next-stage button.

## 4. Core loop and rules contract

All rules live in `js/rules.js`; nothing else mutates game state.

**Units and time.** Lengths are integer milli-units (`MU = 1000` per world unit). Time is integer ticks at `TICKS_PER_SEC = 60`. Commands carry `atTick`; `js/session.js tickNow()` converts `performance.now()` to ticks only while the round is active, so pausing never advances the clock.

**Board.** `state.slabs[0]` is the foundation (`base.w × base.d` units, min 0.4, forced even mu). Each placed slab records `{x, z, w, d, perfect}`. `height(state) = slabs.length − 1`. A pending slab `{axis, phase, spawnTick}` slides on `x` for odd levels and `z` for even (`axisForLevel`); `cfg.axisPattern` of `x-only`/`z-only` overrides this.

**Motion (`slabPosAt`).** Centre position is a triangle wave of amplitude `HALF_RANGE = 2500` mu around the tower centre: period `periodTicks = ceil(4·2500 / (speed·1000/60))` rounded up to even, where `speed = cfg.speed + cfg.speedRamp·level` (`speedAt`). Rounding to even guarantees the wave visits exact centre every half period, so a perfect drop is physically possible at every level. Phase comes from the rules PRNG stream at spawn. Examples: journey stage 1 level 1 has a 546-tick (9.1 s) round trip; stage 40 at level 32 has 108 ticks (1.8 s).

**Legal actions (`legalActions`, `checkDrop`).** `drop` (any non-terminal state, `atTick > state.tick`), `timeout` (only when `timeLimitSec > 0` and `atTick ≥ limit`), `resign`. Invalid reasons: `game-ended`, `unknown-command`, `malformed-command`, `bad-tick`, `early-timeout`, `no-time-limit`. Invalid commands return the untouched state.

**Drop resolution (`applyCommand`)**, in order:
1. If a clock exists and `atTick ≥ timeLimitSec·60` → terminal `time-up`, no placement.
2. `pos = slabPosAt(...)`, `offset = pos − topCentre`, `overlap = min(right edges) − max(left edges)` along the travel axis.
3. `|offset| ≤ cfg.eps` → **perfect**: slab placed at full width on the top's centre, `streak++`, `perfects++`.
4. else `overlap ≤ 0` → **miss**: `misses++`, `streak = 0`, `livesLeft--`; if `livesLeft ≤ 0` terminal `missed`, otherwise a fresh slab respawns over the same footprint (the miss still counts as a drop).
5. else **trim**: slab placed with width `overlap` centred on the overlap; a `trim` event carries the shed piece's side, size and centre for the renderer; `streak = 0`.
6. After placement: if `goalHeight > 0` and `height ≥ goalHeight` → terminal `goal-height`, won. Only if not won: `dropLimit > 0` and `drops ≥ dropLimit` → terminal `move-limit` (goal beats limit on the same drop).

**Scoring (`finalizeScore`, live during play).**

| Component | Rule |
|---|---|
| `heightPoints` | 10 per placed slab |
| `perfectPoints` | 25 per perfect |
| `streakPoints` | 5 × (streak − 1) added on each perfect, i.e. the 2nd consecutive perfect adds 5, the 3rd 10… |
| `goalBonus` | 200 on reaching goal height |
| `dropBonus` | 15 × (par.drops − drops) when won under par drops |
| `timeBonus` | 5 × floor((par.timeSec·60 − tick)/60) when won under par time |
| `total` | sum of the six |

Worked example (the golden test in `tests/rules.test.js`): seed 2026, 2×2 base, speed 1.5, ramp 0.02, goal 4, eps 100, par 6 drops / 60 s. Drops at ticks 60 (perfect), 247 (offset +300 → 295 mu trimmed, width 1705), 303 (perfect), 427 (perfect, goal). Score: height 40 + perfects 75 + streak 5 (only the final back-to-back perfect) + goal 200 + drop bonus (6−4)×15 = 30 + time bonus floor((3600−427)/60) = 52 × 5 = 260 → **610**.

**Stars (`js/session.js endRound`).** 1 for winning, +1 if `drops ≤ par.drops`, +1 if `tick ≤ par.timeSec·60`. Journey stores the best star count per stage; `progress.stars` is the sum.

**Terminal states.** `goal-height` (won), `missed`, `move-limit`, `time-up`, `resigned`. The time-limit watchdog in `session.update()` issues a `timeout` command each frame once the tick passes the limit.

**Tie-breaks (`server.js boardSort`).** Higher score, then fewer drops, then lower authoritative duration, then player id.

**RNG and seeding.** `js/rng.js` derives three mulberry32 streams from one seed by XOR with stream tags: rules (slab phases), decor (skyline layout), AV (pitch variation). Journey/challenge/practice seeds are authored constants; daily seed = FNV-1a of `balance-spire-daily-v1-YYYY-MM-DD`; score chase always uses seed 950 so every endless run is the same shared competition.

**Undo and hints (`session.undo`, `session.hint`).** Undo is allowed when `cfg.mechanics.undo` and the mode is not ranked; it pops a 32-deep state stack and also removes the command and hash from the replay log so the envelope stays consistent. Hint returns `Rules.hint()` — the next tick window `[startTick, endTick]` where `|offset| ≤ epsAt(level)` — and the renderer shows it as a band of width `2·eps` on the travel axis.

**Serialization.** `serialize/deserialize` (`STATE_VERSION 1`), `hashState` = FNV-1a of a stable-stringified state without events; `replay(cfg, commands)` rebuilds terminal state from a log.

## 5. Modes and progression

| Mode | Content | Ranked | Undo / hint | Ends when |
|---|---|---|---|---|
| Journey | 40 authored stages (`Content.JOURNEY`), next unlocks when the previous has ≥1 star | no | yes / yes | goal, miss (1 life unless stated), limit, clock |
| Daily | one ruleset per UTC day (`dailyConfig`) | yes | no / yes | goal or loss |
| Practice | Calm (goal 12, 3 lives), Steady (18, 2), Swift (24, 1), Endless rehearsal | no | yes / yes | goal or miss |
| Challenge | Perfect Ten, Ninety Seconds, Hairline, One Breath, Marathon Course, Grand Constraint | no | no / varies | per card |
| Score chase | `Endless Spire`: 1.8 base, speed 1.8 + 0.05/level, eps 80, one life, seed 950 | yes | no / no | first miss |
| Learn | 5 lessons with goals: place 3, 2 perfects, place 4 after trims, win 6-high within 10 drops, perform an undo | no | per lesson | goal met (round continues until you leave or lose) |

Journey curve: base width 2.0 → 1.2 units, speed 1.1 → 3.1 u/s, ramp 0 → 0.08, goal 8 → 32 slabs, eps 140 → 40 mu. Drop limits start at stage 8, the clock at 15, spare slabs at 13/23/37. Mastery stages 10, 20, 30, 40 combine every mechanic seen so far and set the theme. Themes rotate with progress: First Light (1–9), High Noon (10–14), Ember Skyline (15–19), Starlit Hour (20–24), Aurora Veil (25–29), then cycling.

Daily rotation is keyed on weekday `rot = dayNumber mod 7`: base `1.9 − 0.15·(rot mod 3)`, speed `1.6 + 0.25·(rot mod 4)`, ramp `0.03 + 0.01·(rot mod 3)`, goal `18 + 4·(rot mod 3)`, eps `100 − 15·(rot mod 4)`, drop limit `goal + 5` when `rot ≥ 3`, a 200 s clock when `rot = 6`, two lives when `rot ∈ {2, 5}`, theme `THEMES[rot mod 5]`. Seeds are immutable; the server accepts submissions for today or earlier and boards carry an `excluded` flag for defective days.

Progress (`bs.progress.v1`): stars, per-stage stars, tutorialDone, daily bests by date, bestScore, bestHeight, perfectsTotal, achievements. Achievements (`Content.ACHIEVEMENTS`, granted idempotently in `session.unlock`): first-place, first-perfect, streak-5, height-30, score-1500 (checked per drop); journey-half (20 stages), journey-done (40), daily-7, perfects-100 (checked at round end).

## 6. Controls and interaction

| Action | Desktop | Mobile | Gamepad | Feedback |
|---|---|---|---|---|
| Drop | Space, Enter, click playfield, Drop button | tap playfield (<500 ms, <24 px travel) or Drop button | A (0) | `ack` click, then `place`/`perfect`/`trim`/`miss` sound + caption, haptic 12/30 ms, live-region text |
| Hint | H, Hint button | Hint button | Y (3) | `hint` ping, band flashes 1.6 s |
| Undo | U, Undo button | Undo button | X (2) | `undo` whoosh, tower rebuilds |
| Pause / resume | P, Esc, Pause button | Pause button | Start (9) | `pause` hush, pause sheet |
| Camera refocus | C | — | — | announcement only |
| Back | Esc on settings/help/board | Back buttons | — | focus restored to the opener |

Input locking: `session.drop()` ignores input unless `round.phase === 'active'`; during the countdown, pause, and results nothing reaches the rules. Space/Enter only drop when no screen is open, so they never trigger from a focused menu button. Hold-to-confirm (setting) delays a drop 180 ms and ignores repeats while armed. Pointer capture is taken on `pointerdown` and a `pointercancel` clears the tap. `keydown` with `repeat` is ignored. Gamepad polling runs at 20 Hz with edge detection. Backgrounding the tab pauses the round and saves a snapshot.

## 7. Screens and UI flow

`js/ui.js showScreen()` toggles one `.screen` at a time and pushes the previous onto a back stack. `#app[data-screen]` mirrors the current screen (`play` while in a round).

```
boot → title → mode-select → setup ─start→ countdown → play ↔ paused → results
        │        │                              (Restart / Retry loops to countdown)
        ├ help   ├ (Daily / Journey / Learn shortcut straight to setup)
        ├ board  └ settings (also from pause)          results → next stage / retry / modes
        └ settings
```

- **Title**: title, tagline, Play (primary), Daily / Journey / Learn row, How to play / Leaderboards / Settings row, progress line ("Journey 3/40 · 5★ · best score 610"), connection status line. Authored dawn skyline behind a dark scrim.
- **Mode select**: six cards with live status (journey stages/stars, daily best or "Not played today", best score, lessons).
- **Setup**: info panel states ranked/assists/expected length and, for daily, the seed and constraints; stage list is paged 8 per page so it never overflows a phone; locked stages are disabled; the current stage is outlined.
- **Play**: HUD top (objective, stage name; Height / Score / Streak, plus Drops left, Time, Spare slabs only when the ruleset uses them), countdown overlay, caption strip above the tray, action tray bottom-centre (Drop primary, Hint, Undo, Pause).
- **Paused**: Resume first, then Settings, How to play, Restart round, Leave round (danger).
- **Results**: headline with height and stars, six-row score table plus total, progress line, board status, achievement badges, Retry / Next stage / Modes.
- **Settings**, **Help** (six rule cards), **Leaderboard** (global score chase, then today's daily appended when hosted).

Layout (`css/style.css`): everything is absolutely positioned over the full-window playfield. Desktop ≥1024 px widens HUD margins. ≤640 px stacks the HUD vertically, stretches the tray edge to edge with equal-width buttons and hides the `<kbd>` hints. Landscape ≤480 px tall pins the tray as a vertical column on the right and keeps the HUD in one row. Safe-area insets pad HUD, tray, toast and every screen; screens scroll vertically. Buttons are ≥44×44 CSS px. Must never be cut off: the Drop button, the score table on results, the first unlocked stage in setup, the countdown numeral.

## 8. Art direction

**Palette (CSS tokens).** Ink `#f0ece4`, dim ink `#b6b0a6`, background `#14101e`, panel `rgba(24,20,36,.92)`, line `#3a3450`, accent `#ffd9a0` (warm stone glow; primary buttons, title, countdown), accent-2 `#9fc8ff` (pale sky blue; status text), danger `#e86a5a`, focus ring `#fff2cc`. High contrast swaps to `#ffffff` / `#d8d8d8` / `#000000` / `#ffe600` / `#66ccff`.

**Scene themes (`Content.THEMES`, hex).**

| Theme | skyTop | skyBot | fog | stone | stoneDark | glow | skyline | ground | key |
|---|---|---|---|---|---|---|---|---|---|
| First Light | 2c3a5e | e8a06a | 8a7a8a | bfb4a6 | 8a8078 | ffd9a0 | 3a3450 | 241f2e | ffc98a |
| High Noon | 3a6aa8 | bfe0f0 | a8c0d0 | c8c2b4 | 94908a | fff2cc | 4a5a70 | 2a3038 | fff0d0 |
| Ember Skyline | 35244a | d0604a | 7a5460 | b0a098 | 7a6e68 | ffb066 | 2e2438 | 1e1826 | ff9a5a |
| Starlit Hour | 0c1026 | 2a3454 | 2a3050 | 9a94a8 | 6a6478 | 9fc8ff | 161a30 | 0e1020 | 8fb0e8 |
| Aurora Veil | 0e2430 | 2a6a5a | 2a5058 | a4b0ac | 6e7c78 | 9fffd0 | 142a30 | 0c1a1e | a0f0d0 |

**Shape language.** Everything is a rectangular block: slabs are 1 × 0.42 × 1 boxes scaled to their footprint, the skyline is 56 instanced boxes (24 on low tier) on a ring 16–38 units out, the ground a wide stone cylinder. The moving slab is the only object with an outline (edge lines) and the strongest emissive; perfect slabs keep a 0.45 emissive glow, ordinary ones 0.12. UI corners are 12 px, pills for badges and toasts.

**Hero.** The tower and its hovering slab, framed by a 38° perspective camera 13.5 units back and 6.2 units up, looking 0.9 units below a target that climbs `0.42` per level once the tower passes four slabs. ACES tone mapping at exposure 1.05, sRGB output, hemisphere fill `#bfd0e0/#3a3450` and a warm key `#ffe0b0` at intensity 1.5 with 1024² shadows on the high tier, linear fog from 24 to 90 units in the theme's fog colour.

**Typography.** `system-ui` stack; title `clamp(2.2rem, 8vw, 4rem)` in accent with a soft glow; HUD labels 0.68 rem uppercase tracked; tabular numerals for all counters; countdown numeral `clamp(4rem, 20vw, 9rem)` weight 800.

**Motion.** Camera rise uses a critically damped spring (k = 10) driven by frame dt, interruptible; trims add a shake of at most 0.06 units, misses 0.08, decaying at `0.02^dt`; perfect placement flashes the top slab's emissive to 1.2 (2.2 on win) and eases back over 0.8 s; trimmed pieces are pooled debris (cap 12) that fall under 9.8 u/s² and tumble. Reduced motion (setting or OS preference) snaps the camera, removes shake and debris rotation, and disables all CSS transitions/animations; event timing and the hint band are unchanged.

**Authored visual assets the design calls for.** Cover art (`coverart.png`), a title backdrop (`assets/title-backdrop.webp`), a limestone grain for slabs (`assets/slab-stone.webp`), the SVG favicon and PNG icon. No character art and no 3D model: the hero prop is procedural geometry by design.

## 9. Audio direction

Mix: four gain buses under one master — music (default 40%), effects (80%), ambience (35%), voice cues (60%) — each with a settings slider. Audio unlocks on the first gesture (`A.unlock()` from Play/mode/start buttons). Backgrounding ducks the master to 0 over 0.2 s. Every meaningful sound also emits a caption (toggle) so nothing is audio-only.

Ambience is the authored 20 s skyline loop, faded in over 1.5 s once decoded on top of a low-passed (240 Hz) noise pad that stays as the fallback. Music is a generative pad: every 1.4 s one to four sine tones from the scale C4–E♭4–G4–B♭4–C5, count and gain following `min(4, streak)`, silent while the tab is hidden. One-shots prefer the Opus clip and fall back to synthesized transients (filtered noise thocks, sine chimes) while a clip is loading or if fetch/decode fails.

SFX event table (source for `sfx/manifest.txt`; event ids are keys of `SAMPLE_BY_EVENT` in `js/audio.js`):

| Event | File | Sound | Usage |
|---|---|---|---|
| ack | ui-ack.opus | dry wooden click | every accepted input and rejected-action feedback |
| place | slab-place.opus | heavy stone thud, dusty tail | off-centre placement that stays on the tower |
| perfect | perfect-chime.opus | thud plus three rising glass chimes | placement within eps |
| trim | overhang-trim.opus | stone shearing, fragments falling | overhang shed after an off-centre place |
| miss | slab-miss.opus | block tumbling and clattering away | zero overlap; spare slab spent or round ends |
| win | stage-win.opus | five-tone warm bell fanfare | results when the goal height is reached |
| lose | round-lose.opus | three descending marimba notes | results on missed / move-limit / time-up / resigned |
| undo | drop-undo.opus | airy reverse whoosh | undo accepted |
| hint | hint-ping.opus | delicate high glass ping | hint accepted, band flashes |
| count | count-tick.opus | wooden metronome tick | countdown 3, 2, 1 |
| go | count-go.opus | bright clave snap | round goes active |
| achievement | achievement-chime.opus | sparkling celesta flourish | achievement toast |
| ambience | ambience-skyline.opus | rooftop breeze, distant hum, 20 s loop | ambience bus after unlock |
| lesson | lesson-complete.opus | xylophone resolve with glass chime | Learn lesson goal reached |
| pause | pause-hush.opus | muffled tap and hush | pause opened |

## 10. Localization

The product target is en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT. Today the build ships **English only**: all strings are literal text in `index.html` (screens, settings labels) and `js/ui.js` (help cards, HUD objectives, results headlines, toasts, announcements) and `js/content.js` (stage names, intros, lesson text, achievement names). There is no language table and no language switch; `<html lang="en">` is fixed. Layout already tolerates ~30% expansion: buttons wrap, the score table has no fixed column widths, mode cards and setup rows are flex containers with `min-height` rather than fixed height. See "Design intent not yet implemented".

## 11. Accessibility

- Keyboard-only path: skip link to `#main`; every screen focuses its first control on open and restores focus on back; the Drop button receives focus when a round goes active; Space/Enter/P/Esc/U/H/C cover play; no keyboard trap (Esc always backs out of settings/help/board).
- Focus is a 3 px `#fff2cc` outline with 2 px offset on `:focus-visible`.
- Screen readers: `#board-mirror` (role status) restates tower height, goal, next axis, current width and score after every state change; `#live` (polite) announces placements, undo, invalid actions, hints; `#live-assertive` announces misses, stage intros, results and the 3D-unavailable notice. The playfield is `role="application"` with a label; the results table has a caption and row headers.
- Captions: every audio event writes a short caption to `#caption` for 1.8 s when captions are on (default on).
- Contrast: ink `#f0ece4` on `#14101e` exceeds 12:1; primary button `#241c10` on `#ffd9a0` exceeds 10:1; the high-contrast setting switches to pure white/black/yellow.
- Reduced motion: setting or `prefers-reduced-motion` — see §8. Larger text scales the root to 20 px. Left-handed reverses the tray. Hold-to-confirm and haptics toggles exist. Timing assist shows the perfect band continuously wherever the ruleset allows hints.
- Targets: all buttons ≥44×44 CSS px; the mobile e2e pass asserts the Drop button box.

## 12. StarHermit integration

Manifest: `starhermit.txt` declares `launch=index.html`, `server=server.js`, `cover=coverart.png`, owner id. The Game Script (`server.js`, zero dependencies, `PORT` env or argv) serves the distribution and the same-origin API; it refuses `data/`, `tests/`, `tools/`, `node_modules/` and dotfiles.

Used (`js/platform.js` → `server.js`):

| Feature | Endpoint | Behaviour |
|---|---|---|
| Server time | `GET /api/v1/time` | RTT-adjusted offset; daily date and countdowns use `platform.now()`; success sets `hosted`. |
| Daily leaderboard | `POST /api/v1/daily/submit`, `GET /api/v1/daily/board?date=&friends=` | Replay-validated, one best row per player, 200 stored / 100 returned, `excluded` flag, 10 submits/min/player. |
| Score chase board | `POST /api/v1/score/submit`, `GET /api/v1/score/board` | Same validation against the fixed seed 950; rows appended. |
| Achievements | `POST /api/v1/achievements/unlock` | Idempotent per player and key; only known keys accepted. |
| Activity / presence | `POST /api/v1/activity/start|end`, `POST /api/v1/presence/heartbeat` (30 s) | Playtime pairing per player; heartbeat is liveness only. |
| Funnel | `POST /api/v1/funnel` via `sendBeacon` | Only when the analytics consent box is ticked; six event names counted per day. |

Identity: the launch token (`?launch_token=` or `?token=`) is held in memory and sent as a Bearer header; a persistent anonymous `bs.playerId` travels in `X-Player-Id`. Offline (no host) every mode still plays; ranked results are kept locally and the results screen says so. Submissions carry cfgId, date, seed, content version, the ordered command log, the result and assists; the server rejects stale versions, seed mismatches, duplicate command ids, malformed or non-terminal logs, and score/hash mismatches (`tests/server.test.js`).

Not used: profile names/avatars, cloud saves, per-game settings sync, WebSocket, realtime rooms, matchmaking, invitations, chat, voice, containers. Conventions follow https://wiki.starhermit.com/.

## 13. Technical architecture

- **Load order** (`index.html`): rng → rules → content → audio → platform → session → ui as classic UMD scripts, then `render.js` as an ES module that sets `window.BSRender` and dispatches `bs-render-ready`; `bootstrap.js` polls for it (up to 5 s) and starts with the DOM-only stub if WebGL or the module is unavailable.
- **Main loop** (`bootstrap.js`): one `requestAnimationFrame` loop calls `session.update()` (countdown, time-limit watchdog), computes the interpolation alpha as the fractional tick since the last resolved command (capped at 4 ticks), pushes the immutable state to the renderer, refreshes the hint band and the clock, then renders. Auto quality samples fps every 2 s and steps the tier down after 4 s under 45 fps.
- **Determinism and replay**: rules never read the clock; `session` stamps ticks. The replay envelope (`schema 1`, content and state versions, cfgId, date, seed, initial hash, ordered commands, per-command hashes, result with final hash and duration) is rebuilt by `Rules.replay` on the server. The AV stream is reseeded per round so pitch variants match on replay.
- **Persistence**: `localStorage` documents `{v:1, data, sum}` with an FNV-1a checksum of the stable JSON — `bs.settings.v1`, `bs.progress.v1`, `bs.snapshot.v1` (written on hide/pagehide/GL loss, restored paused at boot), plus `bs.playerId`. Corrupt documents fall back to defaults.
- **Rendering budgets**: DPR capped at 2 / 1.5 / 1 by tier; shadows only on high; stars 600 / 300 / 120; skyline 56 / 56 / 24 instances; debris pool ≤12; slab meshes pooled and hidden rather than disposed; stars and hint/ghost planes never intercept raycasts. Context loss shows the 3D-unavailable panel and saves a snapshot; restore hides it.
- **Server** (`server.js`): token-bucket rate limits per player and route, 64 KB body cap, atomic JSON writes under `data/` (or `BS_DATA_DIR`), immutable caching for `vendor/`, `nosniff` on all static responses.
- **E2E** (`tests/e2e.mjs`): launches headless Chrome with an embedded static server on an ephemeral port that answers `/api/*` with `{}` so the game runs in offline mode; it reads `window.BSRules.perfectWindow` only to time its clicks and performs every action through visible controls.

## 14. Testing and acceptance criteria

`npm test` runs `tests/rules.test.js` (26 tests) and `tests/server.test.js` (7 tests):
- determinism of creation and closed-form motion; perfect / trim / miss / spare-life / axis alternation; win with par bonuses; drop limit; goal-beats-limit; late drop and timeout handling; resign; invalid commands leave state untouched; `legalActions` shape; property over seeds and levels that hint-window drops are always perfect; serialization round trip; replay reproduces the final hash; command-shape guard; fuzzing malformed commands; all 40 journey stages, 6 challenges, 4 presets and 90 consecutive dailies are winnable by perfect play; endless never wins but terminates; lessons are playable; golden hash for the worked example.
- server: self-chosen score-chase seeds rejected, published seed accepted, tampered totals rejected, daily seed enforced, duplicate command ids rejected, undo keeps the envelope replayable, live HTTP daily submit ranks and keeps the better row.

`npm run test:e2e` (Playwright, desktop 1280×800 then mobile 390×844 touch): title → help (6 cards) → mode select → journey setup (only stage 1 unlocked) → countdown → stage 1 won through the Drop button → results with 6 rows and a positive total → star persisted → next stage → pause via P / Esc / settings toggle applied to the DOM → resign via Leave → practice hint + drop + undo → leave; mobile adds tray pause/resume and a ≥44 px Drop target. Any console error or page error fails the run.

QA bar as checkable statements: the first stage's intro is toasted and announced before play; every mode card, setting, help card and board screen is reachable by mouse, touch and keyboard; no console errors or warnings at either viewport; HUD, tray, countdown, score table and setup list are fully visible at 390×844 portrait, 844×390 landscape and 1280×800; ranked features use the StarHermit script when hosted and degrade to local play when not.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `coverart.png` (1200×675, 158 KB) | store cover: luminous slab tower at dawn | FLUX.2 klein, seed 4701, 1200×688 cropped, 256-colour PNG | generated in this pass (replaced a generic placeholder) |
| `assets/title-backdrop.webp` (1536×864, 16 KB) | title-screen key art behind the scrim | FLUX.2 klein, seed 4702, webp q80 | generated in this pass, wired in `css/style.css` |
| `assets/slab-stone.webp` (512×512, 5 KB) | limestone grain multiplied onto slab materials | FLUX.2 klein, seed 4703, webp q85 | generated in this pass, wired in `js/render.js` with untextured fallback |
| `icon.png` (256×256), `favicon.svg` | launcher and tab icons (stacked amber slabs) | authored SVG | shipped |
| `sfx/ui-ack … achievement-chime.opus` (12 clips) | one-shots per §9 | MOSS-SoundEffect v2, 100 steps | shipped |
| `sfx/ambience-skyline.opus` (20 s, 144 KB) | ambience loop | MOSS-SoundEffect v2, 60 steps, seed 3742432200 | generated in this pass, wired |
| `sfx/lesson-complete.opus` (2 s) | lesson goal reached | MOSS-SoundEffect v2, 60 steps, seed 1162542136 | generated in this pass, wired |
| `sfx/pause-hush.opus` (1 s) | pause opened | MOSS-SoundEffect v2, 60 steps, seed 3320720017 | generated in this pass, wired |
| `sfx/manifest.txt` / `manifest.json` / `manifest.md` | canonical binding table / regeneration source / prompt log | — | in sync, 15 entries |
| 3D models, character animation | not required: the hero prop is procedural | — | none by design |

## 16. Known limitations

- No localization layer: English strings are literals in HTML/JS (§10).
- Theme `unlockStars` values in `Content.THEMES` are data only; themes are assigned per stage and never gated by stars (`progress.themeUnlocksSeen` is unused).
- Leaderboards list anonymous player ids, not display names; the `friends=` filter exists server-side but the UI never sends it, and the launch token is forwarded but not verified by the script, so identity on boards is self-asserted (scores themselves are still replay-validated).
- Auto quality steps down from the auto-detected tier rather than the currently active one, so it can only degrade once per session.
- A restored snapshot loses its lesson context (`lesson: null`), so a Learn round resumed after a crash no longer tracks its goal.
- Gamepad bindings are fixed (no remapping UI); the setup screen has no gamepad focus navigation beyond browser defaults.
- The e2e run covers offline play only; daily/score submission is exercised by the server unit test, not through the browser.
- Score chase uses one immutable seed, so the slab phase sequence is identical every run (intentional for fairness, but memorisable).
- Toasts (stage intro, achievements) sit over the HUD objective for 2.6 s on narrow portrait screens; the objective is readable again once the toast clears.

## Design intent not yet implemented

- Ship the nine locale tables (en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT) with a `data-i18n` pass over `index.html` and a string table for `ui.js`/`content.js`, chosen from the host locale with a settings override.
- Gate themes by `unlockStars` and surface unlocks on the results screen.
- Show profile display names and a friends-only toggle on boards using the host identity.
- Resume Learn lessons from snapshots.
