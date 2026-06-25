"""SQLite store for cc-provider: usage history and job accounting."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import os

DB_PATH = Path(os.environ.get(
    "CC_PROVIDER_DB",
    Path.home() / ".cc-provider" / "cc-provider.db",
))


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
    """Create tables if they don't exist."""
    with tx() as con:
        con.executescript("""
        CREATE TABLE IF NOT EXISTS usage_snapshots (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            five_hour_pct REAL    NOT NULL,
            weekly_pct    REAL    NOT NULL,
            weekly_resets_at TEXT,
            recorded_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        );
        CREATE INDEX IF NOT EXISTS usage_snapshots_recorded_at
            ON usage_snapshots(recorded_at DESC);

        CREATE TABLE IF NOT EXISTS job_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            project     TEXT    NOT NULL,
            provider    TEXT    NOT NULL,
            started_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
            finished_at TEXT,
            duration_s  REAL,
            notes       TEXT
        );
        """)
        # Prune usage_snapshots older than 14 days
        con.execute(
            "DELETE FROM usage_snapshots "
            "WHERE recorded_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-14 days')"
        )


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
    """Return bucketed (15-min) usage snapshots for the last N hours."""
    con = _conn()
    rows = con.execute("""
        SELECT
            strftime('%Y-%m-%dT%H:', recorded_at) ||
                printf('%02d', (CAST(strftime('%M', recorded_at) AS INTEGER) / 15) * 15) ||
                ':00Z' AS bucket,
            ROUND(AVG(five_hour_pct), 1)  AS five_hour_pct,
            ROUND(AVG(weekly_pct), 1)     AS weekly_pct,
            COUNT(*)                       AS samples
        FROM usage_snapshots
        WHERE recorded_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ? || ' hours')
        GROUP BY bucket
        ORDER BY bucket ASC
    """, (f"-{hours}",)).fetchall()
    con.close()
    return [dict(r) for r in rows]


def log_job_start(project: str, provider: str) -> int:
    with tx() as con:
        cur = con.execute(
            "INSERT INTO job_log (project, provider) VALUES (?,?)",
            (project, provider),
        )
        return cur.lastrowid


def log_job_finish(job_id: int, duration_s: float, notes: str = "") -> None:
    with tx() as con:
        con.execute(
            "UPDATE job_log SET finished_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), "
            "duration_s=?, notes=? WHERE id=?",
            (duration_s, notes, job_id),
        )


def recent_job_log(limit: int = 20) -> list[dict]:
    con = _conn()
    rows = con.execute(
        "SELECT * FROM job_log ORDER BY started_at DESC LIMIT ?", (limit,)
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]
