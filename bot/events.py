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


# XDEX (raydium_cp_swap) Anchor instruction discriminators — first 8 bytes of
# sha256("global:<name>"). These tell us which XDEX op a tx performed even when
# the call came via CPI from your brains_pairing wrapper.
_XDEX_DISC = {
    "initialize": bytes.fromhex("afaf6d1f0d989bed"),  # new pool created
    "deposit":    bytes.fromhex("f223c68952e1f2b6"),  # liquidity added
    "withdraw":   bytes.fromhex("b712469c946da122"),  # liquidity removed
}

# Tiny base58 decoder so we don't need a third Python dep. Solana uses the
# Bitcoin alphabet. We only need the first 8 bytes (the discriminator) but
# decoding the whole string is just as cheap.
_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_INDEX = {c: i for i, c in enumerate(_B58_ALPHABET)}


def _b58decode(s: str) -> bytes:
    if not s:
        return b""
    n = 0
    for c in s:
        v = _B58_INDEX.get(c)
        if v is None:
            raise ValueError(f"Invalid base58 char: {c!r}")
        n = n * 58 + v
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    leading_zeros = 0
    for c in s:
        if c == "1":
            leading_zeros += 1
        else:
            break
    return b"\x00" * leading_zeros + body


def _xdex_op_in_tx(tx: dict) -> Optional[str]:
    """Returns 'initialize' / 'deposit' / 'withdraw' if the tx invoked that
    XDEX instruction (top-level OR via CPI), else None. swapBaseInput/Output
    are intentionally ignored — buys are detected via vault-delta logic."""
    xdex_pid = config.PROGRAMS["XDEX"]
    for ix in _all_instructions(tx):
        if ix.get("programId") != xdex_pid:
            continue
        data = ix.get("data")
        if not isinstance(data, str):
            continue
        try:
            raw = _b58decode(data)
        except Exception:
            continue
        if len(raw) < 8:
            continue
        head = raw[:8]
        for op, disc in _XDEX_DISC.items():
            if head == disc:
                return op
    return None


def _vault_token_delta(tx: dict) -> Optional[tuple[str, Decimal]]:
    """Looks at the pool's TOKEN vault (BRAINS or LB) and returns the change.
    Reads vault addresses from on-chain config (not signer ATAs), so it's
    immune to RPCs that don't fill the `owner` field on token balance entries.
    Returns (symbol, signed_delta_ui), or None if no recognized pool was touched.
    Positive delta = tokens flowed INTO pool (lp_add / initialize)
    Negative delta = tokens flowed OUT of pool (lp_remove)"""
    # Vaults are loaded fresh per-loop in bot.py via get_active_token_cfg(),
    # but events.py is stateless — it can only see config.TOKENS, which carries
    # static info. The vault address gets injected at classify-time via
    # `vault_token` field on the token_cfg passed in. We don't have that here,
    # so we instead do a sweep: find any account whose post-token-balance mint
    # matches BRAINS or LB and whose balance changed; the larger one wins.
    meta = tx.get("meta", {}) or {}
    pre = meta.get("preTokenBalances", []) or []
    post = meta.get("postTokenBalances", []) or []

    # Build (idx -> sym) map from the BRAINS/LB mints we know about
    mint_to_sym = {cfg["mint"]: sym for sym, cfg in config.TOKENS.items()}

    # Sum balance change per account, filtered to our token mints
    pre_by_idx, post_by_idx, idx_to_sym = {}, {}, {}
    for b in pre:
        sym = mint_to_sym.get(b.get("mint"))
        if not sym: continue
        idx = b.get("accountIndex")
        pre_by_idx[idx] = Decimal(b.get("uiTokenAmount", {}).get("amount", "0"))
        idx_to_sym[idx] = sym
    for b in post:
        sym = mint_to_sym.get(b.get("mint"))
        if not sym: continue
        idx = b.get("accountIndex")
        post_by_idx[idx] = Decimal(b.get("uiTokenAmount", {}).get("amount", "0"))
        idx_to_sym[idx] = sym

    # Pick the largest absolute delta — that's the pool vault, not the user ATA
    # (the pool vault holds 100k+ tokens; user accounts might hold a few hundred,
    # and the deposit/withdraw amounts are equal in magnitude on both sides, so
    # we need a different tie-break). Use largest POST balance instead — pool
    # vaults hold orders of magnitude more than user wallets.
    if not post_by_idx:
        return None
    pool_idx = max(post_by_idx, key=lambda i: post_by_idx.get(i, Decimal(0)))
    sym = idx_to_sym.get(pool_idx)
    if not sym:
        return None
    delta_raw = post_by_idx.get(pool_idx, Decimal(0)) - pre_by_idx.get(pool_idx, Decimal(0))
    if delta_raw == 0:
        return None
    decimals = config.TOKENS[sym]["decimals"]
    return sym, delta_raw / Decimal(10 ** decimals)


def detect_lp_pair_created(tx: dict) -> Optional[dict]:
    """New pool created via XDEX `initialize` for BRAINS / LB."""
    if _xdex_op_in_tx(tx) != "initialize":
        return None
    res = _vault_token_delta(tx)
    if not res:
        return None
    sym, delta_ui = res
    if delta_ui <= 0:
        return None  # initialize must add tokens to pool
    return {"type": "lp_pair", "token": sym,
            "amount": delta_ui, "burned": Decimal(0),
            "creator": _signer(tx)}


def detect_lp_add(tx: dict) -> Optional[dict]:
    """Liquidity added to existing pool via XDEX `deposit`."""
    if _xdex_op_in_tx(tx) != "deposit":
        return None
    res = _vault_token_delta(tx)
    if not res:
        return None
    sym, delta_ui = res
    if delta_ui <= 0:
        return None  # deposit must add tokens to pool
    return {"type": "lp_add", "token": sym,
            "amount": delta_ui,
            "provider": _signer(tx)}


def detect_lp_remove(tx: dict) -> Optional[dict]:
    """Liquidity removed from existing pool via XDEX `withdraw`."""
    if _xdex_op_in_tx(tx) != "withdraw":
        return None
    res = _vault_token_delta(tx)
    if not res:
        return None
    sym, delta_ui = res
    if delta_ui >= 0:
        return None  # withdraw must remove tokens from pool
    return {"type": "lp_remove", "token": sym,
            "amount": abs(delta_ui),
            "provider": _signer(tx)}


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

    e = detect_lp_add(tx)
    if e: events.append(e)

    e = detect_lp_remove(tx)
    if e: events.append(e)

    e = detect_farm_action(tx)
    if e: events.append(e)

    for e in events:
        e["signature"] = sig
        e["slot"] = slot
        e["blockTime"] = block_time
    return events
