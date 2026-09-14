#!/usr/bin/env node
/* ============================================================
   Vérification manuelle « sport » (hors tests automatiques).

   Démarre le VRAI serveur dans un dossier de données temporaire
   (la progression réelle n'est jamais touchée), en laissant le
   serveur détecter tout seul le fichier Pulse de l'utilisateur,
   puis pose de vraies questions à Groq pour vérifier que la
   donnée réelle arrive jusqu'au modèle.

   Usage : node tools/check-sport.js
   ============================================================ */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 18787;
const BASE = 'http://127.0.0.1:' + PORT;

function keyFromEnvFile() {
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = /^\s*GROQ_API_KEY\s*=\s*(.+)\s*$/m.exec(txt);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch (_) {
    return '';
  }
}

async function ask(question) {
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: question }], sessionId: 'check-sport' }),
  });
  const txt = await r.text();
  let texte = '';
  let skill = null;
  let action = null;
  for (const ligne of txt.split('\n')) {
    if (!ligne.startsWith('data: ')) continue;
    let j;
    try { j = JSON.parse(ligne.slice(6)); } catch (_) { continue; }
    if (j.nova_skill) skill = j.nova_skill;
    if (j.nova_action) action = j.nova_action;
    const c = j.choices && j.choices[0];
    if (c && c.delta && c.delta.content) texte += c.delta.content;
  }
  return { texte: texte.trim(), skill: skill, action: action };
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-sport-check-'));
  const enfant = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      NOVA_DATA_DIR: dataDir,
      GROQ_API_KEY: keyFromEnvFile(),
      MAC_CONTROL: 'on',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  enfant.stdout.on('data', () => {});
  let err = '';
  enfant.stderr.on('data', (c) => { err += String(c); });

  const fin = Date.now() + 8000;
  while (Date.now() < fin) {
    try {
      const r = await fetch(BASE + '/api/status');
      if (r.ok) break;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    console.log('--- 1. Détection automatique du programme ---');
    const etat = await (await fetch(BASE + '/api/training')).json();
    console.log('fichier trouvé :', etat.plan.path || '(aucun)');
    console.log('erreur        :', etat.plan.error || '—');
    console.log('séance du jour :', etat.today.title, '| phase', etat.today.phase && etat.today.phase.name,
      '| semaine', etat.today.week + 1, '|', etat.today.estMinutes, 'min |', (etat.today.ex || []).length, 'exercices');
    console.log('cette semaine  :', etat.week.doneCount + '/' + etat.week.goal, 'séances ·', etat.week.phase.name);

    console.log('\n--- 2. Question réelle à Groq (compétence sport) ---');
    const r1 = await ask("Quelle séance j'ai aujourd'hui ?");
    console.log('compétence :', r1.skill ? r1.skill.skill : '(aucune)');
    console.log('donnée     :', r1.skill ? String(r1.skill.output).slice(0, 160) + '…' : '—');
    console.log('réponse    :', r1.texte || '(vide)');

    console.log('\n--- 3. Technique d’un exercice ---');
    const r2 = await ask('Comment on fait les burpees ?');
    console.log('compétence :', r2.skill ? r2.skill.skill : '(aucune)');
    console.log('réponse    :', r2.texte || '(vide)');

    console.log('\n--- 4. Bilan sport ---');
    const r3 = await ask("Où j'en suis dans mon programme de sport ?");
    console.log('compétence :', r3.skill ? r3.skill.skill : '(aucune)');
    console.log('réponse    :', r3.texte || '(vide)');

    console.log('\n--- 5. Action proposée mais NON exécutée ---');
    const r4 = await ask('Valide ma séance de sport, je viens de finir.');
    console.log('action émise :', r4.action ? JSON.stringify(r4.action) : '(aucune)');
    const apres = await (await fetch(BASE + '/api/training')).json();
    console.log('séance validée sans clic ?', apres.today.done, '(doit être false)');

    console.log('\n--- 6. Validation côté serveur (comme le bouton Autoriser) ---');
    const exec = await (await fetch(BASE + '/api/mac/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'training_done' }),
    })).json();
    console.log('résultat    :', JSON.stringify(exec));
    const apres2 = await (await fetch(BASE + '/api/training')).json();
    console.log('séance validée après confirmation ?', apres2.today.done, '| séances :', apres2.stats.sessions);
  } finally {
    if (err.trim()) console.log('\n[stderr serveur]', err.slice(0, 400));
    enfant.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})();
