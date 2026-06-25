"""Time gating and budget-aware provider routing for Claude Max plan."""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

PST = ZoneInfo("America/Los_Angeles")

# ── Config (all env-overridable) ──────────────────────────────────────────────

CODING_START_H       = int(os.environ.get("CODING_START_H",          "16"))   # 4pm PST
CODING_END_H         = int(os.environ.get("CODING_END_H",            "2"))    # 2am PST
FIVE_HOUR_THROTTLE   = float(os.environ.get("FIVE_HOUR_THROTTLE_PCT","75"))   # pause when hit
WEEKLY_RESERVE_PCT   = float(os.environ.get("WEEKLY_RESERVE_PCT",    "35"))   # keep for coding
WEEKLY_HARD_STOP_PCT = float(os.environ.get("WEEKLY_HARD_STOP_PCT",  "90"))   # hard stop

USAGE_CACHE = Path(os.environ.get(
    "CLAUDE_USAGE_CACHE",
    Path.home() / ".claude" / ".usage_cache.json",
))
# Cache is written by Claude Code CLI on every status tick.
# Treat as stale if older than this many seconds (no active session).
CACHE_STALE_S = int(os.environ.get("CACHE_STALE_S", "1800"))  # 30 min


# ── Usage reading ─────────────────────────────────────────────────────────────

def read_usage() -> dict:
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

        five_h_pct   = rl.get("five_hour",  {}).get("used_percentage")
        weekly_pct   = rl.get("seven_day",  {}).get("used_percentage")
        resets_epoch = rl.get("seven_day",  {}).get("resets_at")

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
            "stale":            age_s > CACHE_STALE_S,
        }
    except Exception as e:
        logger.warning(f"[scheduler] failed to read usage cache: {e}")
        return {}


# ── Time gate ─────────────────────────────────────────────────────────────────

def is_coding_window(now: datetime | None = None) -> bool:
    """True if current PST time is inside the coding window (4pm – 2am)."""
    pst = (now or datetime.now(timezone.utc)).astimezone(PST)
    h = pst.hour
    return h >= CODING_START_H or h < CODING_END_H


def next_idle_in_s(now: datetime | None = None) -> int:
    """Seconds until the idle window opens (2am PST). 0 if already idle."""
    if not is_coding_window(now):
        return 0
    pst = (now or datetime.now(timezone.utc)).astimezone(PST)
    h, m, s = pst.hour, pst.minute, pst.second
    if h >= CODING_START_H:
        remaining = (24 - h + CODING_END_H) * 3600 - m * 60 - s
    else:
        remaining = (CODING_END_H - h) * 3600 - m * 60 - s
    return max(60, remaining)


# ── Gate check ────────────────────────────────────────────────────────────────

def can_run(usage: dict | None = None) -> dict:
    """Top-level decision: should a background job run now?

    Returns:
      ok        — True if a job may start now (always on 'max' when ok)
      provider  — 'max' | None
      reason    — human-readable explanation
    """
    now = datetime.now(timezone.utc)

    if is_coding_window(now):
        idle_in = next_idle_in_s(now)
        return {
            "ok": False,
            "provider": None,
            "reason": f"coding window (4pm–2am PST); idle in {idle_in // 60}m",
            "next_idle_in_s": idle_in,
        }

    u = usage if usage is not None else read_usage()

    if u and not u.get("stale"):
        five_h  = u["five_hour_pct"]
        weekly  = u["weekly_pct"]
        ceiling = 100 - WEEKLY_RESERVE_PCT

        if five_h >= FIVE_HOUR_THROTTLE:
            return {
                "ok": False,
                "provider": None,
                "reason": f"5h={five_h:.0f}% ≥ {FIVE_HOUR_THROTTLE:.0f}% — pausing to protect coding budget",
                "next_idle_in_s": 0,
            }

        if weekly >= WEEKLY_HARD_STOP_PCT:
            resets = u.get("weekly_resets_at", "?")
            return {
                "ok": False,
                "provider": None,
                "reason": f"weekly={weekly:.0f}% ≥ {WEEKLY_HARD_STOP_PCT:.0f}% — hard stop until {resets}",
                "next_idle_in_s": 0,
            }

        if weekly >= ceiling:
            return {
                "ok": False,
                "provider": None,
                "reason": f"weekly={weekly:.0f}% ≥ {ceiling:.0f}% — reserving {WEEKLY_RESERVE_PCT:.0f}% for coding",
                "next_idle_in_s": 0,
            }

    return {
        "ok": True,
        "provider": "max",
        "reason": "idle window, budget healthy",
        "next_idle_in_s": 0,
    }
