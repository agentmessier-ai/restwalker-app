# Teleport Search — design

> Find *where* something was said across sessions, instead of pulling one time-slice and
> hoping it's in there.

Companion to [`teleport-design.md`](./teleport-design.md). That document shipped **time-sliced
retrieval** and explicitly deferred *"semantic (non-time) slicing"*. This is that deferred
item, in its most useful concrete form: **keyword search across sessions**, plus the paging
needed to actually reach what it finds.

## Problem

Teleport today answers *"what was I doing in folder X in the last N hours?"*. It cannot answer
*"where did I ever do X?"* — and that second question is the common one once you have more
than a few days of history.

This was found the hard way. Searching ~20 project folders over a 2-week window for whether a
particular MCP tool had ever been called produced a **confidently wrong "it never happened"**.
Three distinct properties of the current design each contributed:

### 1. Truncation silently discards the *oldest* turns, and nothing can page back to them

`getRawConversation` (`node/teleport.ts:215-224`) caps the payload at `TOTAL_CAP` (150 000
chars) by shifting turns off the front:

```ts
while (total > TOTAL_CAP && turns.length > 1) {
  const dropped = turns.shift()!        // oldest first
  total -= dropped.text.length + JSON.stringify(dropped.tool_results ?? '').length
  truncated = true
}
```

For a large session this is not a trim, it's a **cliff**. One real session
(`epyc2`, 3 241 messages, started 07-11 17:03) returned turns beginning only at 07-13 17:13 —
the first ~46 hours were gone. `truncated: true` is set, honestly, but there is no `offset`,
`cursor`, or `before` parameter, so a caller who sees that flag **has no way to fetch what was
dropped**. `full=1` lifts *per-item* truncation but not the total cap, and on a session this
size it makes the payload dramatically larger rather than more reachable.

The window parameter is no escape hatch either: `window` is always computed as
`Date.now() - windowMs` (`teleport.ts:132, 168`), so it can only ever slide the *start* of the
range backwards, never bound the *end*. There is no way to ask for "07-11 to 07-13".

### 2. No search of any kind

`teleport`, `teleport_list`, and `teleport_folders` accept only `folder` / `window` / `session`
/ `full` / `host` (`node/mcp.ts:290-324`). Nothing in the codebase greps transcript content.
The only way to answer "does X appear anywhere" is the O(folders × sessions) loop:
`teleport_folders` → `teleport_list` per folder → `teleport` per session → grep the result by
hand — *while each of those results is silently missing its oldest half*.

### 3. `teleport` without `session` returns exactly one session

`ranked.sort((a,b) => b.mtime - a.mtime); target = ranked[0]` (`teleport.ts:181-182`). Documented
("defaults to the most recent session in the window") but easy to miss: a folder with five
sessions in the window yields **one**, and the other four are invisible unless the caller
separately enumerates them via `teleport_list`. A negative result from a single `teleport` call
therefore means far less than it appears to.

Together: a search that must be driven by the caller, over an API that returns one session at a
time, each with its oldest content unreachably truncated. A "not found" from that process is
not evidence of absence.

## Goals

- **Find** a string across sessions and folders — with the session id, timestamp, and enough
  surrounding text to judge relevance — without pulling whole conversations.
- Search **all** matching content, unaffected by `TOTAL_CAP` (search reads transcripts directly;
  it never builds a capped payload).
- Make truncated retrieval **reachable**: let a caller page back into what `truncated: true`
  dropped.
- Stay inside the existing shape: same `resolvePeer` → `proxy` → local pattern as every other
  `/teleport/*` route, same OpenAPI→MCP derivation, reuse `parseTranscriptLine`.

## Non-goals

- Not semantic/embedding search. Literal + regex only; no index, no model, no new dependency.
- Not a new storage layer. No index files, no SQLite table — transcripts on disk stay the only
  source of truth. (See *Performance* for why this is affordable.)
- Not a replacement for `teleport`. Search **locates**; `teleport` still **retrieves**.
- Not cross-internet. Inherits the LAN-only posture and every gate from the parent design.

## Design

### A. `teleport_search` — new capability

Scan transcript `.jsonl` files line by line with the existing `parseTranscriptLine`
(`node/transcript.ts`), test each entry's text and tool-use names against the query, and return
**match records** rather than conversations.

```
teleport_search(query="pattern_search", folder?, window?, limit?)
  → for each resolved folder (all folders if omitted)
      for each session .jsonl in window (mtime filter, as today)
        for each line → parseTranscriptLine → test query
          → { session_id, project_path, ts, role, kind, excerpt }
```

Deliberate properties:

- **`folder` is optional.** Omitted = search every known project folder. This is the whole
  point: "where did I ever do X" cannot presume the folder.
- **Matches text *and* tool names.** A `mcp__plugin_pattern8_pattern8__pattern_search` tool call
  carries no prose, so text-only matching would miss exactly the case that motivated this. Both
  `entry.text` and `entry.toolUses[].name` are tested; the returned `kind` field says which hit.
- **Bounded by count, not by bytes.** `limit` (default 50, hard max 500) caps *matches*. Each
  excerpt is a fixed window around the hit, so the response size is predictable regardless of
  how large the underlying sessions are — no `TOTAL_CAP` cliff.
- **Returns coordinates, not content.** Every result carries `session_id` + `ts`, which are
  exactly the inputs `teleport(session=…)` needs. Search and retrieve compose.

### B. `before` — make truncated retrieval reachable

Add one optional parameter to the existing conversation path:

| Param | Meaning |
|---|---|
| `window` | (existing) start of range = `now − window` |
| `before` | (new) end of range = this ISO timestamp, instead of `now` |

`getRawConversation` currently derives only `since`; it gains an `until` alongside it, defaulting
to `Date.now()` so **every existing call behaves identically**. When a response comes back
`truncated: true`, the caller re-requests with `before` = the `ts` of the earliest returned turn
and walks backwards through the session a page at a time.

This is a smaller change than a stateful cursor and needs no server-side state: the timestamps
are already in the payload, and paging is just "ask again, ending earlier".

## API

### MCP

| Tool | Input | Returns |
|---|---|---|
| `teleport_search` | `query`, `folder?`, `window?`, `limit?`, `regex?`, `host?` | match records: `session_id`, `project_path`, `ts`, `role`, `kind`, `excerpt` |
| `teleport` | …existing… + `before?` | raw turns ending at `before` instead of now |

`teleport_search` is derived from its OpenAPI schema like every other tool — no hand-written Zod
(`node/mcp.ts` header contract).

### REST

| Endpoint | Method | Purpose |
|---|---|---|
| `/teleport/search` | GET | `?query&folder?&window?&limit?&regex?` → match records |
| `/teleport/conversation` | GET | …existing… + `&before?` |

Both follow the established handler shape: `resolvePeer(host)` → `proxy(...)` if remote,
otherwise execute locally. Search is read-only, so it inherits the parent design's security
model unchanged — the private-IP gate, optional HMAC secure mode, and the "never Bash, never
write" rule all apply as-is.

### Response shape

```jsonc
{
  "host": "this-mac",
  "query": "pattern_search",
  "matches": [
    { "session_id": "abf6d93c-…", "project_path": "/Users/…/dev/epyc2",
      "ts": "2026-07-15T00:41:08.166Z", "role": "assistant",
      "kind": "tool_use",                       // "text" | "tool_use" | "tool_result"
      "excerpt": "…mcp__plugin_pattern8_pattern8__pattern_search…" }
  ],
  "match_count": 12,
  "sessions_scanned": 47,
  "truncated": false        // true = hit `limit`, more matches exist
}
```

`sessions_scanned` is deliberate: a caller can tell "0 matches across 47 sessions" apart from
"0 matches because nothing was scanned" — the failure mode that produced the wrong answer above.

## Performance

Search reads every candidate `.jsonl` in full — the same files `listConversations` already opens
for its metadata pass, so the I/O shape is not new, only more frequent. Cheap protections, in
order of effect:

1. **`mtime` pre-filter** — reuses `sessionFilesInWindow`; a window bounds the file set before
   any parsing. An unbounded search is opt-in, not the default path.
2. **Line-level short-circuit** — test `line.includes(query)` on the **raw string before
   `JSON.parse`**. Non-matching lines (the overwhelming majority) never get parsed. Parsing runs
   only for lines that could match, which turns the cost from "parse everything" into
   "substring-scan everything, parse a handful".
3. **Early exit at `limit`** — stop reading once enough matches are collected.

Measured baseline for scale: the largest local session is 3 241 messages / ~240 KB of extracted
turns; the full `~/.claude/projects` tree is ~100 folders. A substring pass over that is
milliseconds-to-low-seconds — acceptable for an interactive tool, and bounded further by (1).

If this ever stops holding, the escape hatch is an index — explicitly **not** built now
(non-goal), because it would introduce staleness and a storage layer for a problem that
`grep`-speed I/O currently solves.

## Testing

Extends `node/test/teleport.test.ts`, which already builds synthetic `.jsonl` fixtures.

| Test | Asserts |
|---|---|
| `teleport_search: finds text matches` | literal hit in `entry.text`, correct `session_id` + `ts` |
| `teleport_search: finds tool-name matches` | a tool call with **no prose** is found by tool name — the motivating case |
| `teleport_search: folder omitted searches all folders` | matches from ≥2 distinct `project_path`s |
| `teleport_search: limit caps and flags` | `matches.length === limit`, `truncated: true` |
| `teleport_search: sessions_scanned reflects coverage` | non-zero when files were read, distinguishing empty-result causes |
| `getRawConversation: before bounds the end` | no turn newer than `before` |
| `getRawConversation: before pages through a truncated session` | page 2 (via `before` = earliest ts of page 1) returns strictly older turns, no overlap |
| `getRawConversation: no before = unchanged` | regression guard on every existing caller |

## Decisions

1. **Literal/regex, not semantic.** Zero new dependencies, no index, no staleness. The failing
   query was an exact tool name — literal matching solves the real case. Semantic search stays
   deferred, as in the parent design.
2. **Search returns coordinates, not conversations.** Keeps the response bounded and composes
   cleanly with existing `teleport(session=…)`. Search locates; teleport retrieves.
3. **`folder` optional.** The question search exists to answer usually doesn't know the folder.
4. **`before` over a cursor.** No server-side state; the client already has the timestamps it
   needs to page. Additive and default-identical, so nothing existing changes behavior.
5. **`TOTAL_CAP` stays.** It protects the retrieval path, which is the right place for it.
   Search sidesteps it structurally (bounded by match count) rather than by raising a limit,
   and `before` makes what it drops reachable.
6. **Tool *names* are searchable content.** Tool `input` remains behind `full=1` in retrieval;
   search matches names only, so no argument payloads leak into search results.

## Status

**Built.**

1. `before` on `getRawConversation` — done, with the boundary made exclusive (`ts >= until` is
   dropped, not `>`) so re-requesting with `before` = the earliest returned turn's `ts` never
   re-returns that turn. Tests: `node/test/teleport.test.ts` (`before bounds the end`, `before
   pages through a truncated session`, `no before = unchanged`).
2. `teleport_search` core in `node/teleport.ts` — matches `entry.text` and tool-use names only
   (not tool_result content, narrower than the illustrative response JSON above implied).
   Tests: finds text matches, finds tool-name matches, folder-omitted searches all folders,
   limit caps and flags truncated, sessions_scanned reflects coverage.
3. `/teleport/search` route in `node/routes/teleport.ts` — follows the existing
   `resolvePeer`/`proxy` handler shape, same as every other `/teleport/*` route.
4. `teleport_search` MCP tool in `node/mcp.ts`, hand-written Zod like every other tool in that
   file (no OpenAPI→MCP auto-derivation exists in this codebase; corrected from the earlier
   assumption above). `before` added to the existing `teleport` tool's schema.
5. `plugin/skills/teleport/SKILL.md` updated: search-then-retrieve as the flow for "where did I
   ever…" questions, checking `sessions_scanned` before concluding absence, and `before` paging
   for `truncated: true` results.
