/* Balance Spire — audio: authored one-shot samples (sfx/*.opus, lazy-loaded
 * after the gesture unlock) with synthesized short transients as fallbacks.
 * Buses: music / effects / ambience / voice (independent volumes).
 * AV randomness uses the seeded STREAM_AV stream so replays of recorded
 * sessions keep the same pitch variants. No audio-only gameplay: every
 * meaningful sound also emits a caption via onCaption.
 * UMD: window.BSAudio / Node stub.
 */
(function (root, factory) {
  var RNG = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.BSRNG;
  var api = factory(RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BSAudio = api;
})(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  var ctx = null, buses = {}, master = null;
  var avRng = RNG.derive(1, RNG.STREAM_AV);
  var onCaption = null;
  var captionsOn = true;
  var ambienceNodes = null, musicTimer = null, musicIntensity = 0;

  function ensureCtx() {
    if (ctx || typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return ctx;
    var AC = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
    try { ctx = new AC(); } catch (e) { ctx = null; return null; }
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    ['music', 'effects', 'ambience', 'voice'].forEach(function (name) {
      var g = ctx.createGain();
      g.gain.value = name === 'music' ? 0.4 : name === 'ambience' ? 0.35 : 0.8;
      g.connect(master);
      buses[name] = g;
    });
    startAmbience();
    startMusic();
    return ctx;
  }

  // Call from any user gesture.
  function unlock() {
    if (!ensureCtx()) return;
    if (ctx.state === 'suspended') ctx.resume();
  }

  function setVolume(bus, v01) {
    if (buses[bus]) buses[bus].gain.value = Math.max(0, Math.min(1, v01));
  }

  function caption(text) {
    if (captionsOn && onCaption && text) onCaption(text);
  }

  // Short synthesized blip/thock builders --------------------------------

  function blip(bus, freq, dur, type, gain, slide) {
    if (!ctx) return;
    var t = ctx.currentTime;
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, slide), t + dur);
    g.gain.setValueAtTime(gain || 0.25, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(buses[bus]);
    o.start(t); o.stop(t + dur + 0.02);
  }

  function thock(bus, dur, gain, cutoff) {
    if (!ctx) return;
    var t = ctx.currentTime, len = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (avRng.next() * 2 - 1) * (1 - i / len);
    var src = ctx.createBufferSource(); src.buffer = buf;
    var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff || 900;
    var g = ctx.createGain(); g.gain.value = gain || 0.4;
    src.connect(f); f.connect(g); g.connect(buses[bus]);
    src.start(t);
  }

  function chime(freqs, bus, gain) {
    if (!ctx) return;
    freqs.forEach(function (fq, i) {
      setTimeout(function () { blip(bus, fq, 0.35, 'sine', gain || 0.2); }, i * 70);
    });
  }

  // ---------- authored sample one-shots ----------
  // Basenames mirror sfx/manifest.json (clips live at sfx/<name>.opus).
  // Each event prefers its sample; the synthesized path below stays as the
  // fallback while the clip is still loading or if fetch/decode failed.
  var SAMPLE_BY_EVENT = {
    ack: 'ui-ack', place: 'slab-place', perfect: 'perfect-chime',
    trim: 'overhang-trim', miss: 'slab-miss', win: 'stage-win',
    lose: 'round-lose', undo: 'drop-undo', hint: 'hint-ping',
    count: 'count-tick', go: 'count-go', achievement: 'achievement-chime',
    lesson: 'lesson-complete', pause: 'pause-hush'
  };
  var sampleCache = {}; // name -> { state: 'loading'|'ready'|'failed', buffer }

  function loadSample(name) {
    if (sampleCache[name] || !ctx || typeof fetch !== 'function') return;
    var entry = sampleCache[name] = { state: 'loading', buffer: null };
    fetch('sfx/' + name + '.opus').then(function (res) {
      if (!res.ok) throw new Error('http-' + res.status);
      return res.arrayBuffer();
    }).then(function (bytes) {
      return ctx.decodeAudioData(bytes);
    }).then(function (buffer) {
      entry.state = 'ready';
      entry.buffer = buffer;
    }).catch(function () {
      entry.state = 'failed';
    });
  }

  // Plays a ready sample through the effects bus and returns true. Otherwise
  // kicks off the lazy load (only possible after the gesture unlock created
  // the context) and returns false so the caller runs the synthesis fallback.
  function playSample(name) {
    if (!ctx) return false;
    var entry = sampleCache[name];
    if (entry && entry.state === 'ready') {
      var src = ctx.createBufferSource();
      src.buffer = entry.buffer;
      src.connect(buses.effects);
      src.start();
      return true;
    }
    if (!entry) loadSample(name);
    return false;
  }

  // ---------- event mapping ----------
  var lastAck = 0;
  function event(name, detail) {
    if (!ctx) return;
    var sample = SAMPLE_BY_EVENT[name];
    var sampled = sample ? playSample(sample) : false;
    switch (name) {
      case 'ack': // input acknowledgment, < 100 ms path
        if (!sampled) blip('effects', 660 + avRng.next() * 60, 0.06, 'triangle', 0.15);
        caption('');
        break;
      case 'place':
        if (!sampled) {
          thock('effects', 0.12, 0.5, 700 + avRng.next() * 300);
          blip('effects', 180, 0.12, 'sine', 0.3, 90);
        }
        caption('slab placed');
        break;
      case 'perfect':
        if (!sampled) {
          thock('effects', 0.1, 0.4, 900);
          chime([880, 1174, 1568], 'effects', 0.16);
        }
        caption('perfect placement');
        break;
      case 'trim':
        if (!sampled) thock('effects', 0.2, 0.35, 500);
        caption('overhang trimmed');
        break;
      case 'miss':
        if (!sampled) blip('effects', 220, 0.4, 'sawtooth', 0.2, 60);
        caption('slab missed');
        break;
      case 'win':
        if (!sampled) chime([523, 659, 784, 1046, 1318], 'music', 0.22);
        caption('stage complete');
        break;
      case 'lose':
        if (!sampled) chime([392, 311, 233], 'music', 0.2);
        caption('round over');
        break;
      case 'undo':
        if (!sampled) blip('effects', 500, 0.12, 'sine', 0.2, 750);
        caption('drop undone');
        break;
      case 'hint':
        if (!sampled) blip('effects', 1046, 0.15, 'sine', 0.14);
        caption('perfect window marked');
        break;
      case 'count':
        if (!sampled) blip('voice', 440, 0.12, 'square', 0.12);
        caption(String(detail || ''));
        break;
      case 'go':
        if (!sampled) blip('voice', 880, 0.25, 'square', 0.14);
        caption('go');
        break;
      case 'achievement':
        if (!sampled) chime([784, 988, 1175], 'voice', 0.18);
        caption('achievement: ' + (detail || ''));
        break;
      case 'lesson':
        if (!sampled) chime([523, 659, 784], 'voice', 0.16);
        caption('lesson complete');
        break;
      case 'pause':
        if (!sampled) blip('effects', 300, 0.1, 'sine', 0.12, 200);
        caption('');
        break;
    }
  }

  // ---------- ambience: quiet filtered-noise pad ----------
  function startAmbience() {
    if (!ctx || ambienceNodes) return;
    var len = ctx.sampleRate * 2;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0), r = RNG.derive(7, RNG.STREAM_AV);
    for (var i = 0; i < len; i++) d[i] = (r.next() * 2 - 1) * 0.3;
    var src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 240;
    var g = ctx.createGain(); g.gain.value = 0.6;
    src.connect(f); f.connect(g); g.connect(buses.ambience);
    src.start();
    ambienceNodes = { src: src, gain: g };
    startAmbienceSample();
  }

  // Authored skyline loop (sfx/ambience-skyline.opus) fades in over the
  // synthesized pad once decoded; if the fetch or decode fails the pad stays.
  function startAmbienceSample() {
    if (!ctx || typeof fetch !== 'function') return;
    fetch('sfx/ambience-skyline.opus').then(function (res) {
      if (!res.ok) throw new Error('http-' + res.status);
      return res.arrayBuffer();
    }).then(function (bytes) {
      return ctx.decodeAudioData(bytes);
    }).then(function (buffer) {
      if (!ambienceNodes || ambienceNodes.sample) return;
      var src = ctx.createBufferSource(); src.buffer = buffer; src.loop = true;
      var g = ctx.createGain(); g.gain.value = 0.9;
      src.connect(g); g.connect(buses.ambience);
      src.start();
      ambienceNodes.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.5);
      ambienceNodes.sample = { src: src, gain: g };
    }).catch(function () { /* keep the synthesized pad */ });
  }

  // ---------- adaptive music: slow two-note pad, intensity follows streak ----------
  var MUS_SCALE = [261.6, 311.1, 392.0, 466.2, 523.3];
  function startMusic() {
    if (!ctx || musicTimer) return;
    var step = 0;
    musicTimer = setInterval(function () {
      if (!ctx || ctx.state !== 'running' || document.hidden) return;
      var n = 1 + Math.min(3, musicIntensity);
      for (var i = 0; i < n; i++) {
        var fq = MUS_SCALE[(step + i * 2) % MUS_SCALE.length];
        blip('music', fq, 1.6, 'sine', 0.05 + 0.02 * musicIntensity);
      }
      step++;
    }, 1400);
  }
  function setMusicIntensity(streak) { musicIntensity = Math.max(0, Math.min(4, streak | 0)); }

  function duck(hidden) {
    if (!ctx) return;
    master.gain.linearRampToValueAtTime(hidden ? 0 : 1, ctx.currentTime + 0.2);
  }

  return {
    unlock: unlock,
    event: event,
    setVolume: setVolume,
    setMusicIntensity: setMusicIntensity,
    setSeed: function (seed) { avRng = RNG.derive(seed >>> 0, RNG.STREAM_AV); },
    setCaptions: function (on) { captionsOn = !!on; },
    onCaption: function (cb) { onCaption = cb; },
    duck: duck,
    get available() { return ensureCtx() !== null; }
  };
});
