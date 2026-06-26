---
name: status
description: Check RestWalker — what's queued or running, recent results, usage budget, and the next idle window. Use when the user asks "restwalker status", "what's in my restwalker queue", "check restwalker", "what tasks do I have", "how much budget / usage is left", "when's the next idle window", or wants to see pending / running / done / failed tasks.
allowed-tools: mcp__plugin_restwalker_restwalker__status mcp__plugin_restwalker_restwalker__queue_stats mcp__plugin_restwalker_restwalker__queue_list mcp__plugin_restwalker_restwalker__can_run mcp__restwalker__status mcp__restwalker__queue_stats mcp__restwalker__queue_list mcp__restwalker__can_run
---

# RestWalker status

Give the user a quick read on their idle-time task runner using the restwalker MCP tools.

## Steps

1. `queue_stats` — counts by status (scheduled / pending / running / done / failed).
2. `queue_list` — the most recent tasks (newest first) so you can name what's queued or running.
3. `status` — usage %, whether the gate is open or closed right now, and when the next idle/coding window opens. (`can_run` is a quick open/closed check.)

## Report

Summarize concisely:
- **Now**: is anything running? is the gate open or closed, and if closed, when does it open?
- **Queued**: what's pending/scheduled (task ids + one-line descriptions).
- **Recent**: last finished task(s) and whether they succeeded — point failures out plainly.
- **Budget**: 5-hour and weekly usage %, and how close to the pause/stop thresholds.

If a task failed, surface its short result/error and suggest the next action (e.g. raise `timeout_s` if it timed out). Offer the task-result skill to dig into a specific task.
