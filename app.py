"""cc-provider: Claude Max plan router — runs on Mac, serves the local network."""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import db
import scheduler

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="cc-provider", version="1.0.0")


@app.on_event("startup")
def startup():
    db.migrate()
    logger.info("[cc-provider] started — reading %s", scheduler.USAGE_CACHE)


# ── Core routing endpoints ────────────────────────────────────────────────────

@app.get("/can-run")
def can_run(project: str = "default"):
    """Primary endpoint: should a background job run, and on which provider?

    Query params:
      project  — caller identifier (logged, optional)

    Response:
      ok        bool    — True if a job may start now
      provider  str     — 'max' | 'deepseek' | null
      reason    str     — human-readable explanation
    """
    usage = scheduler.read_usage()
    result = scheduler.can_run(usage)

    # Snapshot current usage while we have it
    if usage and not usage.get("stale"):
        try:
            db.record_snapshot(
                usage["five_hour_pct"],
                usage["weekly_pct"],
                usage.get("weekly_resets_at"),
            )
        except Exception as e:
            logger.warning(f"snapshot write failed: {e}")

    logger.info(
        f"[can-run] project={project!r} ok={result['ok']} "
        f"provider={result.get('provider')} reason={result['reason']!r}"
    )
    return result


@app.get("/status")
def status():
    """Full scheduler state: usage, window, provider decision, thresholds."""
    now = datetime.now(timezone.utc)
    usage = scheduler.read_usage()
    decision = scheduler.can_run(usage)
    snap = db.latest_snapshot()

    return {
        "window":           "coding" if scheduler.is_coding_window(now) else "idle",
        "next_idle_in_s":   scheduler.next_idle_in_s(now),
        "ok":               decision["ok"],
        "provider":         decision.get("provider"),
        "reason":           decision["reason"],
        "usage": {
            "five_hour_pct":    usage.get("five_hour_pct"),
            "weekly_pct":       usage.get("weekly_pct"),
            "weekly_resets_at": usage.get("weekly_resets_at"),
            "cache_age_s":      round(usage.get("age_s", 0), 1) if usage else None,
            "stale":            usage.get("stale", True),
        },
        "last_db_snapshot":  dict(snap) if snap else None,
        "thresholds": {
            "coding_start_h":        scheduler.CODING_START_H,
            "coding_end_h":          scheduler.CODING_END_H,
            "five_hour_throttle_pct": scheduler.FIVE_HOUR_THROTTLE,
            "weekly_reserve_pct":    scheduler.WEEKLY_RESERVE_PCT,
            "weekly_hard_stop_pct":  scheduler.WEEKLY_HARD_STOP_PCT,
            "cache_stale_s":         scheduler.CACHE_STALE_S,
        },
    }


# ── Job accounting ────────────────────────────────────────────────────────────

class JobStart(BaseModel):
    project: str
    provider: str


class JobFinish(BaseModel):
    duration_s: float
    notes: str = ""


@app.post("/jobs/start")
def job_start(body: JobStart):
    """Log a job starting. Returns job_id for later /jobs/{id}/finish."""
    job_id = db.log_job_start(body.project, body.provider)
    return {"job_id": job_id}


@app.post("/jobs/{job_id}/finish")
def job_finish(job_id: int, body: JobFinish):
    """Log a job completing."""
    db.log_job_finish(job_id, body.duration_s, body.notes)
    return {"ok": True}


@app.get("/jobs")
def jobs(limit: int = 20):
    """Recent job log."""
    return {"jobs": db.recent_job_log(limit)}


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/healthz")
def healthz():
    return {"ok": True}
