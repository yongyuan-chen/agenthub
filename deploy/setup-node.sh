#!/usr/bin/env bash
# Enroll an ADDITIONAL server as an AgentHub executor node (M3 一键加机).
# Run ON the new server, from a checkout of this repo:
#   APP_URL=https://agenthub.win ACCESS_TOKEN=xxx \
#   ANTHROPIC_BASE_URL=https://relay:8081 ANTHROPIC_API_KEY=sk-... \
#   bash deploy/setup-node.sh [node-id]
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

: "${APP_URL:?set APP_URL (e.g. https://agenthub.win)}"
: "${ACCESS_TOKEN:?set ACCESS_TOKEN}"
: "${ANTHROPIC_BASE_URL:?set ANTHROPIC_BASE_URL}"
: "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY}"

NODE_ID="${1:-$(hostname -s | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/-*$//')}"
NODE_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')"
TOKEN_HASH="$(printf '%s' "$NODE_TOKEN" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(require("crypto").createHash("sha256").update(d).digest("hex")))')"

command -v claude >/dev/null || echo "WARN: claude CLI not found; install it first (npm i -g @anthropic-ai/claude-code)"

echo "[node] enrolling $NODE_ID at $APP_URL"
curl -sf -X POST "$APP_URL/api/nodes" \
  -H "authorization: Bearer $ACCESS_TOKEN" -H "content-type: application/json" \
  -d "{\"id\":\"$NODE_ID\",\"tokenHash\":\"$TOKEN_HASH\",\"labels\":[\"$(uname -s | tr '[:upper:]' '[:lower:]')\"]}" >/dev/null

mkdir -p "$HOME/.agenthub"
cat > "$HOME/.agenthub/executor.config.json" <<EOF
{
  "cloudUrl": "${APP_URL/https:/wss:}",
  "nodeId": "$NODE_ID",
  "nodeToken": "$NODE_TOKEN",
  "anthropic": {
    "baseUrl": "$ANTHROPIC_BASE_URL",
    "apiKey": "$ANTHROPIC_API_KEY",
    "model": "${ANTHROPIC_MODEL:-gpt-5.6}"
  },
  "claudeBin": "$(command -v claude || echo claude)",
  "maxParallel": 3,
  "maxCostUsd": 10,
  "workRoot": "$HOME/agenthub"
}
EOF
chmod 600 "$HOME/.agenthub/executor.config.json"

NODE_BIN="$(command -v node)"
if [ "$(uname -s)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.agenthub.executor.plist"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/agenthub/logs"
  sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__ROOT__|$ROOT|g" -e "s|__HOME__|$HOME|g" \
    deploy/com.agenthub.executor.plist.template > "$PLIST"
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
else
  sudo sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__ROOT__|$ROOT|g" -e "s|__USER__|$USER|g" \
    deploy/agenthub-executor.service > /etc/systemd/system/agenthub-executor.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now agenthub-executor
fi
echo "[node] done. node '$NODE_ID' should appear online on the board shortly."
