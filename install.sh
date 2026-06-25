#!/bin/bash
set -e

PLIST_SRC="$(cd "$(dirname "$0")" && pwd)/com.restwalker.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.restwalker.plist"
DATA_DIR="$HOME/.restwalker"
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
# Find a Python 3.10+ — prefer explicit PYTHON env var, then python3, then versioned binaries
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

echo "==> restwalker installer"
echo "    install dir : $INSTALL_DIR"
echo "    python      : $PYTHON"
echo "    data dir    : $DATA_DIR"
echo ""

# ── 1. Python check ───────────────────────────────────────────────────────────
if ! "$PYTHON" -c "import sys; assert sys.version_info >= (3,10)" 2>/dev/null; then
  echo "ERROR: Python 3.10+ required. Set PYTHON=/path/to/python3 to override."
  exit 1
fi

# ── 2. Dependencies ───────────────────────────────────────────────────────────
echo "==> Installing Python dependencies..."
"$PYTHON" -m pip install -q -r "$INSTALL_DIR/requirements.txt"

# ── 3. Data directory ─────────────────────────────────────────────────────────
mkdir -p "$DATA_DIR"

# ── 4. LaunchAgent plist ─────────────────────────────────────────────────────
echo "==> Installing LaunchAgent..."

# Patch plist with real python path and install dir
sed \
  -e "s|~/miniconda3/bin/python3|$PYTHON|g" \
  -e "s|~/dev/restwalker|$INSTALL_DIR|g" \
  -e "s|~/.restwalker|$DATA_DIR|g" \
  "$PLIST_SRC" > "$PLIST_DST"

# ── 5. Load ───────────────────────────────────────────────────────────────────
# Unload first in case a previous version is running
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

echo ""
echo "✓ restwalker installed and running on http://localhost:47290"
echo "  Logs: tail -f $DATA_DIR/restwalker.log"
echo "  To uninstall: ./uninstall.sh"
