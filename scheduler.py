"""Time gating and budget-aware routing for Claude Max plan."""
from __future__ import annotations

import json
import logging
import os
import subprocess
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

def _tz(name: str = "America/Los_Angeles") -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except Exception:
        logger.warning(f"[scheduler] unknown timezone {name!r}, falling back to UTC")
        return ZoneInfo("UTC")

USAGE_CACHE = Path(os.environ.get(
    "CLAUDE_USAGE_CACHE",
    Path.home() / ".claude" / ".usage_cache.json",
))

USAGE_API = "https://api.anthropic.com/api/oauth/usage"
KEYCHAIN_SERVICE = "Claude Code-credentials"


# ── OAuth token ───────────────────────────────────────────────────────────────

def _read_keychain_token() -> str | None:
    """Read Claude Code OAuth access token from macOS Keychain."""
    try:
        raw = subprocess.check_output(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            stderr=subprocess.DEVNULL, timeout=5,
        ).decode().strip()
        data = json.loads(raw)
        return data.get("claudeAiOauth", {}).get("accessToken")
    except Exception:
        return None


# ── Usage reading ─────────────────────────────────────────────────────────────

def fetch_usage_from_api() -> dict:
    """Fetch live usage directly from api.anthropic.com/api/oauth/usage.

    This is the same endpoint ccstatusline uses — gives real-time percentages.
    Returns dict with: five_hour_pct, weekly_pct, weekly_resets_at, source='api'.
    Returns {} on failure.
    """
    token = _read_keychain_token()
    if not token:
        logger.warning("[scheduler] keychain token not found")
        return {}
    try:
        req = urllib.request.Request(
            USAGE_API,
            headers={
                "Authorization": f"Bearer {token}",
                "anthropic-beta": "oauth-2025-04-20",
            },
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())

        five_h  = data.get("five_hour", {})
        seven_d = data.get("seven_day", {})

        five_h_pct = five_h.get("utilization")
        weekly_pct = seven_d.get("utilization")

        if five_h_pct is None or weekly_pct is None:
            return {}

        resets_at = seven_d.get("resets_at")
        return {
            "five_hour_pct":    float(five_h_pct),
            "weekly_pct":       float(weekly_pct),
            "weekly_resets_at": resets_at,
            "age_s":            0.0,
            "stale":            False,
            "source":           "api",
        }
    except Exception as e:
        logger.warning(f"[scheduler] API fetch failed: {e}")
        return {}


def _read_usage_from_file(cache_stale_s: float = 1800) -> dict:
    """Fallback: read from .usage_cache.json written by Claude Code CLI."""
    if not USAGE_CACHE.exists():
        return {}
    try:
        stat = USAGE_CACHE.stat()
        age_s = datetime.now().timestamp() - stat.st_mtime
        data = json.loads(USAGE_CACHE.read_text())
        rl = data.get("rate_limits", {})
        five_h_pct = rl.get("five_hour", {}).get("used_percentage")
        weekly_pct = rl.get("seven_day", {}).get("used_percentage")
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
            "source":           "file",
        }
    except Exception as e:
        logger.warning(f"[scheduler] file read failed: {e}")
        return {}


# ── In-memory cache ───────────────────────────────────────────────────────────
# Prevents hammering the API on every /status request or watcher event.

_mem_cache: dict = {}
_mem_cache_ts: float = 0.0
MEM_CACHE_TTL_S: float = 300.0   # only call the API every 5 min max


def read_usage(cache_stale_s: float = 1800, force_refresh: bool = False) -> dict:
    """Return usage data with in-memory TTL.

    Calls the live API at most every MEM_CACHE_TTL_S seconds.
    Falls back to .usage_cache.json if API is unavailable.
    Pass force_refresh=True to bypass the in-memory TTL (used by /sync).
    """
    global _mem_cache, _mem_cache_ts
    import time
    now = time.monotonic()

    if not force_refresh and _mem_cache and (now - _mem_cache_ts) < MEM_CACHE_TTL_S:
        return _mem_cache

    usage = fetch_usage_from_api()
    if usage:
        _mem_cache = usage
        _mem_cache_ts = now
        return usage

    # API failed — fall back to file, but don't cache the fallback so we
    # retry the API on the next call.
    return _read_usage_from_file(cache_stale_s)


# ── Time gate ─────────────────────────────────────────────────────────────────

def is_coding_window(now: datetime | None = None, start_h: int = 16, end_h: int = 2, tz: str = "America/Los_Angeles") -> bool:
    local = (now or datetime.now(timezone.utc)).astimezone(_tz(tz))
    h = local.hour
    return h >= start_h or h < end_h


def next_idle_in_s(now: datetime | None = None, start_h: int = 16, end_h: int = 2, tz: str = "America/Los_Angeles") -> int:
    if not is_coding_window(now, start_h, end_h, tz):
        return 0
    local = (now or datetime.now(timezone.utc)).astimezone(_tz(tz))
    h, m, s = local.hour, local.minute, local.second
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
    tz        = s.get("TIMEZONE", "America/Los_Angeles")
    five_h_t  = float(s.get("FIVE_HOUR_PAUSE_PCT", 75))
    reserve   = float(s.get("WEEKLY_RESERVE_PCT",  35))
    hard_stop = float(s.get("WEEKLY_HARD_STOP_PCT",90))
    stale_s   = float(s.get("CACHE_STALE_MIN",     30)) * 60

    now = datetime.now(timezone.utc)

    if is_coding_window(now, start_h, end_h, tz):
        idle_in = next_idle_in_s(now, start_h, end_h, tz)
        return {
            "ok": False,
            "provider": None,
            "reason": f"coding window ({start_h}:00–{end_h}:00 {tz}); idle in {idle_in // 60}m",
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
