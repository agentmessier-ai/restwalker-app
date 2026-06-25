# cc-provider

Mac background service that smartly gates Claude Max plan usage for background jobs.

Runs as a LaunchAgent on port **47290**, owns its own SQLite DB, and exposes:
- a scheduling API (`/can-run`) for factory-research hub to query before claiming jobs
- a live dashboard UI at `http://localhost:47290`

## How it works

Usage data is fetched live from `api.anthropic.com/api/oauth/usage` using the OAuth token stored in your macOS Keychain (`Claude Code-credentials`). This is the same endpoint the `ccstatusline` shell widget uses — always real-time, never stale.

Data is cached in memory for 5 minutes to avoid rate-limiting. The background poller refreshes every `POLL_INTERVAL_MIN` minutes and persists snapshots to SQLite for trend charts.

### Budget gates (all configurable via the gear icon)

| Gate | Default | Behaviour |
|---|---|---|
| Coding window | 16:00–02:00 PST | Always `ok=false` during active hours |
| 5h usage | ≥ 75% | Pause to protect interactive budget |
| Weekly ceiling | ≥ 65% (100 − 35% reserve) | Pause background jobs |
| Weekly hard stop | ≥ 90% | Hard pause regardless |

When `ok=true`, the hub runs the job with `provider=max`. When `ok=false`, the hub sleeps 5 min and retries.

## Dashboard

`http://localhost:47290` shows:

- Current window, 5h usage, weekly usage, next milestone
- 48h trend chart (5h and weekly lines, threshold overlays, coding-window shading)
- 4 linear-regression predictions (next hour / 4h / 8h / 24h)
- Gear modal to configure all thresholds without restarting the service

## Setup

### 1. Install dependencies

```bash
cd ~/dev/cc-provider
pip install -r requirements.txt
```

### 2. Install as LaunchAgent

```bash
cp com.cc-provider.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.cc-provider.plist
```

The plist uses `~/miniconda3/bin/python3`. Edit `ProgramArguments` if your Python path differs.

### 3. Wire up factory-research hub

Set `CC_PROVIDER_URL=http://192.168.0.124:47290` in the hub's environment (already in `deploy/k3s/hub-deployment.yaml`).

## API

| Endpoint | Method | Description |
|---|---|---|
| `/can-run?project=<name>` | GET | `{ok, provider, reason, next_idle_in_s}` |
| `/status` | GET | Full state: window, usage, thresholds, last snapshot |
| `/sync` | POST | Force immediate API fetch + DB record (called by UI on open) |
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
| `com.cc-provider.plist` | LaunchAgent template |

## Logs

```bash
tail -f ~/.cc-provider/cc-provider.log
```
