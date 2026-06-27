---
name: teleport
description: Carry a recent Claude Code conversation from another folder — or another Mac on the LAN — into this session. Use when the user says "what was I doing in <folder/project>", "carry over / bring over the conversation from <folder>", "continue what I started in <other repo>", "pull my session from <project>", "teleport the conversation from my other Mac", or otherwise wants context from a Claude session that happened somewhere else.
allowed-tools: mcp__plugin_restwalker_restwalker__teleport mcp__plugin_restwalker_restwalker__teleport_list mcp__plugin_restwalker_restwalker__teleport_folders mcp__restwalker__teleport mcp__restwalker__teleport_list mcp__restwalker__teleport_folders Bash
---

# Teleport a conversation into this session

The user worked with Claude somewhere else — a different folder, or a different Mac — and
wants that thread *here*. How you do it depends on **where** it is.

## Same Mac, different folder → use the MCP tools (no Bash)

1. `teleport_folders` — list teleportable folders (if you're unsure of the exact name).
2. `teleport_list folder=<name>` — see candidate sessions (pick one if there are several).
3. `teleport folder=<name>` (optionally `session=<id>`, `window=6h`) — returns the raw turns.
   Read them and continue.

Local is the common case and needs nothing else.

## Another Mac on the LAN → do it with **Bash** (not the teleport host= tools)

macOS blocks the RestWalker daemon from reaching the LAN, but **your Bash tool can** — so
discover and pull the peer yourself with `curl`. There is no pairing/config to set up on this
machine; the peer just needs RestWalker running with **"Advertise on LAN"** on and bound to
`0.0.0.0`.

### Step 1 — get the peer's address

- **If the user gave an IP/host**, use it (default port **47290**). Confirm it's RestWalker:
  ```bash
  curl -s --max-time 2 http://<ip>:47290/teleport/ping     # expect {"service":"restwalker",...}
  ```
- **Otherwise discover it** — a **time-boxed scan of your own /24 only**:
  ```bash
  SUBNET=$(curl -s http://localhost:47290/teleport/local-net | sed -n 's/.*"prefixes":\["\([0-9.]*\)".*/\1/p')
  [ -z "$SUBNET" ] && SUBNET=$(ipconfig getifaddr en0 | cut -d. -f1-3)
  PORT=47290
  seq 1 254 | xargs -P 60 -I{} sh -c '
    curl -s --max-time 1 "http://'"$SUBNET"'.{}:'"$PORT"'/teleport/ping" 2>/dev/null \
      | grep -q "\"service\":\"restwalker\"" && echo "'"$SUBNET"'.{}"'
  ```
  **This is the time box and you must keep it:** scan **only the single /24**, `--max-time 1`
  per host, 60 in parallel → it finishes in a few seconds. **Never widen the range (no /16, no
  multiple subnets) and never raise `--max-time`** — a large or slow LAN must not be allowed to
  hang the scan. If nothing comes back quickly, stop and tell the user no peer was found.

### Step 2 — pull the conversation directly

```bash
# list sessions to choose one (optional):
curl -s --max-time 6 'http://<ip>:47290/teleport/list?folder=<name>&window=6h'
# pull the raw conversation (most recent in window, or a specific session):
curl -s --max-time 15 'http://<ip>:47290/teleport/conversation?folder=<name>&window=6h'
# or with a chosen full session id: ...&session=<uuid>
```
Parse the JSON (`turns[]` = the dialogue + tool calls), read it, and continue the user's work.

### If it can't connect

- `curl` returns nothing / times out: the peer isn't reachable. Tell the user to make sure the
  other Mac is **on and on the same network**, and that RestWalker there has **Settings →
  Teleport → "Advertise on LAN"** on with the daemon bound to `0.0.0.0`.
- If even a *known-good* peer times out from your Bash, your terminal/Claude Code may lack macOS
  **Local Network** permission — grant it in System Settings → Privacy & Security → Local Network.

## Notes

- Teleport is **read-only** — it never modifies the source conversation or its files.
- Default trusted-LAN setup uses **no token** (open to your LAN, guarded to private IPs). If both
  Macs are configured with a shared `TELEPORT_TOKEN` ("secure mode"), use the `teleport_handoff`
  tool instead so the daemon signs the request — but that's opt-in, not the default.
- Windows: `1h` for "just now", `6h` (default) for "today", `24h` for "earlier".
