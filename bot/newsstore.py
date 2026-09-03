"""
Supabase adapter for THE EMOJI news notifier.

Separate from `storage.py` on purpose: that module is the buy bot's, its caches
are tuned for a 5s chain-poll loop, and welding a second bot's tables into it
would mean one cache TTL serving two very different read patterns.

Same service-role key, same egress discipline — see the note in storage.py about
the quota that uncached polling burned through.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

import requests

import config

log = logging.getLogger("newsstore")

TIMEOUT = 12


def _hdr(prefer: str = "return=representation") -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": prefer,
    }


def _url(path: str) -> str:
    return f"{config.SUPABASE_URL}/rest/v1/{path}"


# ─────────────────────────────────────────────────────────────
# CONNECTION + STATE
# ─────────────────────────────────────────────────────────────
def load_connection() -> dict:
    """Token, username and the master enable switch. Not cached: the loop reads
    it once per cycle at 90s, which is already slower than storage.py's TTL."""
    r = requests.get(_url("news_bot_connection?id=eq.main&select=*"), headers=_hdr(), timeout=TIMEOUT)
    r.raise_for_status()
    rows = r.json()
    if not rows:
        log.warning("no news_bot_connection row — did you run SUPABASE_NEWSBOT.sql?")
        return {"telegram_token": "", "bot_username": "", "enabled": False}
    row = rows[0]
    return {
        "telegram_token": row.get("telegram_token") or "",
        "bot_username": row.get("bot_username") or "",
        "enabled": bool(row.get("enabled")),
    }


def load_state() -> dict:
    r = requests.get(_url("news_state?id=eq.main&select=*"), headers=_hdr(), timeout=TIMEOUT)
    r.raise_for_status()
    rows = r.json()
    if not rows:
        return {"update_offset": 0, "config": {}}
    return {
        "update_offset": int(rows[0].get("update_offset") or 0),
        "config": rows[0].get("config") or {},
    }


def save_offset(offset: int) -> None:
    """⛔ Written after every drained batch, not on shutdown. A machine that is
    killed (Fly restarts, deploys) never runs a shutdown hook, and an offset
    only flushed at exit means the next boot replays the batch."""
    requests.patch(
        _url("news_state?id=eq.main"),
        headers=_hdr("return=minimal"),
        json={"update_offset": offset, "updated_at": "now()"},
        timeout=TIMEOUT,
    ).raise_for_status()


# ─────────────────────────────────────────────────────────────
# SUBSCRIBERS
# ─────────────────────────────────────────────────────────────
DEFAULT_TOPICS = {"news": True, "projects": True, "builders": True}


def subscribe(chat_id: str, chat_type: str, chat_title: str) -> dict:
    """Idempotent. ⛔ A returning subscriber keeps the topic choices they made
    before — `topics` is deliberately absent from the update below, so a second
    /start re-activates the row without resetting it to the defaults. Sending
    someone back to all-on because they typed /start twice is a small thing that
    reads as the bot ignoring them."""
    existing = get_sub(chat_id)
    body: dict[str, Any] = {
        "chat_id": str(chat_id),
        "chat_type": chat_type,
        "chat_title": chat_title,
        "active": True,
        "blocked_at": None,
        "updated_at": "now()",
    }
    if not existing:
        body["topics"] = DEFAULT_TOPICS
    r = requests.post(
        _url("news_subs"),
        headers=_hdr("resolution=merge-duplicates,return=representation"),
        json=body,
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    rows = r.json()
    return rows[0] if rows else body


def get_sub(chat_id: str) -> Optional[dict]:
    r = requests.get(
        _url(f"news_subs?chat_id=eq.{chat_id}&select=*"), headers=_hdr(), timeout=TIMEOUT
    )
    r.raise_for_status()
    rows = r.json()
    return rows[0] if rows else None


def set_active(chat_id: str, active: bool, blocked: bool = False) -> None:
    body: dict[str, Any] = {"active": active, "updated_at": "now()"}
    if blocked:
        body["blocked_at"] = "now()"
    requests.patch(
        _url(f"news_subs?chat_id=eq.{chat_id}"),
        headers=_hdr("return=minimal"), json=body, timeout=TIMEOUT,
    ).raise_for_status()


def set_topics(chat_id: str, topics: dict) -> None:
    requests.patch(
        _url(f"news_subs?chat_id=eq.{chat_id}"),
        headers=_hdr("return=minimal"),
        json={"topics": topics, "updated_at": "now()"},
        timeout=TIMEOUT,
    ).raise_for_status()


def active_subs() -> list[dict]:
    """Only the columns the fan-out needs. ⛔ `select=*` here would pull every
    subscriber's whole row on every announcement."""
    r = requests.get(
        _url("news_subs?active=is.true&select=chat_id,topics"), headers=_hdr(), timeout=TIMEOUT
    )
    r.raise_for_status()
    return r.json()


def count_subs() -> tuple[int, int]:
    """(active, total) — for the admin panel."""
    def n(q: str) -> int:
        r = requests.get(_url(q), headers={**_hdr(), "Prefer": "count=exact"},
                         timeout=TIMEOUT)
        r.raise_for_status()
        rng = r.headers.get("content-range", "*/0")
        return int(rng.split("/")[-1] or 0)
    return n("news_subs?active=is.true&select=chat_id"), n("news_subs?select=chat_id")


# ─────────────────────────────────────────────────────────────
# THE DESK — what to announce, and what has already gone out
# ─────────────────────────────────────────────────────────────
# ⛔ EXPLICIT COLUMN LISTS. `select=*` on desk_articles drags the whole body
#    array of every story across the wire on every poll, forever, to read a
#    title. This is the same egress lesson storage.py carries.
DESK = {
    "article": ("desk_articles", "id,title,dek,tag,date,by"),
    "project": ("desk_projects", "id,name,tag,blurb,status,emo"),
    "builder": ("desk_builders", "id,name,kind,tagline"),
}


def desk_rows(kind: str, limit: int = 30) -> list[dict]:
    table, cols = DESK[kind]
    r = requests.get(
        _url(f"{table}?select={cols}&order=created_at.desc&limit={limit}"),
        headers=_hdr(), timeout=TIMEOUT,
    )
    r.raise_for_status()
    return r.json()


def seen_ids(kind: str) -> set[str]:
    r = requests.get(
        _url(f"news_seen?kind=eq.{kind}&select=row_id"), headers=_hdr(), timeout=TIMEOUT
    )
    r.raise_for_status()
    return {row["row_id"] for row in r.json()}


def mark_seen(kind: str, row_ids: list[str]) -> None:
    """⛔⛔ CALLED BEFORE THE FAN-OUT, NOT AFTER. If it ran after sending and the
    machine died mid-broadcast, the row would still be unseen on the next cycle
    and everyone who already got it would get it again. Marking first means the
    worst case is one missed announcement — recoverable by hand — rather than a
    loop that re-sends the same story every 90 seconds to everybody."""
    if not row_ids:
        return
    requests.post(
        _url("news_seen"),
        headers=_hdr("resolution=ignore-duplicates,return=minimal"),
        json=[{"kind": kind, "row_id": r} for r in row_ids],
        timeout=TIMEOUT,
    ).raise_for_status()
