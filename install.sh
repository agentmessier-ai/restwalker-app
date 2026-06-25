#!/bin/bash
set -e

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$HOME/.restwalker"
PLIST_SRC="$INSTALL_DIR/com.restwalker.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.restwalker.plist"
RUNTIME="node"  # default

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
    <string>0.0.0.0</string>
    <string>--port</string>
    <string>47290</string>"
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

# ── Register MCP with Claude Code ─────────────────────────────────────────────
if command -v claude &>/dev/null; then
  echo ""
  echo "┌─ Claude Code MCP ──────────────────────────────────────────────────────────┐"
  echo "│ The restwalker MCP server lets Claude Code queue tasks, check status,      │"
  echo "│ list projects/models, and manage providers — directly from any chat,       │"
  echo "│ without opening the dashboard.                                             │"
  echo "│                                                                            │"
  echo "│ Scopes:                                                                    │"
  echo "│   user    — available in every Claude Code session on this machine         │"
  echo "│   project — available only when Claude Code is opened in a specific folder │"
  echo "└────────────────────────────────────────────────────────────────────────────┘"
  echo ""

  read -r -p "  Register restwalker MCP with Claude Code? [Y/n] " yn
  case "${yn:-Y}" in
    [Yy]*)
      echo ""
      echo "  Scope options:"
      echo "    1) user    — all sessions on this machine (recommended)"
      echo "    2) project — only in the current directory"
      echo ""
      read -r -p "  Choose scope [1/2, default 1]: " scope_choice
      case "${scope_choice:-1}" in
        2)
          MCP_SCOPE="project"
          ;;
        *)
          MCP_SCOPE="user"
          ;;
      esac

      claude mcp remove restwalker 2>/dev/null || true
      claude mcp add --scope "$MCP_SCOPE" restwalker -- "$NODE" "$TSX" "$INSTALL_DIR/node/mcp.ts"
      echo "  ✓ MCP registered (scope: $MCP_SCOPE)"
      ;;
    *)
      echo "  Skipping MCP registration."
      echo "  To add it later:"
      echo "    claude mcp add --scope user restwalker -- $NODE $TSX $INSTALL_DIR/node/mcp.ts"
      ;;
  esac
else
  echo ""
  echo "  Note: Claude Code CLI not found — skipping MCP registration."
  echo "  Install it and then run:"
  echo "    claude mcp add --scope user restwalker -- node $TSX $INSTALL_DIR/node/mcp.ts"
fi

echo ""
echo "✓ restwalker ($RUNTIME) → http://localhost:47290  |  logs: tail -f $DATA_DIR/restwalker.log"
echo "  Dashboard + task queue: http://localhost:47290"
echo "  To uninstall: ./uninstall.sh"
