'use strict';

const { app, BrowserWindow, shell, nativeImage, nativeTheme } = require('electron');
const path = require('path');

const NOVA_URL = process.env.NOVA_URL || 'http://localhost:8787';
const isMac = process.platform === 'darwin';

/* Une seule instance : un deuxième lancement révèle la fenêtre existante. */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 520,
    minHeight: 560,
    show: false,
    backgroundColor: '#00000000',
    /* "verre & lumière" : barre de titre transparente avec contrôles natifs */
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadURL(NOVA_URL);

  /* Les liens externes s'ouvrent dans le navigateur, pas dans l'app. */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(NOVA_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  win.on('closed', () => { win = null; });
}

/* Recrée une fenêtre au clic Dock si l'utilisateur l'a fermée. */
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.whenReady().then(() => {
  /* Icône de Dock dédiée (template dispo pour les autres plateformes). */
  if (isMac) {
    try {
      const iconPath = path.join(__dirname, 'assets', 'icon.png');
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) app.dock.setIcon(img);
    } catch (_) { /* l'icône par défaut d'Electron reste acceptable */ }
  }
  nativeTheme.themeSource = 'system';
  createWindow();

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
});

/* Quitter complètement quand toutes les fenêtres sont fermées (comportement
   macOS : l'app reste dans le Dock, on garde ce réflexe). */
app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

/* Pas de menu inutile : garder l'interface épurée, mais garder les raccourcis. */
app.on('web-contents-created', (_, contents) => {
  contents.on('before-input-event', (event, input) => {
    /* ⌘R rechargement et ⌘Q quitter, comme dans le navigateur. */
    if (input.meta && input.key.toLowerCase() === 'r' && isMac) {
      win && win.reload();
      event.preventDefault();
    }
  });
});
