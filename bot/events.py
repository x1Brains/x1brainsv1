"""
Event detector — classifies each tx into one of 6 event types per token.
Vault addresses come from the connection (passed via classify()).
"""
from __future__ import annotations

import logging
from decimal import Decimal
from typing import Optional

import config

log = logging.getLogger("events")


# ─────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────
def _get_account_keys(tx: dict) -> list[str]:
    msg = tx.get("transaction", {}).get("message", {})
    keys = msg.get("accountKeys", []) or []
    out = []
    for k in keys:
        out.append(k.get("pubkey", "") if isinstance(k, dict) else k)
    return out


def _all_instructions(tx: dict) -> list[dict]:
    msg = tx.get("transaction", {}).get("message", {})
    out: list[dict] = list(msg.get("instructions", []) or [])
    for inner in (tx.get("meta", {}) or {}).get("innerInstructions", []) or []:
        out.extend(inner.get("instructions", []) or [])
    return out


def _program_ids_in_tx(tx: dict) -> set[str]:
    pids = set()
    for ix in _all_instructions(tx):
        pid = ix.get("programId")
        if pid: pids.add(pid)
    return pids


def _signer(tx: dict) -> Optional[str]:
    msg = tx.get("transaction", {}).get("message", {})
    for k in msg.get("accountKeys", []) or []:
        if isinstance(k, dict) and k.get("signer"):
            return k.get("pubkey")
    keys = _get_account_keys(tx)
    return keys[0] if keys else None


def _balance_delta_for_account(tx: dict, account_addr: str) -> Optional[Decimal]:
    meta = tx.get("meta", {}) or {}
    pre = meta.get("preTokenBalances", []) or []
    post = meta.get("postTokenBalances", []) or []
    keys = _get_account_keys(tx)
    if account_addr not in keys: return None
    idx = keys.index(account_addr)

    pre_amt, post_amt = Decimal(0), Decimal(0)
    for b in pre:
        if b.get("accountIndex") == idx:
            pre_amt = Decimal(b.get("uiTokenAmount", {}).get("amount", "0")); break
    for b in post:
        if b.get("accountIndex") == idx:
            post_amt = Decimal(b.get("uiTokenAmount", {}).get("amount", "0")); break
    return post_amt - pre_amt


def _balance_delta_for_owner_and_mint(tx: dict, owner: str, mint: str) -> Optional[Decimal]:
    meta = tx.get("meta", {}) or {}
    pre = meta.get("preTokenBalances", []) or []
    post = meta.get("postTokenBalances", []) or []
    pre_by_idx = {b.get("accountIndex"): Decimal(b.get("uiTokenAmount", {}).get("amount", "0"))
                  for b in pre if b.get("owner") == owner and b.get("mint") == mint}
    post_by_idx = {b.get("accountIndex"): Decimal(b.get("uiTokenAmount", {}).get("amount", "0"))
                   for b in post if b.get("owner") == owner and b.get("mint") == mint}
    if not pre_by_idx and not post_by_idx: return None
    indices = set(pre_by_idx) | set(post_by_idx)
    total = Decimal(0)
    for i in indices:
        total += post_by_idx.get(i, Decimal(0)) - pre_by_idx.get(i, Decimal(0))
    return total


# ─────────────────────────────────────────────────────────────
# CLASSIFIERS
# ─────────────────────────────────────────────────────────────
def detect_buy(tx: dict, token_cfg: dict) -> Optional[dict]:
    v_token = token_cfg.get("vault_token", "")
    v_quote = token_cfg.get("vault_quote", "")
    if not v_token or not v_quote: return None

    tok_delta = _balance_delta_for_account(tx, v_token)
    qte_delta = _balance_delta_for_account(tx, v_quote)
    if tok_delta is None or qte_delta is None: return None
    if tok_delta >= 0 or qte_delta <= 0: return None

    return {
        "type": "buy",
        "token": token_cfg["symbol"],
        "tokens_amount": (-tok_delta) / Decimal(10 ** token_cfg["decimals"]),
        "xnt_amount": qte_delta / Decimal(10 ** 9),
        "buyer": _signer(tx),
    }


def detect_burn(tx: dict, token_cfg: dict) -> Optional[dict]:
    mint = token_cfg["mint"]
    decimals = token_cfg["decimals"]
    burned_raw = Decimal(0)
    method = None

    for ix in _all_instructions(tx):
        parsed = ix.get("parsed")
        if not isinstance(parsed, dict): continue
        ix_type = parsed.get("type")
        info = parsed.get("info", {}) or {}

        if ix_type in ("burn", "burnChecked") and info.get("mint") == mint:
            amt = info.get("amount") or info.get("tokenAmount", {}).get("amount")
            if amt:
                burned_raw += Decimal(amt)
                method = "burn_instruction"
        elif ix_type in ("transfer", "transferChecked"):
            dest = info.get("destination")
            tx_mint = info.get("mint")
            amt = info.get("amount") or info.get("tokenAmount", {}).get("amount")
            if dest and amt and tx_mint == mint:
                meta = tx.get("meta", {}) or {}
                for b in meta.get("postTokenBalances", []) or []:
                    keys = _get_account_keys(tx)
                    if (b.get("accountIndex") < len(keys)
                        and keys[b.get("accountIndex")] == dest
                        and b.get("owner") == config.INCINERATOR_ADDR):
                        burned_raw += Decimal(amt)
                        method = method or "transfer_to_incinerator"
                        break

    if burned_raw == 0: return None
    return {"type": "burn", "token": token_cfg["symbol"],
            "amount": burned_raw / Decimal(10 ** decimals),
            "burner": _signer(tx), "method": method}


def detect_lp_pair_created(tx: dict) -> Optional[dict]:
    pids = _program_ids_in_tx(tx)
    if config.PROGRAMS["PAIRING"] not in pids: return None

    token_symbol = None
    token_amount = Decimal(0)
    for sym, cfg in config.TOKENS.items():
        delta = _balance_delta_for_owner_and_mint(tx, _signer(tx) or "", cfg["mint"])
        if delta is not None and delta < 0:
            if abs(delta) > token_amount:
                token_symbol = sym
                token_amount = abs(delta) / Decimal(10 ** cfg["decimals"])

    if not token_symbol: return None

    burn_amt = Decimal(0)
    for ix in _all_instructions(tx):
        parsed = ix.get("parsed", {})
        if not isinstance(parsed, dict): continue
        if parsed.get("type") in ("burn", "burnChecked"):
            info = parsed.get("info", {}) or {}
            if info.get("mint") == config.TOKENS[token_symbol]["mint"]:
                amt = info.get("amount") or info.get("tokenAmount", {}).get("amount")
                if amt:
                    burn_amt += Decimal(amt) / Decimal(10 ** config.TOKENS[token_symbol]["decimals"])

    return {"type": "lp_pair", "token": token_symbol,
            "amount": token_amount, "burned": burn_amt,
            "creator": _signer(tx)}


def detect_farm_action(tx: dict) -> Optional[dict]:
    pids = _program_ids_in_tx(tx)
    if config.PROGRAMS["FARMS"] not in pids: return None
    signer = _signer(tx)
    if not signer: return None

    # LP movement = stake/unstake (LP wins over claim)
    for sym, cfg in config.TOKENS.items():
        lp_mint = cfg.get("lp_mint")
        if not lp_mint: continue
        lp_delta = _balance_delta_for_owner_and_mint(tx, signer, lp_mint)
        if lp_delta is None or lp_delta == 0: continue
        action = "unstake" if lp_delta > 0 else "stake"
        return {"type": action, "token": sym,
                "lp_amount": abs(lp_delta) / Decimal(10 ** 9),
                "wallet": signer}

    # No LP movement → claim
    best_token, best_amount = None, Decimal(0)
    for sym, cfg in config.TOKENS.items():
        delta = _balance_delta_for_owner_and_mint(tx, signer, cfg["mint"])
        if delta is None or delta <= 0: continue
        amt_ui = delta / Decimal(10 ** cfg["decimals"])
        if amt_ui > best_amount:
            best_amount = amt_ui
            best_token = sym
    if best_token is None: return None
    return {"type": "claim", "token": best_token,
            "amount": best_amount, "wallet": signer}


def classify(tx: dict) -> list[dict]:
    if not tx or (tx.get("meta", {}) or {}).get("err") is not None:
        return []
    sig = (tx.get("transaction", {}).get("signatures", [None]) or [None])[0]
    slot = tx.get("slot", 0)
    block_time = tx.get("blockTime", 0)
    events: list[dict] = []

    for sym, token_cfg in config.TOKENS.items():
        e = detect_buy(tx, token_cfg)
        if e: events.append(e)

    for sym, token_cfg in config.TOKENS.items():
        e = detect_burn(tx, token_cfg)
        if e: events.append(e)

    e = detect_lp_pair_created(tx)
    if e: events.append(e)

    e = detect_farm_action(tx)
    if e: events.append(e)

    for e in events:
        e["signature"] = sig
        e["slot"] = slot
        e["blockTime"] = block_time
    return events
