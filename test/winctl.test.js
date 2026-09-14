/* ============================================================
   Nova — tests du contrôle Windows (lib/winctl.js)

   Aucun Windows requis : on remplace l'exécuteur PowerShell par
   un stub (__setRunner). Les tests vérifient les commandes PS
   construites (échappement, bornes) et le parsage des sorties.
   ============================================================ */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const winctl = require('../lib/winctl.js');

/* Stub d'exécution : enregistre les commandes, renvoie des sorties
   programmées par le test. */
let calls = [];
let canned = () => ({ ok: true, output: '' });

function installStub() {
  calls = [];
  winctl.__setRunner((cmd, timeout) => {
    calls.push({ cmd, timeout });
    return Promise.resolve(canned(cmd));
  });
}

test('psQuote échappe les apostrophes pour PowerShell', () => {
  assert.strictEqual(winctl.psQuote("c'est l'été"), "'c''est l''été'");
  assert.strictEqual(winctl.psQuote('simple'), "'simple'");
});

test('volumeSetAbsolute : redescend à 0 puis remonte jusqu à la cible', async () => {
  installStub();
  const r = await winctl.volumeSetAbsolute(30);
  assert.strictEqual(r.ok, true);
  assert.match(r.output, /30%/);
  assert.strictEqual(calls.length, 2);
  /* 50 appuis bas (VK 174), puis 15 appuis haut (VK 175) pour 30 % */
  assert.match(calls[0].cmd, /-lt 50;\$i\+\+\).*174/);
  assert.match(calls[1].cmd, /-lt 15;\$i\+\+\).*175/);
});

test('volumeSetAbsolute : volume 0 = seulement les appuis bas', async () => {
  installStub();
  await winctl.volumeSetAbsolute(0);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].cmd, /174/);
});

test('volumeSetAbsolute : borne les valeurs hors 0-100', async () => {
  installStub();
  await winctl.volumeSetAbsolute(150);
  assert.match(calls[1].cmd, /-lt 50;/); /* 100 % → 50 appuis */
});

test('volumeStep : +10 % = 5 appuis haut, -6 % = 3 appuis bas', async () => {
  installStub();
  const up = await winctl.volumeStep(10);
  assert.match(up.output, /\+10%/);
  assert.match(calls[0].cmd, /-lt 5;\$i\+\+\).*175/);
  const down = await winctl.volumeStep(-6);
  assert.match(down.output, /-6%/);
  assert.match(calls[1].cmd, /-lt 3;\$i\+\+\).*174/);
});

test('volumeStep : 0 ne déclenche aucune commande', async () => {
  installStub();
  const r = await winctl.volumeStep(0);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls.length, 0);
});

test('battery : parse « pourcentage | PowerOnline »', async () => {
  installStub();
  canned = () => ({ ok: true, output: '80|True' });
  const r = await winctl.battery();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.output, '80%, sur secteur');
  canned = () => ({ ok: true, output: '45|False' });
  const r2 = await winctl.battery();
  assert.strictEqual(r2.output, '45%, sur batterie');
  assert.match(calls[0].cmd, /Win32_Battery/);
});

test('battery : PC fixe (pas de batterie) → erreur claire', async () => {
  installStub();
  canned = () => ({ ok: true, output: 'ERR' });
  const r = await winctl.battery();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /aucune batterie/);
});

test('notify : le texte passe par psQuote dans la commande toast', async () => {
  installStub();
  const r = await winctl.notify("voici l'essai");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.output, 'notification affichée');
  assert.match(calls[0].cmd, /ToastNotificationManager/);
  assert.ok(calls[0].cmd.includes("'voici l''essai'"), 'texte échappé présent');
});

test('open : préfixe https:// pour les domaines nus', async () => {
  installStub();
  const r = await winctl.open('example.com');
  assert.strictEqual(r.ok, true);
  assert.ok(calls[0].cmd.includes('Start-Process '), 'passe par Start-Process');
  assert.ok(calls[0].cmd.includes('https://example.com'), 'URL préfixée');
  const r2 = await winctl.open('https://exemple.fr/page');
  assert.ok(calls[1].cmd.includes('https://exemple.fr/page'));
  assert.strictEqual(r2.ok, true);
});

test('clipboardSet : le texte est quoté, pas injecté', async () => {
  installStub();
  const r = await winctl.clipboardSet("ligne'un");
  assert.strictEqual(r.output, 'copié dans le presse-papiers');
  assert.ok(calls[0].cmd.includes("Set-Clipboard -Value 'ligne''un'"));
});

test('disk : parse octets → Go et pourcentage occupé', async () => {
  installStub();
  canned = () => ({ ok: true, output: '512110190592|256055095296' });
  const r = await winctl.disk();
  assert.strictEqual(r.ok, true);
  assert.match(r.output, /477 Go au total/);
  assert.match(r.output, /50% occupés/);
  canned = () => ({ ok: true, output: 'ERR' });
  const r2 = await winctl.disk();
  assert.strictEqual(r2.ok, false);
});

test('brightness : borne 0-100 dans la commande WMI', async () => {
  installStub();
  const r = await winctl.brightness(150);
  assert.strictEqual(r.ok, true);
  assert.match(calls[0].cmd, /WmiSetBrightness\(1,100\)/);
  await winctl.brightness(-5);
  assert.match(calls[1].cmd, /WmiSetBrightness\(1,0\)/);
});

test('speak : System.Speech + texte quoté', async () => {
  installStub();
  const r = await winctl.speak('bonjour à toi');
  assert.strictEqual(r.output, 'message prononcé');
  assert.match(calls[0].cmd, /SpeechSynthesizer/);
  assert.ok(calls[0].cmd.includes("'bonjour à toi'"));
});

test('échec PowerShell → { ok:false, error } sans lever', async () => {
  installStub();
  canned = () => ({ ok: false, error: 'boom' });
  const r = await winctl.notify('salut');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /notification refusée/);
  const v = await winctl.volumeSetAbsolute(50);
  assert.strictEqual(v.ok, false);
});
