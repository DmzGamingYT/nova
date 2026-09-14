'use strict';

const { contextBridge } = require('electron');
const fs = require('fs');
const path = require('path');

/* Pont minimal : la page sait qu'elle tourne dans l'app Nova (mode bureau,
   barre de menus), sans exposer Node ni Electron au contenu web.
   appVersion est exposé pour la bannière « mise à jour disponible » et le
   bloc Nouveautés des Réglages (public/index.html → window.NovaNews).
   On lit package.json ici : "app" n'existe pas côté preload/renderer. */
let _appVersion = '';
try {
  _appVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '';
} catch (_) {}
contextBridge.exposeInMainWorld('novaDesktop', {
  isDesktop: true,
  isMenuBar: true,
  platform: process.platform,
  appVersion: _appVersion,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
