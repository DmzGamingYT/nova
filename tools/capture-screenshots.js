#!/usr/bin/env node
'use strict';
/* Captures d'écran automatiques de la vraie interface Nova — via Electron
   offscreen (rendu réel, aucune dépendance npm à installer).
   Prérequis : serveur Nova lancé (http://127.0.0.1:8787) + desktop/node_modules
   (Electron y est déjà installé pour l'app).
   Usage : node tools/capture-screenshots.js [--base http://127.0.0.1:8787] [--out docs]

   ⚠️ Un thème = un processus Electron. Capturer les deux thèmes dans un
   même processus plante sur macOS (conflit de mach-ports au deuxième
   BrowserWindow offscreen). Le script marche en deux modes :
     • lancé via `node` : coordinateur — résout le binaire Electron
       (desktop/node_modules) et relance CE script en mode worker pour
       chaque thème, séquentiellement ;
     • lancé en worker (interne, --worker --theme X) : un processus
       Electron fait UN thème puis s'arrête.

   Worker, pour chaque thème :
     1. offscreen BrowserWindow 1280×800 (scale 2 → PNG retina 2560×1600)
     2. bloque /api/memory dans la fenêtre : les captures sont publiques,
        elles ne doivent jamais montrer la vraie mémoire de l'utilisateur
     3. charge l'UI, force le thème via localStorage avant app.js
     4. injecte une conversation réaliste (mêmes classes que l'app : .msg,
        .bubble, .skill-badge) — sans appel réseau ni voix
     5. attend le rendu réel (bulles présentes, PNG non vide), capture
        en docs/screenshot-<thème>.png   */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
function argOf(name, def) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
}
const WORKER_THEME = argv.includes('--worker') ? argOf('--theme', '') : '';
const BASE = argOf('--base', 'http://127.0.0.1:8787');
const OUT = path.resolve(argOf('--out', path.join(__dirname, '..', 'docs')));

function ping() {
  return new Promise((resolve) => {
    http.get(BASE + '/api/status', (r) => { r.resume(); resolve(r.statusCode === 200); })
      .on('error', () => resolve(false));
  });
}

/* Conversation factice injectée dans la vraie UI (mêmes classes que app.js). */
const INJECT = `(function(){
  function mk(){
    var hero = document.getElementById('hero');
    if (hero) hero.style.display = 'none';
    var log = document.getElementById('messages');
    if (!log) return false;
    log.innerHTML = '';   // repart d'un écran propre, même si un rendu tardif a traîné

    function addMsg(role, html){
      var wrap = document.createElement('div');
      wrap.className = 'msg ' + role;
      var b = document.createElement('div');
      b.className = 'bubble';
      if (role === 'assistant') b.innerHTML = html; else b.textContent = html;
      var t = document.createElement('div');
      t.className = 'time';
      t.textContent = ('0'+new Date().getHours()).slice(-2)+':'+('0'+new Date().getMinutes()).slice(-2);
      wrap.appendChild(b); wrap.appendChild(t);
      log.appendChild(wrap);
      return wrap;
    }

    addMsg('user', "Quelle séance j'ai aujourd'hui ?");

    var nova = addMsg('assistant',
      "Aujourd'hui, c'est <b>Haut du corps</b> : pompes × 12 (3 séries), " +
      "dips sur chaise × 10 (3 séries) et planche 45 s (3 passages). " +
      "Environ <b>22 minutes</b> — je te chronomètre si tu veux !");

    var badge = document.createElement('div');
    badge.className = 'skill-badge';
    var dot = document.createElement('span'); dot.className = 'dot';
    var txt = document.createElement('span'); txt.textContent = 'donnée réelle · séance du jour';
    badge.appendChild(dot); badge.appendChild(txt);
    nova.appendChild(badge);

    addMsg('user', 'Merci ! Et il fait quel temps ?');
    addMsg('assistant',
      "Ciel couvert, 18° ressenti — prévois une petite veste pour la séance " +
      "de ce soir. On y va quand tu veux !");
    return true;
  }
  var tries = 0;
  var iv = setInterval(function(){
    tries++;
    if (mk() || tries > 40) clearInterval(iv);
  }, 250);
  true;
})()`;

/* ═════════════════════════════════════════════════════════════════════
   Mode worker (processus Electron) — UN thème, puis app.exit()
   ═════════════════════════════════════════════════════════════════════ */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function captureOnce(theme, outFile) {
  const { app, BrowserWindow } = require('electron');
  const seed = `localStorage.setItem('nova.settings.v1', JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('nova.settings.v1')||'{}'),{theme:'${theme}'})));true;`;

  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true, nodeIntegration: false,
    },
  });
  win.webContents.setFrameRate(20);

  /* Captures publiques : jamais la vraie mémoire de l'utilisateur.
     /api/memory échoue silencieusement côté UI (restoreLastSession
     avale l'erreur), donc aucune conversation réelle ne s'affiche. */
  win.webContents.session.webRequest.onBeforeRequest(
    { urls: ['*://*/api/memory', '*://*/api/memory/*'] },
    (details, callback) => callback({ cancel: true })
  );

  try {
    /* 1re charge → imposer le thème avant que app.js ne lise localStorage */
    await win.loadURL(BASE + '/');
    await win.webContents.executeJavaScript(seed);
    await win.loadURL(BASE + '/');   // recharge : app.js démarre avec le thème voulu

    /* injecter la conversation, puis attendre les 4 bulles réelles */
    await win.webContents.executeJavaScript(INJECT);
    let msgs = 0;
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      try { msgs = await win.webContents.executeJavaScript('document.querySelectorAll("#messages .msg").length'); } catch (_) {}
      if (msgs >= 4) break;
    }
    if (msgs < 4) throw new Error("l'interface n'a pas rendu la conversation (" + msgs + '/4 bulles)');
    await sleep(1100); // laisser l'orbe et les bulles finir leur animation d'entrée

    /* capture, avec garde anti-capture-vide (PNG < 60 Ko = frame noire) */
    for (let attempt = 1; attempt <= 3; attempt++) {
      const img = await win.webContents.capturePage();
      const png = img.toPNG();
      if (png.length > 60 * 1024) {
        fs.writeFileSync(outFile, png);
        console.log('✓ ' + theme + ' → ' + outFile + ' (' +
          Math.round(img.getSize().width) + '×' + img.getSize().height + ', ' +
          Math.round(png.length / 1024) + ' Ko)');
        win.destroy();
        return;
      }
      await sleep(1200);
    }
    throw new Error('capture ' + theme + ' : image vide après 3 essais');
  } catch (e) {
    try { win.destroy(); } catch (_) {}
    throw e;
  }
}

async function workerMain() {
  const { app } = require('electron');
  if (!(await ping())) {
    console.error("Serveur Nova injoignable sur " + BASE + " — lance d'abord ./start.command");
    app.exit(1);
    return;
  }
  const file = path.join(OUT, 'screenshot-' + WORKER_THEME + '.png');
  try {
    await captureOnce(WORKER_THEME, file);
    app.exit(0);
  } catch (e) {
    console.error('Échec (' + WORKER_THEME + ') :', e.message);
    app.exit(1);
  }
}

/* ═════════════════════════════════════════════════════════════════════
   Mode coordinateur (node simple) — un worker Electron par thème
   ═════════════════════════════════════════════════════════════════════ */

function electronBinary() {
  const local = path.join(__dirname, '..', 'desktop', 'node_modules', '.bin', 'electron');
  if (fs.existsSync(local)) return local;
  /* electron installé quelque part d'autre (global, autre projet) : tenter la résolution Node */
  try { return require.resolve('electron'); } catch (_) {}
  return null;
}

function runWorker(electron, theme) {
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [__filename, '--worker', '--theme', theme,
      '--base', BASE, '--out', OUT], { stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('worker ' + theme + ' exit ' + code))));
    child.on('error', reject);
  });
}

async function coordinatorMain() {
  if (!(await ping())) {
    console.error("Serveur Nova injoignable sur " + BASE + " — lance d'abord ./start.command");
    process.exit(1);
  }
  const electron = electronBinary();
  if (!electron) {
    console.error('Electron introuvable — installe les dépendances desktop : (cd desktop && npm install)');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  console.log('Electron : ' + electron);
  try {
    await runWorker(electron, 'light');
    await runWorker(electron, 'dark');   // processus séparé : sinon crash macOS (mach-ports)
    console.log('Terminé — vérifie le rendu puis committe docs/screenshot-*.png');
    process.exit(0);
  } catch (e) {
    console.error('Échec :', e.message);
    process.exit(1);
  }
}

if (WORKER_THEME) {
  /* worker : sous Electron, require('electron') doit renvoyer l'API */
  const electronApi = require('electron');
  if (typeof electronApi === 'string') {
    console.error('Worker lancé hors Electron — relance via : node tools/capture-screenshots.js');
    process.exit(1);
  }
  workerMain();
} else {
  coordinatorMain();
}
