# Example recurring task — "Dream Journal"

A nightly self-improvement task. While you sleep, restwalker reflects on the day's
Claude Code conversations, distills reusable **skills**, and scans the web + GitHub
trending for better ways to do what you're already doing — then writes one markdown
report you can read over coffee.

It's the canonical reference for a *good* recurring task: it reads local context,
uses tools (Bash, WebSearch/WebFetch, Write), produces a single artifact, and recurs
daily during your idle window so it only spends tokens you weren't using anyway.

- **Schedule:** `daily`
- **Tools used:** Bash, WebSearch, WebFetch, Write
- **Output:** `~/.restwalker/dreams/dream-YYYY-MM-DD.md`, declared as an artifact
- **Timeout:** `1800000` (30 min) — web search + GitHub + reading a day of transcripts
  blows past the default 10-minute task timeout, so this task sets its own `timeout_ms`

---

## Schedule it

Via REST API:

```bash
curl -s -X POST http://127.0.0.1:47290/queue \
  -H 'Content-Type: application/json' \
  -d @- <<'JSON'
{
  "description": "<paste the PROMPT block below>",
  "schedule": "daily",
  "timeout_ms": 1800000
}
JSON
```

Via the MCP tool from any Claude Code chat:

```
Use queue_add with schedule "daily" and the Dream Journal prompt.
```

Or from the dashboard: **Add task → set Schedule = Daily → paste the prompt**.

---

## PROMPT

> Copy everything below into the task description.

```
You are restwalker's nightly "Dream Journal". Reflect on the last 24 hours of work
and produce ONE markdown report. Be concise and concrete — this is a journal, not an
essay. Work entirely from local files and the web; do not modify the user's projects.

PART 1 — Distill skills from today's conversations
- Find Claude Code session transcripts modified in the last 24 hours:
    ls -t ~/.claude/projects/**/*.jsonl 2>/dev/null   (each line is one JSON message)
  Also skim ~/.claude/history.jsonl for recent commands.
- Read enough of them to spot recurring patterns: a workflow you repeated, a problem
  you solved more than once, a sequence of steps worth turning into a reusable SKILL.
- For each candidate skill (aim for the best 1–3, not everything), capture:
    • name (kebab-case)   • when to use it   • the concrete steps   • why it helps
- If there were no meaningful conversations, say so plainly and keep the report short.

PART 2 — Best-practice + trending scan (do this for the top 1–3 candidates only)
- For each top candidate, use web search to check whether there's a more established,
  best-practice way to do the same thing. Note what's better and link the source.
- Check GitHub trending for the last ~30 days:
    fetch https://github.com/trending?since=monthly
  Pick the few repos most relevant to how you work, read their READMEs, and compare
  their approach to yours. Note anything concrete you could adopt.

OUTPUT
- Write a single markdown report to:  ~/.restwalker/dreams/dream-<YYYY-MM-DD>.md
  (create the dreams/ directory if needed; use today's date from `date +%F`).
- Structure it:
    # Dream Journal — <date>
    ## Distilled skills        (each: name, when-to-use, steps, why)
    ## Best-practice notes      (per skill: is there a better way? source links)
    ## Trending & comparisons   (repo, what it does, what you could borrow)
    ## Action items             (a short, prioritized checklist for tomorrow)
- Then declare the report as an artifact on its own line:
    ARTIFACT: {"path": "<absolute path to the report>", "description": "Nightly dream journal — distilled skills and best-practice scan"}
- Do NOT auto-install skills or edit ~/.claude/skills. Only recommend; the human decides.
```
