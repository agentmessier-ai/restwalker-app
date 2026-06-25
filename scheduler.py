"""Time gating and budget-aware routing for Claude Max plan."""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

PST = ZoneInfo("America/Los_Angeles")

USAGE_CACHE = Path(os.environ.get(
    "CLAUDE_USAGE_CACHE",
    Path.home() / ".claude" / ".usage_cache.json",
))


# ── Usage reading ─────────────────────────────────────────────────────────────

def read_usage(cache_stale_s: float = 1800) -> dict:
    """Read current Claude Max usage from the Claude Code CLI cache file.

    Returns dict with: five_hour_pct, weekly_pct, weekly_resets_at, age_s, stale.
    Returns {} if the file does not exist or cannot be parsed.
    """
    if not USAGE_CACHE.exists():
        return {}
    try:
        stat = USAGE_CACHE.stat()
        age_s = datetime.now().timestamp() - stat.st_mtime
        data = json.loads(USAGE_CACHE.read_text())
        rl = data.get("rate_limits", {})

        five_h_pct   = rl.get("five_hour", {}).get("used_percentage")
        weekly_pct   = rl.get("seven_day", {}).get("used_percentage")
        resets_epoch = rl.get("seven_day", {}).get("resets_at")

        if five_h_pct is None or weekly_pct is None:
            return {}

        resets_at = None
        if resets_epoch:
            resets_at = datetime.fromtimestamp(float(resets_epoch), tz=timezone.utc).isoformat()

        return {
            "five_hour_pct":    float(five_h_pct),
            "weekly_pct":       float(weekly_pct),
            "weekly_resets_at": resets_at,
            "age_s":            age_s,
            "stale":            age_s > cache_stale_s,
        }
    except Exception as e:
        logger.warning(f"[scheduler] failed to read usage cache: {e}")
        return {}


# ── Time gate ─────────────────────────────────────────────────────────────────

def is_coding_window(now: datetime | None = None, start_h: int = 16, end_h: int = 2) -> bool:
    """True if current PST time is inside the coding window."""
    pst = (now or datetime.now(timezone.utc)).astimezone(PST)
    h = pst.hour
    return h >= start_h or h < end_h


def next_idle_in_s(now: datetime | None = None, start_h: int = 16, end_h: int = 2) -> int:
    """Seconds until the idle window opens. 0 if already idle."""
    if not is_coding_window(now, start_h, end_h):
        return 0
    pst = (now or datetime.now(timezone.utc)).astimezone(PST)
    h, m, s = pst.hour, pst.minute, pst.second
    if h >= start_h:
        remaining = (24 - h + end_h) * 3600 - m * 60 - s
    else:
        remaining = (end_h - h) * 3600 - m * 60 - s
    return max(60, remaining)


# ── Gate check ────────────────────────────────────────────────────────────────

def can_run(usage: dict | None = None, cfg: dict | None = None) -> dict:
    """Should a background job run now?

    cfg keys: CODING_START_H, CODING_END_H, FIVE_HOUR_PAUSE_PCT,
              WEEKLY_RESERVE_PCT, WEEKLY_HARD_STOP_PCT, CACHE_STALE_MIN
    """
    from db import get_settings
    s = cfg or get_settings()

    start_h   = int(s.get("CODING_START_H",      16))
    end_h     = int(s.get("CODING_END_H",         2))
    five_h_t  = float(s.get("FIVE_HOUR_PAUSE_PCT", 75))
    reserve   = float(s.get("WEEKLY_RESERVE_PCT",  35))
    hard_stop = float(s.get("WEEKLY_HARD_STOP_PCT",90))
    stale_s   = float(s.get("CACHE_STALE_MIN",     30)) * 60

    now = datetime.now(timezone.utc)

    if is_coding_window(now, start_h, end_h):
        idle_in = next_idle_in_s(now, start_h, end_h)
        return {
            "ok": False,
            "provider": None,
            "reason": f"coding window ({start_h}:00–{end_h}:00 PST); idle in {idle_in // 60}m",
            "next_idle_in_s": idle_in,
        }

    u = usage if usage is not None else read_usage(stale_s)

    if u and not u.get("stale"):
        five_h  = u["five_hour_pct"]
        weekly  = u["weekly_pct"]
        ceiling = 100 - reserve

        if five_h >= five_h_t:
            return {
                "ok": False, "provider": None, "next_idle_in_s": 0,
                "reason": f"5h={five_h:.0f}% ≥ {five_h_t:.0f}% — pausing to protect coding budget",
            }
        if weekly >= hard_stop:
            resets = u.get("weekly_resets_at", "?")
            return {
                "ok": False, "provider": None, "next_idle_in_s": 0,
                "reason": f"weekly={weekly:.0f}% ≥ {hard_stop:.0f}% — hard stop until {resets}",
            }
        if weekly >= ceiling:
            return {
                "ok": False, "provider": None, "next_idle_in_s": 0,
                "reason": f"weekly={weekly:.0f}% ≥ {ceiling:.0f}% — reserving {reserve:.0f}% for coding",
            }

    return {
        "ok": True,
        "provider": "max",
        "reason": "idle window, budget healthy",
        "next_idle_in_s": 0,
    }
