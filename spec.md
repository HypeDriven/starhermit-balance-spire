# Balance Spire — Game Design Document (running spec)

Balance Spire is a one-input timing game: a luminous stone slab slides back and forth above a tower, you drop it, whatever hangs over the edge is sheared off, and the next slab arrives on the other axis over the narrower footprint. This document describes the game as it ships today. Anything not yet true of the code is confined to "Design intent not yet implemented".

## 1. Overview

| | |
|---|---|
| Pitch | Drop sliding slabs dead-centre to raise a glowing stone spire; every miss narrows the next landing. |
| Genre | Timing / stacking, single player, asynchronous ranked comparison. |
| Session | 1–3 minutes per journey stage; 2–6 minutes for a daily, challenge or endless run. |
| Platforms | A StarHermit engine script game (engine 1.19.1, host API 1.21, `engine.minor=14`): natively in the StarHermit client and in desktop and mobile browsers on the engine's web runtime, from one package. |
| Rendering | `starhermit:scene` (the three.js model) for the spire, `starhermit:ui` for the HUD, tray and screens, `starhermit:draw` for the title's key art. |
| Determinism | Integer milli-units, 60 ticks/s, closed-form slab motion, seeded PRNG; the round clock is the runtime's fixed steps; every ranked run keeps a replayable command log. |

File map (all in the package unless marked dev; `.starhermitignore` leaves out `tests/`, `tools/`, `server.js`, `data/`, `test-results/`):

| Path | Responsibility |
|---|---|
| `starhermit.txt` | Manifest: name, description, owner, `server=score-script.js`, `cover=cover.jpg`, `launch=index.html`, `engine.*` lines, the six actions with keys and pad defaults. |
| `index.html`, `starhermit-files.json` | The engine's web loader and file index, written by `npm run package` (`starhermit package --web .`); never edited by hand. |
| `native/main.ts` | Entry module: screen flow, input routing (actions, playfield taps), session events → HUD state, announcements, captions, results, lifecycle, the fixed-step round clock. |
| `native/classic.ts` | Loads the pure scripts below with `loadClassic` (after a `localStorage` shim over `starhermit:storage`) and types their globals. |
| `native/screens.ts` | Every screen, the HUD, tray, countdown, caption and toast as `starhermit:ui`, the title key art. |
| `native/render.ts`, `native/rounded.ts` | The spire on `starhermit:scene` (tower, moving slab and outline, ghost marker, hint band, debris, sky dome in WGSL, skyline, stars, motes, camera spring); rounded slab geometry. |
| `native/quality.ts` | The four presets and their budgets keyed by the runtime's quality tier and level. |
| `native/audio.ts` | Clips on the runtime's mixer, rendered ambience pad and music voices, captions. |
| `native/platform.ts` | Engine save (progress) with the browser build's cloud save migrated, game settings with the old account keys migrated, device boards, score posting, invite link, profile names. |
| `native/i18n.ts`, `native/style.ts` | Locale from the runtime's interface language; registers `assets/ui-style.json` and the theme. |
| `js/rng.js`, `js/rules.js`, `js/content.js`, `js/session.js` | Unchanged pure game logic (UMD), shared with the Node tests: PRNG, rules engine, versioned content, round runner (its clock injectable with `setClock`). |
| `js/i18n.js` | Every player-facing string in the nine locales (game strings, content names, account and leaderboard lines). |
| `js/migrate.js` | What the browser build left in the account: its cloud-save document and settings keys, as the engine client takes them over. |
| `assets/ui-style.json` | `tools/ui-style.css` converted by `starhermit css` (`npm run css`). |
| `assets/title-backdrop.webp`, `assets/slab-stone.webp` | Title key art; limestone grain on slabs. |
| `sfx/*.opus`, `sfx/manifest.*` | 15 authored clips and the event binding table. |
| `score-script.js` | StarHermit platform script (`server=`): range-checks a finished ranked round's total and posts it to the `high-score` leaderboard. |
| `server.js` (dev) | Local dev server: static host plus replay validation, boards, achievements routes (exercised by `tests/server.test.js`). |
| `tests/` (dev) | Rules, server, progress/migration and localization unit tests; `tests/native.mjs` and `tests/native/*.play`. |
| `tools/` (dev) | `package-web.mjs`, `browser-play.mjs` (headless Chrome play of the packaged loader), `perfect-plan.mjs` (perfect-drop schedules for play scripts), `ui-style.css`. |

## 2. Vision and design pillars

**The spire is the score.** The tower itself is the running scoreboard: its width is your accuracy history, its glow marks perfects, its height is progress. This rules in emissive perfect slabs, visible trimmed debris and a camera that climbs with the tower; it rules out score popups, combo text or any HUD element that competes with the tower for attention.

**One press, total honesty.** There is exactly one gameplay verb (drop) and its consequence is decided by integer maths the player can learn: a perfect is `|offset| ≤ eps`, a trim keeps exactly the overlap, a miss is zero overlap. This rules in the hint band that shows the true window and a results table that sums to the total; it rules out hidden assists, rubber-banding, or cosmetic "near miss" forgiveness.

**Calm pressure.** Difficulty comes from speed, window width, foundation width, drop limits and clocks — never from surprises. Slab motion is a triangle wave with constant amplitude, so rhythm is learnable. This rules out random speed spikes, moving targets, or obstacles.

**Fair by construction.** Same seed, same commands, same tower, everywhere. Daily and score-chase runs carry a replayable command log (`server.js` can re-simulate it; the shipped client keeps boards locally). This rules out client-side timers as authority and rules in an inspectable seed on the setup screen.

**Peaceful skyline.** A dawn-to-aurora palette of luminous stone, quiet ambience and soft chimes; failure is a slab sailing past into mist, not an explosion. This rules out alarms, red flashes, and shaking beyond a two-frame settle.

## 3. Player experience

Target player: someone who enjoys short precision loops (stacking, rhythm, golf-style par) on a phone or during a break, and returns for the daily seed and the 40-stage journey.

First 60 seconds (`native/main.ts`, `native/screens.ts`): the title screen shows Play, Daily challenge, Journey, Learn, How to play, Leaderboards, Settings. Play → mode cards (each states ranking, assists and length) → Journey list with only stage 1 unlocked. Starting "First Stone" toasts and announces its intro text ("Tap, click, or press Space when the sliding slab is over the tower. Anything hanging over the edge is trimmed away."), a 3-2-1 countdown ticks, and the moving slab is the only thing moving on screen. The first drop teaches trim by consequence; stage 3 introduces perfects ("Drop dead centre…"), stage 5 streaks, stage 8 the drop limit, stage 13 spare slabs, stage 15 the clock. Learn mode makes each rule a required action in five lessons. Help cards are available from title and pause.

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

Actions are declared in `starhermit.txt`; players rebind keys and pads in the runtime's Options › Controls, and the game reads actions, never keys.

| Action | Keys (default) | Gamepad (default) | Touch / pointer | Feedback |
|---|---|---|---|---|
| `drop` | Space, Enter, Numpad Enter | South (A) | tap the playfield (< 500 ms, < 24 px travel) or the tray's Drop | `ack` click, then `place`/`perfect`/`trim`/`miss` clip + caption, vibration 12/30 ms (miss 60 ms), announcement |
| `hint` | H | North (Y) | tray Hint | `hint` ping, band flashes 1.6 s |
| `undo` | U | West (X) | tray Undo | `undo` whoosh, tower rebuilds |
| `pause` | P | Start | tray Pause | `pause` hush, pause screen; P again resumes |
| `back` | Escape | East (B) | Back buttons | pauses a round, resumes from the pause screen, backs out of settings, help, board, setup and mode select |
| `camera` | C | Right stick press | — | refocus, announced |

Input locking: drops reach the rules only while `round.phase === 'active'` and no screen is open, so Space/Enter never fire from a focused menu button; a drop clears UI focus first. Hold-to-confirm delays a drop 180 ms and ignores repeats while armed. A pointer press right after a touch is ignored (one tap, one drop). Menus take keyboard (Tab, arrows, Enter, Escape), pad (D-pad/stick, South, East), pointer and touch through `starhermit:ui`; each screen focuses its first control when it opens. Backgrounding the window or tab (`onSuspend`) pauses the round and saves a snapshot. The tray and Keyboard help card show the effective keys (`bindingLabel`, normalized between native codes and browser keys).

## 7. Screens and UI flow

`native/main.ts showScreen()` opens one screen at a time and pushes the previous onto a back stack; `null` is play (HUD and tray).

```
boot → title → mode-select → setup ─start→ countdown → play ↔ paused → results
        │        │                              (Restart / Retry loops to countdown)
        ├ help   ├ (Daily / Journey / Learn shortcut straight to setup)
        ├ board  └ settings (also from pause)          results → next stage / retry / modes
        └ settings
```

- **Title**: over the authored dawn skyline (`assets/title-backdrop.webp`, drawn cover-fit under a dark scrim): title, tagline, Play, a Daily / Journey / Learn row, a How to play / Leaderboards / Settings row (rows wrap on narrow windows), Sign in with StarHermit for guests (the runtime's sign-in), Invite a friend when signed in (copies the invite link), the progress line and the account line.
- **Mode select**: six cards (two columns when they fit) with live status. **Setup**: info panel (ranked/assists/length; for daily the seed and constraints), the paged stage list (up to 8 rows a page, fewer on a short window so the page never scrolls; locked stages disabled, the current one outlined), pager, Start (daily, score chase) and Back.
- **Play**: HUD top (objective and stage; Height / Score / Streak, plus Drops left, Time, Spare slabs when the ruleset uses them), countdown numeral, caption strip above the tray, the toast under the HUD, the action tray bottom-centre.
- **Paused**: Resume, Settings, How to play, Restart round, Leave round (danger). **Results**: heading, headline with height and stars, six-row score table plus total, progress line, device-board rank, StarHermit leaderboard line (signed in), achievement badges, Retry / Next stage / Modes.
- **Settings**: Audio (captions) and Controls & access (left-handed tray, hold-to-confirm, perfect-window marker, haptics, Replay tutorial) fieldsets, a button to the runtime's Options (sound, graphics, language, controls, accessibility), Done. **Help** (six cards), **Leaderboard** (this device's score chase, then today's daily).

Layout (`native/screens.ts`, by the window's logical size in the safe area): screens centre their content and scroll when taller than the window. Wide (≥ 1024 px) widens the HUD margins. Phones (≤ 640 px) stack the HUD's two boxes, stretch the tray edge to edge with equal-width buttons (Drop 1.25 shares) and hide the key hints. Short landscape (≤ 480 px tall) pins the tray as a column at the right. The HUD also stacks whenever its two boxes would not fit one row (long translations). Buttons are ≥ 44 logical px. The runtime's interface size and text size scale everything.

## 8. Art direction

**Palette (style tokens, `tools/ui-style.css`).** Ink `#f0ece4`, dim ink `#b6b0a6`, background `#14101e`, panel `rgba(24,20,36,.92)`, line `#3a3450`, accent `#ffd9a0` (warm stone glow; primary buttons, title, countdown), accent-2 `#9fc8ff` (pale sky blue; status text), danger `#e86a5a`, focus ring `#fff2cc`. High contrast swaps to `#ffffff` / `#d8d8d8` / `#000000` / `#ffe600` / `#66ccff`.

**Scene themes (`Content.THEMES`, hex).**

| Theme | skyTop | skyBot | fog | stone | stoneDark | glow | skyline | ground | key |
|---|---|---|---|---|---|---|---|---|---|
| First Light | 2c3a5e | e8a06a | 8a7a8a | bfb4a6 | 8a8078 | ffd9a0 | 3a3450 | 241f2e | ffc98a |
| High Noon | 3a6aa8 | bfe0f0 | a8c0d0 | c8c2b4 | 94908a | fff2cc | 4a5a70 | 2a3038 | fff0d0 |
| Ember Skyline | 35244a | d0604a | 7a5460 | b0a098 | 7a6e68 | ffb066 | 2e2438 | 1e1826 | ff9a5a |
| Starlit Hour | 0c1026 | 2a3454 | 2a3050 | 9a94a8 | 6a6478 | 9fc8ff | 161a30 | 0e1020 | 8fb0e8 |
| Aurora Veil | 0e2430 | 2a6a5a | 2a5058 | a4b0ac | 6e7c78 | 9fffd0 | 142a30 | 0c1a1e | a0f0d0 |

**Shape language.** Everything is a rectangular block: slabs are 1 × 0.42 × 1 boxes scaled to their footprint, the skyline is 56 instanced boxes (24 with plain detail) on a ring 16–38 units out, the ground a wide stone cylinder. With detailed scenes the slabs are bevelled (rounded boxes, 0.035 radius) with a light clearcoat, the skyline sides carry procedural lit windows in the theme glow, and a thin luminous inlay ring circles the plinth top. The moving slab is the only object with an outline (edge lines) and the strongest emissive; perfect slabs keep a 0.45 emissive glow, ordinary ones 0.12. UI corners are 12 px, pills for badges and toasts.

**Hero.** The tower and its hovering slab, framed by a 38° perspective camera 13.5 units back and 6.2 units up, looking 0.9 units below a target that climbs `0.42` per level once the tower passes four slabs. ACES tone mapping at exposure 1.05, sRGB output, hemisphere fill (theme skyBot over `#3a3450`) and a warm theme key at intensity 1.5 casting soft shadows (the engine's view-based directional shadow, aimed at the tower's middle), a cool rim light from behind on detailed scenes, linear fog from 24 to 90 units in the theme's fog colour. Detailed scenes replace the flat sky colour with a gradient dome (skyTop above, skyBot haze at the horizon, a deep dusk tone below it, a soft glow toward the key light).

**Graphics.** The runtime's Options › Graphics owns the choice (Auto or one of ten levels), render scale, pixel-ratio cap, adaptive resolution, the frame-rate limit and readout. `native/quality.ts` maps the frame's quality tier (`frame().quality`) to the browser build's four presets and their effects: key-light shadows (off / 1024 / 2048 / 4096, held by the runtime to the level), GTAO contact darkening (`renderer.ao`: off, on, high), bloom limited to emissive highlights (`renderer.bloom`, threshold 0.92: the moving slab, perfect-slab glows, the plinth inlay), a display-space colour grade with vignette (`renderer.grade`), FXAA / SMAA / MSAA (`renderer.antialias`), image-based lighting from a hand-built room environment prefiltered by `PMREMGenerator.fromEquirectangular`, particles (off; stars and trim debris; plus rising glow motes), scene detail (plain boxes and flat sky, or the bevelled clearcoat slabs, WGSL gradient sky dome, lit skyline and rim light) and sky motion (drifting bands, twinkling stars, rising motes, a breathing glow on the moving slab; frozen by the runtime's Reduced motion). A tier change applies live.

| Preset (tier) | Slab material | Slab mesh | Skyline buildings | Stars (low particles = 40 %) | Motes | Debris pool | Bloom resolution |
|---|---|---|---|---|---|---|---|
| Low | Lambert | plain box | 16 | 250 | 0 | 4 | ½ |
| Balanced | Standard | rounded box, 2 bevel segments | 40 | 400 | 30 | 8 | ½ |
| High | clearcoat Physical | rounded box, 2 segments | 56 | 600 | 70 | 12 | ¾ |
| Ultra | clearcoat Physical | rounded box, 4 segments | 96 | 1200 | 140 | 16 | full |

**Typography.** `system-ui`; title 4 rem (2.2 rem on phones and short landscape) in accent with a soft glow; HUD labels 0.68 rem uppercase tracked; tabular numerals for all counters; countdown numeral 9 rem (4 rem compact) weight 800.

**Motion.** Camera rise uses a critically damped spring (k = 10) driven by frame dt, interruptible; trims add a shake of at most 0.06 units, misses 0.08, decaying at `0.02^dt`; perfect placement flashes the top slab's emissive to 1.2 (2.2 on win) and eases back over 0.8 s; trimmed pieces are pooled debris (cap 12) that fall under 9.8 u/s² and tumble. The runtime's Reduced motion snaps the camera, removes shake and debris rotation, freezes the ambient sky/star/mote/slab-glow animation and the UI's transitions; event timing and the hint band are unchanged.

**Authored visual assets the design calls for.** Cover art (`coverart.png`), a title backdrop (`assets/title-backdrop.webp`), a limestone grain for slabs (`assets/slab-stone.webp`), the PNG icon. No character art and no 3D model: the hero prop is procedural geometry by design.

Star and mote counts grow within the tier by the level (`frame().levelIndex`, ×1.64 a level above the tier's first, at most twice). Gameplay is identical on every level.

## 9. Audio direction

Mix: the runtime's buses and volumes (Options › Audio: master, music, effects, interface, mute, voice limit). Game events play on effects, the input click and voice cues (countdown, go, achievement, lesson) on interface, the music on music; the browser build's default levels (music 40 %, effects 80 %, ambience 35 %, voice 60 %) are folded into each sound's gain. Clips load once the mixer runs (in browsers after the first press). Every meaningful sound also emits a caption (setting) so nothing is audio-only.

Ambience is the authored 20 s skyline loop, faded in over 1.5 s once loaded over a low-passed (240 Hz) noise pad. Music is a generative pad: every 1.4 s one to four sine voices from C4–E♭4–G4–B♭4–C5, count and gain following `min(4, streak)`. The pad and voices are rendered once into clips (`createClip`), not played as a live synthesis graph, and a clip that failed loads again instead of a synthesized stand-in.

SFX event table (source for `sfx/manifest.txt`; event ids are keys of `SAMPLE_BY_EVENT` in `native/audio.ts`):

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

Nine locales ship for all player-facing text: **en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT** (`js/i18n.js`: screens, HUD, setup, results, help, boards, announcements, captions, refusal reasons, content names and texts, the account and leaderboard lines). `content.js` keeps English data; the client looks names up by id. The language is the runtime's interface language (`preferences().language`: the player's choice in Options › Language, else the account's or device's), mapped to the nearest shipped locale (`es-MX → es-419`, `en-AU → en-GB`, `fr → fr-FR`, `pt-PT → pt-BR`) and applied live: every screen re-renders in the new language next frame, the round and the scene untouched. en-GB uses "centre"; es-ES says "Intro"; fr-CA uses "pointage". Long labels wrap (paragraphs) and the HUD stacks when a translation does not fit one row.

## 11. Accessibility

- Keyboard-only and pad-only paths cover every screen (`starhermit:ui` focus navigation; each screen focuses its first control) and play (the actions); Escape / East always back out.
- Screen readers: the UI's accessibility tree names every control; `ui.announce` speaks placements, perfects, undo, hints, refusals (polite, with the board summary the browser build's mirror held: height, goal, next axis, width, score) and misses, stage intros and results (assertive).
- Captions: every audio event shows a caption for 1.8 s when Captions are on (default on).
- The runtime's Options give interface size, text size, high contrast and reduced motion: the UI follows them, and reduced motion snaps the camera, removes shake and debris tumble and freezes the sky/star/mote/slab-glow animation (event timing and the hint band are unchanged).
- Left-handed reverses the tray. Hold-to-confirm and haptics toggles exist. The perfect-window marker shows the band continuously wherever the ruleset allows hints.
- Targets: buttons ≥ 44 logical px.

## 12. StarHermit integration

Manifest: see §1. Capabilities `platform`, `storage`, `clipboard`. A guest makes no platform call.

| Feature | Behaviour |
|---|---|
| Identity | `player()` (the runtime signs in natively through the client and in browsers through the platform page or the runtime's Account dialog). Guests see "Local play — boards are kept on this device." and **Sign in with StarHermit** (`requestSignIn`); signed in, "Playing as <name> · progress synced" (or saving… / cloud sync unavailable from the save state). A session that ends shows "Signed out of StarHermit — progress stays on this device." |
| Cloud save | Progress is the game's save (`saves`, document `{ v: 1, progress }`, schema 1), on the device and in the account's slot, saved on every progress change. A conflict merges both sides (`BSSession.mergeProgress`: more stars per stage, best daily and overall scores, best height, larger perfects total, Learn completion, earliest achievement unlocks, theme unlocks); an account save that replaced the device's is merged in. Players of the browser build keep their progress: its slot `game:<slug>` (the SDK's zipped save.json with the same document) shows as foreign, is merged into the device's progress and replaced once (`replaceForeign`). |
| Settings | Captions, left-handed tray, hold-to-confirm, perfect-window marker and haptics are game settings (`settings`, `game.<key>`, synced with the account). The browser build's per-player keys are read once (`settings.onLegacy`): the game's toggles carry over unless set since, and every old key (volumes, graphics, reduced motion, contrast, text size, `ui.language`, …) is removed from the account. |
| Leaderboard | A finished daily or score-chase round, signed in, posts its total through `score-script.js` (a practice session whose socket carries `{ type: 'result', scores: { 'high-score': total } }`; the script range-checks it, integer 0–1,000,000, higher better) and the results show "Leaderboard rank: #N" (or posted / not posted). Journey, practice, challenge and Learn post nothing. |
| Device boards | Daily (one best row per player per date) and score chase (every run), 100 rows each, sorted by score, drops, duration, in `storage` (`bs.boards.v1`); rows carry the account id signed in, else a device id, and show profile names (cached) or "Player <id>", the player's own marked "You". |
| Invite | Signed in, **Invite a friend** copies the invite link (`clipboard.writeText` in the press) and confirms with a toast. |
| Reports, crashes, language, sound, graphics, controls | The runtime's own (Options, its error screen and report flow). |

Not used: StarHermit achievements (achievements live in the progress document), the `server.js` board/achievement routes, multiplayer, chat, voice. The daily date is the device's UTC date (the browser build's signed-in server-time offset has no engine counterpart).

## 13. Technical architecture

- **Modules**: `native/main.ts` is the entry; `native/classic.ts` installs a `localStorage` shim over `starhermit:storage` and loads `js/rng.js`, `rules.js`, `content.js`, `i18n.js`, `session.js`, `migrate.js` with `loadClassic`, so the shipped rules are the code the Node tests run.
- **Clock and loop**: `setFixedRate(60)`; each fixed step advances the session clock (`BSSession.setClock`) and runs `session.update()` (countdown, time-limit watchdog). Drops read the tick at the action. `onRender` interpolates the moving slab between steps, syncs the scene, steps the camera spring, debris and ambient motion, and builds the UI. Ticks advance only while active and the game runs (pause, a hidden window, the runtime's menus never move the slab).
- **Determinism and replay**: rules never read the clock; the replay envelope (schema 1, content and state versions, cfgId, date, seed, hashes, ordered commands, result) is what `server.js` re-validates.
- **Persistence**: `storage` holds `bs.settings.v1`, `bs.progress.v1` (the device cache of the save), `bs.snapshot.v1` (written on suspend and quit, restored paused at start), `bs.boards.v1`, `bs.playerId`; `saves` holds the progress; `settings` the game's toggles.
- **Rendering budgets**: per tier (§8); slab meshes pooled and hidden; debris pooled to the budget; stars and motes are two Points objects drawn to the budget's count.

## 14. Testing and acceptance criteria

`npm test` runs, in order:
- `tests/rules.test.js` (26 tests: determinism, perfect / trim / miss / spare life / axis alternation, win and par bonuses, limits, timeouts, resign, invalid commands, `legalActions`, hint-window property, serialization, replay hash, fuzzing, all content winnable by perfect play, golden hash) and `tests/server.test.js` (7 tests: replay validation and boards).
- `node --test tests/progress.test.js` (the merge, the browser save and settings migration, the injected clock) and `tests/i18n.test.js` (every key the client names or builds and every content name in the nine locales with matching placeholders; non-English locales translated).
- `tests/native.mjs`: the web index matches the files, `tsc` (no `skipLibCheck`), `starhermit check .` with no warnings, then every `tests/native/*.play` as a signed-out `--render-check`: `journey-stage` (Settings and How to play, then stage 1 won with eight perfect drops on the Drop key, results with three stars and Next stage, stage 2 started and left), `practice-actions` (hint, a finger's tap on Drop, Undo, Pause/resume with P, Leave round), `score-chase` (a ranked run to its results, the device-board rank, the Leaderboards screen) and `learn-lesson` (lesson 1 completed with Enter). Perfect-drop waits come from `node tools/perfect-plan.mjs <ruleset>`.

`npm run test:browser` (`tools/browser-play.mjs`) serves the packaged folder on loopback and plays it in headless Chrome at 1366×768 (keyboard into stage 1, drop, hint, pause), 390×844 (keys into a round, taps on the playfield drop, pause) and 844×390, failing on console errors or warnings or the runtime's error screen; `node ~/games/tools/engine-web-smoke.mjs .` is the shared start check. `npm run package` regenerates `index.html` and `starhermit-files.json` after every change.

QA bar: the first stage's intro is toasted and announced before play; every screen is reachable by pointer, touch, keyboard and pad; no console errors or warnings in the browser at any viewport; HUD, tray, countdown, score table and setup list are fully visible at 390×844, 844×390 and desktop sizes; ranked rounds record to the device boards; a guest makes no platform request.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `coverart.png` (1200×675, 158 KB) | store cover: luminous slab tower at dawn | FLUX.2 klein, seed 4701, 1200×688 cropped, 256-colour PNG | generated in this pass (replaced a generic placeholder) |
| `assets/title-backdrop.webp` (1536×864, 16 KB) | title-screen key art behind the scrim | FLUX.2 klein, seed 4702, webp q80 | generated in this pass, drawn under the title screen (`native/screens.ts`) |
| `assets/slab-stone.webp` (512×512, 5 KB) | limestone grain multiplied onto slab materials | FLUX.2 klein, seed 4703, webp q85 | generated in this pass, wired in `native/render.ts` with untextured fallback |
| `icon.png` (256×256) | launcher icon (stacked amber slabs); the browser favicons went with the browser client | authored SVG | shipped |
| `sfx/ui-ack … achievement-chime.opus` (12 clips) | one-shots per §9 | MOSS-SoundEffect v2, 100 steps | shipped |
| `sfx/ambience-skyline.opus` (20 s, 144 KB) | ambience loop | MOSS-SoundEffect v2, 60 steps, seed 3742432200 | generated in this pass, wired |
| `sfx/lesson-complete.opus` (2 s) | lesson goal reached | MOSS-SoundEffect v2, 60 steps, seed 1162542136 | generated in this pass, wired |
| `sfx/pause-hush.opus` (1 s) | pause opened | MOSS-SoundEffect v2, 60 steps, seed 3320720017 | generated in this pass, wired |
| `sfx/manifest.txt` / `manifest.json` / `manifest.md` | canonical binding table / regeneration source / prompt log | — | in sync, 15 entries |
| 3D models, character animation | not required: the hero prop is procedural | — | none by design |

## 16. Known limitations

- Theme `unlockStars` values in `Content.THEMES` are data only; themes are assigned per stage and never gated by stars.
- The in-game Leaderboard screen is local to the device; the StarHermit `high-score` board is reported only as the rank line on results.
- A restored snapshot loses its lesson context, so a Learn round resumed after a crash no longer tracks its goal.
- Score chase uses one immutable seed (intentional for fairness, but memorisable).
- Guests' progress from the browser build's `localStorage` cannot migrate (it was the browser's, not the account's); signed-in players' cloud saves do.
- The daily date follows the device's clock (UTC).

## Design intent not yet implemented

- Gate themes by `unlockStars` and surface unlocks on the results screen.
- Shared (cross-player) daily and score-chase boards.
- Resume Learn lessons from snapshots.
