'use strict';

const {
  app, BrowserWindow, Tray, Menu, nativeImage, shell,
  globalShortcut, screen, nativeTheme, Notification,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

const SHORTCUT = process.env.NOVA_SHORTCUT || 'CommandOrControl+Shift+Space';
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

/* ------------------------------------------------------------------ */
/* Serveur embarqué : l'app packagée embarque le cœur (server.js +     */
/* public/ + lib/, copiés par tools/sync-core.js puis extraResources)  */
/* et lance son propre serveur sur un port libre — la fenêtre n'est    */
/* plus dependante d'un serveur lancé à la main.                       */
/* ------------------------------------------------------------------ */

let serverChild = null;
let serverPort = 0;
/* Site du projet — cible des liens « Nouveautés / Dépannage » du menu */
const SITE = 'https://dmzgamingyt.github.io/nova';
const SITE_GH = 'https://github.com/DmzGamingYT/nova';
/* Packagé : serveur embarqué (port libre). En dev : le serveur du dépôt
   sur :8787 (start.command), workflow inchangé — NOVA_EMBEDDED=1 ou
   NOVA_URL permettent de tester l'embarqué / une autre instance. */
let NOVA_URL = process.env.NOVA_URL
  || (app.isPackaged || process.env.NOVA_EMBEDDED ? '' : 'http://localhost:8787');

function coreDir() {
  /* packagé : resources/core (posé par extraResources) ;
     dev : la racine du dépôt (desktop/..), là où vit server.js */
  const packed = path.join(process.resourcesPath || '', 'core');
  if (app.isPackaged && fs.existsSync(path.join(packed, 'server.js'))) return packed;
  const root = path.join(app.getAppPath(), '..');
  if (fs.existsSync(path.join(root, 'server.js'))) return root;
  return app.getAppPath();
}

/* URL de l'UI, avec la version de l'app en paramètre : la page web
   l'affiche et compare à la dernière release GitHub (Nouveautés). */
function novaUiUrl() {
  try {
    const v = app.getVersion();
    return v ? NOVA_URL + '?appv=' + encodeURIComponent(v) : NOVA_URL;
  } catch (_) {
    return NOVA_URL;
  }
}

function httpProbe(url) {
  return new Promise((resolve) => {
    const req = http.get(url + '/api/status', (r) => { r.resume(); resolve(r.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

async function waitReady(url, child, timeoutMs) {
  const fin = Date.now() + (timeoutMs || 15000);
  while (Date.now() < fin) {
    if (child.exitCode !== null) throw new Error('le serveur embarqué s\'est arrêté (code ' + child.exitCode + ')');
    if (await httpProbe(url)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('le serveur embarqué n\'a pas répondu');
}

async function startEmbeddedServer() {
  /* Un serveur Nova externe (NOVA_URL) reste prioritaire : permet de
     faire pointer l'app vers une instance déjà lancée. */
  if (NOVA_URL) {
    rebuildTrayMenu();
    return;
  }
  serverPort = await freePort();
  NOVA_URL = 'http://127.0.0.1:' + serverPort;

  const core = coreDir();
  /* Données de l'app packagée : dossier userData (writable partout,
     séparé du dépôt de dev). En dev : le data/ du dépôt, comme start.command. */
  const dataDir = app.isPackaged
    ? path.join(app.getPath('userData'), 'core-data')
    : path.join(core, 'data');

  serverChild = spawn(process.execPath, [path.join(core, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(serverPort),
      NOVA_DATA_DIR: dataDir,
      ELECTRON_RUN_AS_NODE: '1',   // process.execPath = binaire Electron → en faire un Node propre
    }),
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  serverChild.on('exit', (code) => { serverChild = null; if (code) console.error('[nova-server] exit', code); });

  await waitReady(NOVA_URL, serverChild);
  rebuildTrayMenu();
}

function stopEmbeddedServer() {
  if (!serverChild) return;
  try { if (isWin) spawn('taskkill', ['/pid', String(serverChild.pid), '/f', '/t']); else serverChild.kill('SIGTERM'); } catch (_) {}
  serverChild = null;
}

/* Dossier de données surchargé (dev/test) : permet de faire tourner une
   instance de dev à côté de l'app installée (verrous d'instance distincts). */
if (process.env.NOVA_USER_DATA) app.setPath('userData', process.env.NOVA_USER_DATA);

/* Une seule instance : un deuxième lancement révèle le panneau. */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let tray = null;
let win = null;        // panneau flottant d'accès rapide
let fullWin = null;    // fenêtre classique (depuis le menu de la barre)

/* ------------------------------------------------------------------ */
/* Panneau flottant type Spotlight                                     */
/* ------------------------------------------------------------------ */

function createPanel() {
  win = new BrowserWindow({
    width: 680,
    height: 560,
    show: false,
    frame: false,
    resizable: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    /* flottant au-dessus de tout, sans voler le focus à l'app active */
    alwaysOnTop: true,
    /* apparaît sur tous les espaces + au-dessus du plein écran */
    visibleOnAllWorkspaces: true,
    roundedCorners: true,
    hasShadow: true,
    transparent: true,
    backgroundColor: '#00000000',
    vibrancy: isMac ? 'under-window' : undefined,
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  if (isMac) {
    /* visible sur tous les espaces, même en plein écran */
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  win.loadURL(novaUiUrl());

  /* clic ailleurs → le panneau se replie (comme Spotlight) */
  win.on('blur', () => {
    if (win && win.isVisible()) win.hide();
  });

  /* liens externes dans le navigateur */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(NOVA_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

function togglePanel() {
  if (!win) createPanel();
  /* serveur embarqué mort (crash, veille longue) → relance au réveil */
  if (!NOVA_URL && !serverChild) startEmbeddedServer().catch(() => {});
  if (win.isVisible()) {
    win.hide();
    return;
  }
  /* position : centré-haut de l'écran actif (celui où travaille l'utilisateur) */
  const { workArea } = screen.getPrimaryDisplay();
  const [w] = win.getSize();
  const x = Math.round(workArea.x + (workArea.width - w) / 2);
  const y = Math.round(workArea.y + 90);
  win.setPosition(x, y, false);
  win.show();
  win.focus();
}

function openFullWindow() {
  if (fullWin && !fullWin.isDestroyed()) {
    fullWin.focus();
    return;
  }
  fullWin = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 520,
    minHeight: 560,
    show: false,
    backgroundColor: '#00000000',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    vibrancy: isMac ? 'under-window' : undefined,
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  fullWin.once('ready-to-show', () => fullWin.show());
  fullWin.loadURL(novaUiUrl());
  fullWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(NOVA_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  fullWin.on('closed', () => { fullWin = null; });
}

/* ------------------------------------------------------------------ */
/* Mise à jour automatique (electron-updater, releases GitHub)         */
/* ------------------------------------------------------------------ */

/* Vrai seulement si l'app est signée + notarisée : Squirrel exige une
   signature valide pour remplacer l'app sur le disque. */
function updatesSupported() {
  return isMac && app.isPackaged && !process.mas;
}

let updaterState = 'idle'; // idle | checking | available | none | downloaded | error
let updaterError = null;

function setUpdaterState(state, err) {
  updaterState = state;
  updaterError = err || null;
  rebuildTrayMenu();
  if (state === 'error') console.error('[updater]', updaterError);
}

function setupAutoUpdater() {
  if (!updatesSupported()) return;

  autoUpdater.logger = console;
  autoUpdater.autoDownload = true;   // télécharge en arrière-plan
  autoUpdater.autoInstallOnAppQuit = true; // installe au redémarrage suivant

  autoUpdater.on('checking-for-update', () => setUpdaterState('checking'));
  autoUpdater.on('update-available', () => setUpdaterState('available'));
  autoUpdater.on('update-not-available', () => setUpdaterState('none'));
  autoUpdater.on('download-progress', (p) => {
    console.log(`[updater] ${Math.round(p.percent)} % — ${p.transferred}/${p.total} octets`);
  });
  autoUpdater.on('update-downloaded', (info) => {
    setUpdaterState('downloaded');
    const n = new Notification({
      title: 'Nova est prête à se mettre à jour',
      body: `Version ${info.version} téléchargée. Relance Nova pour l'appliquer.`,
      silent: false,
    });
    n.on('click', () => autoUpdater.quitAndInstall());
  });
  /* Erreur (typiquement build non signé ou pas de release encore publiée) :
     on revient à l'état neutre, le détail reste dans la console. */
  autoUpdater.on('error', (err) => {
    console.error('[updater]', err && err.message ? err.message : err);
    setUpdaterState('idle');
  });

  autoUpdater.checkForUpdates().catch(() => {});
  /* re-check toutes les 6 heures */
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

function updaterMenuLabel() {
  switch (updaterState) {
    case 'checking':   return { label: 'Mise à jour : vérification…', enabled: false };
    case 'available':  return { label: 'Mise à jour : téléchargement…', enabled: false };
    case 'none':       return { label: 'Nova est à jour ✓', enabled: false };
    case 'downloaded': return { label: 'Redémarrer pour installer la mise à jour', click: () => autoUpdater.quitAndInstall() };
    case 'error':      return { label: 'Mise à jour : échec (' + (updaterError && updaterError.message ? updaterError.message.slice(0, 40) : 'erreur') + ')', enabled: false };
    default:           return { label: 'Rechercher les mises à jour…', click: () => { setUpdaterState('checking'); autoUpdater.checkForUpdates().catch(() => {}); } };
  }
}

/* ------------------------------------------------------------------ */
/* Barre de menus (Tray)                                               */
/* ------------------------------------------------------------------ */

function trayIcon() {
  if (isMac) {
    /* template : macOS l'adapte à la barre claire/sombre automatiquement */
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'iconTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  /* Windows : icône couleur normale dans la zone de notification */
  return nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Nova v' + app.getVersion(), enabled: false },
    { type: 'separator' },
    { label: 'Ouvrir le panneau (' + SHORTCUT.replace('CommandOrControl', isMac ? '⌘' : 'Ctrl') + ')', click: () => togglePanel() },
    { label: 'Ouvrir dans une fenêtre complète', click: openFullWindow },
    { type: 'separator' },
    { label: 'Serveur : ' + NOVA_URL + (serverChild ? ' (embarqué)' : ''), enabled: false },
    {
      label: 'Ouvrir dans le navigateur',
      click: () => shell.openExternal(NOVA_URL),
    },
    { type: 'separator' },
    {
      label: 'Nouveautés du projet',
      click: () => shell.openExternal(SITE + '/nouveautes.html'),
    },
    {
      label: 'Dépannage & aide',
      click: () => shell.openExternal(SITE + '/depannage.html'),
    },
    {
      label: 'Page GitHub',
      click: () => shell.openExternal(SITE_GH),
    },
    { type: 'separator' },
    updaterMenuLabel(),
    { type: 'separator' },
    {
      label: isMac ? 'Quitter Nova' : 'Quitter Nova',
      accelerator: isMac ? 'Command+Q' : undefined,
      click: () => app.quit(),
    },
  ]));
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Nova — clic pour ouvrir · ' + SHORTCUT);
  tray.on('click', () => togglePanel());
  rebuildTrayMenu();
}

/* ------------------------------------------------------------------ */
/* Cycle de vie                                                        */
/* ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  if (isMac && app.dock) {
    /* app de barre de menus : pas d'icône dans le Dock */
    try { app.dock.hide(); } catch (_) {}
  }
  nativeTheme.themeSource = 'system';

  try {
    await startEmbeddedServer();
  } catch (e) {
    console.error('[nova-server]', e.message);
    new Notification({
      title: 'Nova — serveur en échec',
      body: 'Le serveur interne n\'a pas démarré. L\'app essaiera de le relancer à la prochaine ouverture du panneau.',
      silent: true,
    }).show();
  }

  createTray();
  createPanel();
  setupAutoUpdater();

  globalShortcut.register(SHORTCUT, () => togglePanel());

  app.on('second-instance', () => togglePanel());
});

app.on('before-quit', () => stopEmbeddedServer());

/* rester actif quand toutes les fenêtres sont fermées (barre de menus) */
app.on('window-all-closed', (e) => {
  /* no-op : l'app vit dans la barre de menus */
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('web-contents-created', (_, contents) => {
  contents.on('before-input-event', (event, input) => {
    /* Échap ferme le panneau flottant */
    if (input.key === 'Escape') {
      if (win && win.isVisible()) { win.hide(); event.preventDefault(); }
      if (fullWin) { fullWin.hide(); event.preventDefault(); }
    }
  });
});
