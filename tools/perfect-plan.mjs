// Prints the ticks of perfect drops for a ruleset (journey stage id, practice
// or challenge id), dropping at the middle of each perfect window: the
// schedule tests/native/*.play scripts press the Drop key on. The round
// clock is the runtime's fixed steps, one tick a frame in a render check.
//   node tools/perfect-plan.mjs j01 [drops]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Rules = require('../js/rules.js');
const Content = require('../js/content.js');
const id = process.argv[2] || 'j01';
const all = [...Content.JOURNEY, ...Content.PRACTICE, ...Content.CHALLENGES, Content.SCORE_CHASE, ...Content.tutorialLessons().map((l) => l.cfg)];
const cfg = all.find((c) => c.id === id);
if (!cfg) { console.error(`no ruleset ${id}`); process.exit(1); }
let s = Rules.createGame(cfg);
const max = Number(process.argv[3] || 60);
const ticks = [];
for (let i = 0; i < max && !s.terminal; i++) {
  const w = Rules.perfectWindow(s.cfg, s.pending, s.slabs.length, s.tick + 1);
  const at = Math.floor((w.startTick + w.endTick) / 2);
  const r = Rules.applyCommand(s, { type: 'drop', id: 'p' + i, atTick: at });
  s = r.state;
  ticks.push({ at, window: [w.startTick, w.endTick] });
}
console.log(JSON.stringify({ id, terminal: s.terminal, score: s.score.total, ticks }));
