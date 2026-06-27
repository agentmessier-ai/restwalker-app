---
name: result
description: Review what a RestWalker task produced. Use when the user asks "what did my restwalker task do", "show the result of task N", "did last night's task finish", "show the dream journal", "what artifacts did it create", or wants a completed task's output, files, or transcript.
allowed-tools: mcp__plugin_restwalker_restwalker__queue_get mcp__plugin_restwalker_restwalker__queue_artifacts mcp__plugin_restwalker_restwalker__queue_session mcp__plugin_restwalker_restwalker__queue_list mcp__restwalker__queue_get mcp__restwalker__queue_artifacts mcp__restwalker__queue_session mcp__restwalker__queue_list
---

# Review a RestWalker task result

The user wants the outcome of a task RestWalker ran. Use the restwalker MCP tools.

## Steps

1. **Identify the task.** If the user gave an id, use it. Otherwise `queue_list` and pick the most relevant recent task (by description / recency).
2. `queue_get <id>` — status, result (truncated), tokens, tool calls, workspace path.
3. `queue_artifacts <id>` — files the task declared as outputs (path + type). These are the deliverables; surface their paths so the user can open them.
4. Only if they want detail: `queue_session <id>` — the full transcript (thinking, tool calls, results).

## Report

- State the outcome first: done / failed, when, how long, tokens used.
- If there are **artifacts**, list them with paths (e.g. the dream journal markdown) and offer to read/summarize one.
- If it **failed**, quote the error and suggest the fix (timeouts → raise `timeout_s`; missing tool/permission → note it).
- Keep it tight; expand only on request.
