"""cc-provider: Claude Max plan router — runs on Mac as a background service."""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse

import db
import scheduler

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

POLL_INTERVAL_S = int(os.environ.get("POLL_INTERVAL_S", "300"))  # 5 min


# ── Background poller ─────────────────────────────────────────────────────────

async def _usage_poller():
    """Poll ~/.claude/.usage_cache.json every POLL_INTERVAL_S seconds.

    Writes a snapshot to SQLite only when the cache is fresh (an active Claude
    Code session is running). Stale reads are skipped — no point recording zeros.
    """
    logger.info(f"[poller] started — polling every {POLL_INTERVAL_S}s")
    while True:
        try:
            usage = scheduler.read_usage()
            if usage and not usage.get("stale"):
                db.record_snapshot(
                    usage["five_hour_pct"],
                    usage["weekly_pct"],
                    usage.get("weekly_resets_at"),
                )
                logger.debug(
                    f"[poller] recorded 5h={usage['five_hour_pct']:.1f}% "
                    f"weekly={usage['weekly_pct']:.1f}%"
                )
            else:
                age = usage.get("age_s", -1) if usage else -1
                logger.debug(f"[poller] cache stale (age={age:.0f}s) — skipping")
        except Exception as e:
            logger.warning(f"[poller] error: {e}")
        await asyncio.sleep(POLL_INTERVAL_S)


# ── App lifespan ──────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    db.migrate()
    logger.info(f"[cc-provider] started — watching {scheduler.USAGE_CACHE}")
    task = asyncio.create_task(_usage_poller())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="cc-provider", version="1.0.0", lifespan=lifespan)


# ── Routing ───────────────────────────────────────────────────────────────────

@app.get("/can-run")
def can_run(project: str = "default"):
    """Can a background job run right now?

    Returns: ok (bool), provider ('max' | null), reason (str).
    """
    usage = scheduler.read_usage()
    result = scheduler.can_run(usage)
    logger.info(f"[can-run] project={project!r} ok={result['ok']} reason={result['reason']!r}")
    return result


@app.get("/status")
def status():
    """Full scheduler state: window, usage, thresholds."""
    now = datetime.now(timezone.utc)
    usage = scheduler.read_usage()
    decision = scheduler.can_run(usage)
    snap = db.latest_snapshot()

    return {
        "window":          "coding" if scheduler.is_coding_window(now) else "idle",
        "next_idle_in_s":  scheduler.next_idle_in_s(now),
        "ok":              decision["ok"],
        "provider":        decision.get("provider"),
        "reason":          decision["reason"],
        "usage": {
            "five_hour_pct":    usage.get("five_hour_pct"),
            "weekly_pct":       usage.get("weekly_pct"),
            "weekly_resets_at": usage.get("weekly_resets_at"),
            "cache_age_s":      round(usage.get("age_s", 0), 1) if usage else None,
            "stale":            usage.get("stale", True),
        },
        "last_db_snapshot": dict(snap) if snap else None,
        "thresholds": {
            "coding_start_h":       scheduler.CODING_START_H,
            "coding_end_h":         scheduler.CODING_END_H,
            "five_hour_pause_pct":  scheduler.FIVE_HOUR_THROTTLE,
            "weekly_reserve_pct":   scheduler.WEEKLY_RESERVE_PCT,
            "weekly_hard_stop_pct": scheduler.WEEKLY_HARD_STOP_PCT,
            "cache_stale_s":        scheduler.CACHE_STALE_S,
        },
    }


# ── History ───────────────────────────────────────────────────────────────────

@app.get("/history")
def history(hours: int = 48):
    return {"history": db.usage_history(hours)}


# ── UI ────────────────────────────────────────────────────────────────────────

@app.get("/")
def ui():
    return FileResponse(Path(__file__).parent / "index.html")


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/healthz")
def healthz():
    return {"ok": True}
