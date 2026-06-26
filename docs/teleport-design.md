# Teleport — design

> Carry a recent Claude Code conversation from *another folder* or *another Mac* into the session you're in right now.

## Problem

Claude Code stores conversations **per project folder** at
`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` (one JSON message per line).
That siloing means:

- You asked Claude something in `~/dev/foo`, then opened Claude in `~/dev/bar` and lost that thread.
- You worked on a different Mac and can't pick the conversation back up here.

You can't carry the context over. **Teleport** finds the relevant conversation —
by folder name and a time window — and pulls it into the current session, locally
or from another restwalker on the LAN.

## Goals

- From inside any Claude Code session, pull the **recent conversation** (last hour / day)
  from **another folder** on this machine.
- Do the same from **another Mac** running restwalker, discovered on the local network.
- Surface it as an **MCP tool** so Claude can read the prior thread and continue it.
- Reuse what restwalker already has: the JSONL parser (`session.ts`), the projects
  index (`history.jsonl`), the REST→MCP derivation, the existing daemon.

## Non-goals (v1)

- Not a full conversation *sync*/merge or a replacement for Claude Code's own history.
- Not real-time streaming of a live session — it's a pull of what's already on disk.
- Not cross-internet (LAN only; the daemon is localhost-by-default by design).

## Core concept

A **conversation slice** = the messages in `[now − window, now]` for a *resolved
project* on a *host*. Teleport's job is: resolve the folder → find the session(s) in
the window → return a slice the current Claude can consume.

```
teleport(folder="myapp", window="1h", host=local|peer)
   → resolve folder to a project dir
   → find session .jsonl files touched within the window
   → parse + filter messages to the window
   → return a digest (messages + summary) as MCP text
```

## Architecture

```
        Claude Code (session in ~/dev/bar)
                  │  MCP: teleport(folder="foo", window="1h")
                  ▼
        restwalker MCP server (node/mcp.ts)  ──HTTP──►  REST /teleport/*
                                                            │
                                  ┌─────────────────────────┼───────────────────────────┐
                                  ▼                         ▼                             ▼
                         teleport.ts (local)      peer client (remote)          mDNS discovery
                    reads ~/.claude/projects   calls peer's /teleport/*      browse _restwalker._tcp
                    via session.ts parser      over the LAN (token-gated)    to find other Macs
```

New pieces:

| Piece | File | Role |
|---|---|---|
| Retrieval core | `node/teleport.ts` | resolve folder → sessions → sliced digest (extends `session.ts`) |
| REST routes | `node/routes/teleport.ts` | `/teleport/folders`, `/teleport/list`, `/teleport/conversation`, `/teleport/peers` |
| MCP tools | `node/mcp.ts` | `teleport`, `teleport_list`, `teleport_peers` |
| Discovery | `node/teleport-mdns.ts` | advertise + browse `_restwalker._tcp` (Phase 2) |
| Settings | `db/settings.ts` | `TELEPORT_NETWORK_ENABLED`, `TELEPORT_TOKEN`, `TELEPORT_DEFAULT_WINDOW` |

## Folder resolution

Folder input can be: a bare name (`myapp`), a path (`~/dev/myapp`), or partial.
Resolution order:

1. If it's an absolute/`~` path that exists → encode it (`cwd.replace(/[^a-zA-Z0-9]/g,'-')`)
   and look under `~/.claude/projects/`.
2. Otherwise match against **`~/.claude/history.jsonl`** project paths (full paths, with
   timestamps) by basename or substring.
3. Ambiguous (multiple matches) → return **candidates** for the caller to disambiguate,
   rather than guessing.

`history.jsonl` is the source of truth for path↔folder because the on-disk encoding is
lossy (every non-alphanumeric becomes `-`, so it can't be reliably decoded).

## Time windowing

- `window`: a duration (`1h`, `6h`, `24h`) or explicit `since`/`until` ISO timestamps.
  Default `1h` (the "I just asked this elsewhere" case).
- Coarse filter: session files with `mtime ≥ now − window`.
- Fine filter: within a session, keep messages whose per-line `timestamp` is in the window
  (Claude Code stamps each message). If a line has no timestamp, fall back to file mtime.

## What teleport returns (the digest)

```jsonc
{
  "source":  { "host": "this-mac|peer-name", "folder": "foo",
               "project_path": "/Users/.../dev/foo", "session_id": "<uuid>" },
  "window":  { "since": "...", "until": "..." },
  "summary": {                          // cheap, from analyzeSession()
    "user_requests": ["..."], "files_touched": ["..."],
    "key_steps": ["Edit x.ts", "Bash: npm test"], "outcome": "..." },
  "messages": [                          // the actual thread, window-filtered
    { "role": "user",      "ts": "...", "text": "..." },
    { "role": "assistant", "ts": "...", "text": "...", "tools": ["Read app.ts", "Edit db.ts"] }
  ],
  "truncated": false
}
```

- **Token budget**: cap the digest (e.g. ~8–15k tokens). If over budget, keep the most
  recent messages + the summary, set `truncated: true`. `window=1h` is usually small;
  `24h` may truncate.
- Thinking blocks are dropped; tool calls are condensed to `Tool target` lines.

## Remote (another Mac)

Each restwalker both **serves** teleport queries (reads its own `~/.claude/projects`) and
can **act as client** to peers.

- **Discovery (Phase 2):** advertise `_restwalker._tcp.local` via mDNS/Bonjour with TXT
  `{host, version, port}`; `teleport_peers` browses for instances. (`bonjour-service`,
  pure-JS, no native build.) Fallback: a static peer list in settings.
- **Transport:** the same REST API. `teleport(host="other-mac")` → MCP server →
  `GET http://other-mac:47290/teleport/conversation?...` → relays the digest back.
- **Requirement:** the peer must be **LAN-reachable**, i.e. started with `HOST=0.0.0.0`
  (restwalker is localhost-only by default — see README). Teleport doesn't change that
  default; it's opt-in.

## Security & privacy

Conversations contain secrets, code, and private context — so the network path is
**off by default** and gated:

- **Local** (same user, own files): no new exposure. Always allowed.
- **Remote serving** requires *all* of:
  1. `TELEPORT_NETWORK_ENABLED=1` (setting, default `0`).
  2. The daemon bound to the LAN (`HOST=0.0.0.0`) — already a deliberate opt-in.
  3. A valid **HMAC signature**: `x-teleport-sig = HMAC(TELEPORT_TOKEN, method+url+ts)`
     with a fresh `x-teleport-ts` (±5 min). The shared **`TELEPORT_TOKEN`** is *never
     transmitted* — only proof of possession is. Pair two Macs by copying the token.
- **No SSRF**: the daemon only ever proxies to a peer **actually discovered via mDNS**,
  using that peer's *advertised* address. An arbitrary `host` string is rejected (400) —
  the token is never attached to a caller-controlled URL.
- `/teleport/*` is **read-only** (no Bash, no writes). Localhost requests skip auth;
  remote requests require the signature.
- Residual (documented, acceptable for v1): plaintext HTTP transport of the *response*
  on the LAN, and a 5-min replay window. Keep network teleport to **trusted networks**;
  TLS/cert-pinning is a future hardening.

## MCP tools

| Tool | Input | Returns |
|---|---|---|
| `teleport` | `folder`, `window?`, `host?`, `session?` | the digest for the most-recent matching conversation (or a chosen `session`) |
| `teleport_list` | `folder?`, `window?`, `host?` | candidate conversations (session id, path, start/end, msg count, first request) — for picking |
| `teleport_peers` | — | discoverable restwalker hosts on the LAN |

Flow: if the folder is ambiguous or you don't know which session, `teleport_list` first,
then `teleport` with the chosen `session`. For the common case ("grab what I just did in
foo"), `teleport(folder="foo")` returns the latest slice directly.

## REST endpoints (source of truth; MCP derives from these)

| Endpoint | Method | Purpose |
|---|---|---|
| `/teleport/folders` | GET | known project folders (from `history.jsonl`), recency-sorted |
| `/teleport/list` | GET | `?folder&window` → candidate sessions (metadata only) |
| `/teleport/conversation` | GET | `?folder&window&session?` → the digest |
| `/teleport/peers` | GET | discovered LAN peers (Phase 2) |

## Phasing

- **Phase 1 (MVP, local only):** `teleport.ts` retrieval + the three local REST endpoints +
  `teleport` / `teleport_list` MCP tools + folder resolution + windowing + token-budgeted
  digest. Delivers cross-folder teleport on one Mac.
- **Phase 2 (network):** mDNS discovery, `host` param, `TELEPORT_TOKEN` gating, `teleport_peers`.
- **Phase 3 (nice-to-have):** smarter slicing (semantic relevance, not just time), an
  "inject as a queued restwalker task" mode, multi-session merge.

## Decisions (locked, v1)

1. **Return shape — raw conversation.** Return the actual messages (every user/assistant
   turn's text + tool calls), not a summary. Tool *outputs/results* are truncated per-item
   and the whole payload is size-capped with a `truncated` flag, so a 6h pull stays loadable;
   a `full=1` flag can lift the per-item truncation.
2. **Default window — 6h.**
3. **Scope — local + LAN together in v1.** Cross-folder *and* cross-Mac ship together.
4. **Ambiguous folder — the calling agent decides.** `teleport_list` returns candidates;
   the MCP agent picks and calls `teleport` with the chosen `session`. No server-side guessing.
5. **Discovery — mDNS/Bonjour.** Advertise/browse `_restwalker._tcp` via `bonjour-service`
   (pure-JS, no native build). A static peer list in settings remains as a fallback.
