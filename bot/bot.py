#!/usr/bin/env python3
"""
X1 Brains Multi-Event Bot — Fly.io edition
==========================================
Reads connection (Telegram token + chat + pool vaults) from Supabase.
Polls X1 every 5s, classifies each new tx, posts an alert per event type.

Required env vars (set with `fly secrets set`):
  SUPABASE_URL=https://xxxxx.supabase.co
  SUPABASE_SERVICE_KEY=eyJh...
"""
from __future__ import annotations

import asyncio
import logging
from decimal import Decimal
from typing import Optional

from telegram import Bot
from telegram.constants import ParseMode

import config
import events as event_mod
import messages
import prices
import storage
from x1_rpc import RPC

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
log = logging.getLogger("bot")


def watched_accounts() -> list[str]:
    accounts: list[str] = []
    conn = storage.load_connection()
    for sym in config.TOKENS:
        v = (conn.get("vaults") or {}).get(sym, {}).get("vault_token", "")
        if v: accounts.append(v)
    for sym, t in config.TOKENS.items():
        accounts.append(t["mint"])
    accounts.append(config.PROGRAMS["FARMS"])
    accounts.append(config.PROGRAMS["PAIRING"])
    return list(dict.fromkeys(accounts))


def get_active_token_cfg(symbol: str, conn: dict) -> dict:
    cfg = dict(config.TOKENS[symbol])
    v = (conn.get("vaults") or {}).get(symbol, {})
    cfg["vault_token"] = v.get("vault_token", "")
    cfg["vault_quote"] = v.get("vault_quote", "")
    return cfg


def event_enabled(event: dict, settings: dict) -> bool:
    sym = event.get("token", "").lower()
    t = event["type"]
    return settings.get({
        "buy": f"{sym}_buys", "burn": f"{sym}_burns", "lp_pair": f"{sym}_lp",
        "stake": f"{sym}_stake", "unstake": f"{sym}_unstake", "claim": f"{sym}_claim",
    }.get(t, ""), False)


def passes_threshold(event, settings, xnt_usd, metrics) -> bool:
    t = event["type"]
    if t == "buy":
        usd = float(event["xnt_amount"] * xnt_usd) if xnt_usd else None
        return usd is None or usd >= settings.get("min_buy_usd", 0)
    if t == "burn":
        return float(event["amount"]) >= settings.get("min_burn_tokens", 0)
    if t == "lp_pair":
        if metrics and metrics.get("price_usd"):
            return float(event["amount"]) * float(metrics["price_usd"]) * 2 >= settings.get("min_lp_usd", 0)
        return True
    if t in ("stake", "unstake"):
        return float(event["lp_amount"]) >= settings.get("min_stake_lp", 0)
    if t == "claim":
        if metrics and metrics.get("price_usd"):
            return float(event["amount"]) * float(metrics["price_usd"]) >= settings.get("min_claim_usd", 0)
        return True
    return True


async def send_event(bot: Bot, event: dict, rpc: RPC, settings: dict, conn: dict):
    sym = event.get("token", "BRAINS")
    token_cfg = get_active_token_cfg(sym, conn)
    metrics = prices.get_token_metrics(rpc, token_cfg)
    xnt_usd = prices.get_xnt_usd_price()

    lb_tier = None
    actor = event.get("buyer") or event.get("wallet") or event.get("burner")
    if actor and event["type"] in ("buy", "stake", "claim"):
        lb_bal = prices.get_lb_balance(rpc, actor)
        lb_tier = prices.get_lb_tier(lb_bal)

    if not passes_threshold(event, settings, xnt_usd, metrics):
        log.info(f"   …filtered {event['type']} for {sym}")
        return

    msg = messages.build_message(event, metrics, lb_tier, xnt_usd, settings)
    banner_url = storage.banner_url(sym)
    chat_id = conn.get("chat_id")
    if not chat_id:
        log.warning("Skipping send — no chat_id"); return

    try:
        if banner_url:
            # Telegram fetches the URL itself — no need to download then upload
            await bot.send_photo(
                chat_id=chat_id, photo=banner_url, caption=msg,
                parse_mode=ParseMode.MARKDOWN,
            )
        else:
            await bot.send_message(
                chat_id=chat_id, text=msg,
                parse_mode=ParseMode.MARKDOWN,
                disable_web_page_preview=True,
            )
        log.info(f"✅ Posted {event['type']} for {sym}: {event['signature'][:12]}…")
    except Exception as e:
        log.error(f"❌ Telegram send failed: {e}")


def classify_with_conn(tx, conn) -> list[dict]:
    original = {sym: dict(cfg) for sym, cfg in config.TOKENS.items()}
    try:
        for sym in config.TOKENS:
            v = (conn.get("vaults") or {}).get(sym, {})
            config.TOKENS[sym]["vault_token"] = v.get("vault_token", "")
            config.TOKENS[sym]["vault_quote"] = v.get("vault_quote", "")
        return event_mod.classify(tx)
    finally:
        for sym, cfg in original.items():
            config.TOKENS[sym] = cfg


async def main_loop():
    log.info("🧠 X1 Brains Bot starting (Fly.io edition)…")
    log.info(f"   RPC:      {config.RPC_URL}")
    log.info(f"   Supabase: {config.SUPABASE_URL[:32]}…")

    if not config.SUPABASE_URL or not config.SUPABASE_SERVICE_KEY:
        log.error("❌ SUPABASE_URL / SUPABASE_SERVICE_KEY not set — exiting")
        return

    rpc = RPC(config.RPC_URL)
    bot: Optional[Bot] = None
    last_token = ""
    processed: set[str] = set()

    # --- Heartbeat state -------------------------------------------------
    # Tracks consecutive cycles where every account 503'd (or otherwise
    # failed). Once we cross the threshold we post one warning to TG;
    # when we get our first successful cycle after that, we post a recovery.
    HEARTBEAT_THRESHOLD = 5  # consecutive fully-failed cycles before alerting
    failed_cycles = 0
    rpc_alerted = False
    # ---------------------------------------------------------------------

    while True:
        try:
            if not storage.is_connection_complete():
                log.info("⏸  Waiting for admin to finish setup at /x9b7r41ns/bot…")
                await asyncio.sleep(15)
                continue

            conn = storage.load_connection()
            settings = storage.load_settings()

            if conn["telegram_token"] != last_token:
                bot = Bot(token=conn["telegram_token"])
                last_token = conn["telegram_token"]
                log.info(f"   Telegram bot ready → posting to: {conn.get('chat_title') or conn['chat_id']}")

            accounts = watched_accounts()

            # Seed first time
            for acc in accounts:
                if storage.get_last_sig(acc): continue
                try:
                    sigs = rpc.get_signatures_for_address(acc, limit=1)
                    if sigs:
                        storage.update_last_sig(acc, sigs[0]["signature"])
                        log.info(f"   Seeded {acc[:8]}… → {sigs[0]['signature'][:12]}…")
                except Exception as e:
                    log.warning(f"Seed {acc[:8]}…: {e}")

            new_tx_sigs: dict[str, dict] = {}
            cycle_ok = 0
            cycle_fail = 0
            for acc in accounts:
                last = storage.get_last_sig(acc)
                try:
                    sigs = rpc.get_signatures_for_address(acc, limit=config.SIG_BATCH_SIZE)
                    cycle_ok += 1
                except Exception as e:
                    cycle_fail += 1
                    log.warning(f"sigs for {acc[:8]}…: {e}"); continue

                fresh = []
                for s in sigs:
                    if s["signature"] == last: break
                    fresh.append(s)
                if not fresh: continue

                storage.update_last_sig(acc, fresh[0]["signature"])
                fresh.reverse()
                for s in fresh:
                    if s.get("err") is not None: continue
                    sig = s["signature"]
                    if sig in processed or sig in new_tx_sigs: continue
                    new_tx_sigs[sig] = {"sig": sig, "account": acc}

            # --- Heartbeat alert logic -----------------------------------
            if cycle_ok == 0 and cycle_fail > 0:
                failed_cycles += 1
                if failed_cycles == HEARTBEAT_THRESHOLD and not rpc_alerted and bot is not None:
                    try:
                        await bot.send_message(
                            chat_id=conn["chat_id"],
                            text="⚠️ X1 RPC unavailable — buy/event alerts may be delayed.",
                        )
                        rpc_alerted = True
                        log.warning(f"Posted RPC-degraded heartbeat after {failed_cycles} failed cycles")
                    except Exception as e:
                        log.warning(f"Failed to post RPC-degraded heartbeat: {e}")
            elif cycle_ok > 0:
                if rpc_alerted and bot is not None:
                    try:
                        await bot.send_message(
                            chat_id=conn["chat_id"],
                            text="✅ X1 RPC recovered — alerts are flowing again.",
                        )
                        log.info("Posted RPC-recovered heartbeat")
                    except Exception as e:
                        log.warning(f"Failed to post RPC-recovered heartbeat: {e}")
                failed_cycles = 0
                rpc_alerted = False
            # -------------------------------------------------------------

            if new_tx_sigs:
                log.info(f"Found {len(new_tx_sigs)} new tx(s)")

            for sig in new_tx_sigs:
                try:
                    tx = rpc.get_transaction(sig)
                except Exception as e:
                    log.warning(f"tx {sig[:12]}…: {e}"); continue
                if not tx: continue

                evts = classify_with_conn(tx, conn)
                processed.add(sig)
                for evt in evts:
                    if not event_enabled(evt, settings): continue
                    if bot is not None:
                        await send_event(bot, evt, rpc, settings, conn)

            if len(processed) > 5000:
                processed = set(list(processed)[-2500:])

        except Exception as e:
            log.error(f"Main loop error: {e}", exc_info=True)

        await asyncio.sleep(config.POLL_INTERVAL)


if __name__ == "__main__":
    asyncio.run(main_loop())
