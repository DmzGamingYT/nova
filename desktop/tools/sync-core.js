#!/usr/bin/env node
'use strict';

/* ============================================================
   Nova — synchronise le cœur de l'app dans le paquet desktop

   L'app de barre de menus embarque son propre serveur : ce script
   copie server.js + public/ depuis la racine du dépôt vers
   desktop/core/, qui est ensuite packagé par electron-builder
   (extraResources). À relancer après toute modification du cœur :
     npm run sync-core   (déclenché automatiquement par npm start)
   ============================================================ */

const fs = require('fs');
const path = require('path');

const DESKTOP = path.join(__dirname, '..');
const ROOT = path.join(DESKTOP, '..');
const DEST = path.join(DESKTOP, 'core');

const PUBLIC_KEEP = new Set(['index.html', 'app.js', 'style.css', 'wake.js']);

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

rmrf(DEST);
fs.mkdirSync(DEST, { recursive: true });

/* Le cœur serveur, autonome : zéro dépendance Node au-delà du stdlib.
   lib/ contient les compétences et l'entraînement, requises par server.js. */
copyFile(path.join(ROOT, 'server.js'), path.join(DEST, 'server.js'));
const libSrc = path.join(ROOT, 'lib');
if (fs.existsSync(libSrc)) {
  for (const e of fs.readdirSync(libSrc, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.js')) copyFile(path.join(libSrc, e.name), path.join(DEST, 'lib', e.name));
  }
}

/* L'interface web (fichiers connus uniquement — pas de surprise) */
const pub = path.join(ROOT, 'public');
for (const name of PUBLIC_KEEP) {
  const src = path.join(pub, name);
  if (fs.existsSync(src)) copyFile(src, path.join(DEST, 'public', name));
}

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(path.relative(DEST, p));
  }
})(DEST);

console.log('[sync-core] ' + files.length + ' fichiers copiés dans desktop/core :');
for (const f of files) console.log('  · ' + f);
