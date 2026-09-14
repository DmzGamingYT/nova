#!/usr/bin/env bash
# ============================================================
# Nova — préparation d'une release GitHub
#
#   ./tools/gen-release-notes.sh <tag> <dossier-artefacts>
#
# Génère dans <dossier-artefacts> :
#   • SHA256SUMS.txt    checksums des .dmg / .zip construits
#   • release-notes.md  changelog depuis le tag précédent + checksums
#
# Requiert un checkout COMPLET (fetch-depth: 0 + fetch-tags)
# pour retrouver le tag précédent via git describe.
# ============================================================
set -euo pipefail

TAG="${1:?usage: gen-release-notes.sh <tag> <artifacts-dir>}"
DIR="${2:?usage: gen-release-notes.sh <tag> <artifacts-dir>}"

cd "$(git rev-parse --show-toplevel)"

# ── 1. Checksums SHA-256 ───────────────────────────────────────────────
ARTIFACTS=()
for f in "$DIR"/*.dmg "$DIR"/*.zip; do
  [ -f "$f" ] && ARTIFACTS+=("$f")
done
if [ "${#ARTIFACTS[@]}" -eq 0 ]; then
  echo "gen-release-notes: aucun artefact .dmg/.zip dans $DIR" >&2
  exit 1
fi

SUMS="$DIR/SHA256SUMS.txt"
: > "$SUMS"
for f in "${ARTIFACTS[@]}"; do
  ( cd "$DIR" && shasum -a 256 "$(basename "$f")" ) >> "$SUMS"
done

# ── 2. Changelog depuis le tag précédent ───────────────────────────────
PREV="$(git describe --tags --abbrev=0 "$TAG^" 2>/dev/null || true)"
if [ -n "$PREV" ]; then
  RANGE="$PREV..$TAG"
  HEADER="## Quoi de neuf depuis $PREV"
else
  RANGE="$TAG"
  HEADER="## Première version publiée"
fi

CHANGES="$(git log --no-merges --date=format:'%d/%m/%Y' \
             --pretty='- %s (%ad)' "$RANGE" 2>/dev/null || true)"
# dédoublonne (le run de main et celui du tag répètent les mêmes commits)
CHANGES="$(printf '%s\n' "$CHANGES" | awk '!seen[$0]++' || true)"
# retire le bruit de CI
CHANGES="$(printf '%s\n' "$CHANGES" \
  | grep -viE '^(- )?(chore\(release\)?|bump version|merge (pull request|branch))' \
  | sed '/^$/d' || true)"
if [ -z "$CHANGES" ]; then
  CHANGES="- Voir l'historique des commits sur GitHub"
fi

# ── 3. Tableau des fichiers + note selon le mode de signature ──────────
# Le ZIP n'est joint à la release que par le chemin signé (electron-builder
# --publish) ; en build ad-hoc il reste disponible dans les artefacts CI.
TABLE=""
for f in "$DIR"/*.dmg; do
  [ -f "$f" ] && TABLE+="| \`$(basename "$f")\` | Installation (glisser Nova dans Applications) |"$'\n'
done
if [ "${NOVA_SIGNED:-}" = "true" ]; then
  for f in "$DIR"/*.zip; do
    [ -f "$f" ] && TABLE+="| \`$(basename "$f")\` | Mise à jour automatique (electron-updater) |"$'\n'
  done
fi

if [ "${NOVA_SIGNED:-}" = "true" ]; then
  NOTE="Build **signé et notarisé** : l'app se met à jour automatiquement."
else
  NOTE="Build **non signé** : au premier lancement, clic droit → **Ouvrir**."
fi

# ── 4. Notes markdown ─────────────────────────────────────────────────
cat > "$DIR/release-notes.md" <<EOF
$HEADER

$CHANGES

## Téléchargements

| Fichier | Usage |
|---|---|
$TABLE
### Checksums SHA-256

Vérifie ton téléchargement :

\`\`\`
$(cat "$SUMS")
\`\`\`

> $NOTE
EOF

echo "── SHA256SUMS.txt ──"
cat "$SUMS"
echo "── release-notes.md ──"
cat "$DIR/release-notes.md"
