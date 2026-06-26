---
name: schedule-dream-journal
description: Set up RestWalker's nightly "Dream Journal" — a daily task that reflects on the last 24h of Claude Code conversations, distills reusable skills, scans the web + GitHub trending for better practices, and writes a markdown report. Use when the user says "set up my dream journal", "schedule the nightly reflection", "have restwalker review my day", or wants a recurring self-improvement task.
allowed-tools: mcp__plugin_restwalker_restwalker__queue_add mcp__plugin_restwalker_restwalker__queue_list mcp__restwalker__queue_add mcp__restwalker__queue_list
---

# Schedule the nightly Dream Journal

Set up (or confirm) RestWalker's flagship recurring task. First check `queue_list` for an existing daily task whose description starts with "Dream Journal" — if one exists, tell the user it's already scheduled and stop (don't duplicate it).

Otherwise call `queue_add` with:
- `schedule`: `"daily"`
- `timeout_s`: `1800` (30 min — it does web search + GitHub + reads a day of transcripts)
- `description`: the prompt below, verbatim.

```
You are RestWalker's nightly "Dream Journal". Reflect on the last 24 hours of work and produce ONE markdown report. Be concise and concrete — a journal, not an essay. Work only from local files and the web; do not modify the user's projects.

PART 1 — Distill skills from today's conversations
- Find Claude Code session transcripts modified in the last 24 hours under ~/.claude/projects/ (each line of a .jsonl is one JSON message). Also skim ~/.claude/history.jsonl for recent commands.
- Spot recurring patterns: a workflow repeated, a problem solved more than once, steps worth turning into a reusable SKILL.
- For the best 1-3 candidates capture: name (kebab-case), when to use it, the steps, why it helps. If there were no meaningful conversations, say so and keep it short.

PART 2 — Best-practice + trending scan (top 1-3 candidates only)
- Use web search to check whether there's a more established way to do each. Note what's better and link the source.
- Fetch https://github.com/trending?since=monthly , read the READMEs of the few most relevant repos, and note anything concrete worth adopting.

OUTPUT
- Write the report to ~/.restwalker/dreams/dream-<YYYY-MM-DD>.md (create the dir; use `date +%F`) with sections: Distilled skills, Best-practice notes, Trending & comparisons, Action items.
- Declare it as an artifact: ARTIFACT: {"path": "<absolute path>", "description": "Nightly dream journal — distilled skills and best-practice scan"}
- Do NOT auto-install skills or edit ~/.claude/skills. Only recommend; the human decides.
```

After queuing, confirm the task id and that it runs nightly during the idle window. Mention they can read each morning's report with the task-result skill.
