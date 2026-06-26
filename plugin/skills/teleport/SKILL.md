---
name: teleport
description: Carry a recent Claude Code conversation from another folder — or another Mac on the LAN — into this session. Use when the user says "what was I doing in <folder/project>", "carry over / bring over the conversation from <folder>", "continue what I started in <other repo>", "pull my session from <project>", "teleport the conversation from my other Mac", or otherwise wants context from a Claude session that happened somewhere else. Reads it via the RestWalker teleport MCP tools.
allowed-tools: mcp__plugin_restwalker_restwalker__teleport mcp__plugin_restwalker_restwalker__teleport_list mcp__plugin_restwalker_restwalker__teleport_folders mcp__plugin_restwalker_restwalker__teleport_peers mcp__restwalker__teleport mcp__restwalker__teleport_list mcp__restwalker__teleport_folders mcp__restwalker__teleport_peers
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

4. **Another Mac?** Call `teleport_peers` to list restwalker Macs on the LAN, then
   `teleport folder=<name> host=<peer>`. (Cross-Mac needs network teleport enabled + a shared
   token on both Macs — if no peers show up, tell the user to enable it in RestWalker Settings →
   Teleport on the other Mac.)

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
