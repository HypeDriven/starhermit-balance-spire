/* Balance Spire — Graphics section of the Settings screen.
 * Builds the controls into #gfx-settings, keeps them in sync with
 * BSSession.settings.graphics (saved with the other settings under
 * bs.settings.v1) and applies every change live through BSRender.setGraphics.
 * Strings for this section are localized (en-US, en-GB, es-419, es-ES, de-DE,
 * fr-FR, fr-CA, pt-BR, it-IT), chosen from the browser's languages.
 * Browser only: window.BSGraphicsPanel.
 */
(function (root) {
  'use strict';

  var EN = {
    graphics: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {tier})',
    renderScale: 'Render scale', fromPreset: 'From preset ({tier})',
    adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
    postFailed: 'Post-processing is unavailable on this device, so effects render without it.',
    presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
    cats: { shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade',
      antialias: 'Anti-aliasing', particles: 'Particles', reflections: 'Reflections',
      detail: 'Scene detail', background: 'Sky motion' },
    tiers: { off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', fxaa: 'FXAA',
      smaa: 'SMAA', msaa: 'MSAA', plain: 'Plain', detailed: 'Detailed', static: 'Static',
      animated: 'Animated' },
    describe: { noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion',
      aoFull: 'full ambient occlusion', bloom: 'bloom', reflections: 'reflections',
      particles: '{tier} particles', tiers: { low: 'low', high: 'high' } }
  };

  function variant(base, patch) {
    var out = JSON.parse(JSON.stringify(base));
    Object.keys(patch).forEach(function (k) {
      if (patch[k] && typeof patch[k] === 'object') Object.assign(out[k], patch[k]);
      else out[k] = patch[k];
    });
    return out;
  }

  var ES = {
    graphics: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})',
    renderScale: 'Escala de renderizado', fromPreset: 'Según el ajuste ({tier})',
    adaptive: 'Resolución adaptativa', showFps: 'Mostrar cuadros por segundo',
    postFailed: 'El posprocesado no está disponible en este dispositivo; los efectos se muestran sin él.',
    presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    cats: { shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Gradación de color',
      antialias: 'Antialiasing', particles: 'Partículas', reflections: 'Reflejos',
      detail: 'Detalle de la escena', background: 'Movimiento del cielo' },
    tiers: { off: 'Desactivado', on: 'Activado', low: 'Bajo', medium: 'Medio', high: 'Alto', fxaa: 'FXAA',
      smaa: 'SMAA', msaa: 'MSAA', plain: 'Sencillo', detailed: 'Detallado', static: 'Estático',
      animated: 'Animado' },
    describe: { noShadows: 'sin sombras', shadows: 'sombras {n}²', ao: 'oclusión ambiental',
      aoFull: 'oclusión ambiental completa', bloom: 'resplandor', reflections: 'reflejos',
      particles: 'partículas: {tier}', tiers: { low: 'bajo', high: 'alto' } }
  };

  var FR = {
    graphics: 'Graphismes', quality: 'Qualité', auto: 'Auto (détectée : {tier})',
    renderScale: 'Échelle de rendu', fromPreset: 'Selon le préréglage ({tier})',
    adaptive: 'Résolution adaptative', showFps: 'Afficher les images par seconde',
    postFailed: 'Le post-traitement n’est pas disponible sur cet appareil ; les effets s’affichent sans lui.',
    presets: { low: 'Basse', balanced: 'Équilibrée', high: 'Élevée', ultra: 'Ultra' },
    cats: { shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage des couleurs',
      antialias: 'Anticrénelage', particles: 'Particules', reflections: 'Reflets',
      detail: 'Détail de la scène', background: 'Mouvement du ciel' },
    tiers: { off: 'Désactivé', on: 'Activé', low: 'Bas', medium: 'Moyen', high: 'Élevé', fxaa: 'FXAA',
      smaa: 'SMAA', msaa: 'MSAA', plain: 'Simple', detailed: 'Détaillé', static: 'Statique',
      animated: 'Animé' },
    describe: { noShadows: 'sans ombres', shadows: 'ombres {n}²', ao: 'occlusion ambiante',
      aoFull: 'occlusion ambiante complète', bloom: 'halo lumineux', reflections: 'reflets',
      particles: 'particules : {tier}', tiers: { low: 'bas', high: 'élevé' } }
  };

  var STRINGS = {
    'en-US': EN,
    'en-GB': variant(EN, { cats: { grade: 'Colour grade' } }),
    'es-419': ES,
    'es-ES': variant(ES, { showFps: 'Mostrar fotogramas por segundo',
      fromPreset: 'Según el preajuste ({tier})', cats: { antialias: 'Suavizado de bordes' } }),
    'de-DE': {
      graphics: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})',
      renderScale: 'Renderskalierung', fromPreset: 'Wie Voreinstellung ({tier})',
      adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
      postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; Effekte werden ohne sie dargestellt.',
      presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
      cats: { shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchteffekt', grade: 'Farbkorrektur',
        antialias: 'Kantenglättung', particles: 'Partikel', reflections: 'Reflexionen',
        detail: 'Szenendetails', background: 'Himmelsbewegung' },
      tiers: { off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', fxaa: 'FXAA',
        smaa: 'SMAA', msaa: 'MSAA', plain: 'Einfach', detailed: 'Detailliert', static: 'Statisch',
        animated: 'Animiert' },
      describe: { noShadows: 'keine Schatten', shadows: '{n}²-Schatten', ao: 'Umgebungsverdeckung',
        aoFull: 'volle Umgebungsverdeckung', bloom: 'Leuchteffekt', reflections: 'Reflexionen',
        particles: 'Partikel: {tier}', tiers: { low: 'niedrig', high: 'hoch' } }
    },
    'fr-FR': FR,
    'fr-CA': variant(FR, { showFps: 'Afficher la fréquence d’images' }),
    'pt-BR': {
      graphics: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {tier})',
      renderScale: 'Escala de renderização', fromPreset: 'Conforme a predefinição ({tier})',
      adaptive: 'Resolução adaptativa', showFps: 'Mostrar taxa de quadros',
      postFailed: 'O pós-processamento não está disponível neste dispositivo; os efeitos são exibidos sem ele.',
      presets: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
      cats: { shadows: 'Sombras', ao: 'Oclusão de ambiente', bloom: 'Brilho', grade: 'Correção de cor',
        antialias: 'Antisserrilhamento', particles: 'Partículas', reflections: 'Reflexos',
        detail: 'Detalhe da cena', background: 'Movimento do céu' },
      tiers: { off: 'Desligado', on: 'Ligado', low: 'Baixo', medium: 'Médio', high: 'Alto', fxaa: 'FXAA',
        smaa: 'SMAA', msaa: 'MSAA', plain: 'Simples', detailed: 'Detalhado', static: 'Estático',
        animated: 'Animado' },
      describe: { noShadows: 'sem sombras', shadows: 'sombras {n}²', ao: 'oclusão de ambiente',
        aoFull: 'oclusão de ambiente completa', bloom: 'brilho', reflections: 'reflexos',
        particles: 'partículas: {tier}', tiers: { low: 'baixo', high: 'alto' } }
    },
    'it-IT': {
      graphics: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {tier})',
      renderScale: 'Scala di rendering', fromPreset: 'Come da preimpostazione ({tier})',
      adaptive: 'Risoluzione adattiva', showFps: 'Mostra frequenza fotogrammi',
      postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; gli effetti vengono mostrati senza.',
      presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
      cats: { shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore',
        antialias: 'Antialiasing', particles: 'Particelle', reflections: 'Riflessi',
        detail: 'Dettaglio scena', background: 'Movimento del cielo' },
      tiers: { off: 'Disattivato', on: 'Attivato', low: 'Basso', medium: 'Medio', high: 'Alto', fxaa: 'FXAA',
        smaa: 'SMAA', msaa: 'MSAA', plain: 'Semplice', detailed: 'Dettagliato', static: 'Statico',
        animated: 'Animato' },
      describe: { noShadows: 'nessuna ombra', shadows: 'ombre {n}²', ao: 'occlusione ambientale',
        aoFull: 'occlusione ambientale completa', bloom: 'bagliore', reflections: 'riflessi',
        particles: 'particelle: {tier}', tiers: { low: 'basso', high: 'alto' } }
    }
  };
  var PRIMARY = { en: 'en-US', es: 'es-419', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR', it: 'it-IT' };

  function pickLocale() {
    var langs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || 'en-US'];
    for (var i = 0; i < langs.length; i++) {
      var l = String(langs[i]);
      var exact = Object.keys(STRINGS).find(function (k) { return k.toLowerCase() === l.toLowerCase(); });
      if (exact) return exact;
      var p = PRIMARY[l.split('-')[0].toLowerCase()];
      if (p) return p;
    }
    return 'en-US';
  }

  var S = null, R = null, G = null, T = EN, host = null, ids = {};

  function saved() { return S.settings.graphics || (S.settings.graphics = {}); }
  function commit(next) {
    S.settings.graphics = next;
    S.saveSettings();
    R.setGraphics(next);
    refresh();
  }

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }
  function row(labelText, control, forId) {
    var l = el('label', { 'for': forId, 'class': 'gfx-row' });
    l.appendChild(el('span', null, labelText));
    l.appendChild(control);
    return l;
  }

  function build() {
    host.textContent = '';
    host.setAttribute('lang', locale);
    host.appendChild(el('legend', null, T.graphics));

    var preset = el('select', { id: 'gfx-preset', 'data-gfx': 'preset' });
    preset.addEventListener('change', function () {
      commit(G.choosePreset(saved(), preset.value === 'auto' ? undefined : preset.value));
    });
    host.appendChild(row(T.quality, preset, 'gfx-preset'));

    var scaleWrap = el('span', { 'class': 'gfx-scale' });
    var scale = el('input', { id: 'gfx-scale', type: 'range', min: '50', max: '200', step: '10', 'data-gfx': 'render_scale' });
    var out = el('output', { id: 'gfx-scale-out', 'for': 'gfx-scale' });
    scale.addEventListener('input', function () { out.textContent = scale.value + '%'; });
    scale.addEventListener('change', function () {
      var n = Object.assign({}, saved()); n.render_scale = Number(scale.value) / 100; commit(n);
    });
    scaleWrap.appendChild(scale); scaleWrap.appendChild(out);
    host.appendChild(row(T.renderScale, scaleWrap, 'gfx-scale'));

    var grid = el('div', { 'class': 'gfx-cats' });
    Object.keys(G.CATEGORIES).forEach(function (cat) {
      var sel = el('select', { id: 'gfx-' + cat, 'data-gfx-cat': cat });
      sel.addEventListener('change', function () {
        var n = Object.assign({}, saved());
        if (sel.value === 'preset') delete n[cat]; else n[cat] = sel.value;
        commit(n);
      });
      grid.appendChild(row(T.cats[cat], sel, 'gfx-' + cat));
    });
    host.appendChild(grid);

    [['adaptive', 'gfx-adaptive', T.adaptive], ['show_fps', 'gfx-fps', T.showFps]].forEach(function (d) {
      var cb = el('input', { id: d[1], type: 'checkbox', 'data-gfx': d[0] });
      cb.addEventListener('change', function () {
        var n = Object.assign({}, saved()); n[d[0]] = cb.checked; commit(n);
      });
      var l = el('label', { 'for': d[1], 'class': 'gfx-check' });
      l.appendChild(cb); l.appendChild(document.createTextNode(' ' + d[2]));
      host.appendChild(l);
    });

    host.appendChild(el('p', { id: 'gfx-summary', 'class': 'dim gfx-summary' }));
    var note = el('p', { id: 'gfx-post-note', 'class': 'gfx-note' }, T.postFailed);
    note.hidden = true;
    host.appendChild(note);
    ['gfx-preset', 'gfx-scale', 'gfx-scale-out', 'gfx-adaptive', 'gfx-fps', 'gfx-summary', 'gfx-post-note']
      .forEach(function (id) { ids[id] = document.getElementById(id); });
  }

  function fillOptions(sel, items) {
    var cur = sel.value;
    sel.textContent = '';
    items.forEach(function (it) { sel.appendChild(el('option', { value: it[0] }, it[1])); });
    sel.value = items.some(function (it) { return it[0] === cur; }) ? cur : items[0][0];
  }

  function refresh() {
    if (!host) return;
    var s = saved();
    var info = R.graphicsInfo ? R.graphicsInfo() : null;
    var detected = info ? info.detected : 'balanced';
    var r = info ? info.resolved : G.resolve(s, detected);
    var p = ids['gfx-preset'];
    fillOptions(p, [['auto', T.auto.replace('{tier}', T.presets[detected])]].concat(
      G.PRESETS.map(function (k) { return [k, T.presets[k]]; })));
    p.value = G.PRESETS.indexOf(s.preset) >= 0 ? s.preset : 'auto';
    var pct = Math.round((Number(s.render_scale) || 1) * 100);
    ids['gfx-scale'].value = String(pct);
    ids['gfx-scale-out'].textContent = pct + '%';
    Object.keys(G.CATEGORIES).forEach(function (cat) {
      var sel = document.getElementById('gfx-' + cat);
      var tier = G.presetTier(r.preset, cat);
      fillOptions(sel, [['preset', T.fromPreset.replace('{tier}', T.tiers[tier] || tier)]].concat(
        G.CATEGORIES[cat].map(function (t) { return [t, T.tiers[t] || t]; })));
      sel.value = G.CATEGORIES[cat].indexOf(s[cat]) >= 0 ? s[cat] : 'preset';
    });
    ids['gfx-adaptive'].checked = s.adaptive !== false;
    ids['gfx-fps'].checked = !!s.show_fps;
    updateSummary();
  }

  function updateSummary() {
    var info = R.graphicsInfo ? R.graphicsInfo() : null;
    if (!info) { ids['gfx-summary'].textContent = ''; return; }
    ids['gfx-summary'].textContent = info.gpu + ' · ' + G.describe(info.resolved, info.pixels, T.describe);
    ids['gfx-post-note'].hidden = !info.postFailed;
    document.body.dataset.gfxPreset = info.resolved.preset;
  }

  var locale = 'en-US';
  function init(session, render) {
    S = session; R = render; G = root.BSGfx;
    host = document.getElementById('gfx-settings');
    if (!host || !G) return;
    locale = pickLocale();
    T = STRINGS[locale] || EN;
    build();
    refresh();
    // Keep the summary (pixels, adaptive changes, post status) current while visible.
    setInterval(function () {
      if (host.offsetParent !== null) updateSummary();
    }, 1000);
  }

  // StarHermit account strings (sign-in, invite, toast, title status line).
  var ACCOUNT = {
    "en-US": {
      "signIn": "Sign in with StarHermit",
      "invite": "Invite a friend",
      "inviteCopied": "Invite link copied to the clipboard.",
      "inviteFailed": "Could not copy the invite link.",
      "offline": "Offline — progress is stored on this device.",
      "playingAs": "Playing as {name}",
      "synced": "progress synced",
      "saving": "saving…",
      "syncOff": "cloud sync unavailable",
      "signedOut": "Signed out of StarHermit — progress stays on this device.",
      "lbPosting": "Posting score to the leaderboard…",
      "lbRank": "Leaderboard rank: #{rank}",
      "lbPosted": "Score posted to the leaderboard.",
      "lbNotPosted": "Score not posted to the leaderboard."
    },
    "en-GB": {
      "signIn": "Sign in with StarHermit",
      "invite": "Invite a friend",
      "inviteCopied": "Invite link copied to the clipboard.",
      "inviteFailed": "Could not copy the invite link.",
      "offline": "Offline — progress is stored on this device.",
      "playingAs": "Playing as {name}",
      "synced": "progress synced",
      "saving": "saving…",
      "syncOff": "cloud sync unavailable",
      "signedOut": "Signed out of StarHermit — progress stays on this device.",
      "lbPosting": "Posting score to the leaderboard…",
      "lbRank": "Leaderboard rank: #{rank}",
      "lbPosted": "Score posted to the leaderboard.",
      "lbNotPosted": "Score not posted to the leaderboard."
    },
    "es-419": {
      "signIn": "Iniciar sesión con StarHermit",
      "invite": "Invitar a un amigo",
      "inviteCopied": "Enlace de invitación copiado al portapapeles.",
      "inviteFailed": "No se pudo copiar el enlace de invitación.",
      "offline": "Sin conexión: el progreso se guarda en este dispositivo.",
      "playingAs": "Jugando como {name}",
      "synced": "progreso sincronizado",
      "saving": "guardando…",
      "syncOff": "sincronización en la nube no disponible",
      "signedOut": "Sesión de StarHermit cerrada: el progreso se queda en este dispositivo.",
      "lbPosting": "Enviando la puntuación a la clasificación…",
      "lbRank": "Puesto en la clasificación: #{rank}",
      "lbPosted": "Puntuación publicada en la clasificación.",
      "lbNotPosted": "La puntuación no se publicó en la clasificación."
    },
    "es-ES": {
      "signIn": "Iniciar sesión con StarHermit",
      "invite": "Invitar a un amigo",
      "inviteCopied": "Enlace de invitación copiado en el portapapeles.",
      "inviteFailed": "No se pudo copiar el enlace de invitación.",
      "offline": "Sin conexión: el progreso se guarda en este dispositivo.",
      "playingAs": "Jugando como {name}",
      "synced": "progreso sincronizado",
      "saving": "guardando…",
      "syncOff": "sincronización en la nube no disponible",
      "signedOut": "Sesión de StarHermit cerrada: el progreso se queda en este dispositivo.",
      "lbPosting": "Enviando la puntuación a la clasificación…",
      "lbRank": "Puesto en la clasificación: #{rank}",
      "lbPosted": "Puntuación publicada en la clasificación.",
      "lbNotPosted": "La puntuación no se ha publicado en la clasificación."
    },
    "de-DE": {
      "signIn": "Mit StarHermit anmelden",
      "invite": "Freund einladen",
      "inviteCopied": "Einladungslink in die Zwischenablage kopiert.",
      "inviteFailed": "Einladungslink konnte nicht kopiert werden.",
      "offline": "Offline – der Fortschritt wird auf diesem Gerät gespeichert.",
      "playingAs": "Du spielst als {name}",
      "synced": "Fortschritt synchronisiert",
      "saving": "wird gespeichert …",
      "syncOff": "Cloud-Synchronisierung nicht verfügbar",
      "signedOut": "Von StarHermit abgemeldet – der Fortschritt bleibt auf diesem Gerät.",
      "lbPosting": "Punktzahl wird an die Bestenliste gesendet…",
      "lbRank": "Rang in der Bestenliste: #{rank}",
      "lbPosted": "Punktzahl in der Bestenliste eingetragen.",
      "lbNotPosted": "Punktzahl nicht in der Bestenliste eingetragen."
    },
    "fr-FR": {
      "signIn": "Se connecter avec StarHermit",
      "invite": "Inviter un ami",
      "inviteCopied": "Lien d’invitation copié dans le presse-papiers.",
      "inviteFailed": "Impossible de copier le lien d’invitation.",
      "offline": "Hors ligne : la progression est enregistrée sur cet appareil.",
      "playingAs": "Vous jouez en tant que {name}",
      "synced": "progression synchronisée",
      "saving": "enregistrement…",
      "syncOff": "synchronisation cloud indisponible",
      "signedOut": "Déconnecté de StarHermit : la progression reste sur cet appareil.",
      "lbPosting": "Envoi du score au classement…",
      "lbRank": "Rang au classement : #{rank}",
      "lbPosted": "Score publié au classement.",
      "lbNotPosted": "Score non publié au classement."
    },
    "fr-CA": {
      "signIn": "Se connecter avec StarHermit",
      "invite": "Inviter un ami",
      "inviteCopied": "Lien d’invitation copié dans le presse-papiers.",
      "inviteFailed": "Impossible de copier le lien d’invitation.",
      "offline": "Hors ligne : la progression est enregistrée sur cet appareil.",
      "playingAs": "Vous jouez en tant que {name}",
      "synced": "progression synchronisée",
      "saving": "enregistrement…",
      "syncOff": "synchronisation infonuagique indisponible",
      "signedOut": "Déconnecté de StarHermit : la progression reste sur cet appareil.",
      "lbPosting": "Envoi du pointage au classement…",
      "lbRank": "Rang au classement : #{rank}",
      "lbPosted": "Pointage publié au classement.",
      "lbNotPosted": "Pointage non publié au classement."
    },
    "pt-BR": {
      "signIn": "Entrar com a StarHermit",
      "invite": "Convidar um amigo",
      "inviteCopied": "Link de convite copiado para a área de transferência.",
      "inviteFailed": "Não foi possível copiar o link de convite.",
      "offline": "Offline — o progresso fica salvo neste dispositivo.",
      "playingAs": "Jogando como {name}",
      "synced": "progresso sincronizado",
      "saving": "salvando…",
      "syncOff": "sincronização na nuvem indisponível",
      "signedOut": "Você saiu da StarHermit — o progresso continua neste dispositivo.",
      "lbPosting": "Enviando a pontuação para o placar…",
      "lbRank": "Posição no placar: #{rank}",
      "lbPosted": "Pontuação enviada ao placar.",
      "lbNotPosted": "A pontuação não foi enviada ao placar."
    },
    "it-IT": {
      "signIn": "Accedi con StarHermit",
      "invite": "Invita un amico",
      "inviteCopied": "Link di invito copiato negli appunti.",
      "inviteFailed": "Impossibile copiare il link di invito.",
      "offline": "Offline: i progressi sono salvati su questo dispositivo.",
      "playingAs": "Stai giocando come {name}",
      "synced": "progressi sincronizzati",
      "saving": "salvataggio…",
      "syncOff": "sincronizzazione cloud non disponibile",
      "signedOut": "Disconnesso da StarHermit: i progressi restano su questo dispositivo.",
      "lbPosting": "Invio del punteggio alla classifica…",
      "lbRank": "Posizione in classifica: #{rank}",
      "lbPosted": "Punteggio pubblicato in classifica.",
      "lbNotPosted": "Punteggio non pubblicato in classifica."
    }
  };
  function accountStrings() { return ACCOUNT[pickLocale()] || ACCOUNT['en-US']; }

  root.BSGraphicsPanel = { init: init, refresh: refresh, STRINGS: STRINGS, pickLocale: pickLocale,
    ACCOUNT: ACCOUNT, accountStrings: accountStrings };
})(typeof self !== 'undefined' ? self : this);
