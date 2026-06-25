#!/bin/bash
set -e

PLIST_DST="$HOME/Library/LaunchAgents/com.restwalker.plist"
DATA_DIR="$HOME/.restwalker"

echo "==> Uninstalling restwalker..."

# ── 1. Stop and remove LaunchAgent ───────────────────────────────────────────
if [ -f "$PLIST_DST" ]; then
  launchctl unload "$PLIST_DST" 2>/dev/null || true
  rm "$PLIST_DST"
  echo "    removed LaunchAgent"
else
  echo "    LaunchAgent not found (already removed?)"
fi

# ── 2. Data directory ─────────────────────────────────────────────────────────
if [ -d "$DATA_DIR" ]; then
  read -r -p "Delete data directory $DATA_DIR (DB + logs)? [y/N] " confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    rm -rf "$DATA_DIR"
    echo "    removed $DATA_DIR"
  else
    echo "    kept $DATA_DIR"
  fi
fi

echo ""
echo "✓ restwalker uninstalled."
echo "  The app directory was not removed — delete it manually if you want:"
echo "  rm -rf $(cd "$(dirname "$0")" && pwd)"
