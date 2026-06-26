---
name: queue-task
description: Defer work to RestWalker to run later during idle time. Use when the user finds something important-but-not-urgent and wants it done off-hours — e.g. "create a restwalker task to do X tonight", "queue this for later", "have restwalker run X when I'm idle", "do this overnight", "add a background task", "remind restwalker to refactor Y". Captures the work into a self-contained prompt and calls the restwalker queue_add MCP tool.
allowed-tools: mcp__restwalker__queue_add mcp__restwalker__status mcp__restwalker__list_projects
---

# Queue a RestWalker task

The user wants to hand off some work to **RestWalker** — the idle-time runner that spends spare Claude Max tokens off-hours, while they rest. You are turning a passing "we should do X later" into a concrete queued task.

## Steps

1. **Write a self-contained task description.** The agent that runs this later has **none** of the current chat's context. Bake everything it needs into the description:
   - *What* to do and the *definition of done*.
   - *Where* — the repo/path, key files, the branch.
   - Any constraints ("don't push", "open a PR", "write the report to ~/…").
   Prefer an imperative, specific prompt over a vague one.

2. **Pick the schedule** (the `schedule` arg):
   - one-off (default) → `"once"` — runs the next time the idle/usage gate opens (often tonight).
   - repeating → `"daily"` / `"weekly"` / `"hourly"` / `"monthly"`.

3. **Set a timeout if it's heavy** (`timeout_s`, seconds). The default is 600 (10 min). For web research, large refactors, or multi-file work, set 1800 (30 min) or more.

4. **Set `cwd`** to the repo path if the task is repo-specific (use `list_projects` to find recent project paths if helpful).

5. **Call `queue_add`** (the restwalker MCP tool) with `description` and the chosen `schedule` / `timeout_s` / `cwd`.

6. **Confirm** to the user: the task id, the schedule, and that it runs during the idle window when the usage gate is open (mention `status` shows when that is). Offer to check on it later with the queue-status skill.

## Notes

- Don't over-interrogate the user. Infer sensible defaults from the conversation and state what you chose ("Queued as a one-off, 30-min timeout, in ~/dev/foo — task #42").
- If the `mcp__restwalker__*` tools are **not** available, tell the user RestWalker isn't connected and to run `restwalker install` (or register the MCP), then stop.
- This only *queues* the task; it does not run it now. If the user wants it to run immediately regardless of the gate, mention `queue_force_run`.
