"""cc-provider: Claude Mac plan router — runs on Mac as a background service."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

import db
import scheduler

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


# ── Sync helper ───────────────────────────────────────────────────────────────

def _do_sync() -> dict:
    """Read .usage_cache.json immediately and write to DB if fresh."""
    cfg = db.get_settings()
    stale_s = float(cfg.get("CACHE_STALE_MIN", 30)) * 60
    usage = scheduler.read_usage(stale_s)
    if usage and not usage.get("stale"):
        db.record_snapshot(usage["five_hour_pct"], usage["weekly_pct"], usage.get("weekly_resets_at"))
        logger.info(f"[sync] 5h={usage['five_hour_pct']:.1f}% weekly={usage['weekly_pct']:.1f}%")
    else:
        age = usage.get("age_s", -1) if usage else -1
        logger.debug(f"[sync] cache stale (age={age:.0f}s) — skipping record")
    return usage


# ── File watcher ──────────────────────────────────────────────────────────────
# React the instant the Claude Code CLI writes .usage_cache.json rather than
# polling on a fixed interval. Falls back to a periodic sweep for safety.

class _CacheHandler(FileSystemEventHandler):
    def __init__(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop
        self._target = str(scheduler.USAGE_CACHE)

    def on_modified(self, event):
        if not event.is_directory and event.src_path == self._target:
            logger.info("[watcher] cache file changed — syncing")
            self._loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(_async_sync())
            )


async def _async_sync():
    try:
        _do_sync()
    except Exception as e:
        logger.warning(f"[watcher] sync error: {e}")


async def _background_watcher():
    """Watch .usage_cache.json via FSEvents + periodic fallback sweep."""
    loop = asyncio.get_event_loop()
    handler = _CacheHandler(loop)
    observer = Observer()
    watch_dir = str(scheduler.USAGE_CACHE.parent)
    observer.schedule(handler, watch_dir, recursive=False)
    observer.start()
    logger.info(f"[watcher] watching {scheduler.USAGE_CACHE}")

    cfg = db.get_settings()
    fallback_s = float(cfg.get("POLL_INTERVAL_MIN", 5)) * 60
    try:
        while True:
            # Periodic sweep — catches cases where FSEvents missed a write
            await asyncio.sleep(fallback_s)
            cfg = db.get_settings()
            fallback_s = float(cfg.get("POLL_INTERVAL_MIN", 5)) * 60
            _do_sync()
    finally:
        observer.stop()
        observer.join()


# ── App lifespan ──────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    db.migrate()
    logger.info(f"[cc-provider] started — watching {scheduler.USAGE_CACHE}")
    task = asyncio.create_task(_background_watcher())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="cc-provider", version="1.0.0", lifespan=lifespan)


# ── Sync ──────────────────────────────────────────────────────────────────────

@app.post("/sync")
def sync():
    """Immediately read .usage_cache.json and write to DB. Called on page open."""
    usage = _do_sync()
    return {"ok": True, "stale": usage.get("stale", True) if usage else True}


# ── Routing ───────────────────────────────────────────────────────────────────

@app.get("/can-run")
def can_run(project: str = "default"):
    """Can a background job run right now? Returns: ok, provider, reason."""
    cfg   = db.get_settings()
    usage = scheduler.read_usage(float(cfg.get("CACHE_STALE_MIN", 30)) * 60)
    result = scheduler.can_run(usage, cfg)
    logger.info(f"[can-run] project={project!r} ok={result['ok']} reason={result['reason']!r}")
    return result


@app.get("/status")
def status():
    """Full scheduler state: window, usage, thresholds."""
    cfg   = db.get_settings()
    stale_s = float(cfg.get("CACHE_STALE_MIN", 30)) * 60
    now   = datetime.now(timezone.utc)
    usage = scheduler.read_usage(stale_s)
    decision = scheduler.can_run(usage, cfg)
    snap  = db.latest_snapshot()

    start_h = int(cfg.get("CODING_START_H", 16))
    end_h   = int(cfg.get("CODING_END_H",   2))

    return {
        "window":          "coding" if scheduler.is_coding_window(now, start_h, end_h) else "idle",
        "next_idle_in_s":  scheduler.next_idle_in_s(now, start_h, end_h),
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
            "coding_start_h":       start_h,
            "coding_end_h":         end_h,
            "five_hour_pause_pct":  float(cfg.get("FIVE_HOUR_PAUSE_PCT",  75)),
            "weekly_reserve_pct":   float(cfg.get("WEEKLY_RESERVE_PCT",   35)),
            "weekly_hard_stop_pct": float(cfg.get("WEEKLY_HARD_STOP_PCT", 90)),
            "cache_stale_min":      float(cfg.get("CACHE_STALE_MIN",      30)),
            "poll_interval_min":    float(cfg.get("POLL_INTERVAL_MIN",     5)),
        },
    }


# ── Settings ──────────────────────────────────────────────────────────────────

@app.get("/settings")
def get_settings():
    return db.get_settings()


@app.post("/settings")
def post_settings(body: dict):
    allowed = set(db.SETTING_DEFAULTS.keys())
    unknown = set(body.keys()) - allowed
    if unknown:
        raise HTTPException(422, f"Unknown settings: {unknown}")
    db.update_settings(body)
    return {"ok": True, "settings": db.get_settings()}


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
