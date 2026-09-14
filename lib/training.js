/* ============================================================
   Nova — moteur sport (programme « Pulse », poids du corps)

   Principe : Nova ne recopie PAS le programme. Elle l'ouvre.
   Le plan vit dans le fichier Pulse de l'utilisateur
   (index.html, autonome) : on en extrait le littéral `PLAN` et
   on le relit à chaque changement du fichier. Modifier le
   programme dans Pulse suffit donc à mettre Nova à jour — pas
   de copie qui dérive.

   La progression, elle, est propre à Nova (data/training.json) :
   quelles séances sont validées, quels exercices sont cochés.
   Une sauvegarde exportée depuis Pulse peut être importée pour
   amorcer l'historique.

   Module isolé (aucun état global, aucune dépendance au serveur
   HTTP) pour être testable directement : voir test/training.test.js.
   ============================================================ */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

/* ------------------------------------------------------------------ */
/* Constantes partagées                                               */
/* ------------------------------------------------------------------ */

const DAY_NAMES = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const WEEK_GOAL = 5;              // séances visées par semaine (comme Pulse)
const PROGRAM_WEEKS_FALLBACK = 16;
const MAX_SESSIONS = 3000;        // garde-fou sur le fichier de progression
const STORE_VERSION = 1;

/* Phases du programme : identiques à Pulse (cycle de 7 semaines). */
function phaseOf(weekIndex) {
  const c = (((Number(weekIndex) || 0) % 7) + 7) % 7;
  if (c <= 1) {
    return {
      key: 'fondation', name: 'Fondation', mult: 1, restMult: 1, setBonus: 0,
      desc: 'Volume modéré : on apprend les mouvements, on soigne la technique et l’amplitude.',
    };
  }
  if (c <= 3) {
    return {
      key: 'dev', name: 'Développement', mult: 1.15, restMult: 1, setBonus: 2,
      desc: 'Volume en hausse : séries supplémentaires sur les exercices clés, on progresse proprement.',
    };
  }
  if (c <= 5) {
    return {
      key: 'intensite', name: 'Intensité', mult: 1.3, restMult: 0.85, setBonus: 2,
      desc: 'Repos raccourci et temps sous tension accru : le corps s’adapte, la force grimpe.',
    };
  }
  return {
    key: 'deload', name: 'Allègement', mult: 0.75, restMult: 1.15, setBonus: 0,
    desc: 'Semaine plus douce pour assimiler, récupérer et arriver frais au cycle suivant.',
  };
}

/* ------------------------------------------------------------------ */
/* Dates — tout est local, jamais en UTC, jamais via le fuseau        */
/* ------------------------------------------------------------------ */

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function isoDate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function parseISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d;
}

function isIsoDate(s) { return !!parseISO(s); }

function todayISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return isoDate(d);
}

function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

/** Lundi de la semaine contenant `d` (la semaine commence lundi). */
function mondayOf(d) {
  const x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

/** 0 = lundi … 6 = dimanche */
function dowIndex(d) { return (d.getDay() + 6) % 7; }

/** Nombre de jours entiers entre deux dates (insensible aux changements d'heure). */
function daysBetween(a, b) {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / 86400000);
}

function frDateLong(d) {
  try {
    const s = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  } catch (_) {
    return isoDate(d);
  }
}

/* ------------------------------------------------------------------ */
/* Lecture du plan depuis le fichier Pulse                            */
/* ------------------------------------------------------------------ */

/* Extrait le littéral JS qui suit `const PLAN =` (ou let/var), en tenant
   compte des chaînes, des échappements et des commentaires. */
function findLiteral(html, name) {
  const src = String(html || '');
  const re = new RegExp('(?:const|let|var)\\s+' + name + '\\s*=\\s*');
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index + m[0].length;
  const open = src[start];
  if (open !== '[' && open !== '{') return null;
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let quote = null;
  let mode = 'code';
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    const next = src[j + 1];
    if (mode === 'line') { if (c === '\n') mode = 'code'; continue; }
    if (mode === 'block') { if (c === '*' && next === '/') { mode = 'code'; j++; } continue; }
    if (quote) {
      if (c === '\\') { j++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && next === '/') { mode = 'line'; j++; continue; }
    if (c === '/' && next === '*') { mode = 'block'; j++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  return null;
}

/* Le littéral est évalué dans un contexte vide et avec un délai : il ne
   contient que des données, jamais de code censé s'exécuter. */
function evalLiteral(literal) {
  if (!literal || literal.length > 200000) return null;
  try {
    return vm.runInNewContext('(' + literal + ')', Object.create(null), { timeout: 1500 });
  } catch (_) {
    return null;
  }
}

function cleanStr(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanNum(v, min, max) {
  const n = Math.round(Number(v));
  if (!isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

/** Normalise un exercice : on ne garde que des champs connus et bornés. */
function normalizeExercise(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const n = cleanStr(raw.n, 90);
  if (!n) return null;
  const ex = {
    n: n,
    cue: cleanStr(raw.cue, 400),
    s: cleanNum(raw.s, 1, 20) || 1,
    rest: cleanNum(raw.rest, 0, 900) || 0,
    m: cleanStr(raw.m, 90),
  };
  /* Une valeur nulle ou négative est une erreur de saisie : on la jette
     plutôt que de la ramener à 1, ce qui inventerait une prescription. */
  const reps = Number(raw.reps) > 0 ? cleanNum(raw.reps, 1, 400) : null;
  const secs = Number(raw.secs) > 0 ? cleanNum(raw.secs, 3, 7200) : null;
  if (reps) ex.reps = reps;
  else if (secs) ex.secs = secs;
  const note = cleanStr(raw.note, 40);
  if (note) ex.note = note;
  return ex;
}

/** Normalise le programme : 7 jours obligatoires, types connus. */
function normalizePlan(raw) {
  if (!Array.isArray(raw) || raw.length !== 7) {
    return { ok: false, error: 'le programme doit contenir exactement 7 journées' };
  }
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = raw[i];
    if (!d || typeof d !== 'object') return { ok: false, error: 'jour ' + (i + 1) + ' illisible' };
    const type = cleanStr(d.type, 20) || 'rest';
    if (!/^[a-z]{3,12}$/.test(type)) return { ok: false, error: 'jour ' + (i + 1) + ' : type inattendu' };
    const focus = Array.isArray(d.focus)
      ? d.focus.map((f) => cleanStr(f, 40)).filter(Boolean).slice(0, 6)
      : [];
    const ex = (Array.isArray(d.ex) ? d.ex : []).map(normalizeExercise).filter(Boolean).slice(0, 20);
    days.push({
      type: type,
      title: cleanStr(d.title, 120) || 'Séance',
      icon: cleanStr(d.icon, 30),
      accent: /^#[0-9a-f]{3,8}$/i.test(String(d.accent || '')) ? String(d.accent) : '',
      focus: focus,
      ex: ex,
    });
  }
  return { ok: true, days: days };
}

function programWeeksFromHtml(html) {
  const m = /(?:const|let|var)\s+PROGRAM_WEEKS\s*=\s*(\d{1,3})/.exec(String(html || ''));
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= 104 ? n : PROGRAM_WEEKS_FALLBACK;
}

/* Reconnaît un fichier Pulse sans se tromper : le plan ET la marque. */
function looksLikePulse(html) {
  const s = String(html || '');
  return /(?:const|let|var)\s+PLAN\s*=\s*\[/.test(s) && /pulse/i.test(s);
}

/** Lit un fichier et en tire le programme. Ne jette jamais. */
function readPlanFile(filePath) {
  let html;
  try {
    html = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { ok: false, error: 'fichier illisible (' + (e.code || 'erreur') + ')' };
  }
  if (!/(?:const|let|var)\s+PLAN\s*=\s*\[/.test(html)) {
    return { ok: false, error: 'aucun programme trouvé dans ce fichier (il ne ressemble pas à Pulse)' };
  }
  const literal = findLiteral(html, 'PLAN');
  if (!literal) return { ok: false, error: 'programme trouvé mais illisible (littéral PLAN incomplet)' };
  const value = evalLiteral(literal);
  if (!value) return { ok: false, error: 'programme illisible (le littéral PLAN n’est pas des données valides)' };
  const norm = normalizePlan(value);
  if (!norm.ok) return { ok: false, error: norm.error };
  return {
    ok: true,
    days: norm.days,
    programWeeks: programWeeksFromHtml(html),
  };
}

/* Fichiers Pulse possibles, du plus probable au moins probable.
   Sert à retrouver le programme si l'utilisateur déplace le dossier. */
function detectPlanPath(home) {
  const base = home || os.homedir();
  const racines = [path.join(base, 'Desktop'), path.join(base, 'Bureau'), path.join(base, 'Documents')];
  const candidats = [];
  for (const racine of racines) {
    let entrees;
    try {
      entrees = fs.readdirSync(racine, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entrees) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        for (const nom of ['index.html', 'pulse.html', 'Pulse.html']) {
          candidats.push(path.join(racine, e.name, nom));
        }
      } else if (/\.html?$/i.test(e.name)) {
        candidats.push(path.join(racine, e.name));
      }
    }
  }
  for (const c of candidats.slice(0, 60)) {
    let html;
    try {
      const st = fs.statSync(c);
      if (!st.isFile() || st.size > 4 * 1024 * 1024) continue;
      html = fs.readFileSync(c, 'utf8');
    } catch (_) {
      continue;
    }
    if (looksLikePulse(html)) return c;
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* Séance d'un jour (phase appliquée)                                 */
/* ------------------------------------------------------------------ */

function dayPlanFor(plan, dateISO, startISO) {
  const d = parseISO(dateISO);
  if (!d || !plan || !plan.days || plan.days.length !== 7) return null;
  const tpl = plan.days[dowIndex(d)];
  const start = parseISO(startISO);
  const week = start ? Math.floor(daysBetween(mondayOf(start), mondayOf(d)) / 7) : 0;
  const phase = phaseOf(Math.max(0, week));
  if (tpl.type === 'rest' || !tpl.ex.length) {
    return {
      dateISO: dateISO, dow: dowIndex(d), week: week, phase: phase,
      type: tpl.type, title: tpl.title, focus: tpl.focus, accent: tpl.accent, ex: [],
    };
  }
  const ex = tpl.ex.map((e, i) => {
    const bonus = i < phase.setBonus ? 1 : 0;
    const out = { n: e.n, cue: e.cue, m: e.m, s: Math.min(6, e.s + bonus) };
    if (e.reps) out.reps = Math.round(e.reps * phase.mult);
    if (e.secs) out.secs = Math.round((e.secs * phase.mult) / 5) * 5;
    out.rest = Math.round((e.rest * phase.restMult) / 5) * 5;
    if (e.note) out.note = e.note;
    return out;
  });
  return {
    dateISO: dateISO, dow: dowIndex(d), week: week, phase: phase,
    type: tpl.type, title: tpl.title, focus: tpl.focus, accent: tpl.accent, ex: ex,
  };
}

/** Durée estimée, même formule que Pulse. */
function estMinutes(p) {
  if (!p || p.type === 'rest') return 0;
  let t = 0;
  for (const e of p.ex || []) {
    const duree = e.reps ? e.reps * 2.5 : (e.secs || 0);
    t += e.s * (duree + e.rest + 15);
  }
  return Math.round(t / 60);
}

/** « 4 × 10 de pompes, 75 s de repos » — forme parlable. */
function describeExercise(e) {
  const charge = e.reps ? e.s + ' séries de ' + e.reps + ' répétitions'
    : e.secs ? e.s + ' séries de ' + e.secs + ' secondes'
      : e.s + ' séries';
  const repos = e.rest ? ', ' + e.rest + ' s de repos' : '';
  const note = e.note ? ' ' + e.note : '';
  return e.n + ' : ' + charge + repos + note + (e.m ? ' (' + e.m + ')' : '');
}

/* ------------------------------------------------------------------ */
/* Niveaux (mêmes paliers que Pulse)                                  */
/* ------------------------------------------------------------------ */

const LEVELS = [
  { min: 0, name: 'Débutant' },
  { min: 120, name: 'Régulier' },
  { min: 320, name: 'Discipliné' },
  { min: 650, name: 'Athlète' },
  { min: 1100, name: 'Machine' },
  { min: 1700, name: 'Légende' },
];

function levelOf(xp) {
  let lvl = LEVELS[0];
  for (const l of LEVELS) if (xp >= l.min) lvl = l;
  return lvl;
}

/* ------------------------------------------------------------------ */
/* L'instance : plan + progression                                     */
/* ------------------------------------------------------------------ */

class Training {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir   dossier de données (training.json)
   * @param {string} [opts.planPath] chemin du fichier Pulse
   * @param {string} [opts.envPath]  chemin forcé par l'environnement (prioritaire)
   */
  constructor(opts) {
    opts = opts || {};
    this.dataDir = opts.dataDir || path.join(__dirname, '..', 'data');
    this.file = path.join(this.dataDir, 'training.json');
    this.envPath = opts.envPath || '';
    this.store = {
      version: STORE_VERSION,
      start: '',
      planPath: opts.planPath || '',
      sessions: {},
      updatedAt: '',
    };
    this._cache = null; // { path, mtime, plan, error, days, programWeeks }
  }

  /* ---------- progression : lecture / écriture ---------- */

  countSessions() { return Object.keys(this.store.sessions).length; }

  load() {
    let j = null;
    try {
      j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (_) {
      j = null; // premier lancement, ou fichier corrompu : on repart proprement
    }
    const s = { version: STORE_VERSION, start: '', planPath: '', sessions: {}, updatedAt: '' };
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      if (isIsoDate(j.start)) s.start = String(j.start);
      if (typeof j.planPath === 'string') s.planPath = j.planPath.slice(0, 500);
      if (j.sessions && typeof j.sessions === 'object' && !Array.isArray(j.sessions)) {
        const cles = Object.keys(j.sessions).slice(0, MAX_SESSIONS);
        for (const k of cles) {
          if (!isIsoDate(k)) continue;
          const r = j.sessions[k];
          if (!r || typeof r !== 'object') continue;
          const rec = {};
          if (r.done) rec.done = 1;
          if (r.ex && typeof r.ex === 'object' && !Array.isArray(r.ex)) {
            const ex = {};
            for (const ik of Object.keys(r.ex).slice(0, 40)) {
              const idx = Number(ik);
              if (!isFinite(idx) || idx < 0 || idx > 39) continue;
              if (r.ex[ik]) ex[String(idx)] = 1;
            }
            if (Object.keys(ex).length) rec.ex = ex;
          }
          const note = cleanStr(r.note, 200);
          if (note) rec.note = note;
          if (Object.keys(rec).length) s.sessions[k] = rec;
        }
      }
      if (typeof j.updatedAt === 'string') s.updatedAt = j.updatedAt.slice(0, 40);
    }
    this.store = s;
    return this;
  }

  save() {
    this.store.updatedAt = new Date().toISOString();
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.store, null, 1));
      fs.renameSync(tmp, this.file);
      return true;
    } catch (_) {
      return false; // disque plein : on ne casse pas la conversation
    }
  }

  /* ---------- plan ---------- */

  /** Chemin effectif : environnement > configuration > détection automatique. */
  resolvePlanPath() {
    if (this.envPath && fs.existsSync(this.envPath)) return this.envPath;
    const conf = this.store.planPath;
    if (conf && fs.existsSync(conf)) return conf;
    /* La détection balaie le Bureau : désactivable (NOVA_TRAINING_AUTODETECT=off). */
    if (/^(off|0|non|false)$/i.test(String(process.env.NOVA_TRAINING_AUTODETECT || ''))) return conf || this.envPath || '';
    const trouve = detectPlanPath();
    if (trouve) {
      if (trouve !== conf) {
        this.store.planPath = trouve;
        this.save();
      }
      return trouve;
    }
    return conf || this.envPath || '';
  }

  /** Plante le programme (cache invalidé au moindre changement du fichier). */
  plan() {
    const p = this.resolvePlanPath();
    if (!p) {
      return { ok: false, error: 'programme sport introuvable — indique le fichier Pulse dans les réglages' };
    }
    let mtime = 0;
    try {
      mtime = fs.statSync(p).mtimeMs;
    } catch (_) {
      mtime = 0;
    }
    if (this._cache && this._cache.path === p && this._cache.mtime === mtime) return this._cache.result;
    const lu = readPlanFile(p);
    const result = lu.ok
      ? { ok: true, path: p, days: lu.days, programWeeks: lu.programWeeks, mtime: mtime }
      : { ok: false, path: p, error: lu.error };
    this._cache = { path: p, mtime: mtime, result: result };
    return result;
  }

  setPlanPath(p) {
    this.store.planPath = typeof p === 'string' ? p.trim().slice(0, 500) : '';
    this._cache = null;
    this.save();
    return this.plan();
  }

  /* ---------- dates du programme ---------- */

  /** Lundi de la semaine 1 : configuré, sinon semaine en cours (règle de Pulse). */
  startISO() {
    if (isIsoDate(this.store.start)) return this.store.start;
    return isoDate(mondayOf(new Date()));
  }

  setStart(iso) {
    if (isIsoDate(iso)) {
      this.store.start = String(iso);
      this.save();
      return true;
    }
    return false;
  }

  /* ---------- séances ---------- */

  day(dateISO) {
    const p = this.plan();
    const iso = isIsoDate(dateISO) ? String(dateISO) : todayISO();
    if (!p.ok) return { ok: false, error: p.error, dateISO: iso };
    const base = dayPlanFor(p.days ? { days: p.days } : null, iso, this.startISO());
    if (!base) return { ok: false, error: 'date invalide', dateISO: iso };
    const rec = this.store.sessions[iso] || {};
    const ex = base.ex.map((e, i) => Object.assign({}, e, { done: !!(rec.ex && rec.ex[i]) }));
    return Object.assign({}, base, {
      ok: true,
      source: p.path,
      programWeeks: p.programWeeks,
      estMinutes: estMinutes(base),
      done: !!rec.done,
      note: rec.note || '',
      ex: ex,
      doneCount: ex.filter((e) => e.done).length,
    });
  }

  today() { return this.day(todayISO()); }

  /** Vue d'une semaine : 7 séances à partir du lundi de `offsetWeeks`. */
  week(offsetWeeks, refISO) {
    const p = this.plan();
    const start = parseISO(refISO || todayISO()) || new Date();
    /* Programme indisponible : on renvoie une semaine vide mais bien formée,
       pour que le bilan et le diagnostic restent lisibles sans planter. */
    if (!p.ok) {
      return {
        ok: false, error: p.error, days: [], start: isoDate(mondayOf(start)),
        week: 0, phase: phaseOf(0), goal: WEEK_GOAL, doneCount: 0,
      };
    }
    const lundi = addDays(mondayOf(start), 7 * (Number(offsetWeeks) || 0));
    const jours = [];
    for (let i = 0; i < 7; i++) {
      const iso = isoDate(addDays(lundi, i));
      const d = this.day(iso);
      jours.push({
        dateISO: iso,
        label: DAY_NAMES[i],
        dateLabel: frDateLong(parseISO(iso)),
        type: d.type || '',
        title: d.title || '',
        focus: d.focus || [],
        estMinutes: d.estMinutes || 0,
        exCount: (d.ex || []).length,
        done: !!d.done,
        isToday: iso === todayISO(),
        isPast: iso < todayISO(),
      });
    }
    const semaine = this.weekIndex(lundi);   // semaineIndex accepte Date ou ISO
    return {
      ok: true,
      start: isoDate(lundi),
      week: semaine,
      phase: phaseOf(Math.max(0, semaine)),
      days: jours,
      goal: WEEK_GOAL,
      doneCount: jours.filter((j) => j.done && j.type !== 'rest').length,
    };
  }

  /** Semaine du programme (0 = première) pour une date (ISO ou objet Date). */
  weekIndex(date) {
    const d = date instanceof Date ? date : parseISO(date);
    const debut = parseISO(this.startISO());
    if (!d || !debut) return 0;
    return Math.floor(daysBetween(mondayOf(debut), mondayOf(d)) / 7);
  }

  markDone(dateISO, val) {
    const iso = isIsoDate(dateISO) ? String(dateISO) : todayISO();
    const rec = this.store.sessions[iso] || {};
    if (val === false) {
      delete rec.done;
    } else {
      rec.done = 1;
      /* Valider une séance coche ce qui ne l'était pas encore : on ne
         laisse pas un exercice « fait » en dehors d'une séance validée. */
      const d = this.day(iso);
      if (d.ok && d.ex.length) {
        rec.ex = {};
        for (let i = 0; i < d.ex.length; i++) rec.ex[i] = 1;
      }
    }
    if (Object.keys(rec).length) this.store.sessions[iso] = rec;
    else delete this.store.sessions[iso];
    this.save();
    return this.day(iso);
  }

  setExercise(dateISO, index, val) {
    const iso = isIsoDate(dateISO) ? String(dateISO) : todayISO();
    const i = Number(index);
    if (!isFinite(i) || i < 0 || i > 39) return { ok: false, error: 'index d’exercice invalide' };
    const rec = this.store.sessions[iso] || {};
    rec.ex = rec.ex || {};
    if (val === false) delete rec.ex[String(i)];
    else rec.ex[String(i)] = 1;
    /* Une case décochée invalide la séance : l'état reste cohérent. */
    if (val === false) delete rec.done;
    this.store.sessions[iso] = rec;
    this.save();
    return this.day(iso);
  }

  /* ---------- statistiques ---------- */

  stats() {
    const fait = this.store.sessions;
    let seances = 0;
    let repos = 0;
    let minutes = 0;
    let exCoches = 0;
    for (const k of Object.keys(fait)) {
      const rec = fait[k] || {};
      if (rec.ex) exCoches += Object.keys(rec.ex).length;
      if (!rec.done) continue;
      const d = this.day(k);
      if (d.ok && d.type === 'rest') repos++;
      else seances++;
      minutes += d.estMinutes || 0;
    }
    const xp = seances * 25 + repos * 15 + exCoches * 5;
    const lvl = levelOf(xp);
    const semaine = this.week();
    /* Meilleure semaine jamais réalisée, bornée au programme. */
    const p = this.plan();
    const nbSemaines = (p.ok && p.programWeeks) || PROGRAM_WEEKS_FALLBACK;
    const debut = parseISO(this.startISO());
    let meilleure = 0;
    if (debut) {
      for (let w = 0; w < Math.min(nbSemaines, 60); w++) {
        let n = 0;
        for (let i = 0; i < 7; i++) {
          const iso = isoDate(addDays(addDays(mondayOf(debut), w * 7), i));
          const rec = fait[iso];
          if (rec && rec.done) {
            const d = this.day(iso);
            if (!d.ok || d.type !== 'rest') n++;
          }
        }
        if (n > meilleure) meilleure = n;
      }
    }
    /* Série en cours : jours validés d'affilée (les jours de repos non
       validés et le jour en cours ne cassent rien, comme dans Pulse). */
    let serie = 0;
    const aujourdhui = todayISO();
    const depart = parseISO(this.startISO());
    if (depart) {
      let d = parseISO(aujourdhui);
      for (let i = 0; i < 400; i++) {
        const iso = isoDate(d);
        if (iso < this.startISO()) break;
        const rec = fait[iso] || {};
        if (rec.done) serie++;
        else if (dowIndex(d) === 6) { /* repos non validé : neutre */ }
        else if (iso === aujourdhui) { /* aujourd'hui pas encore fait : neutre */ }
        else break;
        d = addDays(d, -1);
      }
    }
    return {
      sessions: seances,
      restDays: repos,
      minutes: minutes,
      exercisesDone: exCoches,
      streak: serie,
      bestWeek: meilleure,
      week: semaine.week,
      phase: semaine.phase,
      weekDone: semaine.doneCount,
      weekGoal: WEEK_GOAL,
      weekStart: semaine.start,
      programWeeks: nbSemaines,
      xp: xp,
      level: lvl.name,
      nextLevel: (LEVELS.find((l) => l.min > xp) || null),
      levelMin: lvl.min,
      start: this.startISO(),
      tracked: Object.keys(fait).length,
    };
  }

  /* ---------- import d'une sauvegarde Pulse ---------- */

  /**
   * La sauvegarde Pulse exportée ressemble à :
   *   { app:'pulse', version:…, state:{ sessions:{...}, meta:{...}, … } }
   * Les anciennes sauvegardes (v1) sont aplaties : { done:{...}, meta:{...} }.
   */
  importPulse(payload) {
    let obj = payload;
    if (typeof payload === 'string') {
      try {
        obj = JSON.parse(payload);
      } catch (_) {
        return { ok: false, error: 'fichier illisible : ce n’est pas du JSON' };
      }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, error: 'sauvegarde illisible' };
    }
    if (obj.app && obj.app !== 'pulse') {
      return { ok: false, error: 'ce fichier ne vient pas de Pulse (app = ' + cleanStr(obj.app, 30) + ')' };
    }
    const etat = obj.state && typeof obj.state === 'object' ? obj.state : obj;
    const sessions = etat.sessions && typeof etat.sessions === 'object' ? etat.sessions : etat.done;
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {
      return { ok: false, error: 'cette sauvegarde ne contient aucune séance' };
    }
    let ajoutees = 0;
    let maj = 0;
    for (const k of Object.keys(sessions).slice(0, MAX_SESSIONS)) {
      if (!isIsoDate(k)) continue;
      const r = sessions[k];
      if (!r || typeof r !== 'object') continue;
      const rec = this.store.sessions[k] || {};
      const avant = JSON.stringify(rec);
      if (r.done) rec.done = 1;
      if (r.ex && typeof r.ex === 'object' && !Array.isArray(r.ex)) {
        rec.ex = rec.ex || {};
        for (const ik of Object.keys(r.ex).slice(0, 40)) {
          const idx = Number(ik);
          if (!isFinite(idx) || idx < 0 || idx > 39) continue;
          if (r.ex[ik]) rec.ex[String(idx)] = 1;
        }
      }
      const note = cleanStr(r.note, 200);
      if (note) rec.note = note;
      if (JSON.stringify(rec) === avant) continue;
      this.store.sessions[k] = rec;
      if (avant === '{}') ajoutees++;
      else maj++;
    }
    /* Sans date de départ configurée, la plus ancienne séance donne la
       semaine 1 : les phases retombent alors sur celles de Pulse. */
    let depart = '';
    if (!isIsoDate(this.store.start)) {
      const cles = Object.keys(this.store.sessions).filter(isIsoDate).sort();
      if (cles.length) {
        depart = isoDate(mondayOf(parseISO(cles[0])));
        this.store.start = depart;
      }
    }
    this.save();
    return {
      ok: true,
      added: ajoutees,
      updated: maj,
      total: this.countSessions(),
      start: this.store.start || '',
      startInferred: !!depart,
    };
  }

  /* ---------- diagnostic ---------- */

  info() {
    const p = this.plan();
    const s = this.stats();
    return {
      ok: !!p.ok,
      planPath: p.path || this.store.planPath || '',
      planFound: !!p.ok,
      planError: p.ok ? '' : p.error,
      programWeeks: (p.ok && p.programWeeks) || 0,
      planDetected: p.ok ? 'fichier Pulse' : '',
      start: this.startISO(),
      sessionsTracked: this.countSessions(),
      sessionsDone: s.sessions,
      streak: s.streak,
      minutes: s.minutes,
      week: s.week,
      phase: s.phase.name,
      xp: s.xp,
      level: s.level,
      dataFile: this.file,
    };
  }

  /* ---------- remise à zéro ---------- */

  reset(keepConfig) {
    this.store.sessions = {};
    if (!keepConfig) {
      this.store.start = '';
      this.store.planPath = '';
    }
    this._cache = null;
    this.save();
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Formulations parlées (utilisées par les compétences de lecture)     */
/* ------------------------------------------------------------------ */

function dateFromWords(text, refISO) {
  const brut = String(text || '').toLowerCase();
  const t = brut.normalize ? brut.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : brut;
  const ref = parseISO(refISO) || parseISO(todayISO());
  const fixe = { aujourdhui: 0, ce: 0, 'ce soir': 0, 'ce matin': 0, demain: 1, 'apres-demain': 2, apresdemain: 2, hier: -1, 'avant-hier': -2 };
  /* Les expressions longues d'abord : sans ça, « après-demain » serait lu
     comme « demain » (le tiret crée une frontière de mot). */
  const mots = Object.keys(fixe).sort((a, b) => b.length - a.length);
  for (const mot of mots) {
    if (new RegExp('\\b' + mot.replace('-', '[- ]?') + '\\b').test(t)) return isoDate(addDays(ref, fixe[mot]));
  }
  const jours = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
  for (let i = 0; i < jours.length; i++) {
    if (new RegExp('\\b' + jours[i] + '\\b').test(t)) {
      const decalage = (i - dowIndex(ref) + 7) % 7;
      /* Le jour déjà passé de la semaine renvoie à la semaine suivante. */
      return isoDate(addDays(ref, decalage));
    }
  }
  return isoDate(ref);
}

/** Programme complet sur une ligne par jour — base du contexte système. */
function weekLines(training, offsetWeeks) {
  const w = training.week(offsetWeeks);
  if (!w.ok) return [];
  return w.days.map((d) => {
    const etat = d.done ? 'validée' : (d.isPast ? 'non validée' : (d.isToday ? 'aujourd’hui, à faire' : 'à venir'));
    const detail = d.type === 'rest' ? 'repos' : (d.exCount + ' exercices, ~' + d.estMinutes + ' min');
    return d.label + ' : ' + d.title + ' (' + detail + ') — ' + etat;
  });
}

module.exports = {
  Training,
  DAY_NAMES,
  WEEK_GOAL,
  LEVELS,
  phaseOf,
  levelOf,
  isoDate,
  parseISO,
  isIsoDate,
  todayISO,
  addDays,
  mondayOf,
  dowIndex,
  daysBetween,
  frDateLong,
  findLiteral,
  evalLiteral,
  normalizePlan,
  normalizeExercise,
  readPlanFile,
  detectPlanPath,
  looksLikePulse,
  programWeeksFromHtml,
  dayPlanFor,
  estMinutes,
  describeExercise,
  dateFromWords,
  weekLines,
};
