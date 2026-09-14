'use strict';

const {
  app, BrowserWindow, Tray, Menu, nativeImage, shell,
  globalShortcut, screen, nativeTheme, Notification,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

const NOVA_URL = process.env.NOVA_URL || 'http://localhost:8787';
const SHORTCUT = process.env.NOVA_SHORTCUT || 'CommandOrControl+Shift+Space';
const isMac = process.platform === 'darwin';

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
  win.loadURL(NOVA_URL);

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
  fullWin.loadURL(NOVA_URL);
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
  /* template : macOS l'adapte à la barre claire/sombre automatiquement */
  const p = path.join(__dirname, 'assets', 'iconTemplate.png');
  const img = nativeImage.createFromPath(p);
  img.setTemplateImage(true);
  return img;
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Nova v' + app.getVersion(), enabled: false },
    { type: 'separator' },
    { label: 'Ouvrir le panneau (' + SHORTCUT.replace('CommandOrControl', '⌘') + ')', click: () => togglePanel() },
    { label: 'Ouvrir dans une fenêtre complète', click: openFullWindow },
    { type: 'separator' },
    { label: 'Serveur : ' + NOVA_URL, enabled: false },
    {
      label: 'Ouvrir dans le navigateur',
      click: () => shell.openExternal(NOVA_URL),
    },
    { type: 'separator' },
    updaterMenuLabel(),
    { type: 'separator' },
    {
      label: 'Quitter Nova',
      accelerator: 'Command+Q',
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

app.whenReady().then(() => {
  if (isMac && app.dock) {
    /* app de barre de menus : pas d'icône dans le Dock */
    try { app.dock.hide(); } catch (_) {}
  }
  nativeTheme.themeSource = 'system';
  createTray();
  createPanel();
  setupAutoUpdater();

  globalShortcut.register(SHORTCUT, () => togglePanel());

  app.on('second-instance', () => togglePanel());
});

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
