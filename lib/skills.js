/* ============================================================
   Nova — compétences de lecture (données réelles, sans risque)

   Ces compétences ne modifient rien sur le Mac : elles lisent
   l'heure, la météo, la batterie, le disque, le réseau, la durée
   d'allumage et le presse-papiers. Le serveur les exécute AVANT
   d'appeler le modèle : la réponse part alors d'une donnée vraie
   au lieu d'être inventée.

   Module volontairement isolé (aucune dépendance au serveur HTTP)
   pour être testable et réutilisable : voir test/skills.test.js.
   ============================================================ */

'use strict';

const os = require('os');
const https = require('https');
const { execFile } = require('child_process');
const entrainement = require('./training.js');
/* Contrôle Windows : utilisé par les compétences de lecture sur win32
   (batterie, disque, presse-papiers). Chargé partout pour rester testable. */
const winctl = require('./winctl.js');

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

function trunc(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/* Exécution d'un binaire en promesse — jamais via un shell, arguments validés */
function execFileP(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs || 8000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
        if (err) return resolve({ ok: false, error: err.message });
        resolve({ ok: true, output: String(stdout || '').trim() });
      });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

/* GET texte simple avec suivi d'une redirection (utilisé pour la météo) */
function httpGetText(host, urlPath, timeoutMs) {
  return new Promise((resolve) => {
    let req;
    try {
      req = https.get(
        { host, path: urlPath, headers: { 'User-Agent': 'Nova-local/1.0', 'Accept-Language': 'fr' }, timeout: timeoutMs || 8000 },
        (r) => {
          if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
            r.resume();
            try {
              const u = new URL(r.headers.location);
              return httpGetText(u.host, u.pathname + u.search, timeoutMs).then(resolve);
            } catch (_) {
              return resolve('');
            }
          }
          if (r.statusCode !== 200) { r.resume(); return resolve(''); }
          let d = '';
          r.setEncoding('utf8');
          r.on('data', (c) => { d += c; if (d.length > 6000) { try { req.destroy(); } catch (_) {} } });
          r.on('end', () => resolve(d));
        }
      );
    } catch (_) {
      return resolve('');
    }
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(''); });
    req.on('error', () => resolve(''));
  });
}

const SKILL_CACHE = new Map();
function cacheGet(k, ms) {
  const e = SKILL_CACHE.get(k);
  return e && Date.now() - e.t < ms ? e.value : null;
}
function cacheSet(k, value) {
  SKILL_CACHE.set(k, { t: Date.now(), value });
}

function frDate(d) {
  try { return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
  catch (_) { return d.toISOString().slice(0, 10); }
}
function frTime(d) {
  try { return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
  catch (_) { return d.toISOString().slice(11, 16); }
}

/* ------------------------------------------------------------------ */
/* Les compétences — chacune renvoie { ok, output } ou { ok, error }    */
/* ------------------------------------------------------------------ */

const SKILLS = {

  /* ---------------------- sport (programme Pulse) ---------------------- */

  /* Ces quatre compétences lisent le programme dans le fichier Pulse de
     l'utilisateur via lib/training.js. Aucune ne modifie quoi que ce soit :
     valider une séance reste une action confirmée, traitée par le serveur. */

  workout(arg, ctx) {
    const tr = ctx && ctx.training;
    if (!tr) return { ok: false, error: 'programme sport indisponible' };
    const iso = entrainement.dateFromWords(arg, entrainement.todayISO());
    const d = tr.day(iso);
    if (!d.ok) return { ok: false, error: d.error };
    const jour = entrainement.frDateLong(entrainement.parseISO(iso));
    if (d.type === 'rest' || !d.ex.length) {
      return {
        ok: true,
        output: jour + ' : jour de repos complet — priorité sommeil, rien à valider.',
        data: { kind: 'rest', dateISO: iso, dateLabel: jour, title: d.title },
      };
    }
    const tete = jour + ' : « ' + d.title + ' », phase ' + d.phase.name + ' (semaine ' +
      (d.week + 1) + ' sur ' + d.programWeeks + '), environ ' + d.estMinutes + ' minutes' +
      (d.focus.length ? ', ciblant ' + d.focus.join(', ') : '') + '.';
    const liste = d.ex.map((e, i) => (i + 1) + ') ' + entrainement.describeExercise(e)).join(' ; ');
    return {
      ok: true,
      output: tete + ' Exercices : ' + liste + '. ' + (d.done ? 'Séance déjà validée.' : 'Pas encore validée.'),
      data: {
        kind: 'workout', dateISO: iso, dateLabel: jour, title: d.title, type: d.type,
        phase: d.phase.name, week: d.week + 1, weeks: d.programWeeks, focus: d.focus,
        estMinutes: d.estMinutes, done: d.done, exDone: d.doneCount,
        ex: d.ex.map((e) => ({
          n: e.n, s: e.s, reps: e.reps || 0, secs: e.secs || 0, rest: e.rest, m: e.m || '', note: e.note || '', done: !!e.done,
        })),
      },
    };
  },

  workout_week(arg, ctx) {
    const tr = ctx && ctx.training;
    if (!tr) return { ok: false, error: 'programme sport indisponible' };
    const t = normalizeFr(arg);
    const offset = /\b(prochaine|suivante)\b/.test(t) ? 1 : (/\b(derniere|precedente|passee)\b/.test(t) ? -1 : 0);
    const w = tr.week(offset);
    if (!w.ok) return { ok: false, error: w.error };
    const p = tr.plan();
    const lignes = entrainement.weekLines(tr, offset);
    return {
      ok: true,
      output: 'Semaine ' + (w.week + 1) + (p.ok ? ' sur ' + p.programWeeks : '') + ', phase ' + w.phase.name +
        ' — ' + w.doneCount + ' séance' + (w.doneCount > 1 ? 's' : '') + ' validée' + (w.doneCount > 1 ? 's' : '') +
        ' sur un objectif de ' + w.goal + '. ' + lignes.join(' ; ') + '.',
      data: { kind: 'week', week: w.week + 1, phase: w.phase.name, goal: w.goal, done: w.doneCount, days: w.days },
    };
  },

  training_stats(arg, ctx) {
    const tr = ctx && ctx.training;
    if (!tr) return { ok: false, error: 'programme sport indisponible' };
    const s = tr.stats();
    const niveau = s.nextLevel
      ? ' Niveau ' + s.level + ', encore ' + (s.nextLevel.min - s.xp) + ' points avant « ' + s.nextLevel.name + ' ».'
      : ' Niveau ' + s.level + '.';
    return {
      ok: true,
      output: 'Bilan sport : ' + s.sessions + ' séance' + (s.sessions > 1 ? 's' : '') + ' validée' + (s.sessions > 1 ? 's' : '') +
        (s.restDays ? ' et ' + s.restDays + ' jour' + (s.restDays > 1 ? 's' : '') + ' de repos' : '') +
        ', ' + s.minutes + ' minutes cumulées, série en cours de ' + s.streak + ' jour' + (s.streak > 1 ? 's' : '') +
        '. Semaine ' + (s.week + 1) + ' sur ' + s.programWeeks + ' : ' + s.weekDone + ' séance' + (s.weekDone > 1 ? 's' : '') +
        ' sur ' + s.weekGoal + (s.bestWeek ? ' (meilleure semaine : ' + s.bestWeek + ')' : '') + '.' + niveau,
      data: { kind: 'stats', stats: s },
    };
  },

  workout_exercise(arg, ctx) {
    const tr = ctx && ctx.training;
    if (!tr) return { ok: false, error: 'programme sport indisponible' };
    const p = tr.plan();
    if (!p.ok) return { ok: false, error: p.error };
    const trouve = findPlanExercises(p.days, arg);
    if (!trouve.length) return { ok: false, error: 'exercice inconnu dans le programme' };
    const choisis = trouve.slice(0, 3);
    return {
      ok: true,
      output: choisis.map((e) => e.n + ' : « ' + e.cue + ' » — ' + entrainement.describeExercise(e)).join(' '),
      data: { kind: 'exercise', found: choisis.map((e) => ({ n: e.n, cue: e.cue, m: e.m })) },
    };
  },

  now() {
    const d = new Date();
    return { ok: true, output: 'nous sommes le ' + frDate(d) + ', il est ' + frTime(d) };
  },
  date() {
    return { ok: true, output: 'nous sommes le ' + frDate(new Date()) };
  },
  async battery() {
    if (process.platform === 'win32') {
      const r = await winctl.battery();
      return r.ok ? r : { ok: false, error: r.error || 'batterie inaccessible' };
    }
    if (process.platform !== 'darwin') return { ok: false, error: 'batterie disponible seulement sur macOS et Windows' };
    const r = await execFileP('pmset', ['-g', 'batt']);
    if (!r.ok) return { ok: false, error: 'batterie inaccessible' };
    const m = r.output.match(/(\d+)%/);
    const ac = /AC Power/i.test(r.output);
    return { ok: true, output: m ? m[1] + '%, ' + (ac ? 'sur secteur' : 'sur batterie') : trunc(r.output, 120) };
  },
  async disk() {
    if (process.platform === 'win32') {
      const r = await winctl.disk();
      return r.ok ? r : { ok: false, error: r.error || 'disque illisible' };
    }
    const r = await execFileP('df', ['-h', '/']);
    if (!r.ok) return { ok: false, error: 'disque illisible' };
    const ligne = (r.output.split('\n')[1] || '').split(/\s+/);
    if (ligne.length < 5) return { ok: false, error: 'disque illisible' };
    return {
      ok: true,
      output: 'disque principal : ' + ligne[1] + ' au total, ' + ligne[2] + ' utilisés, ' + ligne[3] + ' libres (' + ligne[4] + ' occupés)',
    };
  },
  ip() {
    const cands = [];
    const ifaces = os.networkInterfaces();
    for (const nom of Object.keys(ifaces)) {
      for (const i of ifaces[nom] || []) {
        if (!i.internal && (i.family === 'IPv4' || i.family === 4)) cands.push({ nom, address: i.address });
      }
    }
    if (!cands.length) return { ok: false, error: 'aucune adresse réseau active' };
    const choix = cands.find((c) => /^(en|wl)/i.test(c.nom)) || cands[0];
    return { ok: true, output: 'adresse IP locale ' + choix.address + ' (interface ' + choix.nom + ')' };
  },
  uptime() {
    const s = Math.floor(os.uptime());
    const j = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const bits = [];
    if (j) bits.push(j + ' jour' + (j > 1 ? 's' : ''));
    if (h) bits.push(h + ' heure' + (h > 1 ? 's' : ''));
    if (!j && m) bits.push(m + ' minute' + (m > 1 ? 's' : ''));
    const machine = process.platform === 'win32' ? 'le PC' : 'le Mac';
    return { ok: true, output: machine + ' est allumé depuis ' + (bits.join(' et ') || 'moins d\u2019une minute') };
  },
  async clipboard() {
    if (process.platform === 'win32') {
      const r = await winctl.clipboardGet();
      if (!r.ok) return { ok: false, error: 'presse-papiers illisible' };
      const txt = String(r.output || '').trim();
      if (!txt) return { ok: true, output: 'le presse-papiers est vide' };
      return { ok: true, output: 'presse-papiers (' + txt.length + ' caractères) : « ' + trunc(txt, 300) + ' »' };
    }
    if (process.platform !== 'darwin') return { ok: false, error: 'presse-papiers disponible seulement sur macOS et Windows' };
    const r = await execFileP('pbpaste', []);
    if (!r.ok) return { ok: false, error: 'presse-papiers illisible' };
    const txt = r.output.replace(/\s+/g, ' ').trim();
    if (!txt) return { ok: true, output: 'le presse-papiers est vide' };
    return { ok: true, output: 'presse-papiers (' + txt.length + ' caractères) : « ' + trunc(txt, 300) + ' »' };
  },
  async weather(arg, ctx) {
    /* Ville : celle demandée, sinon celle du profil, sinon Namur. */
    const profil = (ctx && ctx.profile) || null;
    const brut = String(arg || (profil && profil.city) || 'Namur');
    const ville = brut.replace(/[^\p{L}\p{N}\s'’-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Namur';
    const ck = 'weather:' + ville.toLowerCase();
    const hit = cacheGet(ck, 10 * 60 * 1000);
    if (hit) return { ok: true, output: hit, cached: true };
    const q = '/' + encodeURIComponent(ville) + '?format=' + encodeURIComponent('%l : %c %t (ressenti %f), vent %w, humidité %h');
    const body = await httpGetText('wttr.in', q, 9000);
    if (!body) return { ok: false, error: 'météo indisponible (pas de connexion ?)' };
    const out = body.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!out) return { ok: false, error: 'météo indisponible' };
    cacheSet(ck, out);
    return { ok: true, output: out };
  },
};

const READONLY_SKILLS = Object.keys(SKILLS);

/* ------------------------------------------------------------------ */
/* Détection d'intention                                               */
/* ------------------------------------------------------------------ */

/* Minuscules, sans accents, et élisions recollées :
   « qu'est-ce que j'ai copié ? » → « quest-ce que jai copie ? ».
   La parole transcrite par Whisper omet souvent les apostrophes, d'où ce
   nettoyage : « qu est-ce que j ai copié » donne le même résultat. */
function normalizeFr(s) {
  let t = String(s || '').toLowerCase();
  try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) {}
  return t.replace(/\b(qu|j|l|d|n|s|t|c|m|jusqu|presqu)['\u2019\s](?=[a-z])/g, '$1');
}

/* Ville glissée dans la demande : « … à Namur », « … pour Bruxelles » */
function skillCityFromText(text) {
  const propre = normalizeFr(text).replace(/[?!.,;:…]+\s*$/, '').trim();
  const m = propre.match(/(?:\b(?:a|pour|sur|vers|de|du|en))\s+([a-z][a-z'\u2019 -]{2,28})$/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

/* Détection d'une intention d'information (français, accents ignorés).
   Volontairement conservatrice : mieux vaut ne pas détecter que se tromper. */
const SKILL_INTENTS = [
  /* Sport d'abord : « c'est quoi la séance » n'est jamais une question de date. */
  { skill: 'workout_week', re: /((programme|planning|plan|seances?|entrainements?)[a-z ]*(de la semaine|cette semaine|hebdomadaire|de ma semaine)|(semaine|planning)[a-z ]*(de sport|sportive|dentrainement)|(mes|les) seances de la semaine|ma semaine de sport)/ },
  { skill: 'workout_exercise', force: true, re: /((comment (on|je) (fait|fais|realise|execute)|comment bien (faire|executer|realiser)|technique (du|de la|des|dun|dune)|cest quoi la technique|comment on sexecute|comment bien faire)[a-z ]*(pompe|squat|fente|burpee|planche|gainage|dip|rowing|traction|mountain|jumping|crunch|bicyclette|superman|mollet|pont|chaise|hollow|oiseau|curl|tirage|marche|etirement|mobilite|fessier|abdo|bras|dos|epaules|triceps))/, arg: (t) => t },
  { skill: 'training_stats', re: /(ou j ?en suis|ou en suis[- ]je|ma progression|mon avancement|mon niveau (sportif|de sport)|mes (stats|statistiques)( de sport| sportives)?|combien de seances|jai fait combien de seances|ma serie de seances|mon streak|mon xp)/ },
  { skill: 'workout', re: /((quel|quelle|cest quoi|il y a)[a-z ]*(entrainement|seance|programme|training)[a-z ]*(du jour|daujourdhui|de demain|de ce soir|dhier|de lundi|de mardi|de mercredi|de jeudi|de vendredi|de samedi|de dimanche|prevu)?|(entrainement|seance)[a-z ]*(du jour|daujourdhui|de demain|de ce soir|dhier)|ma seance|mon entrainement|mon programme de sport|(sport|entrainement)[a-z ]*(aujourdhui|ce soir|du jour|de demain)|(je fais quoi|on fait quoi|je fais comme|quest[- ]?ce que je fais|quest[- ]?ce quil y a)[a-z ]*(au sport|a la salle|comme (seance|entrainement|sport)|comme sport|de prevu))/ },
  { skill: 'weather', re: /(meteo|quel temps|il fait (quel )?temps|temperature (dehors|exterieure)|va[- ]t[- ]il pleuvoir|est[- ]ce quil pleut)/, arg: skillCityFromText },
  { skill: 'clipboard', re: /(presse[- ]?papiers?|quest[- ]?ce que jai copi|ce que jai copi|jai copie quoi)/ },
  { skill: 'battery', re: /(batterie|autonomie|niveau de charge|combien de charge)/ },
  { skill: 'disk', re: /(espace disque|place (libre|restante)|stockage (libre|restant)|disque dur)/ },
  { skill: 'ip', re: /(mon adresse ip|adresse ip locale|\bmon ip\b)/ },
  { skill: 'uptime', re: /(depuis combien de temps (le mac|tu es|il est)|allume depuis|depuis quand (je|tu) (travail|utilis))/ },
  { skill: 'date', re: /(quel jour (sommes[- ]?nous|on est|est[- ]?on)|quelle date|on est quel jour|la date daujourdhui)/ },
  { skill: 'now', re: /(quelle heure|il est quelle heure|lheure (exacte|est[- ]?il)|tu as lheure)/ },
];

/* On ne détourne jamais une demande d'explication, de récit ou d'action :
   ces phrases doivent aller au modèle, pas aux compétences. */
const SKILL_SKIP_RE = /(ouvre|lance|demarre|affiche|montre[- ]moi le site|previens|envoie|mets[- ]moi|ferme|explique|raconte|decris|decris[- ]moi|comment (fonctionne|marche|ca marche)|pourquoi|apprends|prepare|propose|aide[- ]moi|resume)/;

function detectSkill(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 160) return null;
  const n = normalizeFr(t);
  /* Une demande d'explication part au modèle… sauf pour les intentions
     marquées « force » (la technique d'un exercice) : là, la donnée réelle
     — la consigne écrite dans le programme — est exactement ce qu'on veut. */
  const explication = SKILL_SKIP_RE.test(n);
  for (const it of SKILL_INTENTS) {
    if (!it.re.test(n)) continue;
    if (explication && !it.force) return null;
    return { skill: it.skill, arg: it.arg ? it.arg(t) : '' };
  }
  return null;
}

/* Retrouve un ou plusieurs exercices du programme à partir d'une phrase :
   « comment on fait les pompes » donne les variantes de pompes du plan. */
function findPlanExercises(days, text) {
  const t = normalizeFr(text);
  const copie = (e) => ({
    n: e.n, cue: e.cue || '', m: e.m || '', s: e.s,
    reps: e.reps, secs: e.secs, rest: e.rest, note: e.note,
  });
  const exacts = [];
  for (const d of days || []) {
    for (const e of d.ex || []) {
      const nom = normalizeFr(e.n);
      if (nom && t.indexOf(nom) !== -1) exacts.push(copie(e));
    }
  }
  if (exacts.length) return exacts;
  /* À défaut, un mot significatif du nom suffit (« burpees », « gainage »). */
  const trouves = [];
  for (const d of days || []) {
    for (const e of d.ex || []) {
      const mots = normalizeFr(e.n).split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
      if (mots.some((w) => new RegExp('\\b' + w + 's?\\b').test(t))) trouves.push(copie(e));
    }
  }
  return trouves;
}

async function runSkill(name, arg, ctx) {
  const fn = SKILLS[String(name || '').toLowerCase()];
  if (!fn) return { ok: false, error: 'compétence inconnue' };
  try {
    const r = await fn(arg, ctx);
    return Object.assign({ skill: String(name).toLowerCase(), arg: arg || '' }, r);
  } catch (e) {
    return { ok: false, skill: String(name), error: e.message };
  }
}

module.exports = {
  SKILLS,
  READONLY_SKILLS,
  SKILL_INTENTS,
  detectSkill,
  runSkill,
  execFileP,
  httpGetText,
  normalizeFr,
  skillCityFromText,
  frDate,
  frTime,
  trunc,
  findPlanExercises,
};
