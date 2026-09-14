/* ============================================================
   Nova — tests du programme sport (Pulse)

   1. Moteur : lecture du plan dans le fichier Pulse, phases,
      séances, progression, import d'une sauvegarde Pulse.
   2. Serveur : routes /api/training (lecture, validation de
      séance, configuration, import, remise à zéro).
   3. Sécurité : rien de ce qui vient du réseau ne doit casser
      le serveur ni lire un fichier arbitraire.
   ============================================================ */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { startServer, tempDataDir } = require('./helpers.js');
const T = require('../lib/training.js');
const skills = require('../lib/skills.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'pulse.html');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nova-sport-')); }

function newTraining(extra) {
  const tr = new T.Training(Object.assign({ dataDir: tempDir(), envPath: FIXTURE }, extra || {}));
  tr.load();
  return tr;
}

/* ------------------------------------------------------------------ */
/* 1. Lecture du plan                                                  */
/* ------------------------------------------------------------------ */

test('le plan est lu dans le fichier Pulse', () => {
  const r = T.readPlanFile(FIXTURE);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.days.length, 7);
  assert.equal(r.programWeeks, 16);
  assert.equal(r.days[0].type, 'push');
  assert.equal(r.days[6].type, 'rest');
  assert.equal(r.days[0].ex[0].n, 'Pompes');
  assert.equal(r.days[0].ex[0].s, 4);
});

test('un fichier qui n’est pas un programme est refusé proprement', () => {
  const f = path.join(tempDir(), 'page.html');
  fs.writeFileSync(f, '<html><body><script>const autre = 1;</script></body></html>');
  const r = T.readPlanFile(f);
  assert.equal(r.ok, false);
  assert.match(r.error, /aucun programme/);
});

test('un fichier absent est refusé sans exception', () => {
  const r = T.readPlanFile(path.join(tempDir(), 'absent.html'));
  assert.equal(r.ok, false);
  assert.match(r.error, /illisible/);
});

test('un littéral PLAN incomplet ne fait pas planter la lecture', () => {
  const f = path.join(tempDir(), 'tronque.html');
  fs.writeFileSync(f, '<html><script>const PLAN = [{ type:"push"');
  const r = T.readPlanFile(f);
  assert.equal(r.ok, false);
  assert.match(r.error, /illisible/);
});

test('le littéral n’est pas exécuté dans le contexte du serveur', () => {
  /* Ni require, ni process : le bac à sable est vide et le délai borné. */
  const f = path.join(tempDir(), 'piege.html');
  fs.writeFileSync(f, '<html><script>const PLAN = require("fs").readdirSync("/");</script></html>');
  const r = T.readPlanFile(f);
  assert.equal(r.ok, false, 'un code exécutable ne doit jamais passer');
});

test('findLiteral tient compte des chaînes et des commentaires', () => {
  const html = '<script>const PLAN = ["a]b", /* ] */ "c"]; const x = 1;</script>';
  const lit = T.findLiteral(html, 'PLAN');
  assert.equal(lit, '["a]b", /* ] */ "c"]');
  assert.deepEqual(T.evalLiteral(lit), ['a]b', 'c']);
});

test('normalizePlan refuse une structure invalide', () => {
  assert.equal(T.normalizePlan([{ type: 'push' }]).ok, false);
  const six = new Array(6).fill({ type: 'push', title: 'x', ex: [] });
  assert.equal(T.normalizePlan(six).ok, false);
  const mauvais = new Array(7).fill({ type: 'push', title: 'x', ex: [] });
  mauvais[3] = { type: 'PAS VALIDE !', title: 'x', ex: [] };
  assert.equal(T.normalizePlan(mauvais).ok, false);
});

test('normalizeExercise borne les valeurs', () => {
  const ex = T.normalizeExercise({ n: '  Pompes   lentes ', s: 999, reps: -4, rest: 100000, m: 'Pectoraux' });
  assert.equal(ex.n, 'Pompes lentes');
  assert.equal(ex.s, 20);          // borné à 20
  assert.equal(ex.rest, 900);      // borné à 900
  assert.equal(ex.reps, undefined); // -4 est écarté
  assert.equal(T.normalizeExercise({ cue: 'sans nom' }), null);
});

/* ------------------------------------------------------------------ */
/* 2. Phases et séances — identiques à celles de Pulse                 */
/* ------------------------------------------------------------------ */

test('les phases suivent le cycle de 7 semaines', () => {
  assert.equal(T.phaseOf(0).key, 'fondation');
  assert.equal(T.phaseOf(1).key, 'fondation');
  assert.equal(T.phaseOf(2).key, 'dev');
  assert.equal(T.phaseOf(3).key, 'dev');
  assert.equal(T.phaseOf(4).key, 'intensite');
  assert.equal(T.phaseOf(5).key, 'intensite');
  assert.equal(T.phaseOf(6).key, 'deload');
  assert.equal(T.phaseOf(7).key, 'fondation');
  assert.equal(T.phaseOf(-1).key, 'deload'); // robuste aux indices négatifs
});

test('chaque séance reproduit exactement les calculs de Pulse', () => {
  const plan = { days: T.readPlanFile(FIXTURE).days };
  /* Réimplémentation littérale des formules du fichier Pulse. */
  const pulse = (iso, debut) => {
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    const d = T.parseISO(iso);
    const lundi = (x) => {
      const y = new Date(x.getTime());
      y.setHours(0, 0, 0, 0);
      y.setDate(y.getDate() - ((y.getDay() + 6) % 7));
      return y;
    };
    const semaine = Math.round((lundi(d) - lundi(T.parseISO(debut))) / (7 * 86400000));
    const c = Math.max(0, semaine) % 7;
    const ph = c <= 1 ? { mult: 1, restMult: 1, setBonus: 0 }
      : c <= 3 ? { mult: 1.15, restMult: 1, setBonus: 2 }
        : c <= 5 ? { mult: 1.3, restMult: 0.85, setBonus: 2 }
          : { mult: 0.75, restMult: 1.15, setBonus: 0 };
    const tpl = plan.days[(d.getDay() + 6) % 7];
    return tpl.ex.map((e, i) => ({
      n: e.n,
      s: Math.min(6, e.s + (i < ph.setBonus ? 1 : 0)),
      reps: e.reps ? Math.round(e.reps * ph.mult) : undefined,
      secs: e.secs ? Math.round((e.secs * ph.mult) / 5) * 5 : undefined,
      rest: Math.round((e.rest * ph.restMult) / 5) * 5,
    }));
  };
  const debut = '2026-09-14';
  let compares = 0;
  for (let w = 0; w < 10; w++) {
    for (let i = 0; i < 7; i++) {
      const iso = T.isoDate(T.addDays(T.parseISO(debut), w * 7 + i));
      const moi = T.dayPlanFor(plan, iso, debut);
      const eux = pulse(iso, debut);
      assert.equal(moi.week, w, 'semaine du ' + iso);
      assert.equal(moi.ex.length, eux.length);
      moi.ex.forEach((e, j) => {
        assert.equal(e.n, eux[j].n);
        assert.equal(e.s, eux[j].s, e.n + ' séries le ' + iso);
        assert.equal(e.reps, eux[j].reps, e.n + ' répétitions le ' + iso);
        assert.equal(e.secs, eux[j].secs, e.n + ' secondes le ' + iso);
        assert.equal(e.rest, eux[j].rest, e.n + ' repos le ' + iso);
      });
      compares++;
    }
  }
  assert.equal(compares, 70);
});

test('le dimanche est un jour de repos, sans exercice', () => {
  const plan = { days: T.readPlanFile(FIXTURE).days };
  const dimanche = '2026-09-20'; // dimanche
  const p = T.dayPlanFor(plan, dimanche, '2026-09-14');
  assert.equal(p.type, 'rest');
  assert.equal(p.ex.length, 0);
  assert.equal(T.estMinutes(p), 0);
});

test('la durée estimée suit la formule du programme', () => {
  const plan = { days: T.readPlanFile(FIXTURE).days };
  const p = T.dayPlanFor(plan, '2026-09-14', '2026-09-14');
  // Pompes : 4 × (10 × 2,5 + 75 + 15) = 460 s ; Planche : 3 × (45 + 45 + 15) = 315 s
  assert.equal(T.estMinutes(p), Math.round((460 + 315) / 60));
});

test('les dates en mots sont comprises', () => {
  const ref = '2026-09-16'; // mercredi
  assert.equal(T.dateFromWords('aujourd’hui', ref), ref);
  assert.equal(T.dateFromWords('demain', ref), '2026-09-17');
  assert.equal(T.dateFromWords('hier', ref), '2026-09-15');
  assert.equal(T.dateFromWords('après-demain', ref), '2026-09-18');
  assert.equal(T.dateFromWords('lundi', ref), '2026-09-21');
  assert.equal(T.dateFromWords('séance de demain', ref), '2026-09-17');
  assert.equal(T.dateFromWords('la météo à Namur', ref), ref);
});

test('les niveaux suivent les paliers du programme', () => {
  assert.equal(T.levelOf(0).name, 'Débutant');
  assert.equal(T.levelOf(120).name, 'Régulier');
  assert.equal(T.levelOf(649).name, 'Discipliné');
  assert.equal(T.levelOf(650).name, 'Athlète');
  assert.equal(T.levelOf(99999).name, 'Légende');
});

/* ------------------------------------------------------------------ */
/* 3. Progression enregistrée par Nova                                 */
/* ------------------------------------------------------------------ */

test('valider une séance coche ses exercices et alimente les stats', () => {
  const tr = newTraining();
  const jour = tr.day('2026-09-14'); // lundi : 2 exercices dans la fixture
  assert.equal(jour.ok, true);
  assert.equal(jour.done, false);
  const apres = tr.markDone('2026-09-14', true);
  assert.equal(apres.done, true);
  assert.equal(apres.doneCount, apres.ex.length);
  const s = tr.stats();
  assert.equal(s.sessions, 1);
  assert.equal(s.streak, 1);
  assert.equal(s.weekDone, 1);
  assert.ok(s.xp >= 25);
});

test('décocher un exercice invalide la séance', () => {
  const tr = newTraining();
  tr.markDone('2026-09-14', true);
  const r = tr.setExercise('2026-09-14', 0, false);
  assert.equal(r.done, false);
  assert.equal(r.ex[0].done, false);
  assert.equal(tr.stats().sessions, 0);
});

test('un index d’exercice hors bornes est refusé', () => {
  const tr = newTraining();
  assert.equal(tr.setExercise('2026-09-14', 99, true).ok, false);
  assert.equal(tr.setExercise('2026-09-14', -1, true).ok, false);
  assert.equal(tr.setExercise('2026-09-14', 'abc', true).ok, false);
});

test('les jours de repos validés sont comptés à part', () => {
  const tr = newTraining();
  tr.markDone('2026-09-20', true); // dimanche
  const s = tr.stats();
  assert.equal(s.sessions, 0);
  assert.equal(s.restDays, 1);
  assert.equal(s.minutes, 0);
});

test('la progression survit au redémarrage', () => {
  const dossier = tempDir();
  const a = new T.Training({ dataDir: dossier, envPath: FIXTURE }).load();
  a.setStart('2026-09-14');
  a.markDone('2026-09-15', true);
  const b = new T.Training({ dataDir: dossier, envPath: FIXTURE }).load();
  assert.equal(b.startISO(), '2026-09-14');
  assert.equal(b.countSessions(), 1);
  assert.equal(b.day('2026-09-15').done, true);
});

test('un fichier de progression corrompu ne bloque pas le démarrage', () => {
  const dossier = tempDir();
  fs.writeFileSync(path.join(dossier, 'training.json'), '{ ceci n est pas du json');
  const tr = new T.Training({ dataDir: dossier, envPath: FIXTURE }).load();
  assert.equal(tr.countSessions(), 0);
  assert.equal(tr.today().ok, true, 'le programme reste utilisable');
});

test('les entrées invalides du fichier de progression sont écartées', () => {
  const dossier = tempDir();
  fs.writeFileSync(path.join(dossier, 'training.json'), JSON.stringify({
    version: 1,
    start: 'pas-une-date',
    sessions: { '2026-09-14': { done: 1, ex: { 0: 1, 99: 1, x: 1 } }, 'hier': { done: 1 }, '2026-09-15': 'nope' },
  }));
  const tr = new T.Training({ dataDir: dossier, envPath: FIXTURE }).load();
  assert.equal(tr.store.start, '', 'la date invalide est ignorée');
  assert.equal(tr.countSessions(), 1);
  assert.deepEqual(Object.keys(tr.store.sessions['2026-09-14'].ex), ['0']);
});

test('sans date configurée, le programme commence le lundi de la semaine', () => {
  const tr = newTraining();
  const debut = T.parseISO(tr.startISO());
  assert.equal((debut.getDay() + 6) % 7, 0, 'le début tombe un lundi');
});

/* ------------------------------------------------------------------ */
/* 4. Import d'une sauvegarde Pulse                                    */
/* ------------------------------------------------------------------ */

test('une sauvegarde Pulse est importée', () => {
  const tr = newTraining();
  const r = tr.importPulse({
    app: 'pulse',
    state: { sessions: { '2026-09-14': { done: 1, ex: { 0: 1 } }, '2026-09-15': { done: 1 } } },
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.added, 2);
  assert.equal(tr.day('2026-09-14').done, true);
  assert.equal(tr.day('2026-09-14').ex[0].done, true);
});

test('une sauvegarde à plat (v1, clé « done ») est acceptée', () => {
  const tr = newTraining();
  const r = tr.importPulse({ done: { '2026-09-14': { done: 1 } } });
  assert.equal(r.ok, true, r.error);
  assert.equal(tr.day('2026-09-14').done, true);
});

test('un fichier qui ne vient pas de Pulse est refusé', () => {
  const tr = newTraining();
  assert.equal(tr.importPulse({ app: 'autre', state: { sessions: {} } }).ok, false);
  assert.match(tr.importPulse({ app: 'autre' }).error, /ne vient pas de Pulse/);
  assert.equal(tr.importPulse('pas du json').ok, false);
  assert.equal(tr.importPulse(null).ok, false);
  assert.equal(tr.importPulse([]).ok, false);
  assert.equal(tr.importPulse({ app: 'pulse', state: {} }).ok, false);
  assert.equal(tr.countSessions(), 0, 'aucun import raté ne doit écrire');
});

test('l’import déduit la semaine 1 de la plus ancienne séance', () => {
  const tr = newTraining();
  const r = tr.importPulse({ app: 'pulse', state: { sessions: { '2026-09-16': { done: 1 } } } });
  assert.equal(r.startInferred, true);
  assert.equal(r.start, '2026-09-14', 'le lundi de cette semaine');
});

test('l’import ne remplace pas une date de début déjà choisie', () => {
  const tr = newTraining();
  tr.setStart('2026-08-03');
  const r = tr.importPulse({ app: 'pulse', state: { sessions: { '2026-09-16': { done: 1 } } } });
  assert.equal(r.startInferred, false);
  assert.equal(tr.startISO(), '2026-08-03');
});

/* ------------------------------------------------------------------ */
/* 5. Compétences et détection d'intention                             */
/* ------------------------------------------------------------------ */

test('les compétences sport répondent avec la donnée réelle', async () => {
  const tr = newTraining();
  const ctx = { training: tr };
  const jour = await skills.runSkill('workout', 'aujourd’hui', ctx);
  assert.equal(jour.ok, true, jour.error);
  assert.match(jour.output, /séance|repos/);
  assert.equal(jour.data.kind, jour.data.kind);
  assert.ok(['workout', 'rest'].includes(jour.data.kind));

  const semaine = await skills.runSkill('workout_week', '', ctx);
  assert.equal(semaine.ok, true);
  assert.equal(semaine.data.days.length, 7);

  const stats = await skills.runSkill('training_stats', '', ctx);
  assert.equal(stats.ok, true);
  assert.equal(stats.data.stats.sessions, 0);

  const ex = await skills.runSkill('workout_exercise', 'comment on fait les pompes', ctx);
  assert.equal(ex.ok, true, ex.error);
  assert.match(ex.output, /Pompes/);
  assert.match(ex.output, /Mains sous les épaules/);
});

test('sans programme, une compétence sport échoue sans casser', async () => {
  const r = await skills.runSkill('workout', '', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /indisponible/);
});

test('une technique inconnue du programme ne détourne pas la réponse', async () => {
  const tr = newTraining();
  const r = await skills.runSkill('workout_exercise', 'comment on fait le développé couché', { training: tr });
  assert.equal(r.ok, false);
});

test('les questions de sport sont détectées, les autres non', () => {
  const cas = {
    "Quelle séance j'ai aujourd'hui ?": 'workout',
    "C'est quoi l'entraînement du jour": 'workout',
    'la séance de demain': 'workout',
    'ma séance': 'workout',
    'mon programme de sport': 'workout',
    'le programme de la semaine': 'workout_week',
    'mes séances de la semaine': 'workout_week',
    'où j’en suis dans mon programme': 'training_stats',
    'combien de séances j’ai fait': 'training_stats',
    'comment on fait les pompes': 'workout_exercise',
    'explique-moi la technique du gainage': 'workout_exercise',
  };
  for (const [phrase, attendu] of Object.entries(cas)) {
    const d = skills.detectSkill(phrase);
    assert.ok(d, 'non détecté : ' + phrase);
    assert.equal(d.skill, attendu, phrase);
  }
  const autres = [
    'quelle heure est-il',
    'quel temps fait-il à Namur',
    'explique-moi comment fonctionne la batterie',
    'ouvre mon appli de sport',
    'prépare-moi une séance courte',
  ];
  for (const phrase of autres) {
    const d = skills.detectSkill(phrase);
    assert.ok(!d || !/^(workout|workout_week|workout_exercise|training_stats)$/.test(d.skill), 'détecté à tort : ' + phrase);
  }
});

/* ------------------------------------------------------------------ */
/* 6. Routes HTTP                                                      */
/* ------------------------------------------------------------------ */

test('l’API sport expose la séance du jour', async (t) => {
  const srv = await startServer({ env: { NOVA_TRAINING_PLAN: FIXTURE } });
  t.after(() => srv.stop());

  const r = await srv.json('/api/training');
  assert.equal(r.status, 200);
  assert.equal(r.body.plan.found, true, r.body.plan.error);
  assert.equal(r.body.plan.programWeeks, 16);
  assert.equal(r.body.plan.days.length, 7);
  assert.equal(r.body.week.days.length, 7);
  assert.equal(r.body.today.ok, true);
  assert.equal(r.body.stats.sessions, 0);

  /* La séance du jour correspond au jour réel de la semaine. */
  const jour = new Date();
  const attendu = ['push', 'legs', 'cardio', 'pull', 'full', 'mobility', 'rest'][(jour.getDay() + 6) % 7];
  assert.equal(r.body.today.type, attendu);
});

test('valider une séance via l’API met à jour la progression', async (t) => {
  const srv = await startServer({ env: { NOVA_TRAINING_PLAN: FIXTURE } });
  t.after(() => srv.stop());

  const jour = (await srv.json('/api/training')).body.today;
  if (jour.type === 'rest') {
    t.skip('aujourd’hui est un jour de repos dans la fixture');
    return;
  }
  const r = await srv.json('/api/training/done', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ done: true }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.today.done, true);
  assert.equal(r.body.stats.sessions, 1);

  const decoche = await srv.json('/api/training/done', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index: 0, value: false }),
  });
  assert.equal(decoche.body.today.ex[0].done, false);
  assert.equal(decoche.body.today.done, false, 'décocher invalide la séance');
});

test('la navigation de semaine passe par ?week=', async (t) => {
  const srv = await startServer({ env: { NOVA_TRAINING_PLAN: FIXTURE } });
  t.after(() => srv.stop());

  const base = (await srv.json('/api/training')).body;
  const suivante = (await srv.json('/api/training?week=1')).body;
  assert.equal(suivante.config.start, base.config.start, 'la config ne change pas');
  assert.equal(
    suivante.week.days[0].dateISO,
    T.isoDate(T.addDays(T.parseISO(base.week.days[0].dateISO), 7)),
    'la semaine suivante commence 7 jours plus tard'
  );
  assert.equal(suivante.week.week, base.week.week + 1);

  const precedente = (await srv.json('/api/training?week=-1')).body;
  assert.equal(precedente.week.week, base.week.week - 1);

  const absurde = (await srv.json('/api/training?week=99999999')).body;
  assert.equal(absurde.week.ok, true, 'une valeur extrême reste bornée et ne casse rien');
});

test('la configuration du programme est validée', async (t) => {
  const srv = await startServer({ env: { NOVA_TRAINING_PLAN: FIXTURE } });
  t.after(() => srv.stop());

  const pasHtml = await srv.json('/api/training/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planPath: '/etc/hosts' }),
  });
  assert.equal(pasHtml.status, 400);
  assert.match(pasHtml.body.error, /\.html/);

  const absent = await srv.json('/api/training/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planPath: '/tmp/fichier-qui-nexiste-pas.html' }),
  });
  assert.equal(absent.status, 400);
  assert.match(absent.body.error, /introuvable/);

  const dateInvalide = await srv.json('/api/training/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: 'hier' }),
  });
  assert.equal(dateInvalide.status, 400);

  const ok = await srv.json('/api/training/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: '2026-08-03' }),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.config.start, '2026-08-03');
  assert.equal(ok.body.stats.week, 6, '6 semaines après le 3 août (semaine 7, phase allègement)');
  assert.equal(ok.body.stats.phase.name, 'Allègement');
});

test('l’import par HTTP accepte une sauvegarde Pulse et refuse le reste', async (t) => {
  const srv = await startServer({ env: { NOVA_TRAINING_PLAN: FIXTURE, NOVA_TRAINING_AUTODETECT: 'off' } });
  t.after(() => srv.stop());

  const bon = await srv.json('/api/training/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: JSON.stringify({ app: 'pulse', state: { sessions: { '2026-09-14': { done: 1 } } } }) }),
  });
  assert.equal(bon.status, 200);
  assert.equal(bon.body.imported.added, 1);
  assert.equal(bon.body.stats.sessions, 1);
  assert.match(bon.body.message, /importée/);

  const mauvais = await srv.json('/api/training/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '{"app":"spotify"}' }),
  });
  assert.equal(mauvais.status, 400);

  const vide = await srv.json('/api/training/import', { method: 'POST' });
  assert.equal(vide.status, 400, 'un corps vide ne fait pas planter le serveur');
});

test('la remise à zéro efface la progression mais garde la configuration', async (t) => {
  const srv = await startServer({ env: { NOVA_TRAINING_PLAN: FIXTURE } });
  t.after(() => srv.stop());

  await srv.json('/api/training/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: JSON.stringify({ app: 'pulse', state: { sessions: { '2026-09-14': { done: 1 } } } }) }),
  });
  const r = await srv.json('/api/training/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.stats.sessions, 0);
  assert.equal(r.body.today.ok, true);
  assert.equal(r.body.plan.found, true, 'le programme reste branché');
});

test('le diagnostic inclut l’état du programme sport', async (t) => {
  const srv = await startServer({ env: { NOVA_TRAINING_PLAN: FIXTURE } });
  t.after(() => srv.stop());
  const r = await srv.json('/api/diag');
  assert.equal(r.status, 200);
  assert.equal(r.body.training.planFound, true);
  assert.equal(r.body.training.programWeeks, 16);
  assert.ok(r.body.training.dataFile.endsWith('training.json'));
});

test('sans programme, l’API répond quand même (et le dit)', async (t) => {
  /* Détection automatique coupée : sinon le serveur irait chercher le vrai
     fichier Pulse du Bureau et ce test dépendrait de la machine. */
  const srv = await startServer({
    env: {
      NOVA_TRAINING_PLAN: path.join(tempDir(), 'absent.html'),
      NOVA_TRAINING_AUTODETECT: 'off',
    },
  });
  t.after(() => srv.stop());
  const r = await srv.json('/api/training');
  assert.equal(r.status, 200);
  assert.equal(r.body.plan.found, false);
  assert.match(r.body.plan.error, /introuvable|illisible/);
  assert.equal(r.body.today.ok, false);
  const diag = await srv.json('/api/diag');
  assert.equal(diag.body.training.planFound, false);
});
