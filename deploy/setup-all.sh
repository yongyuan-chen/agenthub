#!/usr/bin/env bash
# AgentHub one-command setup:
#   1. deploy Cloudflare worker (API + Hub DO + D1 + frontend assets)
#   2. enroll this machine as an executor node
#   3. install + start the executor daemon (launchd on macOS, systemd on Linux)
#
# Usage:  bash deploy/setup-all.sh
# Requires: node >= 22, git, network access to api.cloudflare.com & registry.npmjs.org
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ENV_FILE="$ROOT/deploy/.env"

log()  { printf '\033[1;36m[setup]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[setup] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || fail "deploy/.env not found"
set -a; source "$ENV_FILE"; set +a

command -v node >/dev/null || fail "node not found"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' \
  || fail "need node >= 22.5 (executor uses node:sqlite)"

# first run: version the repo (kept out of the restricted build sandbox)
if [ ! -d .git ]; then
  git init -q
  git add -A
  git -c user.name="agenthub" -c user.email="agenthub@local" commit -q -m "AgentHub v0.1 initial commit" || true
  log "git repository initialized"
fi

# ---------- 0. generate missing secrets and persist them into .env ----------
save_env() { # save_env KEY VALUE
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed "s|^${key}=.*|${key}=${val}|" "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

if [ -z "${ADMIN_USERNAME:-}" ]; then
  ADMIN_USERNAME="admin"
  save_env ADMIN_USERNAME "$ADMIN_USERNAME"
fi
if [ -z "${ADMIN_PASSWORD:-}" ]; then
  ADMIN_PASSWORD="$(node -e 'console.log(require("crypto").randomBytes(18).toString("base64url"))')"
  save_env ADMIN_PASSWORD "$ADMIN_PASSWORD"
  log "generated admin account '$ADMIN_USERNAME'"
fi
if [ -z "${NODE_ID:-}" ]; then
  NODE_ID="$(hostname -s | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/-*$//')"
  save_env NODE_ID "$NODE_ID"
fi
if [ -z "${NODE_TOKEN:-}" ]; then
  NODE_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')"
  save_env NODE_TOKEN "$NODE_TOKEN"
  log "generated NODE_TOKEN for node '$NODE_ID'"
fi
if [ -z "${VAPID_JSON:-}" ]; then
  VAPID_JSON="$(node deploy/gen-vapid.mjs | base64 | tr -d '\n')"
  save_env VAPID_JSON "$VAPID_JSON"
  log "generated VAPID keypair"
fi
VAPID_PUBLIC_KEY="$(echo "$VAPID_JSON" | base64 -d | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).publicKey))')"
VAPID_PRIVATE_JWK="$(echo "$VAPID_JSON" | base64 -d | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.stringify(JSON.parse(d).privateJwk)))')"

export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
WRANGLER="npx --yes wrangler@4"

# ---------- 1. build frontend ----------
log "building web frontend..."
cd "$ROOT/packages/web"
if [ ! -d node_modules/esbuild ]; then
  npm install --no-audit --no-fund || npm run install:offline || fail "web deps install failed"
fi
node build.mjs
cd "$ROOT"

# ---------- 2. D1 database ----------
log "ensuring D1 database..."
cd "$ROOT/packages/worker"
D1_ID="$($WRANGLER d1 list --json 2>/dev/null | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  try { const dbs=JSON.parse(d); const hit=dbs.find(x=>x.name==="agenthub"); console.log(hit?hit.uuid:""); }
  catch { console.log(""); }
})')"
if [ -z "$D1_ID" ]; then
  log "creating D1 database 'agenthub'..."
  $WRANGLER d1 create agenthub >/dev/null
  D1_ID="$($WRANGLER d1 list --json | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  const hit=JSON.parse(d).find(x=>x.name==="agenthub"); console.log(hit?hit.uuid:"");
})')"
fi
[ -n "$D1_ID" ] || fail "could not create/find D1 database"
log "D1 id: $D1_ID"
node "$ROOT/deploy/patch-wrangler-config.mjs" "$D1_ID"

log "applying D1 schema..."
$WRANGLER d1 execute agenthub --remote --file schema.sql -y --config wrangler.generated.jsonc

# ---------- 3. deploy worker (custom domain, fallback to workers.dev) ----------
log "deploying worker with custom domain $CUSTOM_DOMAIN ..."
APP_URL="https://$CUSTOM_DOMAIN"
if ! $WRANGLER deploy --config wrangler.generated.jsonc; then
  log "custom-domain deploy failed (token may lack zone permissions); retrying on workers.dev"
  node "$ROOT/deploy/patch-wrangler-config.mjs" "$D1_ID" --no-routes
  OUT="$($WRANGLER deploy --config wrangler.generated.jsonc 2>&1 | tee /dev/stderr)"
  APP_URL="$(echo "$OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)"
  [ -n "$APP_URL" ] || fail "deploy failed entirely"
fi

# ---------- 4. secrets (must come after first deploy; take effect immediately) ----------
log "pushing worker secrets..."
printf '%s' "$VAPID_PUBLIC_KEY"  | $WRANGLER secret put VAPID_PUBLIC_KEY  --config wrangler.generated.jsonc >/dev/null
printf '%s' "$VAPID_PRIVATE_JWK" | $WRANGLER secret put VAPID_PRIVATE_KEY --config wrangler.generated.jsonc >/dev/null
printf 'mailto:admin@%s' "${CUSTOM_DOMAIN#*.}" | $WRANGLER secret put VAPID_SUBJECT --config wrangler.generated.jsonc >/dev/null
cd "$ROOT"

log "waiting for worker health..."
for i in $(seq 1 20); do
  if curl -sf "$APP_URL/api/health" >/dev/null; then break; fi
  sleep 3
  [ "$i" = 20 ] && fail "worker health check failed at $APP_URL"
done
log "worker is live: $APP_URL"

# ---------- 5. bootstrap the admin account ----------
log "bootstrapping admin account '$ADMIN_USERNAME'..."
REG_JSON="$(curl -sf -X POST "$APP_URL/api/register" -H "content-type: application/json" \
  -d "{\"username\":\"$ADMIN_USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}" || true)"
USER_TOKEN="$(printf '%s' "$REG_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(j.token||"")}catch{console.log("")}})')"
if [ -z "$USER_TOKEN" ]; then
  # already bootstrapped on a prior run (username taken) -> log in instead
  LOGIN_JSON="$(curl -sf -X POST "$APP_URL/api/login" -H "content-type: application/json" \
    -d "{\"username\":\"$ADMIN_USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}")"
  USER_TOKEN="$(printf '%s' "$LOGIN_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).token))')"
fi
[ -n "$USER_TOKEN" ] || fail "could not bootstrap or log into admin account"

# ---------- 6. enroll this node ----------
log "enrolling node '$NODE_ID'..."
TOKEN_HASH="$(printf '%s' "$NODE_TOKEN" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(require("crypto").createHash("sha256").update(d).digest("hex")))')"
curl -sf -X POST "$APP_URL/api/nodes" \
  -H "authorization: Bearer $USER_TOKEN" -H "content-type: application/json" \
  -d "{\"id\":\"$NODE_ID\",\"tokenHash\":\"$TOKEN_HASH\",\"labels\":[\"$(uname -s | tr '[:upper:]' '[:lower:]')\"]}" >/dev/null \
  || fail "node enrollment API call failed"

# ---------- 7. executor config ----------
log "writing executor config..."
mkdir -p "$HOME/.agenthub"
WS_URL="${APP_URL/https:/wss:}"
cat > "$HOME/.agenthub/executor.config.json" <<EOF
{
  "cloudUrl": "$WS_URL",
  "nodeId": "$NODE_ID",
  "nodeToken": "$NODE_TOKEN",
  "anthropic": { "baseUrl": "", "apiKey": "", "model": "" },
  "claudeBin": "$(command -v claude || echo claude)",
  "maxParallel": 3,
  "workRoot": "$HOME/agenthub"
}
EOF
chmod 600 "$HOME/.agenthub/executor.config.json"

# ---------- 8. install + start daemon ----------
NODE_BIN="$(command -v node)"
if [ "$(uname -s)" = "Darwin" ]; then
  log "installing launchd agent..."
  PLIST="$HOME/Library/LaunchAgents/com.agenthub.executor.plist"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/agenthub/logs"
  sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__ROOT__|$ROOT|g" -e "s|__HOME__|$HOME|g" \
    deploy/com.agenthub.executor.plist.template > "$PLIST"
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  log "executor daemon started (launchd: com.agenthub.executor)"
else
  log "installing systemd service..."
  sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__ROOT__|$ROOT|g" -e "s|__USER__|$USER|g" \
    deploy/agenthub-executor.service | sudo tee /etc/systemd/system/agenthub-executor.service >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable agenthub-executor
  # 'restart' (not 'start') so re-running this script on an already-installed
  # node actually picks up freshly-downloaded code.
  sudo systemctl restart agenthub-executor
fi

# ---------- 9. verify node online ----------
log "waiting for node to come online..."
for i in $(seq 1 15); do
  ONLINE="$(curl -sf "$APP_URL/api/nodes" -H "authorization: Bearer $USER_TOKEN" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  try{ const n=JSON.parse(d).nodes.find(x=>x.id===process.argv[1]); console.log(n&&n.status==="online"?"yes":"no"); }
  catch{ console.log("no"); }
})' "$NODE_ID")"
  [ "$ONLINE" = "yes" ] && break
  sleep 2
done
if [ "$ONLINE" = "yes" ]; then
  log "node '$NODE_ID' is ONLINE ✔"
else
  log "node not online yet — check logs: tail -f ~/agenthub/logs/executor.log"
fi

echo
echo "=============================================="
echo "  🎉 AgentHub 部署完成"
echo "  访问地址:   $APP_URL"
echo "  管理员账号: $ADMIN_USERNAME"
echo "  管理员密码: $ADMIN_PASSWORD"
echo "  执行节点:   $NODE_ID"
echo "  首次登录后请到「设置」里保存一次模型中转站 Base URL / API Key,"
echo "  节点会自动同步,以后新增节点无需再填写任何信息。"
echo "  (手机打开地址登录;建议'添加到主屏幕'并开启推送)"
echo "=============================================="
