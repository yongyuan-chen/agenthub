#!/usr/bin/env bash
# AgentHub node installer — the whole "add a machine" flow is:
#   curl -fsSL https://<your-domain>/install.sh | bash
# It installs whatever's missing, then prints a link; open it, log in, click
# 连接, and this machine is a node on your board (Tailscale-style). No secret
# is ever in the command: the node token is generated here and only its hash
# goes to the server. The site fills in __AGENTHUB_ORIGIN__ when serving this.
# Optional env:
#   NODE_ID     re-enroll this exact node (the repair flow)
#   USER_TOKEN  non-interactive enrollment with an account session token
#               (scripts / CI); TEAM_ID then picks the project to bind to
# No LLM relay credentials needed here — save those once in the web UI's
# "设置" page and the cloud pushes them to every node you own automatically.
set -euo pipefail

APP_URL="${APP_URL:-__AGENTHUB_ORIGIN__}"
case "$APP_URL" in http://*|https://*) ;; *) echo "[install] ERROR: set APP_URL (e.g. https://agenthub.win)" >&2; exit 1 ;; esac
USER_TOKEN="${USER_TOKEN:-}"
NODE_ID="${NODE_ID:-}"
TEAM_ID="${TEAM_ID:-}"

log()  { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[install] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# True if $1 is a `node` binary that's actually >= 22.5 — shared by the
# system check below and the cached-portable-copy check inside
# install_portable_node, so a fresh VM with nothing preinstalled needs zero
# manual steps (matching the rest of this installer's zero-friction goal).
node_ok() {
  command -v "$1" >/dev/null 2>&1 && \
    "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' 2>/dev/null
}

# Downloads the official prebuilt Node.js binary straight from nodejs.org —
# no package manager or root assumed, since this script runs on whatever a
# cloud provider's base VM image happens to ship (often nothing newer than
# an ancient distro-packaged node, or no node at all).
install_portable_node() {
  local ARCH NODE_ARCH
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64) NODE_ARCH=x64 ;;
    aarch64|arm64) NODE_ARCH=arm64 ;;
    *) fail "no portable Node.js build for CPU architecture '$ARCH' — install Node.js >= 22.5 manually (https://nodejs.org)" ;;
  esac
  local NODE_DIR="$HOME/.agenthub/node-runtime"
  if node_ok "$NODE_DIR/bin/node"; then
    log "reusing previously auto-installed node ($("$NODE_DIR/bin/node" --version))"
  else
    log "Node.js >= 22.5 not found — downloading a portable copy automatically (no root/package manager needed)..."
    local FILENAME
    FILENAME="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep "linux-${NODE_ARCH}\.tar\.xz" | awk '{print $2}')"
    [ -n "$FILENAME" ] || fail "could not determine the latest Node.js v22 build — install manually (https://nodejs.org)"
    rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
    curl -fsSL "https://nodejs.org/dist/latest-v22.x/$FILENAME" | tar -xJ -C "$NODE_DIR" --strip-components=1
    node_ok "$NODE_DIR/bin/node" || fail "portable Node.js install failed"
    log "installed $("$NODE_DIR/bin/node" --version) into $NODE_DIR"
  fi
  export PATH="$NODE_DIR/bin:$PATH"
  # The systemd service bakes an absolute path to node/claude at enrollment
  # time (see setup-node.sh), so the daemon itself never depends on this —
  # but the IDE-takeover flow (task.jsx's "已切换为 IDE 接管" instructions)
  # tells a human to run `claude --resume ...` directly in a terminal on
  # this box, which needs an ordinary login shell to find it too.
  local MARK="# agenthub: portable node/claude runtime"
  if ! grep -qF "$MARK" "$HOME/.bashrc" 2>/dev/null; then
    { echo "$MARK"; echo "export PATH=\"$NODE_DIR/bin:\$PATH\""; } >> "$HOME/.bashrc"
  fi
}

# Installs the claude CLI via the npm that ships alongside whichever node
# is now active (the portable one from install_portable_node if that ran,
# system npm otherwise). Non-fatal on failure — a node missing the CLI still
# registers and runs fine, it just can't start real sessions until it's
# there (see executor/src/config.mjs's own non-fatal handling of this same
# gap) — so this never aborts the rest of setup via set -e.
install_claude_cli() {
  log "claude CLI not found — installing via npm (npm i -g @anthropic-ai/claude-code)..."
  if npm install -g @anthropic-ai/claude-code >/dev/null 2>&1; then
    log "installed claude CLI: $(claude --version 2>/dev/null || echo ok)"
  else
    log "WARN: automatic claude CLI install failed (no writable global npm prefix?) — install manually: npm i -g @anthropic-ai/claude-code"
  fi
}

node_ok node || install_portable_node
command -v git >/dev/null || fail "git not found"
command -v claude >/dev/null || install_claude_cli

DEST="$HOME/agenthub-src"
log "downloading node package into $DEST ..."
rm -rf "$DEST" && mkdir -p "$DEST"
curl -fsSL "$APP_URL/agenthub-node.tar.gz" | tar -xz -C "$DEST"
cd "$DEST"

log "enrolling node and installing daemon..."
APP_URL="$APP_URL" USER_TOKEN="$USER_TOKEN" TEAM_ID="$TEAM_ID" \
bash deploy/setup-node.sh ${NODE_ID:+"$NODE_ID"}
