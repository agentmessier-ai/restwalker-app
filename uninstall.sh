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

# ── 2. Standalone MCP registration (best-effort) ──────────────────────────────
# Older installs auto-registered a 'restwalker' MCP with Claude Code; remove it so
# no dangling entry is left pointing at deleted code. (The bundled plugin is
# managed by Claude Code — see the reminder below.)
if command -v claude &>/dev/null && claude mcp remove restwalker 2>/dev/null; then
  echo "    removed standalone MCP registration"
fi

# ── 3. Data directory (kept by default — your DB, logs, and task artifacts) ────
if [ -d "$DATA_DIR" ]; then
  if [ -t 0 ]; then
    read -r -p "Delete data directory $DATA_DIR (DB, logs, task workspace/artifacts)? [y/N] " confirm
  else
    confirm="N"
  fi
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    rm -rf "$DATA_DIR"
    echo "    removed $DATA_DIR"
  else
    echo "    kept $DATA_DIR (delete later with: rm -rf $DATA_DIR)"
  fi
fi

echo ""
echo "✓ restwalker uninstalled."
echo "  • If you added the Claude Code plugin, remove it there:  /plugin uninstall restwalker@restwalker"
echo "  • The app directory was not removed — delete it manually if you want:"
echo "      rm -rf $(cd "$(dirname "$0")" && pwd)"
