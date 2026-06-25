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

**Requirements:** macOS, Python 3.11+, Claude Code CLI (must be logged in)

```bash
git clone https://github.com/agentmessier-ai/restwalker.git
cd restwalker
./install.sh
```

`install.sh` will:
1. Install Python dependencies
2. Patch the LaunchAgent plist with your Python path and home directory
3. Copy it to `~/Library/LaunchAgents/` and load it

Open `http://localhost:47290` to confirm it's running.

### Custom Python path

```bash
PYTHON=/opt/homebrew/bin/python3 ./install.sh
```

## Uninstall

```bash
./uninstall.sh
```

Stops the service, removes the LaunchAgent, and optionally deletes `~/.restwalker/` (DB + logs). The app directory is left in place — delete it manually if you want.

## Wiring up a job runner

Query `/can-run` before starting any background job:

```python
import httpx

async def can_run() -> bool:
    try:
        resp = await httpx.AsyncClient(timeout=5).get(
            "http://localhost:47290/can-run", params={"project": "my-project"}
        )
        return resp.json().get("ok", True)
    except Exception:
        return True  # restwalker unreachable — proceed anyway
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

| File | Purpose |
|---|---|
| `app.py` | FastAPI app, FSEvents watcher, background poller |
| `scheduler.py` | Time gating, Anthropic API fetch, budget logic |
| `db.py` | SQLite: usage_snapshots + settings tables |
| `index.html` | Dashboard UI (Chart.js, no build step) |
| `requirements.txt` | Python dependencies |
| `com.restwalker.plist` | LaunchAgent template |
| `install.sh` | One-command installer |
| `uninstall.sh` | Clean removal |

## Logs

```bash
tail -f ~/.restwalker/restwalker.log
```

## Name

Inspired by 梦游 (mèngyóu) — sleepwalking. While you rest, it walks through your Claude Max quota so nothing goes to waste.
