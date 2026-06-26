# restwalker

> While you rest, it walks.

Idle-time Claude task runner — a Mac background service that queues and runs Claude Code agent tasks during your off-hours, gated by live Claude usage so it never burns your interactive budget.

Runs as a LaunchAgent on port **47290** with a SQLite database, a dashboard UI, a REST API (OpenAPI 3.0), and an MCP server for Claude Code.

## How it works

1. You add tasks to the queue (via dashboard, REST API, or MCP tools in Claude Code)
2. The gate checks live Claude usage from `api.anthropic.com`
3. When usage is low and you're outside your coding window, tasks run automatically
4. Sessions are recorded; results, token counts, and transcripts are stored per task

### Budget gates (all configurable)

| Gate | Default | Behaviour |
|---|---|---|
| Coding window | 9 AM – 6 PM | Always paused during active hours |
| 5h usage | ≥ 75% | Pause to protect interactive budget |
| Weekly ceiling | ≥ 65% | Pause background jobs |
| Weekly hard stop | ≥ 90% | Hard stop regardless |

## Install

**Requirements:** macOS, Node.js 20+, Claude Code CLI (must be logged in)

```bash
git clone https://github.com/agentmessier-ai/restwalker.git
cd restwalker
./install.sh
```

The installer:
- Installs Node dependencies
- Installs and starts the LaunchAgent (auto-restarts on login)
- Interactively offers to register the MCP server with Claude Code

Open `http://localhost:47290` to confirm it's running.

### Custom Node path

```bash
NODE=/opt/homebrew/bin/node ./install.sh
```

## Uninstall

```bash
./uninstall.sh
```

Stops the service, removes the LaunchAgent, and optionally deletes `~/.restwalker/` (DB + logs).

## Dashboard

`http://localhost:47290`

- Live gate status, 5h and weekly usage, next window
- 48h trend chart with threshold overlays and coding-window shading
- Task queue: add, paginate, expand rows to view session transcripts and reasoning blocks
- Agent providers: configure which CLI runs tasks and with what arguments
- Settings: all thresholds configurable without restart

## Task queue

Tasks have a description (the prompt), an optional working directory, model, provider, and schedule:

| Schedule | Behaviour |
|---|---|
| `once` | Runs once when the gate opens |
| `hourly` / `daily` / `weekly` / `monthly` | Automatically re-queues after each run |

## Agent providers

The default provider runs `claude --print --permission-mode auto --model {{model}} {{task}}`. You can add any provider with a custom command and args template using `{{task}}`, `{{model}}`, and `{{cwd}}` placeholders.

## MCP server

The MCP server (`node/mcp.ts`) exposes 17 tools for Claude Code via stdio transport:

| Group | Tools |
|---|---|
| Status | `status`, `can_run`, `usage_history`, `sync` |
| Queue | `queue_stats`, `queue_list`, `queue_get`, `queue_add`, `queue_cancel`, `queue_force_run`, `queue_session` |
| Providers | `list_providers`, `add_provider`, `set_default_provider` |
| Discovery | `list_models`, `list_projects` |
| Settings | `get_settings`, `update_settings` |

Register manually if you skipped it during install:

```bash
claude mcp add --scope user restwalker -- node /path/to/node_modules/.bin/tsx /path/to/node/mcp.ts
```

## API

Full OpenAPI 3.0 spec and interactive docs at **`http://localhost:47290/docs`**.

Key endpoints:

| Endpoint | Method | Description |
|---|---|---|
| `/queue` | GET | List tasks (paginated) |
| `/queue` | POST | Add a task |
| `/queue/:id/force-run` | POST | Force-run bypassing the gate |
| `/queue/:id/session` | GET | Session transcript with thinking blocks |
| `/queue/stats` | GET | Counts by status |
| `/providers` | GET/POST | List or add agent providers |
| `/models` | GET | Live Anthropic model list |
| `/projects` | GET | Claude Code projects from history |
| `/status` | GET | Full daemon state |
| `/can-run` | GET | Quick gate check |
| `/settings` | GET/POST | Read or update thresholds |
| `/healthz` | GET | `{ok: true}` |

## Files

| Path | Purpose |
|---|---|
| `node/app.ts` | Fastify app, OpenAPI spec, routes, schedule checker |
| `node/db.ts` | Drizzle ORM repositories (tasks, providers, settings, snapshots) |
| `node/schema.ts` | Drizzle table definitions — single source of truth |
| `node/runner.ts` | better-queue worker, provider resolution, gate logic |
| `node/scheduler.ts` | Keychain read, Anthropic API fetch, time gate, budget logic |
| `node/session.ts` | Session JSONL parser and analysis |
| `node/mcp.ts` | MCP server (stdio, 17 tools) |
| `index.html` | Dashboard UI (no build step) |
| `install.sh` | One-command installer with interactive MCP registration |
| `uninstall.sh` | Clean removal |

## Logs

```bash
tail -f ~/.restwalker/restwalker.log
```
