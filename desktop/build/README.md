# Signature, notarisation et mises à jour automatiques

Deux modes de build, pilotés uniquement par l'environnement — le code et la
config ne changent jamais entre les deux.

## 🔓 Mode local / CI sans secrets (par défaut)

```bash
cd desktop
npm run dist        # CSC_IDENTITY_AUTO_DISCOVERY=false
```

- aucune identité Apple requise : bundle **ad-hoc** non signé, non notarisé
- premier lancement : **clic droit → Ouvrir** (Gatekeeper)
- pas d'auto-mise à jour (electron-updater reste silencieux, aucune erreur visible)

C'est le mode utilisé par la CI sur les push et les PR sans secrets.

## 🔐 Mode signé + notarisé (CI avec secrets, tags `v*`)

La CI détecte le secret `CSC_NAME` :

1. importe le certificat `.p12` (`MACOS_CERTIFICATE` + `MACOS_CERTIFICATE_PWD`)
   dans un trousseau éphémère
2. **codesign** avec `CSC_NAME`, hardened runtime + entitlements
   (`build/entitlements.mac.plist` : micro, AppleScript, JIT)
3. **notarisation** via `build/notarize.js` (Apple ID + mot de passe d'app +
   Team ID), puis *staple*
4. `--publish always` : publie DMG + ZIP + `latest-mac.yml` sur un **brouillon
   de release** GitHub — publie le brouillon depuis l'onglet *Releases* pour
   livrer la mise à jour à toutes les apps installées

### Secrets GitHub à créer (Settings → Secrets → Actions)

| Secret | Contenu | Comment l'obtenir |
|---|---|---|
| `CSC_NAME` | `Developer ID Application: Prénom Nom (TEAMID)` | `security find-identity -v -p codesigning` après import du certificat |
| `MACOS_CERTIFICATE` | certificat `.p12` **encodé base64** | `base64 -i Certificates.p12 \| pbcopy` |
| `MACOS_CERTIFICATE_PWD` | mot de passe du `.p12` | choisi à l'export de Keychain |
| `APPLE_ID` | identifiant Apple Connect | compte développeur ($99/an) |
| `APPLE_APP_SPECIFIC_PASSWORD` | mot de passe spécifique à l'app | appleid.apple.com → Connexion et sécurité |
| `APPLE_TEAM_ID` | Team ID (10 caractères) | developer.apple.com → Membership |

> ⚠️ Un build **non signé ne peut pas s'auto-mettre à jour** : Squirrel.mac
> exige une signature valide pour remplacer l'app sur le disque. C'est
> volontairement limité aux builds signés.

## ♻️ Côté app (electron-updater)

`desktop/main.js` :

- vérifie les mises à jour au lancement + toutes les 6 h
- télécharge en arrière-plan, installe à la prochaine relance
- notification macOS quand une version est prête (clic = relancer)
- état visible dans le menu de la **barre de menus**
  (« Nova est à jour ✓ », « Redémarrer pour installer… »)

## 🧪 Vérification locale

```bash
codesign -dv --verbose=2 desktop/release/mac-arm64/Nova.app
spctl -a -t exec -vv desktop/release/mac-arm64/Nova.app   # "rejected" = normal (ad-hoc)
xcrun stapler validate desktop/release/mac-arm64/Nova.app # après notarisation
```
