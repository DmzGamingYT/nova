'use strict';

const { contextBridge } = require('electron');

/* Pont minimal : la page sait qu'elle tourne dans l'app Nova (mode bureau),
   sans exposer Node ni Electron au contenu web. */
contextBridge.exposeInMainWorld('novaDesktop', {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
