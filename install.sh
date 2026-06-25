#!/bin/bash
set -e

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$HOME/.restwalker"
PLIST_SRC="$INSTALL_DIR/com.restwalker.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.restwalker.plist"
RUNTIME="python"  # default

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
  (cd "$INSTALL_DIR/node" && npm install --omit=dev --quiet)

  PROGRAM_ARGS="<string>$NODE</string>
    <string>$INSTALL_DIR/node/app.js</string>"

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

echo ""
echo "✓ restwalker ($RUNTIME) installed and running on http://localhost:47290"
echo "  Logs: tail -f $DATA_DIR/restwalker.log"
echo "  To uninstall: ./uninstall.sh"
