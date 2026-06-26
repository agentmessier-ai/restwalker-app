# RestWalker plugin for Claude Code

Defer work to [RestWalker](https://github.com/agentmessier-ai/restwalker-app) — the idle-time
Claude task runner — without leaving your chat. You're coding, you spot something important
but not urgent, and you just say *"create a restwalker task to do this tonight."* The skill
writes a self-contained task and queues it via the RestWalker MCP server.

## Requires

The plugin **bundles the RestWalker MCP server** (it declares `restwalker mcp` in
`mcpServers`), so installing the plugin wires up the tools automatically — but it needs the
`restwalker` CLI on your PATH and the daemon set up:

```bash
npm install -g @agentmessier/restwalker   # puts `restwalker` on PATH
restwalker install                         # daemon (LaunchAgent) + node deps
```

After that the plugin's MCP server (`restwalker mcp`) starts on its own when the plugin is
enabled. If RestWalker isn't connected, the skills will tell you.

> Already registered the MCP standalone (via `claude mcp add`, which `restwalker install`
> also offers)? That works too — the skills accept both the plugin-bundled and standalone
> tool names. Pick one to avoid duplicate tools in the menu.

## Install the plugin

```
/plugin marketplace add agentmessier-ai/restwalker-app
/plugin install restwalker@restwalker
```

## Skills

| Skill | Say something like | What it does |
|---|---|---|
| **`/restwalker:defer`** | "do this tonight", "defer this", "have restwalker refactor X overnight" | Turns the work into a self-contained prompt and calls `queue_add`. |
| **`/restwalker:status`** | "restwalker status", "what's in my queue", "how much budget left" | `queue_stats` + `queue_list` + `status` — what's queued/running, recent results, budget, next idle window. |
| **`/restwalker:result`** | "what did last night's task produce", "show the dream journal" | `queue_get` + `queue_artifacts` (+ `queue_session`) — the outcome and its output files. |
| **`/restwalker:dream-journal`** | "set up my nightly dream journal" | Schedules the daily self-improvement task (distill skills + best-practice scan → report). |

All four auto-trigger from natural language (no need to type the `/` form) — the descriptions
are written so Claude picks the right one from how you phrase it.

## Other skills we may add

- **`cancel-task`** — "cancel restwalker task 12" → `queue_cancel`.
- **`run-now`** — "run that task now, don't wait for tonight" → `queue_force_run`.
- **`capture-followup`** — lightweight "remember to do X later" that becomes a one-off task,
  optimized for quick capture mid-flow with minimal back-and-forth.
- **`promote-skill`** — take a Dream Journal recommendation and scaffold it as a real
  `~/.claude/skills/<name>/SKILL.md` (the human-in-the-loop step the journal deliberately leaves out).
- **`tune-budget`** — "pause restwalker if weekly usage passes 80%" → `update_settings`.
