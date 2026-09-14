#!/usr/bin/env node
/**
 * Nova — Assistant IA vocal (Groq)
 * Serveur Node.js sans aucune dépendance.
 *  - Sert l'interface (public/)
 *  - POST /api/chat  → proxy streaming SSE vers Groq (chat completions)
 *  - POST /api/stt   → proxy vers Groq Whisper (transcription vocale)
 *  - GET  /api/models → liste des modèles chat disponibles
 *  - GET  /api/status → { hasKey, model }
 * La clé API est lue depuis .env (GROQ_API_KEY) ou la variable d'environnement.
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const os = require('os');
const { execFile } = require('child_process');

var PORT = parseInt(process.env.PORT, 10);
if (!PORT || PORT < 1 || PORT > 65535) PORT = 8787;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

const GROQ_API_HOST = 'api.groq.com';
/* Modèle par défaut : un modèle réellement disponible chez Groq aujourd'hui.
 * Si celui du .env n'existe plus sur le compte (modèles retirés par l'éditeur),
 * le serveur bascule tout seul et prévient le client (nova_model_used). */
const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const WHISPER_MODEL = 'whisper-large-v3-turbo';
const FALLBACK_STT_MODEL = 'whisper-large-v3';
const MAX_TOKENS = Math.max(256, parseInt(process.env.GROQ_MAX_TOKENS, 10) || 900);

const SYSTEM_PROMPT =
  "Tu es Nova, une assistante IA vocale en français, chaleureuse, vive et efficace. " +
  "Tu réponds toujours en français, dans un langage parlé et naturel, adapté à une conversation vocale. " +
  "Tes réponses sont concises (2 à 6 phrases sauf si on te demande un développement), sans listes à puces ni blocs de code sauf demande explicite, " +
  "car tes réponses sont lues à voix haute. Pas d'emojis. Tu peux avoir une personnalité : tu t'appelles Nova.\n\n" +
  "COMPÉTENCES : tu contrôles le Mac de l'utilisateur en local (environnement protégé). Actions disponibles : " +
  "ouvrir un site web ou une application (open), faire parler le Mac à voix haute (say), afficher une notification à l'écran (notification), " +
  "régler le volume, en valeur absolue ou relative (volume, 0 à 100, ou « +10 »/« -10 »), baisser/monter la luminosité (brightness), " +
  "prendre une capture d'écran (screenshot), copier un texte dans le presse-papiers (clipboard_set), " +
  "ouvrir son programme de sport Pulse (pulse), valider la séance de sport du jour (training_done), " +
  "donner l'heure et la date exactes (now), donner l'état de la batterie (battery).\n" +
  "SPORT : l'utilisateur suit un programme de musculation au poids du corps dont tu connais le détail. " +
  "Réponds de façon concrète (noms des exercices, séries, répétitions, consignes) et encourage sans exagérer.\n" +
  "INFORMATIONS RÉELLES : l'heure, la date, la météo, la batterie, l'espace disque, l'adresse IP, la durée d'allumage du Mac et le " +
  "contenu du presse-papiers te sont fournis automatiquement juste avant la question quand elle porte dessus. " +
  "Dans ce cas, réponds directement avec la valeur reçue, sans écrire de ligne ACTION et sans dire que tu as lancé une commande.\n" +
  "PROTOCOLE D'ACTION : quand l'utilisateur demande concrètement une de ces actions, réponds très brièvement " +
  "(une phrase du style « J'ouvre ça tout de suite. ») puis termine ta réponse par une ligne exacte :\n" +
  "ACTION: nom|argument\n" +
  "(nom = open, say, notification, volume, brightness, screenshot, clipboard_set, now ou battery ; argument vide ou simple : une adresse, un texte, un nombre). " +
  "Cette ligne sera retirée avant l'affichage et une confirmation sécurisée sera proposée à l'utilisateur. " +
  "N'écris ACTION que pour une action réelle, demandée par l'utilisateur, jamais plusieurs par réponse. " +
  "N'invente jamais le résultat d'une action : l'exécution réelle te sera confirmée après.";

/* ------------------------------------------------------------------ */
/* Chargement du .env                                                  */
/* ------------------------------------------------------------------ */

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2];
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
  } catch (_) {
    /* pas de .env, ce n'est pas grave */
  }
}
loadEnvFile();

function getApiKey() {
  return process.env.GROQ_API_KEY || '';
}

/* Clé d'une requête : celle des Réglages (en-tête X-Nova-Key) si elle est
   valide, sinon celle du serveur (.env). La clé du navigateur n'est jamais
   journalisée ni renvoyée au client. */
function requestKey(req) {
  const h = req && req.headers ? req.headers['x-nova-key'] : null;
  if (typeof h === 'string' && /^gsk_[A-Za-z0-9_-]{20,}$/.test(h.trim())) return h.trim();
  return getApiKey();
}

/* ------------------------------------------------------------------ */
/* Mémoire persistante (data/memory.json)                              */
/* ------------------------------------------------------------------ */

/* Dossier de données : surchargeable (utile pour les tests, qui utilisent
   un dossier temporaire et ne touchent jamais à la mémoire réelle). */
const DATA_DIR = process.env.NOVA_DATA_DIR
  ? path.resolve(process.env.NOVA_DATA_DIR)
  : path.join(ROOT, 'data');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const MAX_SESSIONS = 30;      // conversations gardées au maximum
const MAX_SESSION_TURNS = 60; // échanges gardés par conversation

const memory = { sessions: [], lastSessionId: null };

function loadMemory() {
  try {
    const j = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    if (j && Array.isArray(j.sessions)) {
      memory.sessions = j.sessions.filter((s) => s && typeof s.id === 'string' && Array.isArray(s.turns));
      memory.lastSessionId =
        typeof j.lastSessionId === 'string' && memory.sessions.some((s) => s.id === j.lastSessionId)
          ? j.lastSessionId
          : (memory.sessions[0] ? memory.sessions[0].id : null);
    }
  } catch (_) {
    /* pas de mémoire encore — normal au premier lancement */
  }
}

let memorySaveTimer = null;
let memoryDirty = false;
function flushMemoryNow() {
  clearTimeout(memorySaveTimer);
  memoryDirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = MEMORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(memory, null, 1));
    fs.renameSync(tmp, MEMORY_FILE);
  } catch (_) {
    /* le disque est peut-être plein — on ne bloque pas la conversation */
  }
}
function persistMemory() {
  memoryDirty = true;
  clearTimeout(memorySaveTimer);
  memorySaveTimer = setTimeout(flushMemoryNow, 200);
}

/* Écriture synchrone à l'arrêt : aucune perte même en cas de Ctrl+C */
process.on('exit', () => {
  if (memoryDirty) flushMemoryNow();
});
process.on('SIGINT', () => {
  if (memoryDirty) flushMemoryNow();
  process.exit(0);
});
process.on('SIGTERM', () => {
  if (memoryDirty) flushMemoryNow();
  process.exit(0);
});

function newSession() {
  return {
    id: 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    title: 'Nouvelle conversation',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turns: [],
  };
}

function memoryEnsureSession(sessionId) {
  if (typeof sessionId === 'string' && sessionId) {
    const found = memory.sessions.find((s) => s.id === sessionId);
    if (found) return found;
  }
  const sess = newSession();
  memory.sessions.unshift(sess);
  if (memory.sessions.length > MAX_SESSIONS) memory.sessions.length = MAX_SESSIONS;
  memory.lastSessionId = sess.id;
  persistMemory();
  return sess;
}

function truncStr(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function memorySaveTurn(sessionId, userText, assistantText) {
  const sess = memoryEnsureSession(sessionId);
  if (!sess) return;
  sess.turns.push({ user: truncStr(userText, 2000), assistant: truncStr(assistantText, 4000) });
  if (sess.turns.length > MAX_SESSION_TURNS) sess.turns.splice(0, sess.turns.length - MAX_SESSION_TURNS);
  if (sess.title === 'Nouvelle conversation' && userText) {
    sess.title = truncStr(userText, 48);
  }
  sess.updatedAt = new Date().toISOString();
  // remonter la session en tête de liste
  const i = memory.sessions.indexOf(sess);
  if (i > 0) {
    memory.sessions.splice(i, 1);
    memory.sessions.unshift(sess);
  }
  memory.lastSessionId = sess.id;
  persistMemory();
}

function memorySummary() {
  return {
    sessions: memory.sessions.map((s) => ({
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      turns: s.turns.length,
      /* Aperçu : dernière chose dite par l'utilisateur, pour reconnaître
         la conversation d'un coup d'œil dans le navigateur d'historique. */
      preview: s.turns.length ? truncStr(s.turns[s.turns.length - 1].user || s.turns[s.turns.length - 1].assistant || '', 90) : '',
    })),
    lastSessionId: memory.lastSessionId,
  };
}

function todayFr() {
  try {
    return new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

/* Bloc « souvenirs » injecté dans le prompt système */
function memoriesContext() {
  const items = memory.sessions.filter((s) => s.turns.length).slice(0, 6);
  if (!items.length) return '';
  const lines = [];
  for (const s of items) {
    let when;
    try {
      when = new Date(s.updatedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
    } catch (_) {
      when = '';
    }
    for (const t of s.turns.slice(-2)) {
      lines.push('- (' + (when ? when + ', ' : '') + '« ' + s.title + ' ») Utilisateur : ' + truncStr(t.user, 150));
      if (t.assistant) lines.push('  Nova : ' + truncStr(t.assistant, 200));
    }
  }
  if (!lines.length) return '';
  return (
    "Souvenirs de tes échanges précédents avec cet utilisateur (nous sommes le " + todayFr() + "). " +
    "Ils te permettent de garder le fil d'une conversation à l'autre. Utilise-les naturellement " +
    "s'ils sont pertinents, sans les réciter mot pour mot :\n" +
    lines.join('\n')
  );
}

function buildSystemPrompt() {
  const parts = [SYSTEM_PROMPT];
  const prof = profileContext();
  if (prof) parts.push(prof);
  const mac = macSandboxContext();
  if (mac) parts.push(mac);
  const sport = trainingContext();
  if (sport) parts.push(sport);
  const mem = memoriesContext();
  if (mem) parts.push(mem);
  return parts.join('\n\n');
}

function stripThink(s) {
  s = String(s || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const i = s.lastIndexOf('<think>');
  if (i !== -1) s = s.slice(0, i);
  return s.trim();
}

loadMemory();

/* ------------------------------------------------------------------ */
/* Profil utilisateur (data/profile.json)                               */
/* ------------------------------------------------------------------ */

const PROFILE_FILE = path.join(DATA_DIR, 'profile.json');

const DEFAULT_PROFILE = {
  name: 'Alessio Innangi',
  age: 23,
  physique: 'athlétique',
  studies: 'étudiant à EICA Auvelais, formation Technicien en informatique',
  notes: '',
};

let profile = null;

function loadProfile() {
  try {
    const j = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    if (j && typeof j === 'object') {
      profile = { ...DEFAULT_PROFILE, ...j };
      return;
    }
    profile = null;
  } catch (_) {
    profile = null; // sauvegardé au premier tour de chat
  }
}

function saveProfileNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 1));
  } catch (_) {
    /* disque plein — on n'interrompt pas la conversation */
  }
}

function profileContext() {
  const p = profile;
  if (!p || (!p.name && !p.studies && !p.notes)) return '';
  const lines = ['Profil de la personne que tu assistes :'];
  if (p.name) lines.push('- Prénom et nom : ' + p.name);
  if (p.age) lines.push('- Âge : ' + p.age + ' ans');
  if (p.physique) lines.push('- Physique : ' + p.physique);
  if (p.studies) lines.push('- Études : ' + p.studies);
  if (p.notes) lines.push('- Divers : ' + p.notes);
  return lines.join('\n');
}

loadProfile();

/* ------------------------------------------------------------------ */
/* Contrôle du Mac en sandbox (allowlist stricte, localhost only)      */
/* ------------------------------------------------------------------ */

const MAC_CONTROL_ENABLED = process.env.MAC_CONTROL !== 'off';
const MAC_ACTION_RE = /^ACTION:\s*([a-z_]+)\s*\|\s*(.*)$/im;
const SCREENSHOT_DIR = path.join(DATA_DIR, 'screenshots');

/* ------------------------------------------------------------------ */
/* Compétences lecture seule (données réelles, sans confirmation)      */
/* ------------------------------------------------------------------ */

/* Les compétences de lecture (heure, météo, batterie, disque, IP, uptime,
   presse-papiers) vivent dans lib/skills.js : module isolé, sans état
   partagé avec le serveur, donc directement testable (test/skills.test.js). */
const skills = require('./lib/skills.js');
const { execFileP, httpGetText } = skills;

/* ------------------------------------------------------------------ */
/* Programme sport (fichier Pulse de l'utilisateur)                    */
/* ------------------------------------------------------------------ */

/* Le programme n'est jamais recopié : il est LU dans le fichier Pulse
   (index.html autonome) et relu dès que le fichier change. La progression,
   elle, appartient à Nova et vit dans data/training.json. */
const entrainement = require('./lib/training.js');
const TRAINING = new entrainement.Training({
  dataDir: DATA_DIR,
  envPath: process.env.NOVA_TRAINING_PLAN || '',
});
TRAINING.load();

/* Contexte passé aux compétences de lecture. */
function skillCtx() {
  return { profile: profile, training: TRAINING };
}

/* Bloc « sport » du prompt système : quelques lignes suffisent pour que
   Nova parle juste sans déclencher de compétence ; le détail (exercices,
   consignes, séries) vient des compétences quand la question le demande. */
function trainingContext() {
  const p = TRAINING.plan();
  if (!p.ok) return '';
  const s = TRAINING.stats();
  const jour = TRAINING.today();
  const lignes = [
    'Programme sport de l\u2019utilisateur : musculation au poids du corps (« Pulse »), ' +
      p.programWeeks + ' semaines, semaine ' + (s.week + 1) + ' en cours (phase ' + s.phase.name + ').',
    'Séances validées : ' + s.sessions + ' ; série en cours : ' + s.streak + ' jour(s) ; objectif de la semaine : ' +
      s.weekDone + ' sur ' + s.weekGoal + ' ; niveau ' + s.level + '.',
  ];
  if (jour.ok) {
    lignes.push(jour.type === 'rest'
      ? 'Aujourd\u2019hui : repos complet.'
      : 'Séance du jour : « ' + jour.title + ' », ' + jour.ex.length + ' exercices, environ ' + jour.estMinutes +
        ' minutes — ' + (jour.done ? 'déjà validée' : 'pas encore validée') + '.');
  }
  lignes.push(
    'Pour le détail (exercices, séries, consignes), la semaine complète, la technique d\u2019un mouvement ou le bilan, ' +
    'tes compétences workout, workout_week, workout_exercise et training_stats reçoivent la donnée réelle automatiquement.'
  );
  return lignes.join('\n');
}

/* Actions que le modèle peut demander : les écritures (soumis à confirmation
   de l'utilisateur) puis les compétences de lecture, qui ne modifient rien. */
const MAC_ACTION_LIST = [
  'open',
  'say',
  'notification',
  'volume',
  'brightness',
  'screenshot',
  'clipboard_set',
  'training_done',
  'pulse',
  'now',
  'battery',
].concat(skills.READONLY_SKILLS.filter((s) => s !== 'now' && s !== 'battery'));

function macSandboxContext() {
  if (!MAC_CONTROL_ENABLED) return '';
  const host = os.hostname();
  return (
    "Environnement de l'utilisateur : Mac local (« " + host + " », macOS) auquel tu as un accès d'assistant via les actions listées ci-dessus. " +
    "Les actions sont exécutées dans une sandbox sécurisée : si une demande dépasse tes capacités (fichiers, e-mails, achat, suppression), " +
    "dis gentiment que tu ne peux pas faire cette action précise."
  );
}

function execMacAction(action, arg) {
  return new Promise((resolve) => {
    const a = String(action || '').toLowerCase();
    const s = String(arg || '').trim().slice(0, 400);
    const done = (out) => resolve({ ok: true, action: a, arg: s, output: String(out || '').slice(0, 600) });
    const fail = (msg) => resolve({ ok: false, action: a, arg: s, error: msg });
    if (!MAC_CONTROL_ENABLED) return fail('Contrôle du Mac désactivé');
    const opts = { timeout: 8000, windowsHide: true };
    try {
      if (a === 'now') {
        /* Formaté en JS : sortie directement en français, sans dépendre de la locale système */
        try {
          const d = new Date();
          const dateStr = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
          const timeStr = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
          done('nous sommes le ' + dateStr + ', il est ' + timeStr);
        } catch (_) {
          fail('impossible de lire l’horloge');
        }
      } else if (a === 'battery') {
        execFile('pmset', ['-g', 'batt'], opts, (e, so) => {
          if (e) return fail('batterie inaccessible');
          const m = (so || '').match(/(\d+)%/);
          const ac = /AC Power/i.test(so || '');
          done(m ? (m[1] + '%, ' + (ac ? 'sur secteur' : 'sur batterie')) : (so || '').trim());
        });
      } else if (a === 'open') {
        if (!s) return fail('adresse ou application manquante');
        const isUrl = /^(https?:\/\/|www\.)|\.[a-z]{2,}(\/|$)/i.test(s);
        if (isUrl && !/^https?:\/\//i.test(s)) {
          execFile('open', ['https://' + s], opts, (e) => (e ? fail('ouverture impossible') : done('site ouvert : ' + s)));
        } else {
          execFile('open', isUrl ? [s] : ['-a', s], opts, (e) => (e ? fail('application ou site introuvable') : done('ouvert : ' + s)));
        }
      } else if (a === 'say') {
        if (!s) return fail('texte manquant');
        execFile('say', ['-v', 'Amelie', s], { ...opts, timeout: 30000 }, (e) => (e ? fail('voix indisponible') : done('message prononcé')));
      } else if (a === 'notification') {
        if (!s) return fail('texte manquant');
        const script = 'display notification ' + JSON.stringify(s) + ' with title "Nova"';
        execFile('osascript', ['-e', script], opts, (e) => (e ? fail('notification refusée par macOS') : done('notification affichée')));
      } else if (a === 'volume') {
        /* Valeur absolue (0–100) ou relative : « +10 », « -5 », « monte », « baisse » */
        const relatif = /^\s*([+-]\s*\d{1,3}|plus|moins|monte|baisse|augmente|diminue)\s*$/i.exec(s);
        const n = parseInt(s, 10);
        if (!relatif && (isNaN(n) || n < 0 || n > 100)) return fail('volume attendu entre 0 et 100');
        if (relatif) {
          const brut = relatif[1].toLowerCase();
          const delta = /^[+]|monte|augmente|plus/.test(brut) ? 10 : -10;
          const num = /^[+-]\s*(\d{1,3})$/.exec(brut.replace(/\s/g, ''));
          const pas = num ? Math.max(-100, Math.min(100, parseInt(num[1], 10) * (brut.startsWith('-') ? -1 : 1))) : delta;
          execFile('osascript', ['-e', 'output volume of (get volume settings)'], opts, (e1, cur) => {
            if (e1) return fail('volume illisible');
            const base = parseInt(cur, 10);
            const cible = Math.max(0, Math.min(100, (isNaN(base) ? 50 : base) + pas));
            execFile('osascript', ['-e', 'set volume output volume ' + cible], opts, (e2) =>
              (e2 ? fail('réglage refusé') : done('volume réglé à ' + cible + '%' + (pas > 0 ? ' (+' + pas + ')' : ' (' + pas + ')')))
            );
          });
        } else {
          execFile('osascript', ['-e', 'set volume output volume ' + n], opts, (e) => (e ? fail('réglage refusé') : done('volume réglé à ' + n + '%')));
        }
      } else if (a === 'clipboard_set') {
        if (!s) return fail('texte manquant');
        /* pbcopy lit sur son entrée standard : on y écrit le texte, sans shell */
        try {
          const child = execFile('pbcopy', [], { timeout: 5000 }, (e) => (e ? fail('presse-papiers refusé') : done('copié dans le presse-papiers')));
          child.stdin.end(String(s).slice(0, 20000));
        } catch (e) {
          fail('presse-papiers indisponible');
        }
      } else if (a === 'brightness') {
        const n = parseInt(s, 10);
        if (isNaN(n) || n < 0 || n > 100) return fail('luminosité attendue entre 0 et 100');
        const v = Math.max(0, Math.min(1, n / 100)).toFixed(2);
        execFile('osascript', ['-e', 'tell application "System Events" to set brightness of the first brightness to ' + v], opts, (e) =>
          (e ? fail('luminosité non réglable sur ce Mac (essayez les touches F1/F2)') : done('luminosité réglée à ' + n + '%'))
        );
      } else if (a === 'screenshot') {
        /* Le dossier doit exister, sinon screencapture échoue même avec la permission. */
        try {
          fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        } catch (_) {
          return fail('impossible de créer le dossier des captures');
        }
        const shot = path.join(SCREENSHOT_DIR, 'capture-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png');
        execFile('screencapture', ['-x', shot], opts, (e) =>
          e
            ? fail('capture refusée — autorise l\u2019enregistrement d\u2019écran pour le terminal (Réglages → Confidentialité et sécurité → Enregistrement de l\u2019écran)')
            : done('capture enregistrée dans data/screenshots/' + path.basename(shot))
        );
      } else if (a === 'pulse') {
        /* Ouvrir le programme de sport (le fichier Pulse) */
        const planPath = TRAINING.resolvePlanPath();
        if (!planPath) return fail('programme sport introuvable — indique le fichier Pulse dans les réglages');
        execFile('open', [planPath], opts, (e) =>
          (e ? fail('ouverture impossible') : done('programme sport ouvert (' + path.basename(planPath) + ')'))
        );
      } else if (a === 'training_done') {
        /* Valider la séance du jour : action d'écriture, donc confirmée */
        const jour = TRAINING.today();
        if (!jour.ok) return fail(jour.error || 'programme sport indisponible');
        if (jour.type === 'rest') return done('aujourd\u2019hui c\u2019est repos — rien à valider');
        const maj = TRAINING.markDone(jour.dateISO, true);
        done('séance validée : ' + (maj.title || '') + ' (' + (maj.ex || []).length + ' exercices cochés)');
      } else if (skills.SKILLS[a]) {
        /* Compétences de lecture : utilisables aussi via la ligne ACTION */
        skills.runSkill(a, s, skillCtx()).then((r) => {
          if (r && r.ok) done(r.output);
          else fail((r && r.error) || 'compétence indisponible');
        });
      } else {
        return fail('action inconnue');
      }
    } catch (e) {
      fail('exécution impossible : ' + e.message);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('Corps de requête trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* Requête sortante générique : Groq (HTTPS) ou serveur local (HTTP).
   `local` = true → target est une URL complète http://127.0.0.1:PORT/... */
function upstreamRequest(method, target, headers, bodyStream, timeoutMs, local) {
  return new Promise((resolve, reject) => {
    let host, port, reqPath, mod;
    if (local) {
      let u;
      try { u = new URL(target); } catch (e) { reject(new Error('URL invalide : ' + target)); return; }
      host = u.hostname;
      port = u.port || 80;
      reqPath = u.pathname + (u.search || '');
      mod = http;
    } else {
      host = GROQ_API_HOST;
      port = 443;
      reqPath = target;
      mod = https;
    }
    const req = mod.request(
      { host, port, path: reqPath, method, headers, timeout: timeoutMs || 30000 },
      (res) => resolve(res)
    );
    req.on('timeout', () => {
      req.destroy(new Error('Délai dépassé en contactant ' + (local ? 'le serveur local' : 'Groq')));
    });
    req.on('error', reject);
    if (Buffer.isBuffer(bodyStream)) {
      req.end(bodyStream);
    } else if (bodyStream) {
      bodyStream.pipe(req);
      bodyStream.on('error', reject);
    } else {
      req.end();
    }
  });
}

/* Requête vers l'API Groq (chemin relatif sur api.groq.com) */
function groqRequest(method, apiPath, headers, bodyStream, timeoutMs) {
  return upstreamRequest(method, apiPath, headers, bodyStream, timeoutMs, false);
}

/* ------------------------------------------------------------------ */
/* Mode démo (sans clé API) : réponses en français en streaming        */
/* ------------------------------------------------------------------ */

function demoReply(userText) {
  const t = (userText || '').toLowerCase();
  if (/bonjour|salut|hello|coucou|hey/.test(t)) {
    return "Bonjour ! Moi c'est Nova, ton assistante vocale. Je fonctionne pour l'instant en mode démonstration : mes réponses sont pré-écrites. Ajoute ta clé Groq dans le panneau de réglages, en haut à droite, et je deviendrai vraiment intelligente.";
  }
  if (/qui es[- ]tu|t'appelles|c'est quoi nova|présente[- ]toi/.test(t)) {
    return "Je m'appelle Nova. Je suis une assistante qui s'écoute et se parle : tu m'addresses la voix, je te réponds de même. En mode démonstration, je répète mes réponses favorites, mais avec une clé API Groq, je serai propulsée par Llama 3.3, un modèle de 70 milliards de paramètres.";
  }
  if (/merci/.test(t)) {
    return "Avec grand plaisir ! N'hésite pas à me reparler dès que tu veux. Et pense à la clé API pour débloquer le mode complet.";
  }
  if (/blague/.test(t)) {
    return "Voici une blague de développeur : pourquoi les plongeurs plongent-ils toujours en arrière et jamais en avant ? Parce que sinon, ils tombent dans le bateau.";
  }
  if (/voix|parle|son/.test(t)) {
    return "Effectivement, je peux te parler. Ma voix est l'une des voix françaises de ton Mac. Tu peux la changer et régler sa vitesse dans les réglages, avec l'icône d'engrenage en haut à droite.";
  }
  if (/clé|clef|api|groq/.test(t)) {
    return "Pour m'activer complètement, crée une clé API gratuite sur console point groq point com, puis colle-la dans les réglages en haut à droite. Elle reste sur ta machine, elle n'est jamais envoyée ailleurs que chez Groq.";
  }
  return "Je suis en mode démonstration, donc ma réponse est un peu répétitive : avec ta clé API Groq, je répondrai vraiment à tout ce que tu me diras. Clique sur l'engrenage en haut à droite pour configurer, ou continue de me parler en maintenant le bouton du microphone, ou la barre espace.";
}

function streamDemo(res, userText) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const text = demoReply(userText);
  // Découpe en petits morceaux "mot par mot" pour simuler le streaming
  const parts = text.match(/\S+\s*/g) || [text];
  let i = 0;
  const timer = setInterval(() => {
    const burst = parts.slice(i, i + 2).join('');
    i += 2;
    if (burst) {
      res.write(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { content: burst } }],
            demo: true,
          }) +
          '\n\n'
      );
    }
    if (i >= parts.length) {
      clearInterval(timer);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }, 45);
  res.on('close', () => clearInterval(timer));
}

/* ------------------------------------------------------------------ */
/* Modèles locaux : Ollama (port 11434) et LM Studio (port 1234)       */
/*                                                                     */
/* Les deux exposent une API compatible OpenAI (/v1/models,            */
/* /v1/chat/completions en SSE) : on les sonde à chaque /api/models    */
/* et, si un serveur tourne sur la machine, ses modèles apparaissent   */
/* préfixés « local-ollama/ » ou « local-lmstudio/ » dans le sélecteur. */
/* ------------------------------------------------------------------ */

/* URLs surchargables (tests, ou modèle servi par une autre machine du réseau) */
const LOCAL_PROVIDERS = [
  { id: 'ollama', label: 'Ollama', prefix: 'local-ollama', base: process.env.NOVA_OLLAMA_URL || 'http://127.0.0.1:11434' },
  { id: 'lmstudio', label: 'LM Studio', prefix: 'local-lmstudio', base: process.env.NOVA_LMSTUDIO_URL || 'http://127.0.0.1:1234' },
];

function providerOf(modelId) {
  const m = String(modelId || '');
  if (m.startsWith('local-ollama/')) return 'ollama';
  if (m.startsWith('local-lmstudio/')) return 'lmstudio';
  return 'groq';
}

/* Id « local-ollama/llama3.2:3b » → « llama3.2:3b » (nu, pour l'API locale) */
function localBareModel(modelId) {
  return String(modelId).split('/').slice(1).join('/');
}

/* Liste des modèles d'un serveur local ([] si absent ou pas lancé) */
async function localProviderModels(p) {
  try {
    const r = await upstreamRequest('GET', p.base + '/v1/models', null, null, 3000, true);
    const buf = await readBodyFromResponse(r);
    if (r.statusCode !== 200) return [];
    const data = JSON.parse(buf.toString('utf8'));
    return (data.data || [])
      .filter((m) => m && typeof m.id === 'string')
      .map((m) => ({ id: p.prefix + '/' + m.id, label: m.id, owned_by: p.label }));
  } catch (_) {
    return [];   // pas installé ou pas lancé : simplement absent de la liste
  }
}

/* Ouvre le flux SSE d'un modèle local. Long délai : le premier appel
   peut charger le modèle depuis le disque (plusieurs minutes sur une
   machine lente). Renvoie { res } ou { err } avec un message lisible. */
async function openLocalStream(p, modelId, payload, messages, skillNote) {
  const sys = skillNote ? buildSystemPrompt() + '\n\n' + skillNote : buildSystemPrompt();
  const body = JSON.stringify({
    model: localBareModel(modelId),
    messages: [{ role: 'system', content: sys }].concat(messages),
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.7,
    stream: true,
    /* pas de max_tokens imposé : chaque machine locale a ses propres limites */
  });
  try {
    const r = await upstreamRequest('POST', p.base + '/v1/chat/completions', {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Accept: 'text/event-stream',
    }, Buffer.from(body), 600000, true);
    if (r.statusCode !== 200) {
      const buf = await readBodyFromResponse(r);
      let msg = extraireErreurGroq(buf);
      if (!msg) {
        const t = buf.toString('utf8').slice(0, 200).trim();
        msg = t || 'HTTP ' + r.statusCode;
      }
      return { err: p.label + ' (' + localBareModel(modelId) + ') a refusé la requête : ' + msg };
    }
    return { res: r };
  } catch (e) {
    return {
      err: 'Impossible de joindre ' + p.label + ' sur ' + p.base + ' (' + e.message + '). ' +
           'Vérifie que le serveur est lancé (« ollama serve » ou le bouton Developer de LM Studio).',
    };
  }
}

/* ------------------------------------------------------------------ */
/* Routes API                                                          */
/* ------------------------------------------------------------------ */

/* Modèles de chat acceptés : familles actuelles de Groq. Les anciennes listes
 * excluaient gpt-oss, pourtant c'est le meilleur modèle disponible sur le
 * compte — d'où des réponses moindres en repli automatique. */
const CHAT_MODEL_RE = /(^|\b)(llama|mixtral|gemma|qwen|deepseek|kimi|gpt-oss|compound|allam)/i;

function pickChatModels(data) {
  return (data.data || [])
    .map((m) => m.id)
    .filter((id) => typeof id === 'string' && CHAT_MODEL_RE.test(id) && !/whisper|tts|orpheus|guard|embed/i.test(id))
    .sort((a, b) => modelScore(b) - modelScore(a) || a.localeCompare(b));
}

/* Les modèles les plus capables d'abord (gpt-oss-120b > 20b > 27b > 8b…). */
function modelScore(id) {
  const m = String(id).toLowerCase();
  let s = 0;
  if (/gpt-oss-120b/.test(m)) s = 100;
  else if (/gpt-oss-20b/.test(m)) s = 80;
  else if (/compound\b/.test(m) && !/mini/.test(m)) s = 70;
  else if (/qwen3\.8/.test(m)) s = 60;
  else if (/qwen/.test(m)) s = 50;
  else if (/70b/.test(m)) s = 40;
  else if (/kimi|deepseek/.test(m)) s = 30;
  else if (/allam|mixtral|gemma/.test(m)) s = 10;
  return s;
}

/* Le paramètre reasoning_effort: none n'est pas accepté par tous les modèles :
 * gpt-oss l'exige à « low » minimum, qwen tolère « none ». On adapte par modèle. */
function reasoningParamFor(mdl) {
  return /gpt-oss/i.test(String(mdl)) ? 'low' : 'none';
}

async function handleStatus(res) {
  sendJson(res, 200, {
    hasKey: Boolean(getApiKey()),
    model: process.env.GROQ_MODEL || DEFAULT_MODEL,
    sttModel: WHISPER_MODEL,
  });
}

async function handleModels(res) {
  const key = getApiKey();
  if (!key) {
    const locals = (await Promise.all(LOCAL_PROVIDERS.map(localProviderModels))).flat();
    sendJson(res, 200, {
      models: locals.concat([
        { id: DEFAULT_MODEL, label: 'GPT-OSS 120B (recommandé)', owned_by: 'openai' },
        { id: 'qwen/qwen3.6-27b', label: 'Qwen 3.6 27B (rapide)', owned_by: 'qwen' },
      ]),
    });
    return;
  }
  try {
    const r = await groqRequest(
      'GET',
      '/openai/v1/models',
      { Authorization: 'Bearer ' + key },
      null,
      15000
    );
    const buf = await readBodyFromResponse(r);
    if (r.statusCode !== 200) {
      sendJson(res, r.statusCode, { error: extraireErreurGroq(buf) || 'Erreur Groq' });
      return;
    }
    let data;
    try {
      data = JSON.parse(buf.toString('utf8'));
    } catch (_) {
      sendJson(res, 502, { error: 'Réponse illisible de Groq' });
      return;
    }
    const chat = (data.data || [])
      .filter((m) => typeof m.id === 'string' && CHAT_MODEL_RE.test(m.id) && !/whisper|tts|orpheus|guard|embed/i.test(m.id))
      .map((m) => ({ id: m.id, label: m.id, owned_by: m.owned_by || '' }))
      .sort((a, b) => modelScore(b.id) - modelScore(a.id) || a.id.localeCompare(b.id));
    // On ne propose le modèle par défaut que si le compte n'expose rien d'utilisable
    if (!chat.length) {
      chat.push({ id: DEFAULT_MODEL, label: DEFAULT_MODEL + ' (par défaut)', owned_by: 'meta' });
    }
    const locals = (await Promise.all(LOCAL_PROVIDERS.map(localProviderModels))).flat();
    if (locals.length) chat.unshift(...locals);
    sendJson(res, 200, { models: chat });
  } catch (e) {
    sendJson(res, 502, { error: 'Impossible de joindre Groq : ' + e.message });
  }
}

function readBodyFromResponse(r) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => resolve(Buffer.concat(chunks)));
    r.on('error', reject);
  });
}

function extraireErreurGroq(buf) {
  try {
    const j = JSON.parse(buf.toString('utf8'));
    return (j.error && (j.error.message || j.error.code)) || null;
  } catch (_) {
    return null;
  }
}

async function handleChat(req, res) {
  let payload;
  try {
    const buf = await readBody(req, 512 * 1024);
    payload = JSON.parse(buf.toString('utf8') || '{}');
  } catch (e) {
    sendJson(res, 400, { error: 'Requête invalide : ' + e.message });
    return;
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const userText = [...messages].reverse().find((m) => m && m.role === 'user');
  const lastUserText = userText ? String(userText.content || '') : '';
  const session = memoryEnsureSession(typeof payload.sessionId === 'string' ? payload.sessionId : null);

  /* Compétence de lecture détectée en amont : on va chercher la donnée réelle
     (heure, météo, batterie, disque, IP, presse-papiers…) et on la glisse au
     modèle, qui répond alors en une seule passe — moins cher et plus juste
     qu'un aller-retour « action → confirmation ». */
  let skillNote = '';
  let skillInfo = null;
  const det = skills.detectSkill(lastUserText);
  if (det) {
    const r = await skills.runSkill(det.skill, det.arg, skillCtx());
    if (r && r.ok) {
      skillInfo = { skill: det.skill, arg: det.arg || '', output: r.output, data: r.data || null };
      skillNote =
        'Information réelle obtenue à l\u2019instant par ta compétence « ' + det.skill + ' » : ' + r.output +
        '. Sers-t\u2019en pour répondre avec justesse, sans dire que tu as exécuté une commande.';
    }
  }
  if (profile === null) {
    /* premier tour : on matérialise le profil par défaut sur le disque */
    profile = { ...DEFAULT_PROFILE };
    saveProfileNow();
  }

  const model = typeof payload.model === 'string' && payload.model ? payload.model : (process.env.GROQ_MODEL || DEFAULT_MODEL);
  const provider = providerOf(model);

  /* Modèle local (Ollama / LM Studio) : ouvrir le flux et relayer, sans
     passer par le cheminement Groq (clé, repli de modèle, quotas). */
  if (provider !== 'groq') {
    const p = LOCAL_PROVIDERS.find((x) => x.id === provider);
    const up = await openLocalStream(p, model, payload, messages, skillNote);
    if (up.err) {
      sendJson(res, 502, { error: up.err });
      return;
    }
    relayOpenAiStream(req, res, up.res, session, profile, skillInfo, lastUserText, null);
    return;
  }

  const key = requestKey(req);
  if (!key) {
    streamDemo(res, lastUserText);
    return;
  }

  const HALF = Math.max(256, Math.floor(MAX_TOKENS / 2));
  const HALF2 = Math.max(200, Math.floor(HALF / 2));

  function buildBody(mdl, maxTok, useReasoningOff) {
    const body = {
      model: mdl,
      messages: [{ role: 'system', content: skillNote ? buildSystemPrompt() + '\n\n' + skillNote : buildSystemPrompt() }, ...messages],
      temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.7,
      max_tokens: maxTok,
      stream: true,
    };
    // Coupe le raisonnement des modèles qui le permettent : réponse directe,
    // et surtout économise massivement les tokens de sortie (OTPM).
    // gpt-oss exige « low » minimum, qwen accepte « none ».
    if (useReasoningOff) body.reasoning_effort = reasoningParamFor(mdl);
    return JSON.stringify(body);
  }

  async function openStream(mdl, maxTok, useReasoningOff) {
    const body = buildBody(mdl, maxTok, useReasoningOff);
    return groqRequest(
      'POST',
      '/openai/v1/chat/completions',
      {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'text/event-stream',
      },
      Buffer.from(body)
    );
  }

  // Meilleur modèle réellement utilisable sur le compte (≠ celui qui a échoué).
  // Trié par capacité (modelScore) : le repli prend le plus fort, pas le premier venu.
  async function pickAccountModel(failedModel) {
    try {
      const r = await groqRequest('GET', '/openai/v1/models', { Authorization: 'Bearer ' + key }, null, 15000);
      const buf = await readBodyFromResponse(r);
      if (r.statusCode !== 200) return null;
      const data = JSON.parse(buf.toString('utf8'));
      const ids = pickChatModels(data).filter((id) => id !== failedModel);
      return ids[0] || null;
    } catch (_) {
      return null;
    }
  }

  let chosenModel = model;
  let switchedModel = null;
  let useAlt = false;
  let reasoningOff = true;   // on essaie d'abord sans raisonnement
  let tok = MAX_TOKENS;
  let lastErr = '';
  let upstream = null;
  let ok = false;

  for (let attempt = 0; attempt < 6 && !ok; attempt++) {
    let mdl = chosenModel;
    if (useAlt) {
      if (switchedModel) mdl = switchedModel;
      else {
        mdl = await pickAccountModel(chosenModel);
        if (!mdl) break;
        switchedModel = mdl;
      }
    }
    try {
      upstream = await openStream(mdl, tok, reasoningOff);
    } catch (e) {
      sendJson(res, 502, { error: 'Impossible de joindre Groq : ' + e.message });
      return;
    }
    if (upstream.statusCode === 200) {
      chosenModel = mdl;
      ok = true;
      break;
    }
    const buf = await readBodyFromResponse(upstream);
    lastErr = extraireErreurGroq(buf) || '';
    upstream = null;

    if (/does not exist|do not have access|not found|decommissioned|does not have permission|not have access to the model/i.test(lastErr)) {
      useAlt = true;
    } else if (/reasoning_effort|reasoning/i.test(lastErr)) {
      reasoningOff = false;
    } else if (/output tokens per minute|reduce max_tokens/i.test(lastErr)) {
      tok = tok > HALF ? HALF : HALF2;     // limite OTPM → moins de tokens de sortie
    } else {
      break;                               // erreur non récupérable
    }
  }

  if (!ok) {
    sendJson(res, 502, {
      error: lastErr || 'Erreur Groq — aucun modèle utilisable sur ce compte.',
      model: chosenModel,
    });
    return;
  }

  relayOpenAiStream(req, res, upstream, session, profile, skillInfo, lastUserText, switchedModel);
}

/* Relais commun Groq / local : rediffuse le SSE OpenAI au client en
   filtrant <think>…</think> et les lignes ACTION, puis archive le tour
   dans la mémoire persistante. Identique quel que soit le fournisseur. */
function relayOpenAiStream(req, res, upstream, session, profile, skillInfo, lastUserText, switchedModel) {
  // Filtre streaming qui retire les blocs <think>…</think>
  // (raisonnement visible de certains modèles type Qwen) — même coupés entre chunks.
  function makeThinkFilter(emit) {
    let inThink = false;
    let buf = '';
    const TAGS = ['<think>', '</think>'];
    return {
      push(chunkStr) {
        buf += chunkStr;
        let guard = 0;
        while (guard++ < 500) {
          let best = -1;
          let tag = null;
          for (const t of TAGS) {
            const i = buf.indexOf(t);
            if (i !== -1 && (best === -1 || i < best)) { best = i; tag = t; }
          }
          if (!tag) break;
          if (!inThink && best > 0) emit(buf.slice(0, best));
          inThink = tag === '<think>';
          buf = buf.slice(best + tag.length);
        }
        if (!inThink && buf.length > 8) {
          // on garde une petite queue au cas où un tag soit coupé entre deux chunks
          emit(buf.slice(0, buf.length - 8));
          buf = buf.slice(-8);
        }
      },
      flush() {
        if (!inThink && buf) emit(buf);
        buf = '';
      },
    };
  }

  // Filtre streaming qui retire les lignes « ACTION: nom|argument » du flux affiché.
  // La ligne arrive souvent coupée entre deux chunks : on retient la fin de buffer
  // tant qu'elle pourrait commencer une ligne ACTION, et on la relâche sinon.
  function makeActionFilter(emit) {
    let buf = '';
    const RE = /^\s*ACTION:\s*([a-z]+)\s*\|/i;      // début d'une ligne ACTION complète
    function drain(final) {
      let guard = 0;
      while (guard++ < 200) {
        const nl = buf.indexOf('\n');
        if (nl === -1) break;
        const line = buf.slice(0, nl + 1);
        buf = buf.slice(nl + 1);
        if (RE.test(line)) continue; // ligne ACTION supprimée
        emit(line);
      }
      if (!final) {
        // garde en tampon ce qui pourrait encore devenir une ligne ACTION
        const m = buf.match(/^(\s*A(?:C(?:T(?:I(?:O(?:N)?)?)?)?)?:?\s*\w{0,30}\s*\|?)$/i);
        if (m) return; // tout retenir
        emit(buf);
        buf = '';
      }
    }
    return {
      push(chunkStr) {
        buf += chunkStr;
        drain(false);
      },
      flush() {
        drain(true);
        if (buf && !/^\s*ACTION:/i.test(buf)) emit(buf);
        buf = '';
      },
    };
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Relais du SSE : décodage UTF-8 sûr + filtrage des blocs <think> et des lignes ACTION
  res.write('data: ' + JSON.stringify({ nova_session: session.id }) + '\n\n');
  if (switchedModel) {
    res.write('data: ' + JSON.stringify({ nova_model_used: switchedModel }) + '\n\n');
  }
  res.write('data: ' + JSON.stringify({ nova_profile: profile }) + '\n\n');
  if (skillInfo) res.write('data: ' + JSON.stringify({ nova_skill: skillInfo }) + '\n\n');
  const macInfo = MAC_CONTROL_ENABLED ? { host: os.hostname(), platform: 'darwin', actions: MAC_ACTION_LIST } : null;
  if (macInfo) res.write('data: ' + JSON.stringify({ nova_mac: macInfo }) + '\n\n');
  const decoder = new StringDecoder('utf8');
  let accUser = lastUserText;
  let accAssistant = '';
  let rawSse = ''; // copie brute pour la mémoire (parsée en fin de flux)
  const filt = makeThinkFilter((s) => {
    actionFilt.push(s);
  });
  /* Retire les lignes ACTION: … du flux affiché (défense principale côté client, ce filtre en seconde barrière) */
  const actionFilt = makeActionFilter((s) => {
    try { res.write(s); } catch (_) { /* client parti */ }
  });
  upstream.on('data', (c) => {
    const dec = decoder.write(c);
    rawSse += dec;
    filt.push(dec);
  });
  let turnSaved = false;
  function saveTurnOnce(partial) {
    if (turnSaved) return;
    turnSaved = true;
    // Reconstruction de la réponse depuis le SSE brut (lignes complètes uniquement)
    for (const line of rawSse.split('\n')) {
      const d = line.trim();
      if (d.indexOf('data:') !== 0) continue;
      const payload = d.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const c = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (typeof c === 'string') accAssistant += c;
      } catch (_) {}
    }
    const cleanA = stripThink(accAssistant).replace(/^\s*ACTION:\s*[a-z]+\s*\|[^\n]*$/gim, '').trim();
    if (!accUser && !cleanA) return;
    memorySaveTurn(session.id, accUser, partial && cleanA ? cleanA + ' …' : cleanA);
  }
  upstream.on('end', () => {
    const tail = decoder.end();
    filt.push(tail);
    filt.flush();
    actionFilt.flush();
    // Sauvegarde du tour complet dans la mémoire persistante
    saveTurnOnce(false);
    if (finishWithAction()) return; // l'action terminera le flux après exécution
    try { res.end(); } catch (_) {}
  });
  // Client parti (barge-in / fermeture) : on garde quand même la trace partielle
  req.on('close', () => {
    saveTurnOnce(true);
    try { upstream.destroy(); } catch (_) {}
  });
  upstream.on('error', (e) => {
    try {
      res.write('data: ' + JSON.stringify({ error: e.message }) + '\n\n');
      res.end();
    } catch (_) {}
  });

  /* Annonce l'action demandée et clôt le flux. L'exécution ne se fait
     JAMAIS toute seule : le client affiche une carte de confirmation et
     n'appelle POST /api/mac/exec qu'après un clic explicite. La sandbox
     refuse en outre toute action hors allowlist. */
  function finishWithAction() {
    const full = stripThink(accAssistant);
    const m = full.match(MAC_ACTION_RE);
    if (!m) return false;
    const action = m[1].toLowerCase();
    const arg = m[2].trim();
    res.write('data: ' + JSON.stringify({ nova_action: { action, arg } }) + '\n\n');
    res.end();
    return true;
  }
}

async function handleStt(req, res) {
  const key = requestKey(req);
  if (!key) {
    sendJson(res, 200, {
      text: '',
      demo: true,
      message:
        "Mode démo : la transcription réelle nécessite une clé Groq. Écris ton message dans le champ de saisie en attendant.",
    });
    return;
  }

  let body;
  try {
    body = await readBody(req, 30 * 1024 * 1024); // 30 Mo max
  } catch (e) {
    sendJson(res, 413, { error: 'Enregistrement trop volumineux' });
    return;
  }

  const ct = String(req.headers['content-type'] || '');
  const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) {
    sendJson(res, 400, { error: 'Requête multipart attendue' });
    return;
  }
  const boundary = '--' + (m[1] || m[2]).trim();
  const parsed = parseMultipart(body, boundary);
  const filePart = parsed.find((p) => /audio|webm|octet-stream/i.test(p.contentType || '') || p.name === 'file');
  if (!filePart) {
    sendJson(res, 400, { error: 'Fichier audio introuvable dans la requête' });
    return;
  }

  // Requête multipart vers Groq Whisper
  const sttModel = process.env.GROQ_STT_MODEL || WHISPER_MODEL;
  const B = '----NovaForm' + Date.now().toString(36);

  function buildWhisperBody(modelName) {
    return buildMultipartBody(
      [
        mkPart('model', modelName),
        mkPart('language', 'fr'),
        mkPart('response_format', 'json'),
        mkPart('temperature', '0'),
        { name: 'file', filename: filePart.filename || 'audio.webm', contentType: filePart.contentType || 'audio/webm', data: filePart.data },
      ],
      B
    );
  }

  async function tryWhisper(modelName) {
    const outBody = buildWhisperBody(modelName);
    const r = await groqRequest(
      'POST',
      '/openai/v1/audio/transcriptions',
      {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'multipart/form-data; boundary=' + B,
        'Content-Length': outBody.length,
      },
      outBody
    );
    const buf = await readBodyFromResponse(r);
    return { status: r.statusCode, buf };
  }

  try {
    let out = await tryWhisper(sttModel);
    // Certains comptes n'ont pas le modèle turbo : retenter avec whisper-large-v3
    if (out.status !== 200 && !process.env.GROQ_STT_MODEL) {
      const errStr = extraireErreurGroq(out.buf) || '';
      if (/model|decommission|not found|does not exist/i.test(errStr) || out.status === 404) {
        out = await tryWhisper(FALLBACK_STT_MODEL);
      }
    }
    if (out.status !== 200) {
      sendJson(res, out.status === 401 ? 401 : 502, {
        error: extraireErreurGroq(out.buf) || 'Erreur Groq (HTTP ' + out.status + ')',
      });
      return;
    }
    let data;
    try {
      data = JSON.parse(out.buf.toString('utf8'));
    } catch (_) {
      sendJson(res, 502, { error: 'Réponse illisible de Groq' });
      return;
    }
    sendJson(res, 200, { text: (data.text || '').trim() });
  } catch (e) {
    sendJson(res, 502, { error: 'Impossible de joindre Groq : ' + e.message });
  }
}

function mkPart(name, value) {
  return { name, filename: null, contentType: null, data: Buffer.from(String(value)) };
}

function buildMultipartBody(parts, boundary) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(
      Buffer.from(
        '--' + boundary + '\r\n' +
        (p.filename
          ? 'Content-Disposition: form-data; name="' + p.name + '"; filename="' + p.filename + '"\r\n'
          : 'Content-Disposition: form-data; name="' + p.name + '"\r\n') +
        (p.contentType ? 'Content-Type: ' + p.contentType + '\r\n' : '') +
        '\r\n'
      )
    );
    chunks.push(p.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n'));
  return Buffer.concat(chunks);
}

function parseMultipart(buf, boundary) {
  const parts = [];
  const bBuf = Buffer.from(boundary);
  let idx = buf.indexOf(bBuf);
  while (idx !== -1) {
    const next = buf.indexOf(bBuf, idx + bBuf.length);
    if (next === -1) break;
    let seg = buf.slice(idx + bBuf.length, next);
    // retirer le CRLF initial
    if (seg[0] === 13 && seg[1] === 10) seg = seg.slice(2);
    const headerEnd = seg.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerStr = seg.slice(0, headerEnd).toString('utf8');
      const data = seg.slice(headerEnd + 4);
      // retirer le CRLF final
      const trimmed = data.length >= 2 && data[data.length - 2] === 13 && data[data.length - 1] === 10
        ? data.slice(0, -2)
        : data;
      const nameM = headerStr.match(/name="([^"]*)"/i);
      const fileM = headerStr.match(/filename="([^"]*)"/i);
      const ctM = headerStr.match(/content-type:\s*([^\r\n]+)/i);
      parts.push({
        name: nameM ? nameM[1] : '',
        filename: fileM ? fileM[1] : null,
        contentType: ctM ? ctM[1].trim() : null,
        data: trimmed,
      });
    }
    idx = next;
  }
  return parts;
}

/* ------------------------------------------------------------------ */
/* Routes mémoire                                                      */
/* ------------------------------------------------------------------ */

async function handleProfilePut(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
  } catch (_) {
    sendJson(res, 400, { error: 'Requête invalide' });
    return;
  }
  const clean = {};
  for (const k of ['name', 'physique', 'studies', 'notes']) {
    if (typeof body[k] === 'string') clean[k] = body[k].replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  if (body.age !== undefined) {
    const n = parseInt(body.age, 10);
    clean.age = isNaN(n) ? '' : Math.max(0, Math.min(120, n));
  }
  if (profile === null) profile = { ...DEFAULT_PROFILE };
  profile = { ...profile, ...clean };
  saveProfileNow();
  sendJson(res, 200, { ok: true, profile });
}

async function handleMacExec(req, res) {
  if (!MAC_CONTROL_ENABLED) {
    sendJson(res, 403, { error: 'Contrôle du Mac désactivé (MAC_CONTROL=off dans .env)' });
    return;
  }
  let body;
  try {
    body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8') || '{}');
  } catch (_) {
    sendJson(res, 400, { error: 'Requête invalide' });
    return;
  }
  const result = await execMacAction(String(body.action || ''), body.arg);
  sendJson(res, 200, result);
}

/* ------------------------------------------------------------------ */
/* Sport : état complet du programme et de la progression              */
/* ------------------------------------------------------------------ */

/* Un seul objet sert les lectures ET les réponses aux écritures : le
   panneau Sport se resynchronise donc toujours sur la vérité du disque. */
function trainingState() {
  const p = TRAINING.plan();
  const jour = TRAINING.today();
  const semaine = TRAINING.week(0);
  return {
    ok: true,
    plan: {
      found: !!p.ok,
      path: p.ok ? p.path : (TRAINING.store.planPath || ''),
      error: p.ok ? '' : (p.error || ''),
      programWeeks: (p.ok && p.programWeeks) || 0,
      days: p.ok
        ? p.days.map((d, i) => ({
            label: entrainement.DAY_NAMES[i], type: d.type, title: d.title,
            focus: d.focus, exCount: d.ex.length,
          }))
        : [],
    },
    config: { start: TRAINING.startISO(), planPath: TRAINING.store.planPath || '' },
    today: jour,
    week: semaine,
    stats: TRAINING.stats(),
  };
}

/* ?week=±N permet au panneau Sport de naviguer dans les semaines sans
   que le client ait à recalculer les phases lui-même. */
async function handleTraining(res, offsetWeeks) {
  const etat = trainingState();
  const offset = Number(offsetWeeks) || 0;
  if (offset) {
    const borne = Math.max(-520, Math.min(520, Math.round(offset)));
    etat.week = TRAINING.week(borne);
  }
  sendJson(res, 200, etat);
}

async function handleTrainingConfig(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8') || '{}');
  } catch (_) {
    sendJson(res, 400, { error: 'Requête invalide' });
    return;
  }
  let message = '';
  if (typeof body.planPath === 'string') {
    const p = body.planPath.trim();
    /* Un chemin de programme doit être un fichier HTML lisible : on ne
       laisse pas le serveur ouvrir n'importe quoi. */
    if (p && !/\.html?$/i.test(p)) {
      sendJson(res, 400, { error: 'le programme doit être un fichier .html (celui de Pulse)' });
      return;
    }
    if (p && !fs.existsSync(p)) {
      sendJson(res, 400, { error: 'fichier introuvable : ' + p });
      return;
    }
    const plan = TRAINING.setPlanPath(p);
    message = p ? (plan.ok ? 'Programme chargé' : 'Fichier refusé : ' + plan.error) : 'Chemin effacé';
  }
  if (typeof body.start === 'string' && body.start) {
    if (!TRAINING.setStart(body.start)) {
      sendJson(res, 400, { error: 'date de début invalide (attendu AAAA-MM-JJ)' });
      return;
    }
    message = message || 'Date de début enregistrée';
  }
  const etat = trainingState();
  etat.message = message;
  sendJson(res, 200, etat);
}

async function handleTrainingDone(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8') || '{}');
  } catch (_) {
    sendJson(res, 400, { error: 'Requête invalide' });
    return;
  }
  const dateISO = typeof body.date === 'string' && entrainement.isIsoDate(body.date)
    ? body.date
    : entrainement.todayISO();
  if (body.index !== undefined && body.index !== null) {
    const r = TRAINING.setExercise(dateISO, body.index, body.value !== false);
    if (!r || r.ok === false) {
      sendJson(res, 400, { error: (r && r.error) || 'mise à jour impossible' });
      return;
    }
  } else {
    TRAINING.markDone(dateISO, body.done !== false);
  }
  sendJson(res, 200, trainingState());
}

async function handleTrainingImport(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
  } catch (_) {
    sendJson(res, 400, { error: 'Requête invalide' });
    return;
  }
  const r = TRAINING.importPulse(body.content !== undefined ? body.content : body);
  if (!r.ok) {
    sendJson(res, 400, { error: r.error });
    return;
  }
  const etat = trainingState();
  etat.message = 'Sauvegarde Pulse importée : ' + r.added + ' séance(s) ajoutée(s), ' + r.updated + ' mise(s) à jour.';
  etat.imported = r;
  sendJson(res, 200, etat);
}

async function handleTrainingReset(req, res) {
  let body = {};
  try {
    body = JSON.parse((await readBody(req, 4 * 1024)).toString('utf8') || '{}');
  } catch (_) {}
  TRAINING.reset(body.keepConfig !== false);
  sendJson(res, 200, trainingState());
}

async function handleMemoryList(res) {
  sendJson(res, 200, memorySummary());
}

async function handleMemorySession(res, sid) {
  const sess = memory.sessions.find((s) => s.id === sid);
  if (!sess) {
    sendJson(res, 404, { error: 'Conversation introuvable' });
    return;
  }
  sendJson(res, 200, sess);
}

async function handleMemoryDelete(res, sid) {
  const i = memory.sessions.findIndex((s) => s.id === sid);
  if (i === -1) {
    sendJson(res, 404, { error: 'Conversation introuvable' });
    return;
  }
  const [gone] = memory.sessions.splice(i, 1);
  if (memory.lastSessionId === gone.id) {
    memory.lastSessionId = memory.sessions[0] ? memory.sessions[0].id : null;
  }
  flushMemoryNow(); // suppression = écriture immédiate
  sendJson(res, 200, { ok: true, deleted: gone.id });
}

async function handleMemoryForget(res) {
  const count = memory.sessions.length;
  memory.sessions = [];
  memory.lastSessionId = null;
  flushMemoryNow(); // oubli = écriture immédiate
  sendJson(res, 200, { ok: true, forgotten: count });
}

/* Diagnostic : tout ce qu'il faut pour comprendre pourquoi quelque chose
   ne marche pas (clé absente, dossier non inscriptible, micro refusé…).
   Aucune donnée sensible : la clé n'est jamais renvoyée, juste sa présence. */
async function handleDiag(res) {
  const key = getApiKey();
  let dataWritable = true;
  let dataError = '';
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
  } catch (e) {
    dataWritable = false;
    dataError = e.message;
  }
  const turns = memory.sessions.reduce((n, s) => n + (Array.isArray(s.turns) ? s.turns.length : 1), 0);
  sendJson(res, 200, {
    ok: true,
    server: {
      node: process.version,
      platform: process.platform + ' · ' + process.arch,
      host: os.hostname(),
      uptime: Math.floor(process.uptime()),
      port: PORT,
    },
    groq: {
      keyConfigured: !!key,
      keySource: key ? 'serveur (.env)' : 'aucune — mode démo',
      model: process.env.GROQ_MODEL || DEFAULT_MODEL,
      sttModel: WHISPER_MODEL,
      maxTokens: MAX_TOKENS,
    },
    data: {
      dir: DATA_DIR,
      writable: dataWritable,
      error: dataError,
      sessions: memory.sessions.length,
      turns,
      lastSessionId: memory.lastSessionId || null,
      profileSaved: !!profile,
      profileName: (profile && profile.name) || '',
    },
    mac: {
      enabled: MAC_CONTROL_ENABLED,
      host: os.hostname(),
      actions: MAC_ACTION_LIST,
      readonly: skills.READONLY_SKILLS,
      screenshotDir: SCREENSHOT_DIR,
    },
    training: TRAINING.info(),
  });
}

/* ------------------------------------------------------------------ */
/* Fichiers statiques                                                  */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, p));
  /* Comparaison avec le séparateur final : sinon un dossier voisin dont le nom
     commence pareil (« public-old ») passerait le test de préfixe. */
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { error: 'Interdit' });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 — Introuvable');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* Serveur                                                             */
/* ------------------------------------------------------------------ */

/* CORS strict : uniquement pour le site officiel du projet et le local
   (développement du site lui-même). Le site (dmzgamingyt.github.io) peut
   détecter une Nova qui tourne sur la machine du visiteur et lui parler ;
   le reste du web, non. */
const CORS_ALLOW = new Set([
  'https://dmzgamingyt.github.io',
  'http://localhost:5020',
  'http://127.0.0.1:5020',
]);

function corsHeaders(origin) {
  if (!origin || !CORS_ALLOW.has(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Nova-Key',
    'Access-Control-Max-Age': '86400',
  };
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  try {
    /* Préflight CORS (site officiel uniquement). */
    if (req.method === 'OPTIONS') {
      const cors = corsHeaders(req.headers.origin);
      if (cors) {
        res.writeHead(204, cors);
        res.end();
      } else {
        res.writeHead(403);
        res.end();
      }
      return;
    }
    const cors = corsHeaders(req.headers.origin);
    if (cors) {
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    }
    if (req.method === 'GET' && url === '/api/status') return void (await handleStatus(res));
    if (req.method === 'GET' && url === '/api/models') return void (await handleModels(res));
    if (req.method === 'POST' && url === '/api/chat') return void (await handleChat(req, res));
    if (req.method === 'POST' && url === '/api/stt') return void (await handleStt(req, res));
    if (req.method === 'GET' && url === '/api/memory') return void (await handleMemoryList(res));
    if (req.method === 'DELETE' && url.startsWith('/api/memory/')) return void (await handleMemoryDelete(res, url.slice('/api/memory/'.length)));
    if (req.method === 'GET' && url.startsWith('/api/memory/')) return void (await handleMemorySession(res, url.slice('/api/memory/'.length)));
    if (req.method === 'POST' && url === '/api/memory/forget') return void (await handleMemoryForget(res));
    if (req.method === 'GET' && (url === '/api/training' || url.startsWith('/api/training?'))) {
      let offset = 0;
      try {
        offset = new URLSearchParams(url.slice(url.indexOf('?'))).get('week') || 0;
      } catch (_) {}
      return void (await handleTraining(res, offset));
    }
    if (req.method === 'POST' && url === '/api/training/config') return void (await handleTrainingConfig(req, res));
    if (req.method === 'POST' && url === '/api/training/done') return void (await handleTrainingDone(req, res));
    if (req.method === 'POST' && url === '/api/training/import') return void (await handleTrainingImport(req, res));
    if (req.method === 'POST' && url === '/api/training/reset') return void (await handleTrainingReset(req, res));
    if (req.method === 'GET' && url === '/api/profile') return void sendJson(res, 200, { profile });
    if (req.method === 'PUT' && url === '/api/profile') return void (await handleProfilePut(req, res));
    if (req.method === 'POST' && url === '/api/mac/exec') return void (await handleMacExec(req, res));
    if (req.method === 'GET' && url === '/api/mac/status') return void sendJson(res, 200, { enabled: MAC_CONTROL_ENABLED, host: os.hostname(), actions: MAC_ACTION_LIST, readonly: skills.READONLY_SKILLS });
    if (req.method === 'GET' && url === '/api/diag') return void (await handleDiag(res));
    if (req.method === 'GET') return serveStatic(req, res, url);
    sendJson(res, 405, { error: 'Méthode non autorisée' });
  } catch (e) {
    try {
      sendJson(res, 500, { error: 'Erreur interne : ' + e.message });
    } catch (_) {}
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const key = getApiKey();
  console.log('');
  console.log('  ✦ Nova — Assistant IA vocal');
  console.log('  ─────────────────────────────');
  console.log('  Adresse locale : http://localhost:' + PORT);
  console.log('  Clé Groq      : ' + (key ? '✓ trouvée (' + key.slice(0, 6) + '…)' : '✗ absente (mode démo actif)'));
  console.log('  Modèle        : ' + (process.env.GROQ_MODEL || DEFAULT_MODEL));
  console.log('  Mémoire       : ' + memory.sessions.length + ' conversation(s) gardée(s)');
  console.log('');
  console.log('  Astuce : double-clique sur start.command, ou laisse ce terminal ouvert.');
  console.log('  Arrêter : Ctrl+C');
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('Le port ' + PORT + ' est déjà utilisé. Ferme l\'autre instance ou change PORT dans .env.');
    process.exit(1);
  }
  console.error('Erreur serveur :', e.message);
});
