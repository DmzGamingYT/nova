/* ============================================================
   Nova — tests du routage Windows des actions (lib/winctl.js)

   routeAction() centralise les heuristiques partagées avec la
   branche macOS du serveur (volume relatif, URL nue, bornes).
   Tout tourne avec le stub PowerShell : aucun Windows requis.
   ============================================================ */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const winctl = require('../lib/winctl.js');

let calls = [];
let canned = () => ({ ok: true, output: '' });

function installStub() {
  calls = [];
  winctl.__setRunner((cmd) => {
    calls.push(cmd);
    return Promise.resolve(canned(cmd));
  });
}

test('routeAction volume : absolu, relatif chiffré et mots', async () => {
  installStub();
  let r = await winctl.routeAction('volume', '40');
  assert.match(r.output, /40%/);
  let c = calls[calls.length - 1];
  assert.match(c, /-lt 20;\$i\+\+\).*175/); /* 40 % → 20 appuis */

  r = await winctl.routeAction('volume', '+15');
  assert.match(r.output, /\+15%/);
  c = calls[calls.length - 1];
  assert.match(c, /175/); /* 8 appuis haut (arrondi 15/2) */

  const avant = calls.length;
  r = await winctl.routeAction('volume', 'baisse');
  assert.match(r.output, /-10%/);
  c = calls[calls.length - 1];
  assert.match(c, /174/);
  assert.ok(calls.length > avant);

  r = await winctl.routeAction('volume', 'abc');
  assert.match(r.error, /entre 0 et 100/);
  r = await winctl.routeAction('volume', '250');
  assert.match(r.error, /entre 0 et 100/);
  /* « monte de 5 » n'est pas parsé — même comportement que la branche macOS */
  r = await winctl.routeAction('volume', 'monte de 5');
  assert.match(r.error, /entre 0 et 100/);
});

test('routeAction : URL nue préfixée, validations d arguments', async () => {
  installStub();
  await winctl.routeAction('open', 'github.com');
  assert.match(calls[calls.length - 1], /https:\/\/github\.com/);

  let r = await winctl.routeAction('open', '');
  assert.match(r.error, /manquante/);
  r = await winctl.routeAction('say', '');
  assert.match(r.error, /manquant/);
  r = await winctl.routeAction('notification', '');
  assert.match(r.error, /manquant/);
  r = await winctl.routeAction('brightness', '999');
  assert.match(r.error, /entre 0 et 100/);
  r = await winctl.routeAction('action_inexistante', 'x');
  assert.match(r.error, /inconnue/);
});

test('routeAction screenshot : dossier créé et fichier horodaté', async () => {
  installStub();
  const os = require('os');
  const path = require('path');
  const dir = path.join(os.tmpdir(), 'nova-test-caps-' + Date.now());
  const r = await winctl.routeAction('screenshot', '', { screenshotDir: dir });
  assert.strictEqual(r.ok, true);
  assert.match(r.output, /data\/screenshots\/capture-/);
  const fs = require('fs');
  assert.ok(fs.existsSync(dir), 'dossier créé');
  fs.rmSync(dir, { recursive: true, force: true });

  const r2 = await winctl.routeAction('screenshot', '');
  assert.match(r2.error, /dossier des captures/);
});
