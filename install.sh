#!/bin/bash
set -e

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$HOME/.restwalker"
PLIST_SRC="$INSTALL_DIR/com.restwalker.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.restwalker.plist"
RUNTIME="node"  # default

# Bind address + port. Default to localhost — this service can run Bash via tasks,
# so it must not be LAN-reachable unless the operator opts in (HOST=0.0.0.0 install).
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-47290}"

# ── Parse args ────────────────────────────────────────────────────────────────
for arg in "$@"; do
  case $arg in
    --node) RUNTIME="node" ;;
    --python) RUNTIME="python" ;;
  esac
done

echo "==> restwalker installer (runtime: $RUNTIME)"
echo "    install dir : $INSTALL_DIR"
echo "    data dir    : $DATA_DIR"
echo ""

# ── Runtime: Node ─────────────────────────────────────────────────────────────
if [ "$RUNTIME" = "node" ]; then
  NODE="${NODE:-$(which node 2>/dev/null)}"
  if [ -z "$NODE" ]; then
    echo "ERROR: node not found. Install Node.js 20+ from https://nodejs.org"
    exit 1
  fi
  NODE_VER=$("$NODE" -e "process.stdout.write(process.version.slice(1).split('.')[0])")
  if [ "$NODE_VER" -lt 20 ]; then
    echo "ERROR: Node.js 20+ required (found $("$NODE" --version))"
    exit 1
  fi
  echo "    node        : $NODE ($("$NODE" --version))"
  echo ""
  echo "==> Installing Node dependencies..."
  (cd "$INSTALL_DIR/node" && npm install --quiet)

  TSX="$INSTALL_DIR/node/node_modules/.bin/tsx"

  PROGRAM_ARGS="<string>$NODE</string>
    <string>$TSX</string>
    <string>$INSTALL_DIR/node/app.ts</string>"

# ── Runtime: Python ───────────────────────────────────────────────────────────
else
  if [ -n "$PYTHON" ]; then
    : # use as-is
  elif python3 -c "import sys; assert sys.version_info >= (3,10)" 2>/dev/null; then
    PYTHON="$(which python3)"
  else
    for candidate in python3.12 python3.11 python3.10; do
      if command -v "$candidate" &>/dev/null && "$candidate" -c "import sys; assert sys.version_info >= (3,10)" 2>/dev/null; then
        PYTHON="$(which $candidate)"; break
      fi
    done
  fi
  PYTHON="${PYTHON:-python3}"

  if ! "$PYTHON" -c "import sys; assert sys.version_info >= (3,10)" 2>/dev/null; then
    echo "ERROR: Python 3.10+ required. Set PYTHON=/path/to/python3 to override."
    exit 1
  fi
  echo "    python      : $PYTHON ($("$PYTHON" --version))"
  echo ""
  echo "==> Installing Python dependencies..."
  "$PYTHON" -m pip install -q -r "$INSTALL_DIR/requirements.txt"

  PROGRAM_ARGS="<string>$PYTHON</string>
    <string>-m</string>
    <string>uvicorn</string>
    <string>app:app</string>
    <string>--host</string>
    <string>$HOST</string>
    <string>--port</string>
    <string>$PORT</string>"
fi

# ── Data directory ─────────────────────────────────────────────────────────────
mkdir -p "$DATA_DIR"

# ── LaunchAgent plist ─────────────────────────────────────────────────────────
echo "==> Installing LaunchAgent..."

# Resolve claude binary path
CLAUDE_BIN=$(which claude 2>/dev/null || echo "claude")

# Build plist with correct ProgramArguments, paths, and log locations
cat > "$PLIST_DST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.restwalker</string>
  <key>ProgramArguments</key>
  <array>
    $PROGRAM_ARGS
  </array>
  <key>WorkingDirectory</key>
  <string>$INSTALL_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_BIN</key>
    <string>$CLAUDE_BIN</string>
    <key>HOST</key>
    <string>$HOST</string>
    <key>PORT</key>
    <string>$PORT</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$DATA_DIR/restwalker.log</string>
  <key>StandardErrorPath</key>
  <string>$DATA_DIR/restwalker.log</string>
</dict>
</plist>
PLIST

# ── Load ──────────────────────────────────────────────────────────────────────
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

# ── Use it from Claude Code (plugin = MCP + skills) ───────────────────────────
# The plugin bundles the MCP server, so we don't register a standalone MCP here —
# doing both would put duplicate tools in Claude Code's menu.
echo ""
echo "── Use it from Claude Code ──────────────────────────────────────────────────"
echo ""
echo "  Add the plugin — it bundles the MCP server AND the /restwalker:* skills, so"
echo "  you can just say \"have restwalker do this tonight\". In Claude Code:"
echo ""
echo "    /plugin marketplace add agentmessier-ai/restwalker-app"
echo "    /plugin install restwalker@restwalker"
echo ""
echo "  Advanced — want the MCP without the plugin? Register it standalone instead"
echo "  (don't do both — you'd get duplicate tools):"
echo "    claude mcp add --scope user restwalker -- $NODE $TSX $INSTALL_DIR/node/mcp.ts"

SHOWN_HOST="$HOST"; [ "$HOST" = "0.0.0.0" ] && SHOWN_HOST="localhost"
echo ""
echo "✓ restwalker ($RUNTIME) → http://$SHOWN_HOST:$PORT  |  logs: tail -f $DATA_DIR/restwalker.log"
echo "  Dashboard + task queue: http://$SHOWN_HOST:$PORT  (bound $HOST)"
[ "$HOST" = "0.0.0.0" ] && echo "  ⚠ bound to 0.0.0.0 — reachable from the LAN; ensure the network is trusted (this service can run Bash)"
echo "  Change host/port: edit HOST/PORT in $PLIST_DST, then: launchctl unload \"$PLIST_DST\" && launchctl load \"$PLIST_DST\""
echo "  Or reinstall with overrides:  HOST=0.0.0.0 PORT=8080 ./install.sh"
echo "  To uninstall: ./uninstall.sh"
