// i18n.test.js — every string the engine client (native/*.ts) shows exists in
// the nine StarHermit locales (js/i18n.js) with the placeholders of US
// English: the keys its code names, the keys it builds (setup info per mode,
// captions, end reasons, refusal reasons) and every content name and text.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const I = require('../js/i18n.js');
const C = require('../js/content.js');

const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const dir = path.join(__dirname, '..', 'native');
const code = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
const used = new Set();
for (const m of code.matchAll(/\bt\("([A-Za-z0-9.\-]+)"(?!\s*\+)/g)) used.add(m[1]);
// keys built from data: setup info per mode, sound captions, end and refusal reasons
for (const mode of ['journey', 'practice', 'challenge', 'score', 'learn', 'daily']) used.add('setup.' + mode);
for (const c of ['slab placed', 'perfect placement', 'overhang trimmed', 'slab missed', 'stage complete', 'round over', 'drop undone', 'perfect window marked', 'go', 'lesson complete']) {
  used.add('cap.' + c);
  assert.ok(code.includes(`"${c}"`), `audio.ts captions "${c}"`);
}
for (const r of ['missed', 'move-limit', 'time-up', 'resigned']) used.add('why.' + r);
for (const r of ['undo-unavailable', 'hint-unavailable', 'game-ended', 'unknown-command', 'malformed-command', 'bad-tick', 'early-timeout', 'no-time-limit']) used.add('reason.' + r);
for (const c of C.JOURNEY) { used.add('j.' + c.id); if (c.intro) used.add('ji.' + c.id); }
for (const c of C.CHALLENGES) { used.add('ch.' + c.id); used.add('chi.' + c.id); }
for (const c of C.PRACTICE) used.add('pr.' + c.id);
for (const l of C.tutorialLessons()) { used.add('lt.' + l.id); used.add('lx.' + l.id); }
for (const a of C.ACHIEVEMENTS) used.add('ach.' + a.key);
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('ships the nine StarHermit locales', () => assert.deepEqual(I.LOCALES, LOCALES));
test('found the keys in code', () => assert.ok(used.size > 250, String(used.size)));
for (const loc of LOCALES) {
  test(`${loc}: every used key, matching placeholders`, () => {
    const T = I.STRINGS[loc];
    assert.deepEqual([...used].filter((k) => typeof T[k] !== 'string' || !T[k]), []);
    for (const k of used) assert.equal(vars(T[k]), vars(I.STRINGS['en-US'][k]), `${loc}.${k}`);
  });
}
test('content names in US English are the authored data', () => {
  const en = I.STRINGS['en-US'];
  for (const c of C.JOURNEY) assert.equal(en['j.' + c.id], c.name);
  for (const c of C.CHALLENGES) assert.equal(en['ch.' + c.id], c.name);
  for (const a of C.ACHIEVEMENTS) assert.equal(en['ach.' + a.key], a.name);
});
test('the non-English locales are translated', () => {
  for (const loc of LOCALES.filter((l) => !l.startsWith('en'))) {
    const same = [...used].filter((k) => I.STRINGS[loc][k] === I.STRINGS['en-US'][k] && !/^(ach|j|ch)\./.test(k));
    assert.ok(same.length < 25, `${loc}: ${same.join(', ')}`);
  }
});
