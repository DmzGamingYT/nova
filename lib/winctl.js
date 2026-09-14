/* ============================================================
   Nova — contrôle Windows via PowerShell (parité avec macOS)

   Tout passe par un seul binaire : powershell.exe (présent sur
   chaque installation de Windows), appelé SANS shell — execFile
   + tableau d'arguments, jamais de cmd.exe. Les textes issus du
   modèle sont injectés via psQuote (littéral PS) ; les sorties
   structurées sont en « a|b » parsé côté JS.

   Testable partout : __setRunner() remplace l'exécuteur PS par
   un stub (voir test/winctl.test.js) — les tests vérifient la
   commande construite et le parsage, sans Windows réel.
   ============================================================ */

'use strict';

const { execFile } = require('child_process');

/* ------------------------------------------------------------------ */
/* Exécuteur PowerShell (+ point d'injection pour les tests)            */
/* ------------------------------------------------------------------ */

function ps(command, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { timeout: timeoutMs || 8000, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => {
          if (err) return resolve({ ok: false, error: err.message });
          const out = String(stdout || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
          resolve({ ok: true, output: out });
        }
      );
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

/* Surcharge de test : les tests passent une fausse exécution qui
   renvoie { ok, output } ou inspecte la commande construite. */
let runPs = ps;
function __setRunner(fn) { runPs = fn; }
function __resetRunner() { runPs = ps; }

/* ------------------------------------------------------------------ */
/* Échappements                                                         */
/* ------------------------------------------------------------------ */

/* Texte → littéral PowerShell entre apostrophes ('' internes doublés).
   Aucune autre voie d'injection : les valeurs numériques passent par
   Number() + Math.round avant concaténation. */
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/* ------------------------------------------------------------------ */
/* Entrées clavier globales (volume) — user32.keybd_event               */
/* ------------------------------------------------------------------ */

/* VK_VOLUME_DOWN = 0xAE (174), VK_VOLUME_UP = 0xAF (175) ; chaque
   appui vaut 2 % du volume système. keybd_event agit au niveau
   système (pas besoin du focus d'une fenêtre). */
const KB_TYPE =
  "Add-Type -Namespace W -Name K -MemberDefinition " +
  "'[DllImport(\"user32.dll\")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);';";

function sendVolumeKeys(presses, vk) {
  const n = Math.max(0, Math.min(50, Math.round(Number(presses) || 0)));
  if (!n) return Promise.resolve({ ok: true, output: '' });
  const loop =
    'for($i=0;$i -lt ' + n + ';$i++){' +
    '[W.K]::keybd_event(' + vk + ',0,0,[UIntPtr]::Zero);' +
    '[W.K]::keybd_event(' + vk + ',0,2,[UIntPtr]::Zero);' +
    'Start-Sleep -Milliseconds 8}';
  return runPs(KB_TYPE + ' ' + loop, 20000);
}

/* Volume absolu 0–100 : on redescend à 0 (plancher garanti),
   puis on remonte par pas de 2 % jusqu'à la cible. */
async function volumeSetAbsolute(n) {
  const cible = Math.round(Math.max(0, Math.min(100, Number(n) || 0)));
  const down = await sendVolumeKeys(50, 174);
  if (!down.ok) return { ok: false, error: 'réglage du volume refusé' };
  if (cible > 0) {
    const up = await sendVolumeKeys(Math.round(cible / 2), 175);
    if (!up.ok) return { ok: false, error: 'réglage du volume refusé' };
  }
  return { ok: true, output: 'volume réglé à ' + cible + '%' };
}

/* Volume relatif : +N / -N pour cent (arrondi aux pas de 2 %). */
async function volumeStep(pct) {
  const pas = Math.round(Number(pct) || 0);
  if (!pas) return { ok: true, output: 'volume inchangé' };
  const presses = Math.max(1, Math.round(Math.abs(pas) / 2));
  const r = await sendVolumeKeys(presses, pas > 0 ? 175 : 174);
  if (!r.ok) return { ok: false, error: 'réglage du volume refusé' };
  return { ok: true, output: 'volume ' + (pas > 0 ? '+' : '') + pas + '%' };
}

/* ------------------------------------------------------------------ */
/* Notification toast (WinRT — la bulle native Windows 10/11)           */
/* ------------------------------------------------------------------ */

async function notify(text) {
  const msg = String(text || '').slice(0, 200);
  const cmd =
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; ' +
    '$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); ' +
    "$t.GetElementsByTagName('text').Item(0).AppendChild($t.CreateTextNode('Nova')) | Out-Null; " +
    '$t.GetElementsByTagName(\'text\').Item(1).AppendChild($t.CreateTextNode(' + psQuote(msg) + ')) | Out-Null; ' +
    '$n=New-Object Windows.UI.Notifications.ToastNotification -ArgumentList $t; ' +
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Nova.Assistant').Show($n)";
  const r = await runPs(cmd, 10000);
  return r.ok ? { ok: true, output: 'notification affichée' } : { ok: false, error: 'notification refusée par Windows' };
}

/* ------------------------------------------------------------------ */
/* Batterie — Win32_Battery (pourcentage) + BatteryStatus (secteur)     */
/* ------------------------------------------------------------------ */

async function battery() {
  const r = await runPs(
    '$p=(Get-CimInstance Win32_Battery | Select-Object -First 1).EstimatedChargeRemaining; ' +
      '$b=Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1; ' +
      'if($null -eq $p -or $null -eq $b){\'ERR\'}else{"{0}|{1}" -f $p,$b.PowerOnline}',
    8000
  );
  if (!r.ok) return { ok: false, error: 'batterie inaccessible' };
  if (r.output === 'ERR') return { ok: false, error: 'aucune batterie détectée (PC fixe ?)' };
  const parts = r.output.split('|');
  const n = parseInt(parts[0], 10);
  if (isNaN(n)) return { ok: false, error: 'batterie illisible' };
  return { ok: true, output: n + '%, ' + (parts[1] === 'True' ? 'sur secteur' : 'sur batterie') };
}

/* ------------------------------------------------------------------ */
/* Ouvrir — URL/application (Start-Process)                             */
/* ------------------------------------------------------------------ */

/* URL ou nom d'application ; mêmes heuristiques que la branche macOS. */
async function open(s) {
  if (!s) return { ok: false, error: 'adresse ou application manquante' };
  const isUrl = /^(https?:\/\/|www\.)|\.[a-z]{2,}(\/|$)/i.test(s);
  const target = isUrl && !/^https?:\/\//i.test(s) ? 'https://' + s : s;
  const r = await runPs('Start-Process ' + psQuote(target), 10000);
  return r.ok ? { ok: true, output: 'ouvert : ' + s } : { ok: false, error: 'application ou site introuvable' };
}

/* Chemin local (fichier, .lnk, programme) — détection URL désactivée. */
async function openPath(p) {
  if (!p) return { ok: false, error: 'chemin manquant' };
  const r = await runPs('Start-Process ' + psQuote(p), 10000);
  return r.ok ? { ok: true, output: 'ouvert : ' + p } : { ok: false, error: 'ouverture impossible' };
}

/* ------------------------------------------------------------------ */
/* Voix (System.Speech) et presse-papiers (Set-Clipboard)               */
/* ------------------------------------------------------------------ */

async function speak(text) {
  if (!text) return { ok: false, error: 'texte manquant' };
  const r = await runPs(
    'Add-Type -AssemblyName System.Speech; ' +
      '$v=New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
      '$v.Speak(' + psQuote(text) + ')',
    60000
  );
  return r.ok ? { ok: true, output: 'message prononcé' } : { ok: false, error: 'voix indisponible' };
}

async function clipboardSet(text) {
  if (text === undefined || text === null || text === '') return { ok: false, error: 'texte manquant' };
  const r = await runPs('Set-Clipboard -Value ' + psQuote(text), 8000);
  return r.ok ? { ok: true, output: 'copié dans le presse-papiers' } : { ok: false, error: 'presse-papiers refusé' };
}

async function clipboardGet() {
  const r = await runPs('Get-Clipboard -Format Text -Raw', 6000);
  if (!r.ok) return { ok: false, error: 'presse-papiers illisible' };
  return { ok: true, output: r.output.replace(/\s+/g, ' ').trim() };
}

/* ------------------------------------------------------------------ */
/* Luminosité — WmiMonitorBrightness (portables uniquement)             */
/* ------------------------------------------------------------------ */

async function brightness(n) {
  const v = Math.round(Math.max(0, Math.min(100, Number(n) || 0)));
  const r = await runPs(
    '(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods).WmiSetBrightness(1,' + v + ')',
    8000
  );
  return r.ok
    ? { ok: true, output: 'luminosité réglée à ' + v + '%' }
    : { ok: false, error: 'luminosité non réglable sur ce PC (écran externe ou fixe ?)' };
}

/* ------------------------------------------------------------------ */
/* Capture d'écran — System.Drawing CopyFromScreen (écran virtuel)      */
/* ------------------------------------------------------------------ */

async function screenshot(file) {
  const cmd =
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ' +
    '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen; ' +
    '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; ' +
    '$g=[System.Drawing.Graphics]::FromImage($bmp); ' +
    '$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size); ' +
    '$bmp.Save(' + psQuote(file) + ',[System.Drawing.Imaging.ImageFormat]::Png); ' +
    '$g.Dispose(); $bmp.Dispose()';
  const r = await runPs(cmd, 15000);
  return r.ok ? { ok: true, output: '' } : { ok: false, error: 'capture refusée par Windows' };
}

/* ------------------------------------------------------------------ */
/* Disque — Win32_LogicalDisk C: (pour les compétences de lecture)      */
/* ------------------------------------------------------------------ */

async function disk() {
  const r = await runPs(
    "$d=Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\"; " +
      "if($null -eq $d){'ERR'}else{\"{0}|{1}\" -f $d.Size,$d.FreeSpace}",
    6000
  );
  if (!r.ok || r.output === 'ERR') return { ok: false, error: 'disque illisible' };
  const parts = r.output.split('|').map((x) => parseFloat(x));
  if (!isFinite(parts[0]) || !isFinite(parts[1])) return { ok: false, error: 'disque illisible' };
  const [size, free] = parts;
  const gb = (x) => (x / 1073741824).toFixed(0);
  const pct = Math.round(((size - free) / size) * 100);
  return {
    ok: true,
    output: 'disque principal : ' + gb(size) + ' Go au total, ' + gb(size - free) + ' utilisés, ' + gb(free) + ' libres (' + pct + '% occupés)',
  };
}

/* ------------------------------------------------------------------ */
/* Routage des actions Windows (appelé par le serveur)                  */
/* ------------------------------------------------------------------ */

/* Mêmes actions que la branche macOS du serveur, heuristiques
   identiques (volume relatif « +10 / monte / baisse », URL nue
   préfixée…) — seule l'exécution change. opts.screenshotDir est
   fourni par le serveur (dossier des captures). */
async function routeAction(action, arg, opts) {
  const o = opts || {};
  const a = String(action || '').toLowerCase();
  const s = String(arg || '').trim().slice(0, 400);

  if (a === 'open') {
    if (!s) return { ok: false, error: 'adresse ou application manquante' };
    return open(s);
  }
  if (a === 'say') {
    if (!s) return { ok: false, error: 'texte manquant' };
    return speak(s);
  }
  if (a === 'notification') {
    if (!s) return { ok: false, error: 'texte manquant' };
    return notify(s);
  }
  if (a === 'volume') {
    /* Valeur absolue (0–100) ou relative : « +10 », « -5 », « monte », « baisse » */
    const relatif = /^\s*([+-]\s*\d{1,3}|plus|moins|monte|baisse|augmente|diminue)\s*$/i.exec(s);
    const n = parseInt(s, 10);
    if (!relatif && (isNaN(n) || n < 0 || n > 100)) return { ok: false, error: 'volume attendu entre 0 et 100' };
    if (relatif) {
      const brut = relatif[1].toLowerCase().replace(/\s/g, '');
      const pas = /^[+]\d{1,3}$/.test(brut) ? parseInt(brut.slice(1), 10)
        : /^-\d{1,3}$/.test(brut) ? -parseInt(brut.slice(1), 10)
        : /^(plus|monte|augmente)/.test(brut) ? 10 : -10;
      return volumeStep(pas);
    }
    return volumeSetAbsolute(n);
  }
  if (a === 'clipboard_set') {
    if (!s) return { ok: false, error: 'texte manquant' };
    return clipboardSet(s.slice(0, 20000));
  }
  if (a === 'brightness') {
    const n = parseInt(s, 10);
    if (isNaN(n) || n < 0 || n > 100) return { ok: false, error: 'luminosité attendue entre 0 et 100' };
    return brightness(n);
  }
  if (a === 'screenshot') {
    const dir = o.screenshotDir;
    if (!dir) return { ok: false, error: 'dossier des captures inconnu' };
    /* Le dossier doit exister, sinon la capture échoue même avec les droits. */
    try {
      require('fs').mkdirSync(dir, { recursive: true });
    } catch (_) {
      return { ok: false, error: 'impossible de créer le dossier des captures' };
    }
    const file = require('path').join(dir, 'capture-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png');
    const r = await screenshot(file);
    return r.ok
      ? { ok: true, output: 'capture enregistrée dans data/screenshots/' + require('path').basename(file) }
      : r;
  }
  return { ok: false, error: 'action inconnue' };
}

module.exports = {
  ps,
  psQuote,
  battery,
  open,
  openPath,
  speak,
  notify,
  volumeSetAbsolute,
  volumeStep,
  clipboardSet,
  clipboardGet,
  brightness,
  screenshot,
  disk,
  routeAction,
  __setRunner,
  __resetRunner,
};
