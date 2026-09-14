/* ============================================================
   Nova — tests des compétences de lecture (lib/skills.js)

   Ces tests vérifient la détection d'intention (le point le plus
   fragile, car la parole arrive sans apostrophes ni accents) et
   l'exécution de quelques compétences réellement sans effet de
   bord : heure, date, IP, uptime.
   ============================================================ */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const skills = require('../lib/skills.js');

test('détecte l\'intention même sans apostrophes ni accents', () => {
  const cas = [
    ['Quelle heure est-il ?', 'now'],
    ['il est quelle heure', 'now'],
    ['tu as l heure ?', 'now'],
    ['Quel jour sommes-nous ?', 'date'],
    ["on est quel jour aujourd'hui ?", 'date'],
    ['Quel temps fait-il ?', 'weather'],
    ['il fait quel temps dehors ?', 'weather'],
    ['est-ce quil pleut ?', 'weather'],
    ['qu est-ce que j ai copié ?', 'clipboard'],
    ['montre-moi mon presse-papiers', 'clipboard'],
    ['combien de batterie me reste-t-il ?', 'battery'],
    ['il me reste combien d espace disque ?', 'disk'],
    ['quelle est mon adresse IP locale ?', 'ip'],
    ['depuis combien de temps le Mac est allumé ?', 'uptime'],
  ];
  for (const [phrase, attendu] of cas) {
    const d = skills.detectSkill(phrase);
    assert.ok(d, 'aucune compétence détectée pour « ' + phrase + ' »');
    assert.strictEqual(d.skill, attendu, '« ' + phrase + ' » → ' + d.skill + ' au lieu de ' + attendu);
  }
});

test('ne détourne jamais une demande d\'explication ou d\'action', () => {
  const aNePasDetecter = [
    'explique-moi comment fonctionne la batterie d un Mac',
    'raconte-moi une histoire sur le disque dur',
    'ouvre Safari',
    'montre-moi le site de la météo',
    'mets-moi un rappel pour demain',
    'pourquoi mon IP change-t-elle ?',
    'Bonjour, comment vas-tu ?',
    '',
    '   ',
  ];
  for (const phrase of aNePasDetecter) {
    assert.strictEqual(skills.detectSkill(phrase), null, 'détection à tort pour « ' + phrase + ' »');
  }
});

test('ignore les phrases trop longues (ce n\'est plus une question courte)', () => {
  const long = 'Quelle heure est-il ' + 'et surtout '.repeat(20) + '?';
  assert.strictEqual(skills.detectSkill(long), null);
});

test('extrait la ville demandée pour la météo', () => {
  assert.strictEqual(skills.detectSkill('Quel temps fait-il à Namur ?').arg, 'namur');
  assert.strictEqual(skills.detectSkill('Météo pour Bruxelles').arg, 'bruxelles');
  assert.strictEqual(skills.detectSkill('Il fait quel temps ?').arg, '');
});

test('l\'heure et la date réelles sont renvoyées en français', async () => {
  const heure = await skills.runSkill('now');
  assert.strictEqual(heure.ok, true);
  assert.match(heure.output, /^nous sommes le .+, il est \d{2}:\d{2}$/);
  assert.match(heure.output, /(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)/);

  const date = await skills.runSkill('date');
  assert.strictEqual(date.ok, true);
  assert.match(date.output, /^nous sommes le /);
});

test('l\'adresse IP et l\'uptime sont des données réelles', async () => {
  const ip = await skills.runSkill('ip');
  assert.strictEqual(ip.ok, true);
  assert.match(ip.output, /adresse IP locale \d+\.\d+\.\d+\.\d+ \(interface \w+\)/);

  const up = await skills.runSkill('uptime');
  assert.strictEqual(up.ok, true);
  assert.match(up.output, /^le Mac est allumé depuis /);
});

test('une compétence inconnue échoue proprement', async () => {
  const r = await skills.runSkill('rm_rf');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /inconnue/);
});

test('la liste des compétences de lecture est celle attendue', () => {
  for (const nom of ['now', 'date', 'battery', 'disk', 'ip', 'uptime', 'clipboard', 'weather']) {
    assert.ok(skills.READONLY_SKILLS.includes(nom), nom + ' manque dans READONLY_SKILLS');
  }
  /* Aucune compétence de lecture ne doit pouvoir modifier le Mac */
  assert.ok(!skills.READONLY_SKILLS.includes('volume'));
  assert.ok(!skills.READONLY_SKILLS.includes('open'));
});

test('normalizeFr recolle les élisions et retire les accents', () => {
  /* Whisper omet souvent l'apostrophe : les deux écritures doivent converger. */
  assert.strictEqual(skills.normalizeFr("qu'est-ce que j'ai copié ?"), skills.normalizeFr('qu est-ce que j ai copié ?'));
  assert.strictEqual(skills.normalizeFr('Météo à Nîmes'), 'meteo a nimes');
});

test('skillCityFromText accepte la ponctuation finale', () => {
  assert.strictEqual(skills.skillCityFromText('temps pour Bruxelles ?'), 'bruxelles');
  assert.strictEqual(skills.skillCityFromText('météo à Auvelais'), 'auvelais');
  assert.strictEqual(skills.skillCityFromText('il fait quel temps'), '');
});
