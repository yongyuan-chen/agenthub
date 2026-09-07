#!/usr/bin/env bash
# Enroll an ADDITIONAL server as an AgentHub executor node (M3 一键加机).
# Run ON the new server, from a checkout of this repo:
#   APP_URL=https://agenthub.win USER_TOKEN=xxx TEAM_ID=xxx bash deploy/setup-node.sh [node-id]
# No LLM relay credentials needed here — the owning user's Settings-page
# config is pushed to this node automatically the moment it connects.
# TEAM_ID (optional) binds the node to that team at enrollment; leave unset
# for a personal node only its registering user can see/use.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

: "${APP_URL:?set APP_URL (e.g. https://agenthub.win)}"
: "${USER_TOKEN:?set USER_TOKEN (your account session token)}"
TEAM_ID="${TEAM_ID:-}"

# Includes the OS username, not just the hostname — node ids are global
# (unique across every AgentHub account, not just yours), and two different
# people each enrolling from their own account on one shared server (a
# common case: a shared GPU box) used to collide on the bare hostname with
# zero indication why (see the enrollment error handling below for how that
# used to fail silently). Different accounts on a shared box almost always
# mean different OS users too, so folding $(whoami) into the default is
# enough to avoid the collision in the common case without anyone having to
# think about it — NODE_ID is still there to override explicitly either way.
NODE_ID="${1:-$(printf '%s-%s' "$(hostname -s)" "$(whoami)" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed -e 's/-*$//' -e 's/^-*//')}"
NODE_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')"
TOKEN_HASH="$(printf '%s' "$NODE_TOKEN" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(require("crypto").createHash("sha256").update(d).digest("hex")))')"

HAS_CLAUDE=0; HAS_CODEX=0
command -v claude >/dev/null && HAS_CLAUDE=1 || echo "NOTE: claude CLI not found; this node will not run Claude Code profiles (npm i -g @anthropic-ai/claude-code)"
command -v codex >/dev/null && HAS_CODEX=1 || echo "NOTE: codex CLI not found; this node will not run Codex profiles (npm i -g @openai/codex)"
if [ "$HAS_CLAUDE" = 0 ] && [ "$HAS_CODEX" = 0 ]; then
  echo "ERROR: install at least one agent CLI (claude or codex) before setting up this node" >&2
  exit 1
fi

echo "[node] enrolling $NODE_ID at $APP_URL${TEAM_ID:+ (team $TEAM_ID)}"
# Was `curl -sf ... >/dev/null` — with `set -e` that meant any non-2xx (most
# commonly: another user already has a node with this id, since it defaults
# to the bare hostname and two accounts sharing one physical box collide on
# it) killed the script with zero output at all, right after the "enrolling"
# line — found live: a second user on an already-enrolled shared GPU box saw
# nothing but that one line and no error, no hint why. -f discards the
# response body specifically to make scripting "did this succeed" easy, at
# the cost of throwing away the one thing a human needs to see when it didn't.
ENROLL_RESP="$(curl -s -w $'\n%{http_code}' -X POST "$APP_URL/api/nodes" \
  -H "authorization: Bearer $USER_TOKEN" -H "content-type: application/json" \
  ${TEAM_ID:+-H "x-team-id: $TEAM_ID"} \
  -d "{\"id\":\"$NODE_ID\",\"tokenHash\":\"$TOKEN_HASH\",\"labels\":[\"$(uname -s | tr '[:upper:]' '[:lower:]')\"]}")"
ENROLL_HTTP_CODE="${ENROLL_RESP##*$'\n'}"
ENROLL_BODY="${ENROLL_RESP%$'\n'*}"
if [ "$ENROLL_HTTP_CODE" != "200" ]; then
  echo "[node] ERROR: enrollment failed (HTTP $ENROLL_HTTP_CODE): $ENROLL_BODY" >&2
  if [ "$ENROLL_HTTP_CODE" = "409" ]; then
    echo "[node] node id '$NODE_ID' is already taken by another account on this server (ids are global, and default to the hostname) — re-run with a unique NODE_ID, e.g.:" >&2
    echo "  NODE_ID=\"$NODE_ID-$(whoami)\" APP_URL=... USER_TOKEN=... bash deploy/setup-node.sh" >&2
  fi
  exit 1
fi

mkdir -p "$HOME/.agenthub"
cat > "$HOME/.agenthub/executor.config.json" <<EOF
{
  "cloudUrl": "${APP_URL/https:/wss:}",
  "nodeId": "$NODE_ID",
  "nodeToken": "$NODE_TOKEN",
  "provider": { "baseUrl": "", "apiKey": "", "model": "" },
  "claudeBin": "$(command -v claude || echo claude)",
  "codexBin": "$(command -v codex || echo codex)",
  "maxParallel": 3,
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
  # __HOME__ uses this script's own (correct) $HOME rather than assuming
  # /home/$USER — wrong for root, whose home is /root, not /home/root (found
  # live: a fresh root-owned VM enrolled fine but the daemon crash-looped
  # forever because systemd's env pointed at a HOME that didn't match where
  # the config file above was actually written).
  render_unit() {
    sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__ROOT__|$ROOT|g" -e "s|__USER__|$USER|g" -e "s|__HOME__|$HOME|g" \
      deploy/agenthub-executor.service
  }
  install_cron_keepalive() {
    mkdir -p "$HOME/.agenthub"
    cat > "$HOME/.agenthub/run-executor.sh" <<RUNEOF
#!/usr/bin/env bash
# AgentHub executor keepalive — fired by cron @reboot + every minute.
# flock holds for the daemon's whole lifetime so later fires exit instantly;
# the pgrep check additionally covers daemons this script didn't start
# (e.g. a systemd --user unit on a box where only linger was unavailable).
if command -v flock >/dev/null 2>&1 && [ "\${AGENTHUB_LOCKED:-}" != 1 ]; then
  AGENTHUB_LOCKED=1 exec flock -n "$HOME/.agenthub/executor.lock" "\$0"
fi
pgrep -u "\$(id -un)" -f "$ROOT/packages/executor/src/index.mjs" >/dev/null && exit 0
exec "$NODE_BIN" "$ROOT/packages/executor/src/index.mjs" >> "$HOME/.agenthub/executor.log" 2>&1
RUNEOF
    chmod +x "$HOME/.agenthub/run-executor.sh"
    # Idempotent managed entries: every line we own carries the tag, gets
    # stripped and re-added on each run. `|| true` because grep -v yields
    # exit 1 on an empty/fully-filtered crontab and pipefail would kill us.
    local CRON_TAG="# agenthub-executor-keepalive"
    { crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true
      echo "@reboot \"$HOME/.agenthub/run-executor.sh\" $CRON_TAG"
      echo "* * * * * \"$HOME/.agenthub/run-executor.sh\" $CRON_TAG"
    } | crontab -
  }
  # The daemon itself is an ordinary user process (it runs claude as you);
  # root was only ever needed to register the *supervisor*. So: prefer the
  # system-wide unit when it costs nothing (root, or passwordless sudo —
  # probed with `sudo -n` so a curl|bash install never hangs on a password
  # prompt), otherwise degrade to supervisors a plain user can own:
  #   1. systemctl --user + loginctl enable-linger (survives logout/reboot)
  #   2. crontab @reboot + a per-minute flock keepalive (boxes with no
  #      per-user systemd manager at all)
  if [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null; then
    SUDO="sudo"; [ "$(id -u)" = 0 ] && SUDO=""
    render_unit | $SUDO tee /etc/systemd/system/agenthub-executor.service >/dev/null
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable agenthub-executor
    # 'restart' (not 'start') so re-running this script on an already-installed
    # node actually picks up freshly-downloaded code — 'enable --now' is a
    # no-op on an already-active service and would silently keep the old
    # process running forever.
    $SUDO systemctl restart agenthub-executor
  elif systemctl --user show-environment >/dev/null 2>&1; then
    # A root-installed system-wide unit may already exist (an admin enrolled
    # this box before). We can't touch it without sudo, but if it was set up
    # for this same OS user it reads the very ~/.agenthub/executor.config.json
    # this run just rewrote — on its next restart it would adopt the new node
    # identity and collide with the unit we're about to install. Can't fix
    # that without root, so at least say it out loud instead of shipping a
    # silent time bomb.
    if [ "$(systemctl is-active agenthub-executor 2>/dev/null)" = "active" ]; then
      echo "[node] WARN: a system-wide agenthub-executor service is already active on this box." >&2
      echo "[node]       If it belongs to this OS user it shares the config file this install just rewrote;" >&2
      echo "[node]       have an admin remove it (sudo systemctl disable --now agenthub-executor) to avoid" >&2
      echo "[node]       two daemons claiming the same node after its next restart." >&2
    fi
    echo "[node] no sudo available — installing as a user-level systemd service (no root needed)"
    mkdir -p "$HOME/.config/systemd/user"
    # User units can't carry User= (the manager already IS this user) and
    # multi-user.target doesn't exist in the per-user manager.
    render_unit | grep -v '^User=' | sed 's|^WantedBy=multi-user.target$|WantedBy=default.target|' \
      > "$HOME/.config/systemd/user/agenthub-executor.service"
    systemctl --user daemon-reload
    systemctl --user enable agenthub-executor
    systemctl --user restart agenthub-executor
    # Without linger the per-user manager (and the daemon with it) dies when
    # the last SSH session closes. set-self-linger is polkit-allowed for a
    # user's own active session on modern systemd; if this distro still says
    # no, add a cron keepalive rather than silently shipping a node that
    # goes offline the moment the installer logs out.
    if ! loginctl enable-linger "$(id -un)" 2>/dev/null; then
      echo "[node] WARN: could not enable linger — adding a cron keepalive as a safety net"
      install_cron_keepalive
    fi
  else
    echo "[node] no sudo and no per-user systemd — installing a cron keepalive (no root needed)"
    # Kill any previous install's daemon first (mirrors the systemd branches'
    # 'restart' semantics: a re-run must pick up freshly-downloaded code, not
    # leave the old process running forever). Releasing its flock takes a
    # beat, hence the sleep before relaunching.
    if pkill -u "$(id -un)" -f "$ROOT/packages/executor/src/index.mjs" 2>/dev/null; then sleep 1; fi
    install_cron_keepalive
    # cron only fires on the next minute boundary; start it right now too.
    nohup "$HOME/.agenthub/run-executor.sh" >/dev/null 2>&1 &
  fi
fi
echo "[node] done. node '$NODE_ID' should appear online on the board shortly."
