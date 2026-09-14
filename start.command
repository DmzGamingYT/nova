#!/bin/bash
# ✦ Nova — lanceur macOS (double-clic)
cd "$(dirname "$0")"

# Port : variable d'environnement, sinon .env, sinon 8787
PORT_NUM="${PORT:-}"
if [ -z "$PORT_NUM" ] && [ -f .env ]; then
  PORT_NUM=$(grep -E '^\s*PORT\s*=' .env | tail -1 | cut -d= -f2 | tr -d ' "')
fi
PORT_NUM="${PORT_NUM:-8787}"

echo "✦ Démarrage de Nova…"

# Lancer le serveur en arrière-plan
node server.js &
SERVER_PID=$!

# Attendre que le port réponde, puis ouvrir le navigateur
for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://localhost:${PORT_NUM}/api/status"; then
    open "http://localhost:${PORT_NUM}"
    break
  fi
  sleep 0.3
done

echo "✦ Nova tourne sur http://localhost:${PORT_NUM}  (Ctrl+C pour arrêter)"
wait $SERVER_PID
