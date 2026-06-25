#!/bin/bash
set -e

PLIST_SRC="$(cd "$(dirname "$0")" && pwd)/com.restwalker.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.restwalker.plist"
DATA_DIR="$HOME/.restwalker"
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON="${PYTHON:-$(which python3)}"

echo "==> restwalker installer"
echo "    install dir : $INSTALL_DIR"
echo "    python      : $PYTHON"
echo "    data dir    : $DATA_DIR"
echo ""

# ── 1. Python check ───────────────────────────────────────────────────────────
if ! "$PYTHON" -c "import sys; assert sys.version_info >= (3,11)" 2>/dev/null; then
  echo "ERROR: Python 3.11+ required. Set PYTHON=/path/to/python3 to override."
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
