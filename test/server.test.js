/* ============================================================
   Nova — tests d'intégration du serveur (HTTP réel)

   On démarre le vrai serveur dans un dossier temporaire, sans clé
   Groq (donc sans aucun appel réseau vers Groq), et on vérifie :
     - les routes d'information (status, diag, mac/status)
     - le refus des entrées invalides de la sandbox
     - la protection contre la traversée de répertoire
     - la validation/écriture du profil et de la mémoire
   ============================================================ */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { startServer, seed, ROOT } = require('./helpers.js');

/* Un serveur partagé par les tests de lecture seule (démarrage plus rapide) */
let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { if (srv) await srv.stop(); });

test('GET /api/status annonce l\'absence de clé et le modèle', async () => {
  const r = await srv.json('/api/status');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.hasKey, false, 'la clé du .env ne doit pas fuir dans les tests');
  assert.ok(r.body.model, 'un modèle par défaut doit être annoncé');
  assert.ok(r.body.sttModel);
});

test('GET /api/diag décrit serveur, données et sandbox', async () => {
  const r = await srv.json('/api/diag');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.groq.keyConfigured, false);
  assert.strictEqual(r.body.data.dir, srv.dataDir, 'le dossier de données doit être celui injecté');
  assert.strictEqual(r.body.data.writable, true);
  assert.ok(r.body.server && r.body.server.node);
  assert.ok(r.body.mac.actions.includes('clipboard_set'), 'clipboard_set doit être dans les actions');
  assert.ok(r.body.mac.readonly.includes('weather'), 'weather doit être une lecture directe');
  /* La clé n'est jamais renvoyée, seulement sa présence */
  assert.ok(!JSON.stringify(r.body).includes('gsk_'), 'aucune clé ne doit apparaître dans le diagnostic');
});

test('les fichiers de l\'interface sont servis avec le bon type', async () => {
  const page = await srv.fetch('/');
  assert.strictEqual(page.status, 200);
  assert.match(page.headers.get('content-type') || '', /text\/html/);
  const html = await page.text();
  assert.match(html, /Nova/);
  assert.match(html, /wake\.js/, 'le moteur de mot d\'activation doit être chargé par la page');

  const css = await srv.fetch('/style.css');
  assert.strictEqual(css.status, 200);
  assert.match(css.headers.get('content-type') || '', /text\/css/);

  const js = await srv.fetch('/app.js');
  assert.strictEqual(js.status, 200);
  assert.match(js.headers.get('content-type') || '', /javascript/);
});

test('la page contient les six sections de réglages et le catalogue', async () => {
  const html = await (await srv.fetch('/')).text();
  const onglets = ['general', 'voix', 'skills', 'profil', 'memoire', 'historique', 'diagnostic'];
  for (const t of onglets) {
    assert.ok(html.includes('data-tab="' + t + '"'), 'onglet manquant : ' + t);
    assert.ok(html.includes('data-pane="' + t + '"'), 'panneau manquant : ' + t);
  }
  /* Chaque compteur d'onglet doit avoir son panneau : sinon un onglet vide. */
  assert.strictEqual((html.match(/data-tab=/g) || []).length, (html.match(/data-pane=/g) || []).length);
  /* Le catalogue de compétences reste cliquable et documenté */
  assert.ok((html.match(/class="skill-item"/g) || []).length >= 15, 'catalogue de compétences trop pauvre');
  assert.match(html, /data-ask="Quelle heure est-il \?"/);
  assert.match(html, /id="btn-recap-profile"/);
  /* Les identifiants utilisés par app.js doivent tous exister */
  const ids = [...new Set([...html.matchAll(/id="([a-z0-9-]+)"/g)].map((m) => m[1]))];
  assert.ok(ids.includes('mac-control'));
  assert.ok(ids.includes('diag-out'));
});

test('un fichier inexistant renvoie 404, une méthode inconnue 405', async () => {
  const manquant = await srv.fetch('/pas-la.html');
  assert.strictEqual(manquant.status, 404);

  const mauvaise = await srv.json('/api/status', { method: 'POST' });
  assert.strictEqual(mauvaise.status, 405);
  assert.match(mauvaise.body.error, /Méthode/);
});

test('la traversée de répertoire ne peut pas sortir de public/', async () => {
  const tentatives = [
    '/../server.js',
    '/..%2fserver.js',
    '/%2e%2e/server.js',
    '/....//server.js',
    '/../.env',
    '/../data/memory.json',
    '/../../etc/passwd',
  ];
  for (const chemin of tentatives) {
    const r = await srv.fetch(chemin);
    const corps = await r.text();
    assert.notStrictEqual(r.status, 200, chemin + ' ne doit pas renvoyer 200');
    assert.ok(!corps.includes('GROQ_API_KEY'), chemin + ' a fait fuiter le serveur');
    assert.ok(!corps.includes('api.groq.com'), chemin + ' a fait fuiter le serveur');
  }
});

test('un dossier voisin partageant le préfixe n\'est pas accessible', async () => {
  /* « public-old » est voisin de « public » : la comparaison de préfixe
     naïve (startsWith(PUBLIC_DIR)) l'aurait laissé passer. */
  const voisin = path.join(ROOT, 'public-old');
  const secret = path.join(voisin, 'secret.txt');
  fs.mkdirSync(voisin, { recursive: true });
  fs.writeFileSync(secret, 'CONFIDENTIEL-NOVA');
  try {
    const r = await srv.fetch('/../public-old/secret.txt');
    const corps = await r.text();
    assert.notStrictEqual(r.status, 200, 'public-old ne doit pas être servi');
    assert.ok(!corps.includes('CONFIDENTIEL-NOVA'), 'le contenu du dossier voisin a fuité');
  } finally {
    fs.rmSync(voisin, { recursive: true, force: true });
  }
});

test('la sandbox refuse tout ce qui n\'est pas dans l\'allowlist', async () => {
  const refus = [
    [{ action: 'rm_rf', arg: '/' }, /inconnue/],
    [{ action: 'exec', arg: 'rm -rf /' }, /inconnue/],
    [{ action: '', arg: 'x' }, /inconnue/],
    [{ action: 'volume', arg: '999' }, /entre 0 et 100/],
    [{ action: 'volume', arg: 'abc' }, /entre 0 et 100/],
    [{ action: 'brightness', arg: '500' }, /entre 0 et 100/],
    [{ action: 'open', arg: '' }, /manquante/],
    [{ action: 'say', arg: '' }, /manquant/],
    [{ action: 'clipboard_set', arg: '' }, /manquant/],
  ];
  for (const [corps, motif] of refus) {
    const r = await srv.json('/api/mac/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corps),
    });
    assert.strictEqual(r.status, 200, JSON.stringify(corps));
    assert.strictEqual(r.body.ok, false, JSON.stringify(corps) + ' ne doit pas réussir');
    assert.match(r.body.error, motif);
  }
});

test('les lectures passent par la sandbox sans rien modifier', async () => {
  const heure = await srv.json('/api/mac/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'now', arg: '' }),
  });
  assert.strictEqual(heure.body.ok, true);
  assert.match(heure.body.output, /il est \d{2}:\d{2}/);
});

test('une requête invalide vers /api/mac/exec est rejetée proprement', async () => {
  const r = await srv.json('/api/mac/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'ceci n\'est pas du JSON',
  });
  assert.strictEqual(r.status, 400);
});

test('GET /api/mac/status liste les actions et les lectures', async () => {
  const r = await srv.json('/api/mac/status');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.enabled, true);
  assert.ok(r.body.actions.includes('open'));
  assert.ok(r.body.readonly.includes('uptime'));
});

test('le profil est validé, enregistré et relu', async () => {
  const avant = await srv.json('/api/profile');
  assert.strictEqual(avant.status, 200);

  const mise = await srv.json('/api/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '  Alessio    Innangi ', age: 'abc', studies: 'EICA Auvelais' }),
  });
  assert.strictEqual(mise.status, 200);
  assert.strictEqual(mise.body.ok, true);
  assert.strictEqual(mise.body.profile.name, 'Alessio Innangi', 'les espaces multiples doivent être réduits');
  assert.strictEqual(mise.body.profile.age, '', 'un âge non numérique ne doit pas être inventé');

  const relu = await srv.json('/api/profile');
  assert.strictEqual(relu.body.profile.name, 'Alessio Innangi');
  assert.strictEqual(relu.body.profile.studies, 'EICA Auvelais');

  assert.ok(fs.existsSync(path.join(srv.dataDir, 'profile.json')), 'le profil doit être écrit sur le disque');
});

test('le profil refuse les valeurs trop longues (pas d\'injection géante)', async () => {
  const r = await srv.json('/api/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: 'x'.repeat(5000) }),
  });
  assert.strictEqual(r.body.ok, true);
  assert.ok(r.body.profile.notes.length <= 200, 'les champs sont tronqués à 200 caractères');
});

test('la mémoire se charge depuis le disque, se supprime et s\'oublie', async () => {
  const srv2 = await startServer({
    seed(dir) {
      seed(dir, 'memory.json', {
        sessions: [
          { id: 's-1', title: 'Tarte au citron', createdAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:05:00.000Z', turns: [{ user: 'a', assistant: 'b' }, { user: 'c', assistant: 'd' }] },
          { id: 's-2', title: 'Week-end à Lyon', createdAt: '2026-09-12T10:00:00.000Z', updatedAt: '2026-09-12T10:05:00.000Z', turns: [{ user: 'a', assistant: 'b' }] },
        ],
        lastSessionId: 's-1',
      });
    },
  });
  try {
    const liste = await srv2.json('/api/memory');
    assert.strictEqual(liste.status, 200);
    assert.strictEqual(liste.body.sessions.length, 2);
    assert.strictEqual(liste.body.sessions[0].turns, 2, 'turns doit être un NOMBRE d\'échanges');
    assert.strictEqual(liste.body.lastSessionId, 's-1');
    /* Le navigateur d'historique affiche un aperçu de la dernière question */
    assert.strictEqual(liste.body.sessions[0].preview, 'c');
    assert.strictEqual(liste.body.sessions[1].preview, 'a');

    const une = await srv2.json('/api/memory/s-1');
    assert.strictEqual(une.status, 200);
    assert.strictEqual(une.body.title, 'Tarte au citron');

    const inconnue = await srv2.json('/api/memory/nesexiste-pas');
    assert.strictEqual(inconnue.status, 404);

    const suppr = await srv2.json('/api/memory/s-2', { method: 'DELETE' });
    assert.strictEqual(suppr.body.ok, true);
    assert.strictEqual(suppr.body.deleted, 's-2');

    /* La suppression est écrite immédiatement sur le disque */
    const disque = JSON.parse(fs.readFileSync(path.join(srv2.dataDir, 'memory.json'), 'utf8'));
    assert.strictEqual(disque.sessions.length, 1);
    assert.strictEqual(disque.sessions[0].id, 's-1');

    const oubli = await srv2.json('/api/memory/forget', { method: 'POST' });
    assert.deepStrictEqual(oubli.body, { ok: true, forgotten: 1 });

    const vide = await srv2.json('/api/memory');
    assert.strictEqual(vide.body.sessions.length, 0);
    assert.strictEqual(vide.body.lastSessionId, null);
  } finally {
    await srv2.stop();
  }
});

test('une mémoire corrompue ne bloque pas le démarrage', async () => {
  const srv3 = await startServer({
    seed(dir) { seed(dir, 'memory.json', '{ ceci nest pas du json'); },
  });
  try {
    const r = await srv3.json('/api/memory');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.sessions, []);
  } finally {
    await srv3.stop();
  }
});

test('MAC_CONTROL=off coupe toute exécution', async () => {
  const srv4 = await startServer({ env: { MAC_CONTROL: 'off' } });
  try {
    const statut = await srv4.json('/api/mac/status');
    assert.strictEqual(statut.body.enabled, false);

    const exec = await srv4.json('/api/mac/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'now' }),
    });
    assert.strictEqual(exec.status, 403);
    assert.match(exec.body.error, /désactivé/);
  } finally {
    await srv4.stop();
  }
});

test('sans clé, le chat répond en mode démo (aucun appel à Groq)', async () => {
  const r = await srv.fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Bonjour Nova' }] }),
  });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/event-stream/);
  const flux = await r.text();
  assert.match(flux, /data: /);
  assert.match(flux, /"demo":true/, 'les événements doivent être marqués comme démo');
  assert.match(flux, /data: \[DONE\]/);
});

test('une clé mal formée en en-tête est ignorée (pas de fuite vers Groq)', async () => {
  const r = await srv.fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Nova-Key': 'pas-une-cle' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Bonjour' }] }),
  });
  const flux = await r.text();
  assert.match(flux, /"demo":true/, 'une clé invalide doit retomber en mode démo');
});

test('une clé bien formée est prise en compte dans le diagnostic', async () => {
  const srv5 = await startServer({ env: { GROQ_API_KEY: 'gsk_' + 'A'.repeat(40) } });
  try {
    const d = await srv5.json('/api/diag');
    assert.strictEqual(d.body.groq.keyConfigured, true);
    /* Ici on ne parle jamais à Groq : on vérifie juste que la clé est vue. */
    assert.ok(!JSON.stringify(d.body).includes('A'.repeat(40)), 'la clé ne doit jamais être renvoyée');
  } finally {
    await srv5.stop();
  }
});
