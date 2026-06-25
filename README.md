# restwalker

> While you rest, it walks.

Mac background service that maximises Claude Max plan usage during your idle hours — running background AI jobs through the night so no tokens go to waste.

Runs as a LaunchAgent on port **47290**, owns its own SQLite DB, and exposes:
- a scheduling API (`/can-run`) for automated job runners to query before starting work
- a live dashboard UI at `http://localhost:47290`

## How it works

Usage data is fetched live from `api.anthropic.com/api/oauth/usage` using the OAuth token stored in your macOS Keychain (`Claude Code-credentials`) — the same endpoint the `ccstatusline` widget uses. Always real-time, never stale.

Data is cached in memory for 5 minutes to avoid rate-limiting. The background poller refreshes every `POLL_INTERVAL_MIN` minutes and persists snapshots to SQLite for trend charts.

### Budget gates (all configurable via the ⚙ gear icon)

| Gate | Default | Behaviour |
|---|---|---|
| Coding window | 4:00 PM – 2:00 AM | Always `ok=false` during active hours |
| 5h usage | ≥ 75% | Pause to protect interactive budget |
| Weekly ceiling | ≥ 65% (100 − 35% reserve) | Pause background jobs |
| Weekly hard stop | ≥ 90% | Hard pause regardless |

When `ok=true`, the caller runs the job on `provider=max`. When `ok=false`, it should sleep and retry.

## Dashboard

`http://localhost:47290` shows:

- Current window, 5h usage, weekly usage, next milestone
- 48h trend chart (5h and weekly lines, threshold overlays, coding-window shading)
- Linear-regression predictions (next 1h / 4h / 8h / 24h)
- Gear modal to configure all thresholds without restarting the service

## Install

**Requirements:** macOS, Node.js 20+, Claude Code CLI (must be logged in)

```bash
git clone https://github.com/agentmessier-ai/restwalker.git
cd restwalker
./install.sh
```

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

## Wiring up a job runner

Query `/can-run` before starting any background job:

```js
async function canRun() {
  try {
    const res = await fetch('http://localhost:47290/can-run?project=my-project')
    const { ok } = await res.json()
    return ok
  } catch {
    return true  // restwalker unreachable — proceed anyway
  }
}
```

## API

| Endpoint | Method | Description |
|---|---|---|
| `/can-run?project=<name>` | GET | `{ok, provider, reason, next_idle_in_s}` |
| `/status` | GET | Full state: window, usage, thresholds, last snapshot |
| `/sync` | POST | Force immediate API fetch + DB record |
| `/history?hours=48` | GET | 15-min bucketed usage snapshots |
| `/settings` | GET/POST | Read or update all thresholds (no restart needed) |
| `/healthz` | GET | `{ok: true}` |

## Files

| Path | Purpose |
|---|---|
| `node/app.js` | Fastify app, chokidar watcher, background poller |
| `node/scheduler.js` | Keychain read, Anthropic API fetch, time gate, budget logic |
| `node/db.js` | better-sqlite3: migrations, snapshots, settings |
| `index.html` | Dashboard UI (Chart.js, no build step) |
| `install.sh` | One-command installer |
| `uninstall.sh` | Clean removal |
| `archive/python/` | Original Python implementation (reference) |

## Logs

```bash
tail -f ~/.restwalker/restwalker.log
```

## Name

Restwalker — while you rest, it walks through your Claude Max quota so nothing goes to waste.
