"""cc-provider: Claude Max plan router — runs on Mac, serves the local network."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse

import db
import scheduler

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="cc-provider", version="1.0.0")


@app.on_event("startup")
def startup():
    db.migrate()
    logger.info("[cc-provider] started — reading %s", scheduler.USAGE_CACHE)


# ── Routing ───────────────────────────────────────────────────────────────────

@app.get("/can-run")
def can_run(project: str = "default"):
    """Can a background job run right now?

    Returns: ok (bool), provider ('max' | null), reason (str).
    """
    usage = scheduler.read_usage()
    result = scheduler.can_run(usage)

    if usage and not usage.get("stale"):
        try:
            db.record_snapshot(usage["five_hour_pct"], usage["weekly_pct"], usage.get("weekly_resets_at"))
        except Exception as e:
            logger.warning(f"snapshot write failed: {e}")

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
