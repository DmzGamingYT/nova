/**
 * afterAllArtifactBuild — vérification de signature (CI signée seulement).
 *
 * Si une identité Developer ID a signé le bundle (CSC_NAME défini), on
 * vérifie chaque artefact (.app / .dmg) avec `codesign --verify --deep
 * --strict` : toute corruption pendant l'empaquetage fait échouer le build.
 * Les ZIP sont sautés (codesign ne les vérifie pas directement).
 *
 * Sans CSC_NAME (build ad-hoc local), le hook ne fait rien.
 */
'use strict';

const { execFileSync } = require('child_process');

exports.default = async function afterAllArtifactBuild(context) {
  const identity = process.env.CSC_NAME;
  if (!identity) return true;

  const artifacts = (context.outPaths || []).filter((p) =>
    /\.(app|dmg)$/i.test(p)
  );

  for (const artifact of artifacts) {
    try {
      console.log(`[verify-signature] ${artifact}`);
      execFileSync(
        'codesign',
        ['--verify', '--deep', '--strict', '--verbose=2', artifact],
        { stdio: 'inherit' }
      );
      console.log(`[verify-signature] ✅ ${artifact}`);
    } catch (err) {
      console.error(`[verify-signature] ❌ signature invalide : ${artifact}`);
      throw err;
    }
  }

  return true;
};
