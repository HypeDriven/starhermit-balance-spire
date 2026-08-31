/* Balance Spire — versioned content: themes, journey, challenges,
 * practice presets, tutorial lessons, daily ruleset generator.
 * Shared browser (window.BSContent) / Node. Content is data-only; all
 * randomness enters through the config seed.
 */
(function (root, factory) {
  var RNG = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.BSRNG;
  var api = factory(RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BSContent = api;
})(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  var CONTENT_VERSION = 1;

  // ---------- themes (cosmetic only: sky, stone, glow, ambience) ----------
  var THEMES = [
    { id: 'dawn',   name: 'First Light',    unlockStars: 0,
      palette: { skyTop: 0x2c3a5e, skyBot: 0xe8a06a, fog: 0x8a7a8a,
                 stone: 0xbfb4a6, stoneDark: 0x8a8078, glow: 0xffd9a0,
                 skyline: 0x3a3450, ground: 0x241f2e, key: 0xffc98a } },
    { id: 'day',    name: 'High Noon',      unlockStars: 12,
      palette: { skyTop: 0x3a6aa8, skyBot: 0xbfe0f0, fog: 0xa8c0d0,
                 stone: 0xc8c2b4, stoneDark: 0x94908a, glow: 0xfff2cc,
                 skyline: 0x4a5a70, ground: 0x2a3038, key: 0xfff0d0 } },
    { id: 'dusk',   name: 'Ember Skyline',  unlockStars: 30,
      palette: { skyTop: 0x35244a, skyBot: 0xd0604a, fog: 0x7a5460,
                 stone: 0xb0a098, stoneDark: 0x7a6e68, glow: 0xffb066,
                 skyline: 0x2e2438, ground: 0x1e1826, key: 0xff9a5a } },
    { id: 'night',  name: 'Starlit Hour',   unlockStars: 55,
      palette: { skyTop: 0x0c1026, skyBot: 0x2a3454, fog: 0x2a3050,
                 stone: 0x9a94a8, stoneDark: 0x6a6478, glow: 0x9fc8ff,
                 skyline: 0x161a30, ground: 0x0e1020, key: 0x8fb0e8 } },
    { id: 'aurora', name: 'Aurora Veil',    unlockStars: 85,
      palette: { skyTop: 0x0e2430, skyBot: 0x2a6a5a, fog: 0x2a5058,
                 stone: 0xa4b0ac, stoneDark: 0x6e7c78, glow: 0x9fffd0,
                 skyline: 0x142a30, ground: 0x0c1a1e, key: 0xa0f0d0 } }
  ];

  // ---------- journey ----------
  // Compact authored rows:
  // [id, name, seed, baseW(units), speed(u/s), ramp, goalH, eps(mu),
  //  dropLimit, timeLimitSec, parDrops, parTimeSec, lives, themeIdx, intro]
  var J = [
    ['j01','First Stone',       701,2.0,1.1,0.00, 8,140, 0,  0,  9, 90,1,0,'Tap, click, or press Space when the sliding slab is over the tower. Anything hanging over the edge is trimmed away.'],
    ['j02','Second Course',     702,2.0,1.2,0.00, 9,130, 0,  0, 10, 90,1,0,''],
    ['j03','Center Line',       703,2.0,1.2,0.01,10,130, 0,  0, 11, 95,1,0,'Drop dead center for a perfect placement — perfects keep your full width and build a streak.'],
    ['j04','Gentle Sway',       704,2.0,1.3,0.01,10,120, 0,  0, 11, 90,1,0,''],
    ['j05','Streak of Light',   705,1.9,1.3,0.01,11,120, 0,  0, 12, 95,1,0,'Chain perfects for growing streak bonuses.'],
    ['j06','Steady Rise',       706,1.9,1.4,0.01,11,110, 0,  0, 12, 90,1,0,''],
    ['j07','Narrowing Odds',    707,1.9,1.4,0.02,12,110, 0,  0, 13, 95,1,0,''],
    ['j08','Measured Drops',    708,1.9,1.4,0.02,12,100,16,  0, 13, 95,1,0,'New: a drop limit. Misses spend drops too — 16 drops for 12 slabs.'],
    ['j09','Quickening',        709,1.8,1.5,0.02,13,100,17,  0, 14, 95,1,0,''],
    ['j10','Apprentice Trial',  710,1.8,1.5,0.02,14,100,18,150, 15,140,1,1,'MASTERY: a drop limit and the clock together.'],
    ['j11','Dusk Shift',        711,1.8,1.6,0.02,14, 95, 0,  0, 15,100,1,1,''],
    ['j12','Fine Margin',       712,1.8,1.6,0.02,15, 95,19,  0, 16,105,1,1,''],
    ['j13','Two Chances',       713,1.8,1.6,0.03,15, 90, 0,  0, 16,105,2,1,'You carry a spare slab: one clean miss is forgiven.'],
    ['j14','Glass Rhythm',      714,1.7,1.7,0.03,16, 90,20,  0, 17,105,1,1,''],
    ['j15','Against the Clock', 715,1.7,1.7,0.03,16, 85, 0,170, 17,160,1,2,'New: a time limit. The clock only runs while you play.'],
    ['j16','Slim Foundation',   716,1.7,1.8,0.03,17, 85, 0,  0, 18,110,1,2,'A narrower first stone — every trim hurts more.'],
    ['j17','High Wind',         717,1.7,1.8,0.03,17, 80,21,  0, 18,110,1,2,''],
    ['j18','Twin Pressure',     718,1.6,1.9,0.03,18, 80,22,190, 19,180,1,2,''],
    ['j19','Knife Edge',        719,1.6,1.9,0.04,18, 75, 0,  0, 19,110,1,2,''],
    ['j20','Journeyman Trial',  720,1.6,2.0,0.04,20, 75,24,200, 21,190,1,3,'MASTERY: fast slabs, tight limits, one life.'],
    ['j21','Night Course',      721,1.6,2.0,0.04,20, 70, 0,  0, 21,115,1,3,''],
    ['j22','Starlit Sprint',    722,1.6,2.1,0.04,21, 70, 0,200, 22,190,1,3,''],
    ['j23','Spare Slab',        723,1.5,2.1,0.04,21, 70,26,  0, 22,120,2,3,''],
    ['j24','Thin Air',          724,1.5,2.2,0.04,22, 65,27,  0, 23,120,1,3,''],
    ['j25','Pulse of the City', 725,1.5,2.2,0.05,22, 65, 0,215, 23,205,1,4,''],
    ['j26','Aurora Ascent',     726,1.5,2.3,0.05,23, 60,28,  0, 24,125,1,4,''],
    ['j27','Needlework',        727,1.5,2.3,0.05,23, 60, 0,  0, 24,125,1,4,''],
    ['j28','No Hesitation',     728,1.4,2.4,0.05,24, 60,29,230, 25,220,1,4,''],
    ['j29','Vertex',            729,1.4,2.4,0.05,24, 55, 0,  0, 25,125,1,4,''],
    ['j30','Artisan Trial',     730,1.4,2.5,0.05,26, 55,31,240, 27,230,1,0,'MASTERY: everything so far, at dawn.'],
    ['j31','Second Sunrise',    731,1.4,2.5,0.06,26, 55, 0,  0, 27,130,1,0,''],
    ['j32','Razor Course',      732,1.4,2.6,0.06,27, 50,32,  0, 28,130,1,0,''],
    ['j33','Clockwork Spire',   733,1.3,2.6,0.06,27, 50, 0,230, 28,220,1,1,''],
    ['j34','Last Light',        734,1.3,2.7,0.06,28, 50,34,  0, 29,135,1,1,''],
    ['j35','High Tension',      735,1.3,2.7,0.06,28, 45,34,250, 29,240,1,2,''],
    ['j36','Whisper Width',     736,1.3,2.8,0.07,29, 45, 0,  0, 30,135,1,2,''],
    ['j37','Storm Approaches',  737,1.2,2.8,0.07,29, 45,35,  0, 30,140,2,3,''],
    ['j38','Zenith Line',       738,1.2,2.9,0.07,30, 40,36,260, 31,250,1,3,''],
    ['j39','Sky Needle',        739,1.2,3.0,0.07,30, 40, 0,  0, 31,140,1,4,''],
    ['j40','Master of the Spire',740,1.2,3.1,0.08,32, 40,38,270, 33,260,1,4,'MASTERY: the definitive ascent. One life, thin air, no mercy.']
  ];

  function expandLevel(row, idx) {
    return {
      id: row[0], version: CONTENT_VERSION, kind: 'journey', index: idx,
      name: row[1], seed: row[2],
      base: { w: row[3], d: row[3] },
      speed: row[4], speedRamp: row[5],
      goalHeight: row[6], eps: row[7],
      dropLimit: row[8] || 0, timeLimitSec: row[9] || 0,
      par: { drops: row[10], timeSec: row[11] },
      lives: row[12] || 1,
      mechanics: { undo: true, hint: true },
      endless: false,
      theme: THEMES[row[13]].id,
      intro: row[14] || '',
      mastery: /MASTERY/.test(row[14] || '')
    };
  }

  var JOURNEY = J.map(expandLevel);

  // ---------- challenges ----------
  var CHALLENGES = [
    { id: 'c1', name: 'Perfect Ten',     seed: 801, kind: 'challenge',
      base: { w: 1.8, d: 1.8 }, speed: 1.6, speedRamp: 0.02, goalHeight: 10, eps: 70,
      dropLimit: 10, timeLimitSec: 0, par: { drops: 10, timeSec: 120 }, lives: 1,
      mechanics: { undo: false, hint: true }, endless: false, theme: 'dawn',
      intro: 'Ten slabs, ten drops. Every placement must land — no misses allowed.' },
    { id: 'c2', name: 'Ninety Seconds',  seed: 802, kind: 'challenge',
      base: { w: 1.9, d: 1.9 }, speed: 1.8, speedRamp: 0.03, goalHeight: 18, eps: 90,
      dropLimit: 0, timeLimitSec: 90, par: { drops: 19, timeSec: 85 }, lives: 2,
      mechanics: { undo: false, hint: true }, endless: false, theme: 'day',
      intro: 'Reach 18 slabs before the clock runs out.' },
    { id: 'c3', name: 'Hairline',        seed: 803, kind: 'challenge',
      base: { w: 1.4, d: 1.4 }, speed: 2.0, speedRamp: 0.04, goalHeight: 16, eps: 40,
      dropLimit: 22, timeLimitSec: 0, par: { drops: 18, timeSec: 150 }, lives: 1,
      mechanics: { undo: false, hint: false }, endless: false, theme: 'dusk',
      intro: 'A thread-thin foundation and a razor perfect window. No hints.' },
    { id: 'c4', name: 'One Breath',      seed: 804, kind: 'challenge',
      base: { w: 1.7, d: 1.7 }, speed: 2.2, speedRamp: 0.05, goalHeight: 14, eps: 80,
      dropLimit: 14, timeLimitSec: 60, par: { drops: 14, timeSec: 55 }, lives: 1,
      mechanics: { undo: false, hint: false }, endless: false, theme: 'night',
      intro: '14 perfect-required drops inside one minute. No room to breathe.' },
    { id: 'c5', name: 'Marathon Course', seed: 805, kind: 'challenge',
      base: { w: 1.6, d: 1.6 }, speed: 2.2, speedRamp: 0.06, goalHeight: 40, eps: 70,
      dropLimit: 52, timeLimitSec: 0, par: { drops: 43, timeSec: 300 }, lives: 2,
      mechanics: { undo: false, hint: true }, endless: false, theme: 'aurora',
      intro: 'Forty slabs with ever-quickening sway. Endurance, not burst.' },
    { id: 'c6', name: 'Grand Constraint',seed: 806, kind: 'challenge',
      base: { w: 1.5, d: 1.5 }, speed: 2.6, speedRamp: 0.07, goalHeight: 24, eps: 45,
      dropLimit: 28, timeLimitSec: 150, par: { drops: 25, timeSec: 140 }, lives: 1,
      mechanics: { undo: false, hint: false }, endless: false, theme: 'night',
      intro: 'Drop limit, time limit, hairline window, no assists. The full test.' }
  ].map(function (c) { c.version = CONTENT_VERSION; return c; });

  // ---------- practice presets ----------
  var PRACTICE = [
    { seed: 910, id: 'calm',   name: 'Calm',
      base: { w: 2.0, d: 2.0 }, speed: 1.1, speedRamp: 0.01, goalHeight: 12, eps: 140,
      dropLimit: 0, timeLimitSec: 0, par: { drops: 13, timeSec: 120 }, lives: 3,
      mechanics: { undo: true, hint: true }, endless: false },
    { seed: 920, id: 'steady', name: 'Steady',
      base: { w: 1.8, d: 1.8 }, speed: 1.6, speedRamp: 0.03, goalHeight: 18, eps: 90,
      dropLimit: 0, timeLimitSec: 0, par: { drops: 19, timeSec: 150 }, lives: 2,
      mechanics: { undo: true, hint: true }, endless: false },
    { seed: 930, id: 'swift',  name: 'Swift',
      base: { w: 1.6, d: 1.6 }, speed: 2.2, speedRamp: 0.05, goalHeight: 24, eps: 60,
      dropLimit: 0, timeLimitSec: 0, par: { drops: 26, timeSec: 180 }, lives: 1,
      mechanics: { undo: true, hint: true }, endless: false },
    { seed: 940, id: 'endless',name: 'Endless rehearsal',
      base: { w: 1.8, d: 1.8 }, speed: 1.7, speedRamp: 0.04, goalHeight: 0, eps: 80,
      dropLimit: 0, timeLimitSec: 0, par: null, lives: 1,
      mechanics: { undo: true, hint: true }, endless: true }
  ].map(function (p) { p.version = CONTENT_VERSION; p.kind = 'practice'; return p; });

  // ---------- score chase ruleset (endless, ranked) ----------
  var SCORE_CHASE = {
    id: 'score-std', version: CONTENT_VERSION, seed: 950, kind: 'score', name: 'Endless Spire',
    base: { w: 1.8, d: 1.8 }, speed: 1.8, speedRamp: 0.05, goalHeight: 0, eps: 80,
    dropLimit: 0, timeLimitSec: 0, par: null, lives: 1,
    mechanics: { undo: false, hint: false }, endless: true, theme: 'night',
    intro: 'The tower rises until a slab sails past. Play for height and precision.'
  };

  // ---------- daily ----------
  // One immutable ruleset per UTC day, derived purely from the date string.
  function dailyConfig(dateStr) {
    var seed = RNG.hashString('balance-spire-daily-v' + CONTENT_VERSION + '-' + dateStr);
    var day = Math.floor(Date.parse(dateStr + 'T00:00:00Z') / 86400000);
    var rot = ((day % 7) + 7) % 7;
    return {
      id: 'daily-' + dateStr, version: CONTENT_VERSION, kind: 'daily',
      name: 'Daily ' + dateStr, seed: seed, date: dateStr,
      base: { w: 1.9 - (rot % 3) * 0.15, d: 1.9 - (rot % 3) * 0.15 },
      speed: 1.6 + (rot % 4) * 0.25, speedRamp: 0.03 + (rot % 3) * 0.01,
      goalHeight: 18 + (rot % 3) * 4,
      eps: 100 - (rot % 4) * 15,
      dropLimit: rot >= 3 ? 18 + (rot % 3) * 4 + 5 : 0,
      timeLimitSec: rot === 6 ? 200 : 0,
      par: { drops: 19 + (rot % 3) * 4, timeSec: 170 },
      lives: rot === 2 || rot === 5 ? 2 : 1,
      mechanics: { undo: false, hint: true }, endless: false,
      theme: THEMES[rot % THEMES.length].id,
      intro: 'One shared seed for everyone, today only. Ranked — no undo.'
    };
  }

  function utcDateString(nowMs) {
    var d = new Date(nowMs == null ? Date.now() : nowMs);
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }

  // ---------- tutorial (Learn) ----------
  function tutorialLessons() {
    var base = { version: CONTENT_VERSION, kind: 'tutorial',
      dropLimit: 0, timeLimitSec: 0, par: null, endless: false, goalHeight: 0 };
    return [
      { id: 't1', title: 'Set a stone',
        text: 'A slab slides above the foundation. Tap the playfield, click, or press Space to drop it. Land three slabs to finish the lesson.',
        goal: { event: 'place', count: 3 },
        cfg: Object.assign({}, base, { id: 't1', seed: 9701,
          base: { w: 2.2, d: 2.2 }, speed: 0.9, speedRamp: 0, eps: 150, lives: 5,
          mechanics: { undo: false, hint: false } }) },
      { id: 't2', title: 'True center',
        text: 'Drop when the slab is dead center for a perfect placement — no trimming, extra points, and a streak. Score two perfects.',
        goal: { event: 'perfect', count: 2 },
        cfg: Object.assign({}, base, { id: 't2', seed: 9702,
          base: { w: 2.0, d: 2.0 }, speed: 1.0, speedRamp: 0, eps: 160, lives: 5,
          mechanics: { undo: false, hint: true } }) },
      { id: 't3', title: 'Shaved edges',
        text: 'Off-center drops are trimmed: the tower keeps only the overlap and the next slab travels the other way. Recover and place four slabs.',
        goal: { event: 'place', count: 4 },
        cfg: Object.assign({}, base, { id: 't3', seed: 9703,
          base: { w: 1.9, d: 1.9 }, speed: 1.3, speedRamp: 0.01, eps: 70, lives: 5,
          mechanics: { undo: false, hint: true } }) },
      { id: 't4', title: 'The clock and the limit',
        text: 'Some stages limit your drops or your time. Reach six slabs within ten drops — misses spend drops too.',
        goal: { event: 'win', count: 1 },
        cfg: Object.assign({}, base, { id: 't4', seed: 9704, goalHeight: 6,
          base: { w: 2.0, d: 2.0 }, speed: 1.2, speedRamp: 0.01, eps: 110, lives: 5,
          dropLimit: 10, mechanics: { undo: false, hint: true } }) },
      { id: 't5', title: 'Second chances',
        text: 'In relaxed modes you can undo a drop (U) or ask for a hint (H) that marks the perfect window. Place a slab, then undo it.',
        goal: { event: 'undo', count: 1 },
        cfg: Object.assign({}, base, { id: 't5', seed: 9705,
          base: { w: 2.0, d: 2.0 }, speed: 1.1, speedRamp: 0, eps: 120, lives: 5,
          mechanics: { undo: true, hint: true } }) }
    ];
  }

  // ---------- achievements (stable lowercase keys, idempotent) ----------
  var ACHIEVEMENTS = [
    { key: 'first-place',   name: 'First Stone',      desc: 'Place your first slab.' },
    { key: 'first-perfect', name: 'True Center',      desc: 'Score your first perfect placement.' },
    { key: 'streak-5',      name: 'Streak of Light',  desc: 'Chain 5 perfect placements.' },
    { key: 'height-30',     name: 'Cloud Line',       desc: 'Build a tower 30 slabs tall in one round.' },
    { key: 'journey-half',  name: 'Half the Skyline', desc: 'Finish 20 journey stages.' },
    { key: 'journey-done',  name: 'Master of the Spire', desc: 'Finish all 40 journey stages.' },
    { key: 'daily-7',       name: 'Regular',          desc: 'Finish 7 daily challenges.' },
    { key: 'score-1500',    name: 'Luminous',         desc: 'Score 1500+ in a single round.' },
    { key: 'perfects-100',  name: 'Steady Hand',      desc: 'Score 100 perfect placements across all play.' }
  ];

  return {
    CONTENT_VERSION: CONTENT_VERSION,
    THEMES: THEMES,
    JOURNEY: JOURNEY,
    CHALLENGES: CHALLENGES,
    PRACTICE: PRACTICE,
    SCORE_CHASE: SCORE_CHASE,
    ACHIEVEMENTS: ACHIEVEMENTS,
    dailyConfig: dailyConfig,
    utcDateString: utcDateString,
    tutorialLessons: tutorialLessons
  };
});
