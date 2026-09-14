/* ============================================================
   Nova — utilitaires de test

   Démarre le VRAI serveur (server.js) comme le ferait
   start.command, mais dans un dossier de données temporaire et
   sans clé Groq : aucune conversation réelle n'est touchée et
   aucun appel réseau vers Groq n'est possible.
   ============================================================ */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nova-test-'));
}

/* Écrit un fichier dans le dossier de données AVANT le démarrage du
   serveur (utile pour tester le chargement de la mémoire ou du profil). */
function seed(dataDir, name, value) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 1));
  return file;
}

async function waitReady(base, child, timeoutMs) {
  const fin = Date.now() + (timeoutMs || 8000);
  while (Date.now() < fin) {
    if (child.exitCode !== null) throw new Error('le serveur s\'est arrêté (code ' + child.exitCode + ')');
    try {
      const r = await fetch(base + '/api/status');
      if (r.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('le serveur n\'a pas répondu en ' + (timeoutMs || 8000) + ' ms');
}

/**
 * Démarre un serveur de test.
 * @param {object} [opts]
 * @param {object} [opts.env]     variables d'environnement supplémentaires
 * @param {string} [opts.dataDir] dossier de données (sinon temporaire)
 * @param {function} [opts.seed]  (dataDir) => void, exécuté avant le démarrage
 */
async function startServer(opts) {
  opts = opts || {};
  const dataDir = opts.dataDir || tempDataDir();
  if (opts.seed) opts.seed(dataDir);

  const port = 19000 + Math.floor(Math.random() * 900);
  const env = Object.assign({}, process.env, {
    PORT: String(port),
    NOVA_DATA_DIR: dataDir,
    /* Une chaîne vide compte comme « présente » : le .env du développeur
       ne peut donc pas réinjecter une vraie clé pendant les tests. */
    GROQ_API_KEY: '',
    MAC_CONTROL: 'on',
  }, opts.env || {});

  const child = spawn(process.execPath, [SERVER], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += String(c); });
  child.stdout.on('data', () => {});

  const base = 'http://127.0.0.1:' + port;
  try {
    await waitReady(base, child);
  } catch (e) {
    try { child.kill('SIGKILL'); } catch (_) {}
    throw new Error(e.message + (stderr ? ' — ' + stderr.slice(0, 400) : ''));
  }

  return {
    base,
    port,
    dataDir,
    child,
    fetch: (pathname, init) => fetch(base + pathname, init),
    async json(pathname, init) {
      const r = await fetch(base + pathname, init);
      let body = null;
      try { body = await r.json(); } catch (_) {}
      return { status: r.status, headers: r.headers, body };
    },
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const fin = Date.now() + 4000;
      while (child.exitCode === null && Date.now() < fin) await new Promise((r) => setTimeout(r, 40));
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

module.exports = { ROOT, SERVER, startServer, tempDataDir, seed };
