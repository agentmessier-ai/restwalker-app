"""SQLite store for cc-provider: usage history + settings."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
import os

DB_PATH = Path(os.environ.get(
    "CC_PROVIDER_DB",
    Path.home() / ".cc-provider" / "cc-provider.db",
))

# Defaults — env vars win over these; DB settings win over env vars.
SETTING_DEFAULTS: dict[str, str] = {
    "CODING_START_H":       os.environ.get("CODING_START_H",        "16"),
    "CODING_END_H":         os.environ.get("CODING_END_H",          "2"),
    "TIMEZONE":             os.environ.get("TIMEZONE",              "America/Los_Angeles"),
    "FIVE_HOUR_PAUSE_PCT":  os.environ.get("FIVE_HOUR_THROTTLE_PCT","75"),
    "WEEKLY_RESERVE_PCT":   os.environ.get("WEEKLY_RESERVE_PCT",    "35"),
    "WEEKLY_HARD_STOP_PCT": os.environ.get("WEEKLY_HARD_STOP_PCT",  "90"),
    "POLL_INTERVAL_MIN":    os.environ.get("POLL_INTERVAL_MIN",     "5"),
    "CACHE_STALE_MIN":      os.environ.get("CACHE_STALE_MIN",       "30"),
}


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    return con


@contextmanager
def tx():
    con = _conn()
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def migrate() -> None:
    with tx() as con:
        con.executescript("""
        CREATE TABLE IF NOT EXISTS usage_snapshots (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            five_hour_pct    REAL    NOT NULL,
            weekly_pct       REAL    NOT NULL,
            weekly_resets_at TEXT,
            recorded_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        );
        CREATE INDEX IF NOT EXISTS usage_snapshots_recorded_at
            ON usage_snapshots(recorded_at DESC);

        CREATE TABLE IF NOT EXISTS settings (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        );
        """)
        # Seed defaults (only inserts if key doesn't exist yet)
        for k, v in SETTING_DEFAULTS.items():
            con.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (k, v)
            )
        # Prune snapshots older than 14 days
        con.execute(
            "DELETE FROM usage_snapshots "
            "WHERE recorded_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-14 days')"
        )


# ── Settings ──────────────────────────────────────────────────────────────────

def get_settings() -> dict[str, str]:
    con = _conn()
    rows = con.execute("SELECT key, value FROM settings").fetchall()
    con.close()
    result = dict(SETTING_DEFAULTS)
    result.update({r["key"]: r["value"] for r in rows})
    return result


def update_settings(updates: dict[str, str]) -> None:
    with tx() as con:
        for k, v in updates.items():
            if k not in SETTING_DEFAULTS:
                raise ValueError(f"Unknown setting: {k}")
            con.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, "
                "updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')",
                (k, str(v)),
            )


# ── Usage snapshots ───────────────────────────────────────────────────────────

def record_snapshot(five_hour_pct: float, weekly_pct: float, weekly_resets_at: str | None) -> None:
    with tx() as con:
        con.execute(
            "INSERT INTO usage_snapshots (five_hour_pct, weekly_pct, weekly_resets_at) VALUES (?,?,?)",
            (five_hour_pct, weekly_pct, weekly_resets_at),
        )


def latest_snapshot() -> dict | None:
    con = _conn()
    row = con.execute(
        "SELECT * FROM usage_snapshots ORDER BY recorded_at DESC LIMIT 1"
    ).fetchone()
    con.close()
    return dict(row) if row else None


def usage_history(hours: int = 48) -> list[dict]:
    """Return 15-min bucketed usage snapshots for the last N hours."""
    con = _conn()
    rows = con.execute("""
        SELECT
            strftime('%Y-%m-%dT%H:', recorded_at) ||
                printf('%02d', (CAST(strftime('%M', recorded_at) AS INTEGER) / 15) * 15) ||
                ':00Z' AS bucket,
            ROUND(AVG(five_hour_pct), 1) AS five_hour_pct,
            ROUND(AVG(weekly_pct), 1)    AS weekly_pct,
            COUNT(*)                      AS samples
        FROM usage_snapshots
        WHERE recorded_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ? || ' hours')
        GROUP BY bucket
        ORDER BY bucket ASC
    """, (f"-{hours}",)).fetchall()
    con.close()
    return [dict(r) for r in rows]
