# Teleport — design

> Carry a recent Claude Code conversation from *another folder* or *another Mac* into the session you're in right now.

## Problem

Claude Code ties each conversation to the **project folder it ran in**
(`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`, one JSON message per line). When you
juggle several projects — or several machines — that backfires in two everyday ways:

- **Right project, wrong folder.** With multiple projects on the go, it's easy to start Claude
  Code in the wrong directory. The thread you actually want is sitting in *another* folder, out
  of reach of the session you're now in.
- **Same project, different computer.** You start something on one Mac and continue on another —
  but the conversation, and all the context you built up, stayed behind on the first machine.

Either way you lose the thread and end up re-explaining everything. **Teleport** restores the
continuity: name the folder and a time window, and it pulls that recent conversation into your
current session — from this Mac, or from another restwalker on the LAN.

## Goals

- From inside any Claude Code session, pull the **recent conversation** (last hour / day)
  from **another folder** on this machine.
- Do the same from **another Mac** running restwalker on the LAN.
- Surface it as **MCP tools** + a skill so Claude can read the prior thread and continue it.
- Reuse what restwalker already has: the JSONL parser, the REST→MCP derivation, the daemon.

## Status

**Shipped.** Local cross-folder **and** cross-Mac retrieval are built, tested, and merged to
`develop` — released as `@agentmessier/restwalker` **1.1.4** and plugin **0.3.1**.

| # | Feature | Status | Where |
|---|---|---|---|
| 1 | Folder resolution (name/path/substring → project dir, via real `cwd`) | ✅ | `node/teleport.ts` |
| 2 | Time-window parsing (`1h`/`6h`/`24h`, default 6h) | ✅ | `node/teleport.ts` |
| 3 | Conversation listing in window (metadata: id, times, count, first request) | ✅ | `node/teleport.ts` |
| 4 | **Raw** conversation extraction (turns + tool calls, per-item truncation, size cap) | ✅ | `node/teleport.ts` |
| 5 | REST API (`/teleport/folders`, `/list`, `/conversation`, `/ping`, `/local-net`, `/handoff`) | ✅ | `node/routes/teleport.ts` |
| 6 | MCP tools (`teleport`, `teleport_list`, `teleport_folders`, `teleport_handoff`) | ✅ | `node/mcp.ts` |
| 7 | Settings (`TELEPORT_NETWORK_ENABLED`, `TELEPORT_TOKEN`, `TELEPORT_DEFAULT_WINDOW`, `TELEPORT_STATIC_PEERS`) | ✅ | `node/db/settings.ts` |
| 8 | Identity handshake (`/teleport/ping`, CORS+PNA) so a peer can be confirmed | ✅ | `node/routes/teleport.ts` |
| 9 | Cross-Mac pull — **agent-driven** (skill scans the LAN over Bash, pulls directly) | ✅ | `plugin/skills/teleport/SKILL.md` |
| 10 | Security — localhost bypass, private-IP gate, optional **HMAC** "secure mode", read-only | ✅ | `node/routes/teleport.ts` |
| 11 | Dashboard config (Settings → Teleport: default window, optional token, Advertise on LAN) | ✅ | `index.html` |
| 12 | Static peer list (secure/token mode only) | ✅ | `TELEPORT_STATIC_PEERS`, `routes/teleport.ts` |
| 13 | Automated tests (teleport core) | ✅ | `node/test/teleport.test.ts` |
| 14 | Claude Code plugin skill (`/restwalker:teleport`) | ✅ | `plugin/skills/teleport/SKILL.md` |

Deliberately deferred (not built): TLS / cert-pinning for the response channel; semantic
(non-time) slicing; an "inject teleported context as a queued task" mode; multi-session merge.
HMAC already keeps the token off the wire; the rest are speculative for a trusted-LAN v1.

## Non-goals (v1)

- Not a full conversation *sync*/merge or a replacement for Claude Code's own history.
- Not real-time streaming of a live session — it's a pull of what's already on disk.
- Not cross-internet (LAN only; the daemon is localhost-by-default by design).

## Core concept

A **conversation slice** = the messages in `[now − window, now]` for a *resolved project* on a
*host*. Resolve the folder → find the session(s) in the window → return the raw slice the
current Claude can consume.

```
teleport(folder="myapp", window="6h")          # local: via the MCP tool
   → resolve folder to a project dir
   → find session .jsonl files touched within the window
   → parse + filter turns to the window
   → return the raw turns as MCP text
```

## Architecture — and the constraint that shapes it

The whole design is driven by one hard macOS fact:

> **macOS denies a launchd background process "Local Network" access**, and no UI prompt fires
> to grant it. So the installed restwalker **daemon cannot reach LAN devices at all** — only
> `localhost` and the internet. An *interactive* app (a browser, Terminal, the Claude Code
> agent's shell) **can** hold that permission.

So teleport splits the work cleanly: **the daemon never touches the LAN — the agent's Bash does.**

```
 Same Mac, other folder (MCP only):
   Claude Code ──MCP──► daemon (localhost) ──reads ~/.claude──► raw turns

 Another Mac (the agent's Bash crosses the LAN, not the daemon):
   skill ─► (localhost) daemon /teleport/local-net   # which /24 to scan
   skill ─Bash─► scan <subnet>.1-254 : curl /teleport/ping   # find a peer
   skill ─Bash─► curl peer:47290/teleport/conversation       # pull it
```

The local daemon's only LAN-adjacent jobs are **localhost-only**: tell the agent which subnet
to scan (`/teleport/local-net`, reading its own interfaces) and, in secure mode, **sign** a
request (`/teleport/handoff`) so the agent can run it without ever seeing the token.

### What was abandoned: mDNS / daemon-proxy

The first design had the daemon **discover** peers via mDNS (`_restwalker._tcp`) and **proxy**
cross-Mac requests itself. Both are impossible under the constraint above — a launchd daemon
can neither browse mDNS nor open outbound LAN connections. So they were removed:
`node/teleport-mdns.ts`, the `bonjour-service` dependency, and the `teleport_peers` MCP tool /
`/teleport/peers` endpoint are **gone**. Discovery is now an agent-side Bash scan; the fetch is
an agent-side `curl`.

| Piece | File | Role |
|---|---|---|
| Retrieval core | `node/teleport.ts` | resolve folder → sessions → raw turns (shares `transcript.ts`) |
| REST routes | `node/routes/teleport.ts` | `/folders`, `/list`, `/conversation`, `/ping`, `/local-net`, `/handoff` |
| MCP tools | `node/mcp.ts` | `teleport`, `teleport_list`, `teleport_folders`, `teleport_handoff` |
| Skill | `plugin/skills/teleport/SKILL.md` | local via MCP; **remote via Bash** (scan → ping → curl) |
| Settings | `db/settings.ts` | `TELEPORT_NETWORK_ENABLED`, `TELEPORT_TOKEN`, `TELEPORT_DEFAULT_WINDOW`, `TELEPORT_STATIC_PEERS` |

## Folder resolution

Folder input can be a bare name (`myapp`), a path (`~/dev/myapp`), or a substring. Resolution
(`resolveFolders` in `teleport.ts`): exact path → exact basename → substring; ambiguous matches
are returned as **candidates** for the caller to disambiguate rather than guessed.

Folders are enumerated by scanning `~/.claude/projects/<encoded>/` and reading the **real `cwd`
out of each session's JSONL** (the first line that carries one). The on-disk directory encoding
(`cwd.replace(/[^a-zA-Z0-9]/g,'-')`) is lossy and can't be reliably decoded, so the cwd is read
from file contents, not reconstructed from the dir name. The folder roster is ~30s-cached;
conversation *content* is read fresh per call.

## Time windowing

- `window`: a duration (`1h`, `6h`, `24h`); **default `6h`** ("what I did today" case).
- Coarse filter: session files with `mtime ≥ now − window`.
- Fine filter: keep messages whose per-line `timestamp` is in the window. Lines without a
  timestamp fall back to file mtime.

## What teleport returns (raw turns)

```jsonc
{
  "source": { "host": "this-mac", "project_path": "/Users/.../dev/foo",
              "session_id": "<uuid>", "git_branch": "main" },
  "window": { "since": "...", "until": "..." },
  "turns": [
    { "role": "user",      "ts": "...", "text": "...",
      "tool_results": [{ "is_error": false, "content": "..." }] },
    { "role": "assistant", "ts": "...", "text": "...",
      "tool_uses": [{ "name": "Edit", "input": { /* only with full=1 */ } }] }
  ],
  "turn_count": 42,
  "truncated": false
}
```

The actual dialogue is returned (not a summary). Tool-result content is truncated per-item
(`PER_RESULT_CAP`) and the whole payload is size-capped (`TOTAL_CAP`), dropping oldest turns
and setting `truncated: true`; `full=1` lifts the per-item truncation. Tool *inputs* are
included only with `full=1`.

## Remote (another Mac) — agent-driven

Each restwalker **serves** teleport queries for its own `~/.claude/projects` when it opts in.
Pulling *from* a peer is done by the **agent**, not the daemon:

1. **Subnet** — `GET localhost:47290/teleport/local-net` returns this machine's private `/24`
   prefixes + self IPs (or the agent uses `ipconfig`).
2. **Discover** — the skill Bash-scans the `/24` on the default port (`47290`), `curl`-ing each
   host's **`/teleport/ping`** (a fast, unauthenticated identity handshake). The scan is
   **time-boxed** (`--max-time 1` per host, one `/24` only) so a large/slow LAN can't hang it.
   The user can also just give an IP and skip the scan.
3. **Pull** — `curl peer:47290/teleport/conversation?folder=…&window=…` → the raw turns.

**To be a source** (the Mac you pull *from*): `TELEPORT_NETWORK_ENABLED=1` ("Advertise on LAN")
and the daemon bound to `HOST=0.0.0.0`. The Mac you pull *to* needs no config.

**Secure mode (optional):** if both Macs share a `TELEPORT_TOKEN`, the agent calls
`teleport_handoff` instead — the local daemon resolves a configured static peer, **HMAC-signs**
the request, and returns a ready-to-run `curl`; the agent runs it via Bash. The token never
leaves the daemon and is never put on a caller-controlled URL.

## Security & privacy

Conversations contain secrets, code, and private context — so the network path is **off by
default** and gated:

- **Local** (same user, own files): no new exposure. Localhost requests skip auth.
- **`/teleport/ping`** is intentionally **unauthenticated** — it only reveals `service`,
  `version`, `host`, and whether network teleport is on. It carries CORS + Private-Network-Access
  headers so a dashboard browser can probe a LAN peer.
- **Serving** any other `/teleport/*` to a non-local client requires `TELEPORT_NETWORK_ENABLED=1`,
  and then:
  - **no token** → served **only to private/LAN IPs** (RFC1918 / link-local / ULA). A token-less
    daemon never serves a public client, even if accidentally bound to `0.0.0.0`.
  - **token set** ("secure mode") → a fresh **HMAC** signature is required
    (`x-teleport-sig = HMAC(TELEPORT_TOKEN, method+url+ts)`, `±5 min`). The token is proof-of-
    possession only; pair two Macs by copying it.
- **No SSRF**: `teleport_handoff`/`resolvePeer` only ever sign for a **configured static peer**
  (`TELEPORT_STATIC_PEERS`); an arbitrary `host` is rejected (400). The token is never attached
  to a caller-controlled URL.
- `/teleport/*` is **read-only** (no Bash, no writes).
- Residual (acceptable for a trusted LAN): plaintext HTTP on the response, and a 5-min replay
  window in secure mode. TLS/cert-pinning is a documented future hardening.

## MCP tools

| Tool | Input | Returns |
|---|---|---|
| `teleport` | `folder`, `window?`, `session?`, `full?` | raw turns for the most-recent matching conversation (or a chosen `session`) |
| `teleport_list` | `folder`, `window?` | candidate sessions (id, path, start/end, count, first request) — for picking |
| `teleport_folders` | — | known project folders, recency-sorted |
| `teleport_handoff` | `host`, `folder`, `kind?`, `window?`, `session?` | a signed, ready-to-run `curl` for a peer (secure mode); the agent runs it via Bash |

Local flow: `teleport_folders` if unsure of the name → `teleport_list` if several sessions →
`teleport`. Remote flow: the skill scans + `curl`s over Bash (or `teleport_handoff` for token mode).

## REST endpoints (source of truth)

| Endpoint | Method | Purpose |
|---|---|---|
| `/teleport/folders` | GET | known project folders, recency-sorted (`?host` for a peer) |
| `/teleport/list` | GET | `?folder&window` → candidate sessions (metadata only) |
| `/teleport/conversation` | GET | `?folder&window&session?&full?` → raw turns |
| `/teleport/ping` | GET / OPTIONS | unauthenticated identity handshake (CORS + PNA) |
| `/teleport/local-net` | GET | this machine's private `/24` prefixes + self IPs (for the agent's scan) |
| `/teleport/handoff` | GET | resolve + sign a peer request → ready-to-run `curl` (secure mode) |

## Decisions (locked)

1. **Return shape — raw conversation.** Every user/assistant turn's text + tool calls, not a
   summary. Tool outputs truncated per-item + a size cap (`truncated` flag); `full=1` lifts it.
2. **Default window — 6h.**
3. **Scope — local + LAN together.** Cross-folder *and* cross-Mac shipped together.
4. **Ambiguous folder — the calling agent decides.** `teleport_list` returns candidates; no
   server-side guessing.
5. **Cross-Mac is agent-driven, not daemon-driven.** Because the launchd daemon can't reach the
   LAN, the agent's Bash does discovery (scan `/teleport/ping`) and the pull (`curl`). The daemon
   only serves, resolves a static peer, and signs. No mDNS, no daemon proxy.
6. **Default LAN access is token-less but private-IP-gated.** Trusted-LAN convenience by default;
   a shared token enables authenticated "secure mode" via the signed handoff.

## Testing & findings

### Local (cross-folder) — ✅ verified on real data
- Project folders discovered from `~/.claude/projects`; fuzzy match works.
- `teleport folder=restwalker window=168h` → **385 raw turns** with real dialogue + tool calls
  (post-refactor onto the shared `transcript.ts` parser).
- Default window resolves to 6h; `teleport_list` → pick a `session` → exact session returned.
- A folder only appears once Claude Code has had a session in it (creates the `.jsonl` with a
  `cwd`); `mkdir` alone shows nothing.

### Cross-Mac — ✅ verified end-to-end via the agent
- Peer set up on the standard port (`10.0.0.181:47290`, `HOST=0.0.0.0`, Advertise on).
- The skill's Bash scan finds the peer via `/teleport/ping` (time-boxed), then `curl`s
  `/teleport/conversation` directly — succeeding because the **agent's shell holds Local-Network
  permission** while the launchd daemon does not.

### Why not the daemon / browser
- **launchd daemon** → can never reach the LAN (no Local-Network grant, no prompt). Dead end.
- **Browser** (dashboard Test) → *can* be granted, but the prompt for browser `fetch()` to a LAN
  IP is flaky; we removed the dashboard Test/discover UI and lean on the agent's Bash, which is
  already granted reliably.
- **Agent's Bash** → the reliable executor; it's where discovery and the pull run.

### Observability — intentionally minimal
- The only teleport UI is Settings → Teleport (default window, optional token, Advertise on LAN).
  Results go back to the calling Claude chat, not the dashboard. `/teleport/*` request logging is
  off by default. A "recent teleports" panel is a possible follow-up, not built.
