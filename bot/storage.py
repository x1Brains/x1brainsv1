"""
Supabase storage adapter for the bot.

Replaces the JSON-file storage with Supabase tables:
  - bot_connection: telegram token + chat + pool vaults
  - bot_settings:   event toggles + thresholds
  - bot_state:      per-account last-seen tx signatures

The bot uses the SERVICE role key (bypasses RLS), so it can read the
Telegram token and write to all tables. The token never leaves this
host or Supabase.
"""
from __future__ import annotations

import logging
import threading
from typing import Optional

import requests

import config

log = logging.getLogger("storage")

_lock = threading.Lock()


def _hdr() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _check_creds() -> None:
    if not config.SUPABASE_URL or not config.SUPABASE_SERVICE_KEY:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set "
            "(use `fly secrets set` for prod)"
        )


# ─────────────────────────────────────────────────────────────
# CONNECTION
# ─────────────────────────────────────────────────────────────
def load_connection() -> dict:
    """Returns the raw connection row including the unmasked telegram_token."""
    _check_creds()
    with _lock:
        url = f"{config.SUPABASE_URL}/rest/v1/bot_connection?id=eq.main&select=*"
        r = requests.get(url, headers=_hdr(), timeout=10)
        r.raise_for_status()
        rows = r.json()
        if not rows:
            log.warning("No bot_connection row found — did you run SUPABASE_SCHEMA.sql?")
            return {
                "telegram_token": "", "chat_id": "", "chat_title": "",
                "vaults": {
                    "BRAINS": {"vault_token": "", "vault_quote": ""},
                    "LB":     {"vault_token": "", "vault_quote": ""},
                },
            }
        row = rows[0]
        return {
            "telegram_token": row.get("telegram_token") or "",
            "chat_id":        row.get("chat_id") or "",
            "chat_title":     row.get("chat_title") or "",
            "vaults": {
                "BRAINS": {
                    "vault_token": row.get("vault_brains_token") or "",
                    "vault_quote": row.get("vault_brains_quote") or "",
                },
                "LB": {
                    "vault_token": row.get("vault_lb_token") or "",
                    "vault_quote": row.get("vault_lb_quote") or "",
                },
            },
        }


def is_connection_complete() -> bool:
    try:
        c = load_connection()
        if not c["telegram_token"] or not c["chat_id"]:
            return False
        for sym in ("BRAINS", "LB"):
            v = c["vaults"][sym]
            if not v["vault_token"] or not v["vault_quote"]:
                return False
        return True
    except Exception as e:
        log.warning(f"is_connection_complete failed: {e}")
        return False


# ─────────────────────────────────────────────────────────────
# SETTINGS
# ─────────────────────────────────────────────────────────────
def load_settings() -> dict:
    _check_creds()
    with _lock:
        url = f"{config.SUPABASE_URL}/rest/v1/bot_settings?id=eq.main&select=config"
        try:
            r = requests.get(url, headers=_hdr(), timeout=10)
            r.raise_for_status()
            rows = r.json()
            stored = rows[0]["config"] if rows and rows[0].get("config") else {}
        except Exception as e:
            log.warning(f"load_settings failed, using defaults: {e}")
            stored = {}
        return {**config.DEFAULT_SETTINGS, **stored}


# ─────────────────────────────────────────────────────────────
# STATE (per-account last-seen sigs)
# ─────────────────────────────────────────────────────────────
def get_last_sig(account: str) -> Optional[str]:
    _check_creds()
    with _lock:
        try:
            url = f"{config.SUPABASE_URL}/rest/v1/bot_state?account=eq.{account}&select=last_sig"
            r = requests.get(url, headers=_hdr(), timeout=10)
            r.raise_for_status()
            rows = r.json()
            return rows[0]["last_sig"] if rows else None
        except Exception as e:
            log.warning(f"get_last_sig({account[:8]}…) failed: {e}")
            return None


def update_last_sig(account: str, sig: str) -> None:
    _check_creds()
    with _lock:
        try:
            # Upsert via PostgREST
            url = f"{config.SUPABASE_URL}/rest/v1/bot_state"
            headers = {**_hdr(), "Prefer": "resolution=merge-duplicates,return=minimal"}
            body = [{"account": account, "last_sig": sig}]
            r = requests.post(url, headers=headers, json=body, timeout=10)
            r.raise_for_status()
        except Exception as e:
            log.warning(f"update_last_sig({account[:8]}…) failed: {e}")


# ─────────────────────────────────────────────────────────────
# BANNERS (Supabase Storage public URLs)
# ─────────────────────────────────────────────────────────────
_banner_cache: dict[str, tuple[str, float]] = {}
_BANNER_TTL = 60  # seconds


def banner_url(token_symbol: str) -> Optional[str]:
    """
    Returns a public URL for the token's banner, or None if not uploaded.
    Cached for 60s to avoid hammering the storage API.
    """
    import time
    sym = token_symbol.upper()
    cached = _banner_cache.get(sym)
    if cached and time.time() - cached[1] < _BANNER_TTL:
        return cached[0] or None

    try:
        # List bot-banners files matching banner_<sym>.*
        url = f"{config.SUPABASE_URL}/storage/v1/object/list/bot-banners"
        body = {"prefix": "", "limit": 50, "search": f"banner_{sym.lower()}."}
        r = requests.post(url, headers=_hdr(), json=body, timeout=10)
        r.raise_for_status()
        files = r.json()
        match = next((f for f in files if f.get("name", "").startswith(f"banner_{sym.lower()}.")), None)
        if not match:
            _banner_cache[sym] = ("", time.time())
            return None
        public_url = (
            f"{config.SUPABASE_URL}/storage/v1/object/public/bot-banners/{match['name']}"
        )
        _banner_cache[sym] = (public_url, time.time())
        return public_url
    except Exception as e:
        log.warning(f"banner_url({sym}) failed: {e}")
        return None
