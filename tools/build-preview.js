#!/usr/bin/env node
/* Outil de dev : génère preview.html — index.html avec CSS/JS inlinés.
 * Si des captures réelles existent dans /tmp (tour1/tour2), elles sont
 * REJOUÉES à l'identique dans la vraie UI (mode "live replay") ;
 * sinon, un mock statique sert de secours. La voix est simulée. */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readTmp = (p) => {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
};

let html = read('public/index.html');

/* ---- CSS inliné ---- */
/* Remarque : les remplacements passent par des fonctions, sinon les suites
 * « $' », « $& » ou « $1 » présentes dans le code client seraient interprétées
 * comme des motifs de remplacement et corrompraient le fichier généré. */
html = html.replace(
  '<link rel="stylesheet" href="style.css" />',
  () => '<style>\n' + read('public/style.css') + '\n</style>'
);

/* ---- Captures réelles éventuelles ---- */
const q1Json = readTmp('/tmp/turn1-q.json');
const stream1 = readTmp('/tmp/turn1-stream.txt');
const q2 = readTmp('/tmp/turn2-q.txt');
const stream2 = readTmp('/tmp/turn2-stream.txt');
const live = q1Json && stream1 && q2 && stream2
  ? {
      q1: JSON.parse(q1Json).text,
      stream1,
      q2: q2.trim(),
      stream2,
    }
  : null;

/* ---- Scripts inlinés + moteur de replay ---- */
const stubAndMock = `<script>
/* --- Capture globale des erreurs --- */
window.__errors = [];
window.addEventListener('error', function (e) {
  window.__errors.push((e.message || '?') + ' @ ' + (e.filename || '').split('/').pop() + ':' + e.lineno + ':' + e.colno);
});
window.addEventListener('unhandledrejection', function (e) {
  window.__errors.push('REJECTION: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)));
});

/* --- Simulation voix (replay automatisé, aucun son) --- */
/* Attention : speechSynthesis est un accesseur en lecture seule dans Chromium.
 * Object.defineProperty est le seul moyen de le remplacer réellement — une
 * simple affectation échoue en silence et le vrai synthétiseur reste actif.
 * (Bug réel rencontré : les réponses restaient bloquées sur « je réfléchis… ».) */
Object.defineProperty(window, 'speechSynthesis', { value: {
  speaking: false,
  pending: false,
  _timer: null,
  getVoices: function () {
    return [{ voiceURI: 'amelie-mock', name: 'Amélie (macOS, simulée)', lang: 'fr-FR' }];
  },
  speak: function (u) {
    const self = this;
    self.speaking = true;
    if (u && u.onstart) u.onstart();
    const dur = Math.min(6000, 400 + (u && u.text ? u.text.length : 40) * 45);
    self._timer = setTimeout(function () {
      self.speaking = false;
      if (u && u.onend) u.onend();
    }, dur);
  },
  cancel: function () {
    this.speaking = false;
    clearTimeout(this._timer);
  },
}, writable: true, configurable: true });
window.SpeechSynthesisUtterance = function (text) {
  this.text = text; this.lang = ''; this.voice = null;
  this.rate = 1; this.pitch = 1; this.volume = 1;
  this.onstart = null; this.onend = null; this.onerror = null;
};

/* --- Simulation micro : presser = « enregistrer » (aucun vrai son) --- */
window.navigator.mediaDevices = window.navigator.mediaDevices || {};
window.navigator.mediaDevices.getUserMedia = function () {
  const fakeTrack = { stop: function () {}, kind: 'audio' };
  return Promise.resolve({ getTracks: function () { return [fakeTrack]; } });
};
window.AudioContext = function () {
  return {
    createMediaStreamSource: function () { return { connect: function () {} }; },
    createAnalyser: function () {
      const buf = new Uint8Array(256).fill(90);
      return { fftSize: 512, frequencyBinCount: 256, getByteFrequencyData: function (a) { a.set(buf); } };
    },
    close: function () {},
  };
};
window.MediaRecorder = function (stream, opts) {
  this.state = 'inactive';
  this.mimeType = 'audio/webm';
  this.ondataavailable = null;
  this.onstop = null;
  const self = this;
  this.start = function () {
    self.state = 'recording';
    if (self.ondataavailable) self.ondataavailable({ data: new Blob([new Uint8Array(4000)]) });
  };
  this.stop = function () {
    self.state = 'inactive';
    /* Chunk garanti ici : tous les handlers sont forcément posés */
    if (self.ondataavailable) self.ondataavailable({ data: new Blob([new Uint8Array(9000)]) });
    /* Microtask : survit à la suspension des timers du webview */
    queueMicrotask(function () { if (self.onstop) self.onstop(); });
  };
};
window.MediaRecorder.isTypeSupported = function () { return true; };

/* --- Reconnaissance vocale simulée (pour tester le mot d'activation) --- */
window.__NOVA_SR__ = { instances: [] };
function FakeRecognition() {
  var self = this;
  self.lang = '';
  self.continuous = false;
  self.interimResults = false;
  self.maxAlternatives = 1;
  self.started = false;
  self.start = function () { self.started = true; window.__NOVA_SR__.instances.push(self); if (self.onstart) self.onstart(); };
  self.stop = function () { self.started = false; if (self.onend) self.onend(); };
  self.abort = function () { self.started = false; };
  /* Injecte un transcript comme le ferait le moteur natif */
  self.emit = function (text) {
    var results = [{ 0: { transcript: text } }];
    results.length = 1;
    if (self.onresult) self.onresult({ resultIndex: 0, results: results });
  };
}
window.SpeechRecognition = FakeRecognition;
window.webkitSpeechRecognition = FakeRecognition;
window.__NOVA_LIVE__ = ${JSON.stringify(live)};
window.__NOVA_MOCK__ = !window.__NOVA_LIVE__;
/* Astuce de test : NOVA_PREVIEW_MOCK=1 (à la génération) force le mock
 * statique, qui inclut une carte d'action Mac à confirmer. */
window.__NOVA_FORCE_MOCK__ = ${JSON.stringify(Boolean(process.env.NOVA_PREVIEW_MOCK))};

/* --- Mock / replay de l'API locale --- */
const _origFetch = window.fetch.bind(window);
let sttCalls = 0;
let chatCalls = 0;

function sseResponse(events, delayMs) {
  const enc = new TextEncoder();
  window.__sseDebug = window.__sseDebug || { calls: 0, events: 0, closed: 0 };
  window.__sseDebug.calls++;
  const stream = new ReadableStream({
    start(ctrl) {
      /* Enqueue synchrone : le webview de préview suspend les timers
       * quand il n'est pas composité, ce qui bloquait le replay. */
      for (let i = 0; i < events.length; i++) {
        ctrl.enqueue(enc.encode(events[i] + '\\n\\n'));
        window.__sseDebug.events++;
      }
      ctrl.close();
      window.__sseDebug.closed++;
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

function jsonResp(obj) {
  return Promise.resolve(new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } }));
}

/* --- Mémoire simulée (persistée en localStorage pour tester la restauration) ---
 * Premier lancement : deux conversations d'exemple pour explorer l'onglet
 * Historique (liste, recherche, badge « en cours », réouverture). */
function __mem() {
  try {
    var stored = JSON.parse(localStorage.getItem('nova.mock.memory') || 'null');
    if (stored) return stored;
  } catch (e) {}
  const now = Date.now();
  return {
    lastSessionId: 's-demo-1',
    sessions: [
      {
        id: 's-demo-1', title: 'Programme Pulse — séance du jour',
        createdAt: new Date(now - 3600e3).toISOString(), updatedAt: new Date(now - 1800e3).toISOString(),
        turns: [
          { user: 'Quelle est ma séance du jour ?', assistant: 'Haut du corps — Poussée : pompes classiques 4×10, pompes piquées 3×8, dips 3×10 et planche 3×40 secondes. Repos 60 à 75 secondes entre les séries. Bonne séance !' },
          { user: 'Comment on fait les dips ?', assistant: 'Dos près des chaises, coudes vers l arrière, descends jusqu à 90° puis pousse. Tu en fais 3 séries de 10, repos 60 secondes.' },
        ],
      },
      {
        id: 's-demo-2', title: 'Révisions techno — IA',
        createdAt: new Date(now - 86400e3).toISOString(), updatedAt: new Date(now - 86000e3).toISOString(),
        turns: [
          { user: 'Explique-moi ce qu est un modèle de langage, simplement.', assistant: 'Un modèle de langage a lu énormément de textes et appris à prédire le mot suivant. En enchaînant les prédictions, il rédige des réponses cohérentes — sans comprendre comme un humain.' },
          { user: 'Et un token ?', assistant: 'Un token, c est un morceau de mot : « extraordinaire » devient plusieurs tokens. Les modèles lisent et écrivent en tokens, et on paie à ce compteur.' },
        ],
      },
    ],
  };
}
function __memSave(m) { try { localStorage.setItem('nova.mock.memory', JSON.stringify(m)); } catch (e) {} }
function __readBody(o) {
  try { return JSON.parse((o && o.body) || '{}'); } catch (e) { return {}; }
}

/* ---------- Sport : même contrat que le serveur réel ---------- */
const __SPORT_PLAN = [
  { label: 'Lundi', type: 'push', title: 'Haut du corps — Poussée', focus: ['Pectoraux', 'Épaules', 'Triceps'], ex: [
    { n: 'Pompes classiques', cue: 'Mains sous les épaules, corps gainé comme une planche.', s: 4, reps: 10, rest: 75, m: 'Pectoraux' },
    { n: 'Pompes piquées (pike)', cue: 'Hanches très hautes en V inversé.', s: 3, reps: 8, rest: 60, m: 'Épaules' },
    { n: 'Dips entre deux chaises', cue: 'Dos près de la chaise, coudes vers l’arrière.', s: 3, reps: 10, rest: 60, m: 'Triceps' },
    { n: 'Planche bras tendus', cue: 'Corps en un seul bloc, fessiers serrés.', s: 3, secs: 40, rest: 45, m: 'Gainage' },
  ] },
  { label: 'Mardi', type: 'legs', title: 'Bas du corps — Jambes & Fessiers', focus: ['Quadriceps', 'Fessiers'], ex: [
    { n: 'Squats', cue: 'Hanches en arrière, genoux dans l’axe des pieds.', s: 4, reps: 15, rest: 75, m: 'Quadriceps' },
    { n: 'Fentes alternées', cue: 'Le genou arrière frôle le sol sans le toucher.', s: 3, reps: 12, rest: 60, m: 'Fessiers', note: '/ jambe' },
    { n: 'Chaise murale', cue: 'Cuisses parallèles au sol, poids dans les talons.', s: 3, secs: 45, rest: 60, m: 'Quadriceps' },
    { n: 'Extensions de mollets', cue: 'Amplitude maximale, tempo lent et contrôlé.', s: 3, reps: 20, rest: 45, m: 'Mollets' },
  ] },
  { label: 'Mercredi', type: 'cardio', title: 'Cardio léger & Gainage', focus: ['Cardio', 'Abdos'], ex: [
    { n: 'Jumping jacks', cue: 'Atterris souple sur la plante des pieds.', s: 4, secs: 45, rest: 40, m: 'Cardio' },
    { n: 'Mountain climbers', cue: 'Hanches basses et stables.', s: 4, secs: 40, rest: 40, m: 'Cardio' },
    { n: 'Planche', cue: 'Coudes sous les épaules, corps en un bloc.', s: 3, secs: 45, rest: 45, m: 'Gainage' },
  ] },
  { label: 'Jeudi', type: 'pull', title: 'Haut du corps — Tirage & Dos', focus: ['Dos', 'Biceps'], ex: [
    { n: 'Rowing inversé sous une table', cue: 'Tire la poitrine vers la table, omoplates serrées.', s: 4, reps: 10, rest: 75, m: 'Dos' },
    { n: 'Oiseau au sol', cue: 'Ouvre les bras en pinçant les omoplates.', s: 3, reps: 12, rest: 60, m: 'Deltoïdes post.' },
    { n: 'Superman', cue: 'Décolle bras et jambes en t’étirant.', s: 3, secs: 40, rest: 45, m: 'Lombaires' },
  ] },
  { label: 'Vendredi', type: 'full', title: 'Full body & Core', focus: ['Corps entier', 'Gainage'], ex: [
    { n: 'Burpees', cue: 'Poitrine au sol, saut compact, atterrissage amorti.', s: 3, reps: 10, rest: 75, m: 'Full body' },
    { n: 'Squats sautés', cue: 'Squat complet puis explosion vers le haut.', s: 3, reps: 12, rest: 60, m: 'Quadriceps' },
    { n: 'Hollow hold', cue: 'Bas du dos collé au sol.', s: 3, secs: 30, rest: 45, m: 'Abdos' },
  ] },
  { label: 'Samedi', type: 'mobility', title: 'Mobilité & Marche', focus: ['Souplesse', 'Respiration'], ex: [
    { n: 'Marche dynamique en extérieur', cue: 'Allure vive mais confortable, respire par le nez.', s: 1, secs: 1800, rest: 0, m: 'Cardio doux' },
    { n: 'Flow mobilisation (chat-vache)', cue: 'Synchronise chaque mouvement avec ta respiration.', s: 2, secs: 300, rest: 30, m: 'Colonnes' },
  ] },
  { label: 'Dimanche', type: 'rest', title: 'Repos complet — Priorité sommeil', focus: [], ex: [] },
];
const __SPORT_PHASES = [
  { name: 'Fondation', mult: 1, restMult: 1, setBonus: 0 },
  { name: 'Développement', mult: 1.15, restMult: 1, setBonus: 2 },
  { name: 'Intensité', mult: 1.3, restMult: 0.85, setBonus: 2 },
  { name: 'Allègement', mult: 0.75, restMult: 1.15, setBonus: 0 },
];
function __spPad(n) { return n < 10 ? '0' + n : '' + n; }
function __spIso(d) { return d.getFullYear() + '-' + __spPad(d.getMonth() + 1) + '-' + __spPad(d.getDate()); }
function __spParse(s) { const p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
function __spAdd(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
function __spMonday(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function __spLabel(iso) {
  try {
    const s = __spParse(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  } catch (e) { return iso; }
}
function __spPhase(w) { const c = ((w % 7) + 7) % 7; return __SPORT_PHASES[c <= 1 ? 0 : c <= 3 ? 1 : c <= 5 ? 2 : 3]; }
function __sportStore() { try { return JSON.parse(localStorage.getItem('nova.mock.sport') || '{}'); } catch (e) { return {}; } }
function __sportSave(s) { try { localStorage.setItem('nova.mock.sport', JSON.stringify(s)); } catch (e) {} }
function __spMinutes(ex) {
  let t = 0;
  ex.forEach(function (e) { t += e.s * ((e.reps ? e.reps * 2.5 : e.secs || 0) + e.rest + 15); });
  return Math.round(t / 60);
}
function __spStart() {
  const st = __sportStore();
  return st.start || __spIso(__spMonday(new Date()));
}
function __spDay(iso) {
  const st = __sportStore();
  const d = __spParse(iso);
  const tpl = __SPORT_PLAN[(d.getDay() + 6) % 7];
  const week = Math.round((__spMonday(d) - __spMonday(__spParse(__spStart()))) / (7 * 86400000));
  const ph = __spPhase(week);
  const rec = (st.sessions || {})[iso] || {};
  const ex = tpl.ex.map(function (e, i) {
    const bonus = i < ph.setBonus ? 1 : 0;
    return {
      n: e.n, cue: e.cue, m: e.m, note: e.note || '',
      s: Math.min(6, e.s + bonus),
      reps: e.reps ? Math.round(e.reps * ph.mult) : 0,
      secs: e.secs ? Math.round((e.secs * ph.mult) / 5) * 5 : 0,
      rest: Math.round((e.rest * ph.restMult) / 5) * 5,
      done: !!(rec.ex && rec.ex[i]),
    };
  });
  return {
    ok: true, dateISO: iso, dow: (d.getDay() + 6) % 7, week: week, phase: { name: ph.name },
    type: tpl.type, title: tpl.title, focus: tpl.focus, programWeeks: 16,
    ex: ex, estMinutes: __spMinutes(ex), done: !!rec.done,
    doneCount: ex.filter(function (e) { return e.done; }).length,
  };
}
function __spStats() {
  const st = __sportStore();
  const sessions = st.sessions || {};
  let seances = 0, repos = 0, minutes = 0, exCoches = 0;
  Object.keys(sessions).forEach(function (k) {
    const rec = sessions[k] || {};
    if (rec.ex) exCoches += Object.keys(rec.ex).length;
    if (!rec.done) return;
    const d = __spDay(k);
    if (d.type === 'rest') repos++; else seances++;
    minutes += d.estMinutes;
  });
  const xp = seances * 25 + repos * 15 + exCoches * 5;
  const lvl = xp >= 1700 ? 'Légende' : xp >= 1100 ? 'Machine' : xp >= 650 ? 'Athlète' : xp >= 320 ? 'Discipliné' : xp >= 120 ? 'Régulier' : 'Débutant';
  const today = __spDay(__spIso(new Date()));
  let semaine = 0, done = 0;
  for (let i = 0; i < 7; i++) {
    const iso = __spIso(__spAdd(__spMonday(new Date()), i));
    const d = __spDay(iso);
    semaine = d.week;
    if (d.done && d.type !== 'rest') done++;
  }
  return {
    sessions: seances, restDays: repos, minutes: minutes, exercisesDone: exCoches, streak: seances ? 1 : 0,
    bestWeek: done, week: semaine, phase: { name: __spPhase(semaine).name }, weekDone: done, weekGoal: 5,
    programWeeks: 16, xp: xp, level: lvl, nextLevel: xp >= 1700 ? null : { min: 120, name: 'Régulier' },
    start: __spStart(), tracked: Object.keys(sessions).length, todayTitle: today.title,
  };
}
function __sportState(url, opts) {
  const st = __sportStore();
  if (!st.sessions) st.sessions = {};
  const aujourdhui = __spIso(new Date());
  const chemin = String(url).split('?')[0];
  const methode = (opts && opts.method) || 'GET';

  if (methode === 'POST') {
    const b = __readBody(opts);
    let message = '';
    if (chemin.indexOf('/config') !== -1) {
      if (typeof b.planPath === 'string' && b.planPath && !/[.](html|htm)$/i.test(b.planPath)) {
        return { error: 'le programme doit être un fichier .html (celui de Pulse)' };
      }
      if (typeof b.planPath === 'string') st.planPath = b.planPath;
      if (typeof b.start === 'string' && new RegExp('^[0-9]{4}-[0-9]{2}-[0-9]{2}$').test(b.start)) st.start = b.start;
      else if (typeof b.start === 'string') return { error: 'date de début invalide (attendu AAAA-MM-JJ)' };
      message = 'Réglage enregistré (aperçu)';
    } else if (chemin.indexOf('/import') !== -1) {
      try {
        const j = JSON.parse(b.content || '{}');
        if (j.app && j.app !== 'pulse') return { error: 'ce fichier ne vient pas de Pulse (app = ' + j.app + ')' };
        const src = (j.state && j.state.sessions) || j.done || {};
        const cles = Object.keys(src);
        cles.forEach(function (k) { st.sessions[k] = st.sessions[k] || {}; if (src[k] && src[k].done) st.sessions[k].done = 1; });
        message = 'Sauvegarde Pulse importée : ' + cles.length + ' séance(s) (aperçu)';
      } catch (e) { return { error: 'fichier illisible : ce n’est pas du JSON' }; }
    } else if (chemin.indexOf('/reset') !== -1) {
      st.sessions = {};
      message = 'Progression effacée (aperçu)';
    } else if (chemin.indexOf('/done') !== -1) {
      const iso = b.date || aujourdhui;
      const rec = (st.sessions[iso] = st.sessions[iso] || {});
      const jour = __spDay(iso);
      if (b.index !== undefined && b.index !== null) {
        /* Exactement comme le serveur réel : cocher un exercice ne valide
           pas la séance ; le décocher invalide la séance. */
        rec.ex = rec.ex || {};
        if (b.value !== false) rec.ex[b.index] = 1;
        else { delete rec.ex[b.index]; delete rec.done; }
      } else if (b.done === false) {
        delete rec.done;
      } else {
        rec.done = 1;
        rec.ex = {};
        jour.ex.forEach(function (e, i) { rec.ex[i] = 1; });
      }
      if (!Object.keys(rec).length) delete st.sessions[iso];
      message = rec.done ? 'Séance validée (aperçu)' : '';
    }
    __sportSave(st);
    const etat = __sportState(chemin, null);
    etat.message = message;
    return etat;
  }

  const params = new URLSearchParams(String(url).split('?')[1] || '');
  const offset = Number(params.get('week')) || 0;
  const lundi = __spAdd(__spMonday(new Date()), 7 * offset);
  const jours = [];
  for (let i = 0; i < 7; i++) {
    const iso = __spIso(__spAdd(lundi, i));
    const d = __spDay(iso);
    jours.push({
      dateISO: iso, label: __SPORT_PLAN[i].label, type: d.type, title: d.title, focus: d.focus,
      estMinutes: d.estMinutes, exCount: d.ex.length, done: d.done, isToday: iso === aujourdhui, isPast: iso < aujourdhui,
    });
  }
  return {
    ok: true,
    plan: {
      found: true,
      path: st.planPath || '/Users/toi/Desktop/APP 2/index.html',
      error: '', programWeeks: 16,
      days: __SPORT_PLAN.map(function (d) { return { label: d.label, type: d.type, title: d.title, focus: d.focus, exCount: d.ex.length }; }),
    },
    config: { start: __spStart(), planPath: st.planPath || '' },
    today: __spDay(aujourdhui),
    week: { ok: true, start: __spIso(lundi), week: __spDay(__spIso(lundi)).week, phase: { name: __spPhase(__spDay(__spIso(lundi)).week).name }, days: jours, goal: 5, doneCount: jours.filter(function (j) { return j.done && j.type !== 'rest'; }).length },
    stats: __spStats(),
  };
}

window.fetch = function (url, opts) {
  const u = String(url);
  if (u === '/api/status') {
    return jsonResp({ hasKey: true, model: 'openai/gpt-oss-120b', sttModel: 'whisper-large-v3-turbo' });
  }
  if (u === '/api/models') {
    return jsonResp({ models: [
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B (recommandé)' },
      { id: 'qwen/qwen3.6-27b', label: 'Qwen 3.6 27B (rapide)' },
    ] });
  }
  if (u === '/api/profile') {
    if ((opts && opts.method) === 'PUT') {
      const body = __readBody(opts);
      localStorage.setItem('nova.mock.profile', JSON.stringify(body));
      return jsonResp({ ok: true, profile: body });
    }
    let p = null;
    try { p = JSON.parse(localStorage.getItem('nova.mock.profile') || 'null'); } catch (e) {}
    if (!p) {
      p = { name: '', age: '', physique: '', studies: '', notes: '' };
    }
    return jsonResp({ profile: p });
  }
  if (u === '/api/mac/status') {
    return jsonResp({
      enabled: true,
      host: 'macbook-aperçu',
      actions: ['open', 'say', 'notification', 'volume', 'brightness', 'screenshot', 'clipboard_set', 'training_done', 'pulse', 'now', 'battery', 'date', 'disk', 'ip', 'uptime', 'clipboard', 'weather', 'workout', 'workout_week', 'training_stats', 'workout_exercise'],
      readonly: ['now', 'date', 'battery', 'disk', 'ip', 'uptime', 'clipboard', 'weather', 'workout', 'workout_week', 'training_stats', 'workout_exercise'],
    });
  }
  if (u === '/api/diag') {
    /* Même forme que le serveur réel, valeurs d'aperçu */
    const m = __mem();
    let prof = null;
    try { prof = JSON.parse(localStorage.getItem('nova.mock.profile') || 'null'); } catch (e) {}
    return jsonResp({
      ok: true,
      server: { node: 'v22.0.0 (aperçu)', platform: 'darwin · arm64', host: 'macbook-aperçu', uptime: 41, port: 8787 },
      groq: { keyConfigured: true, keySource: 'serveur (.env)', model: 'openai/gpt-oss-120b', sttModel: 'whisper-large-v3-turbo', maxTokens: 900 },
      data: {
        dir: '(aperçu) data/',
        writable: true,
        error: '',
        sessions: m.sessions.length,
        turns: m.sessions.reduce(function (n, s) { return n + ((s.turns || []).length); }, 0),
        lastSessionId: m.lastSessionId,
        profileSaved: !!prof,
        profileName: prof ? prof.name : '',
      },
      mac: {
        enabled: true,
        host: 'macbook-aperçu',
        actions: ['open', 'say', 'notification', 'volume', 'brightness', 'screenshot', 'clipboard_set', 'training_done', 'pulse', 'now', 'battery', 'date', 'disk', 'ip', 'uptime', 'clipboard', 'weather', 'workout', 'workout_week', 'training_stats', 'workout_exercise'],
        readonly: ['now', 'date', 'battery', 'disk', 'ip', 'uptime', 'clipboard', 'weather', 'workout', 'workout_week', 'training_stats', 'workout_exercise'],
        screenshotDir: '(aperçu) data/screenshots',
      },
      training: {
        ok: true,
        planPath: __sportState('/api/training', null).plan.path,
        planFound: true,
        planError: '',
        programWeeks: 16,
        planDetected: 'fichier Pulse',
        start: __spStart(),
        sessionsTracked: Object.keys(__sportStore().sessions || {}).length,
        sessionsDone: __spStats().sessions,
        streak: __spStats().streak,
        minutes: __spStats().minutes,
        week: __spStats().week,
        phase: __spStats().phase.name,
        xp: __spStats().xp,
        level: __spStats().level,
        dataFile: '(aperçu) data/training.json',
      },
    });
  }
  if (u === '/api/mac/exec') {
    const body = __readBody(opts);
    /* L'action de sport doit vraiment modifier le suivi simulé, sinon le
       panneau Sport afficherait un état qui contredit le message affiché. */
    if (body.action === 'training_done') {
      const etat = __sportState('/api/training/done', { method: 'POST', body: JSON.stringify({ done: true }) });
      return jsonResp({
        ok: true, action: 'training_done', arg: '',
        output: 'séance validée : ' + etat.today.title + ' (' + etat.today.ex.length + ' exercices cochés)',
      });
    }
    return jsonResp({ ok: true, action: body.action, arg: body.arg || '', output: 'Simulation (aperçu) : ' + (body.action || 'action') + (body.arg ? ' → ' + body.arg : '') + ' — exécuté pour de vrai sur ton Mac.' });
  }
  if (u.indexOf('/api/training') === 0) {
    return jsonResp(__sportState(u, opts));
  }
  if (u === '/api/stt') {
    const L = window.__NOVA_LIVE__;
    const texts = L ? [L.q1, L.q2] : ['Raconte-moi une blague de développeur.'];
    const t = texts[Math.min(sttCalls, texts.length - 1)];
    sttCalls++;
    return jsonResp({ text: t });
  }
  if (u === '/api/chat') {
    const L = window.__NOVA_FORCE_MOCK__ ? null : window.__NOVA_LIVE__;
    if (L) {
      const raw = chatCalls === 0 ? L.stream1 : L.stream2;
      chatCalls++;
      const body = __readBody(opts);
      const m = __mem();
      let sess = m.sessions.find(function (s) { return s.id === body.sessionId; });
      if (!sess) {
        sess = { id: 'mock-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6), title: 'Nouvelle conversation', updatedAt: new Date().toISOString(), turns: [] };
        m.sessions.unshift(sess);
      }
      const lastU = (body.messages || []).filter(function (x) { return x.role === 'user'; }).pop();
      sess.turns.push({ user: lastU ? lastU.content : '', assistant: '(réponse rejouée depuis la capture réelle)' });
      if (sess.title === 'Nouvelle conversation' && lastU) sess.title = String(lastU.content).slice(0, 48);
      sess.updatedAt = new Date().toISOString();
      m.lastSessionId = sess.id;
      __memSave(m);
      const pre = 'data: ' + JSON.stringify({ nova_session: sess.id }) + '\\n\\n';
      const prof = (() => { try { return JSON.parse(localStorage.getItem('nova.mock.profile') || 'null'); } catch (e) { return null; } })() || { name: '', age: '', physique: '', studies: '', notes: '' };
      const pre2 = 'data: ' + JSON.stringify({ nova_profile: prof }) + '\\n\\n';
      const pre3 = 'data: ' + JSON.stringify({ nova_mac: { host: 'macbook-aperçu', platform: 'darwin' } }) + '\\n\\n';
      const events = [pre, pre2, pre3].concat(raw.split('\\n\\n').filter(function (e) { return e.trim(); }));
      return Promise.resolve(sseResponse(events, 26));
    }
    // Fallback mock statique — exerce une carte de sport ou une carte d'action
    chatCalls++;
    const corps = __readBody(opts);
    const dernier = ((corps.messages || []).filter(function (x) { return x.role === 'user'; }).pop() || {}).content || '';
    const dit = String(dernier).toLowerCase();
    const estSport = /s[eé]ance|entra[iî]nement|sport|programme|pompe|burpee|squat|muscu/.test(dit);
    const veutValider = /valide|termin[eé]e|j.ai fini|fini ma|fini la/.test(dit);
    let text, extra, action = null;
    if (estSport) {
      const etat = __sportState('/api/training', null);
      const j = etat.today;
      /* « où » garde son accent en minuscules : le serveur réel compare sans
         accents, l'aperçu doit donc accepter les deux formes. */
      const ditStats = /o[uù] j|bilan|stats|progression|avance/.test(dit);
      const ditSemaine = !ditStats && /semaine|planning|programme/.test(dit);
      const ditTechnique = !ditStats && !ditSemaine && /comment|technique/.test(dit);
      if (ditStats) {
        const s = etat.stats;
        text = "Voilà où tu en es : " + s.sessions + " séances validées, " + s.minutes + " minutes cumulées, semaine " + (s.week + 1) + " sur " + s.programWeeks + " en phase " + s.phase.name + ", niveau " + s.level + ". Continue comme ça !";
        extra = { skill: 'training_stats', arg: '', output: s.sessions + ' séances validées', data: { kind: 'stats', stats: s } };
      } else if (ditTechnique) {
        const e = j.ex[0] || { n: 'Pompes classiques', cue: 'Mains sous les épaules, corps gainé.', s: 4, reps: 10, m: 'Pectoraux' };
        text = e.n + " : « " + e.cue + " » Tu enchaînes " + (e.reps ? e.s + ' séries de ' + e.reps : e.s + ' séries') + ". Garde un tempo régulier.";
        extra = { skill: 'workout_exercise', arg: 'pompes', output: e.n, data: { kind: 'exercise', found: [{ n: e.n, cue: e.cue, m: e.m }] } };
      } else if (ditSemaine) {
        text = "Cette semaine : " + etat.week.doneCount + " séance(s) validée(s) sur " + etat.week.goal + ", phase " + etat.week.phase.name + ". Aujourd'hui, " + j.title + ".";
        extra = { skill: 'workout_week', arg: '', output: 'semaine de sport', data: { kind: 'week', week: etat.week.week + 1, phase: etat.week.phase.name, goal: etat.week.goal, done: etat.week.doneCount, days: etat.week.days } };
      } else if (j.type === 'rest') {
        text = "Aujourd'hui c'est repos complet : priorité sommeil, rien à valider.";
        extra = { skill: 'workout', arg: '', output: j.title, data: { kind: 'rest', dateISO: j.dateISO, dateLabel: __spLabel(j.dateISO), title: j.title } };
      } else {
        const noms = j.ex.slice(0, 3).map(function (e) { return e.n; }).join(', ');
        text = "Aujourd'hui c'est " + j.title.toLowerCase() + " : " + j.ex.length + " exercices pour environ " + j.estMinutes + " minutes, en phase " + j.phase.name + ". Tu commences par " + noms + ". Tu veux le détail complet ?";
        extra = { skill: 'workout', arg: '', output: j.title, data: { kind: 'workout', dateISO: j.dateISO, dateLabel: __spLabel(j.dateISO), title: j.title, type: j.type, phase: j.phase.name, week: j.week + 1, weeks: 16, focus: j.focus, estMinutes: j.estMinutes, done: j.done, exDone: j.doneCount, ex: j.ex } };
      }
      if (veutValider) { action = { action: 'training_done', arg: '' }; text += ' Je te prépare la validation de la séance.'; }
    } else {
      text = "Bien sûr ! En mode aperçu sans capture, je réponds de façon générique. Je peux aussi te parler de ton programme de sport ou agir sur ton Mac.";
      extra = { skill: 'now', arg: '', output: 'nous sommes le lundi 14 septembre 2026, il est 21:42' };
      action = { action: 'now', arg: '' };
    }
    const events = text.split(' ').map(function (w) {
      return 'data: ' + JSON.stringify({ choices: [{ delta: { content: w + ' ' } }] });
    });
    events.unshift('data: ' + JSON.stringify({ nova_skill: extra }));
    if (action) events.push('data: ' + JSON.stringify({ nova_action: action }));
    events.push('data: [DONE]');
    return Promise.resolve(sseResponse(events, 40));
  }
  if (u === '/api/memory') {
    /* Même contrat que le serveur réel : turns = NOMBRE d'échanges,
       preview = dernier tour (pour l'onglet Historique). */
    const m = __mem();
    return jsonResp({
      sessions: m.sessions.map(function (s) {
        const last = (s.turns && s.turns.length) ? (s.turns[s.turns.length - 1].user || s.turns[s.turns.length - 1].assistant || '') : '';
        return { id: s.id, title: s.title, updatedAt: s.updatedAt, turns: (s.turns || []).length, preview: last.slice(0, 90) };
      }),
      lastSessionId: m.lastSessionId,
    });
  }
  if (u === '/api/memory/forget') {
    const m = __mem();
    const n = m.sessions.length;
    m.sessions = []; m.lastSessionId = null;
    __memSave(m);
    return jsonResp({ ok: true, forgotten: n });
  }
  if (u.indexOf('/api/memory/') === 0) {
    const sid = u.slice('/api/memory/'.length);
    const m = __mem();
    const i = m.sessions.findIndex(function (s) { return s.id === sid; });
    if ((opts && opts.method) === 'DELETE') {
      if (i === -1) return jsonResp({ error: 'introuvable' });
      const gone = m.sessions.splice(i, 1)[0];
      if (m.lastSessionId === gone.id) m.lastSessionId = m.sessions[0] ? m.sessions[0].id : null;
      __memSave(m);
      return jsonResp({ ok: true, deleted: gone.id });
    }
    if (i === -1) return jsonResp({ error: 'introuvable' });
    return jsonResp(m.sessions[i]);
  }
  return _origFetch(url, opts);
};
</script>`;

const inline =
  stubAndMock +
  ['markdown.js', 'orb.js', 'wake.js', 'app.js']
    .map((f) => '<script>\n' + read('public/' + f) + '\n</script>')
    .join('\n');

html = html.replace(
  /<script src="markdown\.js"><\/script>\s*<script src="orb\.js"><\/script>\s*<script src="wake\.js"><\/script>\s*<script src="app\.js"><\/script>/,
  () => inline
);

/* Hook VAD : la preview simule ta voix par script (le webview n'a pas de micro) */
html = html.replace(
  '</body>',
  () => `<script>
  window.NovaConv.simulateLevel = function () { return Number(window.__vadLevel || 0); };
  </script>
  <div id="preview-badge" title="Ce fichier est une simulation hors serveur — les réponses sont des répliques pré-écrites. Ouvre http://127.0.0.1:8787 pour la vraie Nova.">🎭 Aperçu — réponses simulées</div>
  <style>
    #preview-badge { position: fixed; bottom: 12px; right: 12px; z-index: 99999; padding: 6px 12px; border-radius: 999px;
      background: rgba(124,108,255,.92); color: #fff; font: 600 12px -apple-system, system-ui, sans-serif;
      box-shadow: 0 4px 18px rgba(0,0,0,.35); pointer-events: auto; }
  </style>
  </body>`
);

fs.writeFileSync(path.join(ROOT, 'preview.html'), html);
console.log(
  'preview.html généré (' + Math.round(html.length / 1024) + ' Ko) — mode : ' +
  (live ? 'REPLAY RÉEL (tours capturés) — badge « Aperçu » affiché' : 'mock statique — badge « Aperçu » affiché')
);
