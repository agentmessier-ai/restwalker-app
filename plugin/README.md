# RestWalker plugin for Claude Code

Defer work to [RestWalker](https://github.com/agentmessier-ai/restwalker) — the idle-time
Claude task runner — without leaving your chat. You're coding, you spot something important
but not urgent, and you just say *"create a restwalker task to do this tonight."* The skill
writes a self-contained task and queues it via the RestWalker MCP server.

## Requires

RestWalker installed and its MCP server registered (the installer does this):

```bash
npx @agentmessier/restwalker install
```

The skills call the `restwalker` MCP tools. If RestWalker isn't connected, the skills will
tell you to install it.

## Install the plugin

```
/plugin marketplace add agentmessier-ai/restwalker
/plugin install restwalker@restwalker
```

## Skills

| Skill | Say something like | What it does |
|---|---|---|
| **`/restwalker:queue-task`** | "queue this for tonight", "have restwalker refactor X overnight" | Turns the work into a self-contained prompt and calls `queue_add`. |
| **`/restwalker:queue-status`** | "what's in my restwalker queue", "how much budget left" | `queue_stats` + `queue_list` + `status` — what's queued/running, recent results, budget, next idle window. |
| **`/restwalker:task-result`** | "what did last night's task produce", "show the dream journal" | `queue_get` + `queue_artifacts` (+ `queue_session`) — the outcome and its output files. |
| **`/restwalker:schedule-dream-journal`** | "set up my nightly dream journal" | Schedules the daily self-improvement task (distill skills + best-practice scan → report). |

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
