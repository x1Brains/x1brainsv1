"""Price helpers using XDEX API + on-chain pool reserves."""
from __future__ import annotations

import logging
import time
from decimal import Decimal
from typing import Optional

import requests

import config

log = logging.getLogger("prices")

_cache: dict[str, dict] = {}


def _get_cached(mint: str) -> Optional[Decimal]:
    e = _cache.get(mint)
    if not e: return None
    if time.time() - e["ts"] > config.PRICE_CACHE_TTL: return None
    return e["price"]


def get_token_usd_price(mint: str) -> Optional[Decimal]:
    cached = _get_cached(mint)
    if cached is not None: return cached
    try:
        url = (f"{config.XDEX_PRICE_BASE}/token-price/price"
               f"?network=X1+Mainnet&token_address={mint}")
        r = requests.get(url, timeout=8)
        r.raise_for_status()
        j = r.json()
        if j.get("success") and j.get("data", {}).get("price") is not None:
            price = Decimal(str(j["data"]["price"]))
            _cache[mint] = {"price": price, "ts": time.time()}
            return price
    except Exception as e:
        log.warning(f"XDEX price fetch failed for {mint[:8]}…: {e}")
    return None


def get_xnt_usd_price() -> Optional[Decimal]:
    return get_token_usd_price(config.WXNT_MINT)


def get_token_metrics(rpc, token_cfg: dict) -> Optional[dict]:
    try:
        price_usd = get_token_usd_price(token_cfg["mint"])
        xnt_usd = get_xnt_usd_price()
        supply_resp = rpc.get_token_supply(token_cfg["mint"])

        supply_ui = None
        if supply_resp and supply_resp.get("value"):
            supply_ui = Decimal(supply_resp["value"]["amount"]) / Decimal(10 ** token_cfg["decimals"])

        mcap_usd = None
        if price_usd and supply_ui:
            mcap_usd = price_usd * supply_ui

        tvl_usd = None
        v_token = token_cfg.get("vault_token")
        v_quote = token_cfg.get("vault_quote")
        if v_token and v_quote and price_usd is not None and xnt_usd is not None:
            tok_bal = rpc.get_token_account_balance(v_token)
            xnt_bal = rpc.get_token_account_balance(v_quote)
            if tok_bal and xnt_bal:
                tok_amt = Decimal(tok_bal["value"]["amount"]) / Decimal(10 ** token_cfg["decimals"])
                xnt_amt = Decimal(xnt_bal["value"]["amount"]) / Decimal(10 ** 9)
                tvl_usd = (tok_amt * price_usd) + (xnt_amt * xnt_usd)

        return {"price_usd": price_usd, "mcap_usd": mcap_usd,
                "tvl_usd": tvl_usd, "supply": supply_ui}
    except Exception as e:
        log.warning(f"get_token_metrics failed: {e}")
        return None


def get_lb_balance(rpc, owner: str) -> Optional[Decimal]:
    try:
        r = rpc.call("getTokenAccountsByOwner", [
            owner,
            {"mint": config.TOKENS["LB"]["mint"]},
            {"encoding": "jsonParsed", "commitment": "confirmed"},
        ])
        accounts = (r or {}).get("value", [])
        total_raw = 0
        for acc in accounts:
            info = acc.get("account", {}).get("data", {}).get("parsed", {}).get("info", {})
            total_raw += int(info.get("tokenAmount", {}).get("amount", "0"))
        return Decimal(total_raw) / Decimal(10 ** config.TOKENS["LB"]["decimals"])
    except Exception:
        return None


def get_lb_tier(lb_balance: Optional[Decimal]) -> Optional[dict]:
    if lb_balance is None: return None
    bal_ui = float(lb_balance)
    for tier in config.LB_TIERS:
        if bal_ui >= tier["ui_min"]: return tier
    return None
