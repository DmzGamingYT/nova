/**
 * Notarisation macOS — exécutée par electron-builder après la signature
 * (afterSign), uniquement quand des credentials Apple sont fournis.
 *
 * Utilise l'action GitHub lando/notarize-app (notarytool) :
 *   APPLE_ID          → identifiant Apple Connect (développeur individuel)
 *   APPLE_APP_SPECIFIC_PASSWORD → mot de passe spécifique à l'app
 *   APPLE_TEAM_ID     → Team ID
 *
 * En local sans ces variables, le hook ne fait rien : le build reste
 * signé ad-hoc non notarisé (clic droit → Ouvrir).
 */
'use strict';

const { execSync } = require('child_process');
const path = require('path');

exports.default = async function afterSign(context) {
  const { appOutDir, packager } = context;

  const APPLE_ID = process.env.APPLE_ID;
  const APPLE_APP_SPECIFIC_PASSWORD = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID;

  const hasCredentials = APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID;
  if (!hasCredentials) {
    console.log('[notarize] credentials Apple absents — étape ignorée (build non notarisé).');
    return;
  }

  const appName = packager.appInfo.productFilename;
  const productPath = path.join(appOutDir, `${appName}.app`);
  const bundleId = packager.appInfo.info.configuration.appId;

  console.log(`[notarize] notarisation de ${appName}.app (${bundleId})…`);
  execSync(
    [
      'npx --yes app-notarize@latest',
      `--product-path "${productPath}"`,
      `--primary-bundle-id "${bundleId}"`,
      `--appstore-connect-username "${APPLE_ID}"`,
      `--appstore-connect-password "${APPLE_APP_SPECIFIC_PASSWORD}"`,
      `--team-id "${APPLE_TEAM_ID}"`,
      '--verbose',
    ].join(' '),
    { stdio: 'inherit' }
  );
  console.log('[notarize] ✅ app notarisée et staple appliqué.');
};
