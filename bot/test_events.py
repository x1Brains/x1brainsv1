"""Unit tests for the event detector + message templates."""
from __future__ import annotations
import os, sys, tempfile
from decimal import Decimal

# Stub Supabase env so config imports cleanly
os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "test_key")

import config
import events as event_mod
import messages as msg_mod

# Test fixtures
FARMS    = config.PROGRAMS["FARMS"]
PAIRING  = config.PROGRAMS["PAIRING"]
TOK_2022 = config.PROGRAMS["TOKEN_2022"]
TOK      = config.PROGRAMS["TOKEN"]
INCIN    = config.INCINERATOR_ADDR

BRAINS_MINT = config.TOKENS["BRAINS"]["mint"]
LB_MINT     = config.TOKENS["LB"]["mint"]
BRAINS_LP   = config.TOKENS["BRAINS"]["lp_mint"]
LB_LP       = config.TOKENS["LB"]["lp_mint"]
WXNT        = config.WXNT_MINT

V_BR_TOK = "BRBaseVaultBRBaseVaultBRBaseVaultBRBaseVaultBRBa"
V_BR_QTE = "BRQuoteVaultBRQuoteVaultBRQuoteVaultBRQuoteVault"
V_LB_TOK = "LBBaseVaultLBBaseVaultLBBaseVaultLBBaseVaultLBB"
V_LB_QTE = "LBQuoteVaultLBQuoteVaultLBQuoteVaultLBQuoteVault"


def make_balance(idx, mint, owner, amount, decimals):
    return {
        "accountIndex": idx, "mint": mint, "owner": owner,
        "uiTokenAmount": {"amount": str(amount), "decimals": decimals,
                          "uiAmountString": str(amount)}
    }


def make_tx(account_keys, instructions, pre, post, sig="testsig", err=None):
    parsed_keys = [{"pubkey": k, "signer": (i == 0), "writable": True}
                   for i, k in enumerate(account_keys)]
    return {
        "transaction": {"signatures": [sig],
                        "message": {"accountKeys": parsed_keys,
                                    "instructions": instructions}},
        "meta": {"err": err, "preTokenBalances": pre, "postTokenBalances": post,
                 "innerInstructions": []},
        "slot": 1, "blockTime": 1700000000,
    }


def patch_vaults():
    """Inject vault addresses into config.TOKENS for tests."""
    config.TOKENS["BRAINS"]["vault_token"] = V_BR_TOK
    config.TOKENS["BRAINS"]["vault_quote"] = V_BR_QTE
    config.TOKENS["LB"]["vault_token"] = V_LB_TOK
    config.TOKENS["LB"]["vault_quote"] = V_LB_QTE


# ─── BUYS ────────────────────────────────────────────────────────────────────
def test_buy_brains():
    patch_vaults()
    keys = ["BUYER", V_BR_TOK, V_BR_QTE]
    tx = make_tx(keys, [{"programId": config.PROGRAMS["XDEX"], "accounts": [], "data": "x"}],
        pre=[make_balance(1, BRAINS_MINT, "POOL", 10000 * 10**9, 9),
             make_balance(2, WXNT, "POOL", 50 * 10**9, 9)],
        post=[make_balance(1, BRAINS_MINT, "POOL", 9000 * 10**9, 9),
              make_balance(2, WXNT, "POOL", 52 * 10**9, 9)])
    evts = event_mod.classify(tx)
    buys = [e for e in evts if e["type"] == "buy"]
    assert len(buys) == 1
    assert buys[0]["token"] == "BRAINS"
    assert float(buys[0]["tokens_amount"]) == 1000
    assert float(buys[0]["xnt_amount"]) == 2
    print(f"   ✅ BRAINS buy: {buys[0]['tokens_amount']} BRAINS for {buys[0]['xnt_amount']} XNT")


def test_buy_lb():
    patch_vaults()
    keys = ["BUYER", V_LB_TOK, V_LB_QTE]
    tx = make_tx(keys, [{"programId": config.PROGRAMS["XDEX"], "accounts": [], "data": "x"}],
        pre=[make_balance(1, LB_MINT, "POOL", 5000 * 10**2, 2),
             make_balance(2, WXNT, "POOL", 100 * 10**9, 9)],
        post=[make_balance(1, LB_MINT, "POOL", 4500 * 10**2, 2),
              make_balance(2, WXNT, "POOL", 105 * 10**9, 9)])
    evts = event_mod.classify(tx)
    buys = [e for e in evts if e["type"] == "buy"]
    assert len(buys) == 1
    assert buys[0]["token"] == "LB"
    assert float(buys[0]["tokens_amount"]) == 500
    assert float(buys[0]["xnt_amount"]) == 5
    print(f"   ✅ LB buy: {buys[0]['tokens_amount']} LB for {buys[0]['xnt_amount']} XNT")


def test_sell_not_buy():
    patch_vaults()
    keys = ["SELLER", V_BR_TOK, V_BR_QTE]
    tx = make_tx(keys, [{"programId": config.PROGRAMS["XDEX"], "accounts": [], "data": "x"}],
        pre=[make_balance(1, BRAINS_MINT, "POOL", 10000 * 10**9, 9),
             make_balance(2, WXNT, "POOL", 50 * 10**9, 9)],
        post=[make_balance(1, BRAINS_MINT, "POOL", 11000 * 10**9, 9),
              make_balance(2, WXNT, "POOL", 48 * 10**9, 9)])
    evts = event_mod.classify(tx)
    assert not any(e["type"] == "buy" for e in evts)
    print(f"   ✅ Sell correctly NOT classified as buy")


# ─── BURNS ───────────────────────────────────────────────────────────────────
def test_burn_via_burnChecked():
    keys = ["BURNER", "BURNER_BRAINS"]
    tx = make_tx(keys, [{
        "programId": TOK_2022, "accounts": [],
        "parsed": {"type": "burnChecked", "info": {"mint": BRAINS_MINT,
            "tokenAmount": {"amount": str(50000 * 10**9), "decimals": 9}}},
    }], pre=[make_balance(1, BRAINS_MINT, "BURNER", 100000 * 10**9, 9)],
       post=[make_balance(1, BRAINS_MINT, "BURNER", 50000 * 10**9, 9)])
    evts = event_mod.classify(tx)
    burns = [e for e in evts if e["type"] == "burn"]
    assert len(burns) == 1
    assert float(burns[0]["amount"]) == 50000
    print(f"   ✅ Burn via burnChecked: {burns[0]['amount']} BRAINS")


def test_burn_via_transfer_to_incinerator():
    keys = ["WHALE", "WHALE_LB", "INCIN_LB"]
    tx = make_tx(keys, [{
        "programId": TOK, "accounts": [],
        "parsed": {"type": "transferChecked", "info": {
            "mint": LB_MINT, "destination": "INCIN_LB", "source": "WHALE_LB",
            "tokenAmount": {"amount": str(100 * 10**2), "decimals": 2}}},
    }],
        pre=[make_balance(1, LB_MINT, "WHALE", 5000 * 10**2, 2),
             make_balance(2, LB_MINT, INCIN, 1000 * 10**2, 2)],
        post=[make_balance(1, LB_MINT, "WHALE", 4900 * 10**2, 2),
              make_balance(2, LB_MINT, INCIN, 1100 * 10**2, 2)])
    evts = event_mod.classify(tx)
    burns = [e for e in evts if e["type"] == "burn"]
    assert len(burns) == 1
    assert burns[0]["token"] == "LB"
    assert float(burns[0]["amount"]) == 100
    print(f"   ✅ Burn via incinerator transfer: {burns[0]['amount']} LB")


# ─── LP PAIRS ────────────────────────────────────────────────────────────────
def test_lp_pair_creation():
    keys = ["CREATOR", "CREATOR_BRAINS"]
    tx = make_tx(keys, [{"programId": PAIRING, "accounts": [], "data": "p"}],
        pre=[make_balance(1, BRAINS_MINT, "CREATOR", 10_000_000 * 10**9, 9)],
        post=[make_balance(1, BRAINS_MINT, "CREATOR", 5_000_000 * 10**9, 9)])
    evts = event_mod.classify(tx)
    lps = [e for e in evts if e["type"] == "lp_pair"]
    assert len(lps) == 1
    assert lps[0]["token"] == "BRAINS"
    assert float(lps[0]["amount"]) == 5_000_000
    print(f"   ✅ LP pair: {lps[0]['amount']} BRAINS deposited")


def test_lp_pair_with_burn():
    keys = ["CREATOR", "CREATOR_BRAINS"]
    tx = make_tx(keys, [
        {"programId": PAIRING, "accounts": [], "data": "p"},
        {"programId": TOK_2022, "accounts": [],
         "parsed": {"type": "burnChecked", "info": {
            "mint": BRAINS_MINT,
            "tokenAmount": {"amount": str(1_250_000 * 10**9), "decimals": 9}}}},
    ], pre=[make_balance(1, BRAINS_MINT, "CREATOR", 10_000_000 * 10**9, 9)],
       post=[make_balance(1, BRAINS_MINT, "CREATOR", 5_000_000 * 10**9, 9)])
    evts = event_mod.classify(tx)
    lps = [e for e in evts if e["type"] == "lp_pair"]
    assert len(lps) == 1
    assert float(lps[0]["burned"]) == 1_250_000
    print(f"   ✅ LP pair WITH burn: 25% burn portion detected")


# ─── FARM ACTIONS ────────────────────────────────────────────────────────────
def test_farm_stake():
    keys = ["FARMER", "FARMER_BRAINS_LP_ATA"]
    tx = make_tx(keys, [{"programId": FARMS, "accounts": [], "data": "stk"}],
        pre=[make_balance(1, BRAINS_LP, "FARMER", 5 * 10**9, 9)],
        post=[make_balance(1, BRAINS_LP, "FARMER", 0, 9)])
    evts = event_mod.classify(tx)
    ev = [e for e in evts if e["type"] == "stake"]
    assert len(ev) == 1
    assert ev[0]["token"] == "BRAINS"
    assert float(ev[0]["lp_amount"]) == 5
    print(f"   ✅ Farm stake: {ev[0]['lp_amount']} BRAINS LP")


def test_farm_unstake():
    keys = ["FARMER", "FARMER_LB_LP_ATA"]
    tx = make_tx(keys, [{"programId": FARMS, "accounts": [], "data": "ust"}],
        pre=[make_balance(1, LB_LP, "FARMER", 0, 9)],
        post=[make_balance(1, LB_LP, "FARMER", 3 * 10**9, 9)])
    evts = event_mod.classify(tx)
    ev = [e for e in evts if e["type"] == "unstake"]
    assert len(ev) == 1
    assert ev[0]["token"] == "LB"
    assert float(ev[0]["lp_amount"]) == 3
    print(f"   ✅ Farm unstake: {ev[0]['lp_amount']} LB LP")


def test_farm_claim_brains():
    keys = ["FARMER", "FARMER_BRAINS_ATA"]
    tx = make_tx(keys, [{"programId": FARMS, "accounts": [], "data": "clm"}],
        pre=[make_balance(1, BRAINS_MINT, "FARMER", 100 * 10**9, 9)],
        post=[make_balance(1, BRAINS_MINT, "FARMER", 250 * 10**9, 9)])
    evts = event_mod.classify(tx)
    claim_events = [e for e in evts if e["type"] == "claim"]
    assert len(claim_events) == 1
    assert all(e["type"] != "stake" for e in evts)
    assert all(e["type"] != "unstake" for e in evts)
    assert claim_events[0]["token"] == "BRAINS"
    assert float(claim_events[0]["amount"]) == 150
    print(f"   ✅ Farm claim BRAINS: {claim_events[0]['amount']} BRAINS")


def test_farm_claim_lb():
    keys = ["FARMER", "FARMER_LB_ATA"]
    tx = make_tx(keys, [{"programId": FARMS, "accounts": [], "data": "clm"}],
        pre=[make_balance(1, LB_MINT, "FARMER", 0, 2)],
        post=[make_balance(1, LB_MINT, "FARMER", 4400 * 10**2, 2)])
    evts = event_mod.classify(tx)
    claim_events = [e for e in evts if e["type"] == "claim"]
    assert len(claim_events) == 1
    assert claim_events[0]["token"] == "LB"
    assert float(claim_events[0]["amount"]) == 4400
    print(f"   ✅ Farm claim LB: {claim_events[0]['amount']} LB")


def test_unstake_overrides_claim():
    keys = ["FARMER", "FARMER_BRAINS_LP_ATA", "FARMER_BRAINS_ATA"]
    tx = make_tx(keys, [{"programId": FARMS, "accounts": [], "data": "ust+clm"}],
        pre=[make_balance(1, BRAINS_LP, "FARMER", 0, 9),
             make_balance(2, BRAINS_MINT, "FARMER", 0, 9)],
        post=[make_balance(1, BRAINS_LP, "FARMER", 5 * 10**9, 9),
              make_balance(2, BRAINS_MINT, "FARMER", 200 * 10**9, 9)])
    evts = event_mod.classify(tx)
    farm_evts = [e for e in evts if e["type"] in ("stake", "unstake", "claim")]
    assert len(farm_evts) == 1
    assert farm_evts[0]["type"] == "unstake"
    print(f"   ✅ Combined unstake+claim correctly classified as unstake")


# ─── EDGE CASES ──────────────────────────────────────────────────────────────
def test_failed_tx_ignored():
    tx = make_tx(["X"], [], [], [], err={"InstructionError": [0, "Custom"]})
    evts = event_mod.classify(tx)
    assert len(evts) == 0
    print(f"   ✅ Failed tx correctly ignored")


def test_unrelated_tx_ignored():
    keys = ["A", "B"]
    tx = make_tx(keys, [{"programId": "11111111111111111111111111111111", "accounts": [], "data": "x"}],
        pre=[], post=[])
    evts = event_mod.classify(tx)
    assert len(evts) == 0
    print(f"   ✅ Unrelated tx correctly ignored")


def test_message_renders():
    settings = {**config.DEFAULT_SETTINGS}
    samples = [
        {"type": "buy", "token": "BRAINS", "tokens_amount": Decimal("1000"),
         "xnt_amount": Decimal("2"), "buyer": "ABCD" * 10, "signature": "sig"},
        {"type": "burn", "token": "LB", "amount": Decimal("88"),
         "burner": "BURN" * 10, "method": "burn_instruction", "signature": "sig"},
        {"type": "lp_pair", "token": "BRAINS", "amount": Decimal("5000000"),
         "burned": Decimal("1250000"), "creator": "CREATE" * 7, "signature": "sig"},
        {"type": "stake", "token": "LB", "lp_amount": Decimal("1.42"),
         "wallet": "STAKE" * 8, "signature": "sig"},
        {"type": "unstake", "token": "BRAINS", "lp_amount": Decimal("3"),
         "wallet": "UNSTK" * 8, "signature": "sig"},
        {"type": "claim", "token": "BRAINS", "amount": Decimal("150"),
         "wallet": "CLAIM" * 8, "signature": "sig"},
    ]
    for s in samples:
        out = msg_mod.build_message(s, None, None, Decimal("0.42"), settings)
        assert out and len(out) > 50, f"message too short for {s['type']}: {out!r}"
    print(f"   ✅ All 6 message templates render cleanly")


if __name__ == "__main__":
    print("\n🧪 Running event detector tests…\n")
    tests = [
        test_buy_brains, test_buy_lb, test_sell_not_buy,
        test_burn_via_burnChecked, test_burn_via_transfer_to_incinerator,
        test_lp_pair_creation, test_lp_pair_with_burn,
        test_farm_stake, test_farm_unstake,
        test_farm_claim_brains, test_farm_claim_lb, test_unstake_overrides_claim,
        test_failed_tx_ignored, test_unrelated_tx_ignored, test_message_renders,
    ]
    for t in tests:
        t()
    print("\n🎉 All tests passed!\n")
