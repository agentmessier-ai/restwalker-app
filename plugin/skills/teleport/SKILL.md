---
name: teleport
description: Carry a recent Claude Code conversation from another folder — or another Mac on the LAN — into this session. Use when the user says "what was I doing in <folder/project>", "carry over / bring over the conversation from <folder>", "continue what I started in <other repo>", "pull my session from <project>", "teleport the conversation from my other Mac", or otherwise wants context from a Claude session that happened somewhere else. Reads it via the RestWalker teleport MCP tools.
allowed-tools: mcp__plugin_restwalker_restwalker__teleport mcp__plugin_restwalker_restwalker__teleport_list mcp__plugin_restwalker_restwalker__teleport_folders mcp__plugin_restwalker_restwalker__teleport_peers mcp__plugin_restwalker_restwalker__teleport_handoff mcp__restwalker__teleport mcp__restwalker__teleport_list mcp__restwalker__teleport_folders mcp__restwalker__teleport_peers mcp__restwalker__teleport_handoff Bash
---

# Teleport a conversation into this session

The user worked with Claude somewhere else — a different folder, or a different Mac — and
wants that thread *here*. Claude Code stores conversations per project folder, so it can't
carry over on its own. The RestWalker **teleport** tools fetch the raw conversation; you then
read it and continue.

## Steps

1. **Find the source.** If the user named a folder/project, use it directly. If it's vague or
   you're unsure of the exact name, call `teleport_folders` to see what's available
   (most-recent first) and pick the best match.

2. **Pick the conversation (if needed).** For "what I *just* did", `teleport folder=<name>`
   returns the most recent session in the window — usually enough. If there could be several
   relevant sessions, call `teleport_list folder=<name>` first (it returns session ids, times,
   message counts, and the first request) and choose, then pass that `session` to `teleport`.

3. **Set the window.** Default is 6h. Widen it (`window=24h`) for "earlier today / yesterday",
   narrow it (`window=1h`) for "the thing I was just on". Pass `full=true` only if you need
   untruncated tool outputs.

4. **Another Mac? — use the handoff, not a direct tool call.** macOS blocks the RestWalker
   daemon from reaching the LAN, so a plain `teleport host=<peer>` will fail with a 500. Instead:
   - Call **`teleport_handoff`** with `host=<peer ip>` (a peer the user added in Settings →
     Teleport), plus `folder`, `window`, optional `kind`/`session`. It returns a ready-to-run,
     pre-signed **`curl`** command (the daemon signs it; you never see the token).
   - **Run that `curl` with the Bash tool yourself.** Your Bash has macOS Local-Network
     permission (the daemon doesn't), so this is what actually reaches the peer. The first time,
     macOS may prompt to allow local-network access — that's expected.
   - Parse the JSON it prints (same shape as a local pull) and continue.
   - Use `kind=list` first if you need to choose a session, then `kind=conversation` with the
     full `session` id. If `curl` can't connect, the peer isn't reachable — tell the user to
     check it's on, on the same network, and added under Settings → Teleport → peer addresses.

5. **Use it.** The tool returns the raw turns (the dialogue + tool calls). Read them, summarize
   what was going on if helpful, and continue the work the user asked for — now with that context.

## Notes

- Keep windows tight: a wide window can pull a lot. Start narrow and widen only if the thread
  you want isn't there.
- If `teleport` returns an `error` with `candidates`, surface the candidate sessions and ask
  (or pick the obvious one) — don't guess silently.
- If the `mcp__…teleport*` tools aren't available, RestWalker isn't connected — tell the user to
  run `restwalker install` (or register the MCP), then stop.
- Teleport is **read-only**: it never modifies the source conversation or its files.
