"""Message templates — distinct vibe per event type."""
from __future__ import annotations
from decimal import Decimal
from typing import Optional
import config


def fmt_usd(amount: Optional[Decimal]) -> str:
    if amount is None: return "—"
    a = float(amount)
    if a >= 1_000_000: return f"${a/1_000_000:,.2f}M"
    if a >= 1_000: return f"${a/1_000:,.2f}K"
    if a >= 1: return f"${a:,.2f}"
    return f"${a:,.6f}"


def fmt_amount(amount: Decimal) -> str:
    a = float(amount)
    if a >= 1_000_000: return f"{a/1_000_000:,.2f}M"
    if a >= 1_000: return f"{a/1_000:,.2f}K"
    if a >= 1: return f"{a:,.4f}"
    return f"{a:,.6f}"


def fmt_xnt(amount: Decimal) -> str: return f"{fmt_amount(amount)} XNT"


def shorten(addr: Optional[str], head=4, tail=4) -> str:
    if not addr: return "unknown"
    if len(addr) < head + tail + 3: return addr
    return f"{addr[:head]}…{addr[-tail:]}"


def buy_tier(usd: Optional[float], settings: dict) -> str:
    if usd is None: return "normal"
    if usd >= settings.get("tier_whale_usd", 1000): return "whale"
    if usd >= settings.get("tier_big_usd", 100): return "big"
    return "normal"


def emoji_bar(value: float, char: str, max_count=25, per_dollar=10) -> str:
    return char * max(3, min(int(value / per_dollar), max_count))


def explorer_tx(sig: str) -> str: return f"{config.EXPLORER_URL}/tx/{sig}"
def explorer_address(addr: str) -> str: return f"{config.EXPLORER_URL}/address/{addr}"


def build_buy(event: dict, metrics, lb_tier, xnt_usd, settings) -> str:
    sym = event["token"]; emoji = config.TOKENS[sym]["emoji"]
    xnt_amt = event["xnt_amount"]; tokens = event["tokens_amount"]
    usd = float(xnt_amt * xnt_usd) if xnt_usd else None
    tier = buy_tier(usd, settings)
    bar_char = "🐋" if tier == "whale" else "🚀" if tier == "big" else "🟢"
    bar = emoji_bar(usd or float(xnt_amt) * 10, bar_char)

    if tier == "whale":
        header = f"🐋🐋🐋  *${sym} WHALE BUY!*  🐋🐋🐋"
        vibe = f"🔥 *A whale just dove into the {sym.lower()} pool!*"
    elif tier == "big":
        header = f"🚀🚀  *BIG ${sym} BUY!*  🚀🚀"
        vibe = f"💪 *Big brain entered the chat!*"
    else:
        header = f"{emoji}  *NEW ${sym} BUY!*  {emoji}"
        vibe = f"✨ *Another holder joins the brain trust*"

    lines = [header, "", bar, "",
             f"💵 *Spent:* {fmt_xnt(xnt_amt)}" + (f"  ({fmt_usd(Decimal(str(usd)))})" if usd else ""),
             f"{emoji} *Got:* {fmt_amount(tokens)} ${sym}"]
    if metrics:
        if metrics.get("price_usd") is not None:
            lines.append(f"💲 *Price:* {fmt_usd(metrics['price_usd'])}")
        lines.append("")
        if metrics.get("mcap_usd") is not None:
            lines.append(f"📊 *Market Cap:* {fmt_usd(metrics['mcap_usd'])}")
        if metrics.get("tvl_usd") is not None:
            lines.append(f"💧 *TVL:* {fmt_usd(metrics['tvl_usd'])}")
    lines.append("")
    if event.get("buyer"):
        lines.append(f"👤 *Buyer:* [{shorten(event['buyer'])}]({explorer_address(event['buyer'])})")
    if lb_tier:
        lines.append(f"   {lb_tier['name']} LB holder")
    lines.append(f"🔗 [TX]({explorer_tx(event['signature'])})")
    lines.append(""); lines.append(vibe); lines.append(f"#x1brains #{sym} #X1Chain")
    return "\n".join(lines)


def build_burn(event, metrics) -> str:
    sym = event["token"]; emoji = config.TOKENS[sym]["emoji"]
    amt = event["amount"]; method = event.get("method", "burn")
    method_label = ("Token-2022 burn" if method == "burn_instruction"
                    else "→ incinerator" if method == "transfer_to_incinerator"
                    else "burn")
    flames = "🔥" * max(5, min(int(float(amt) / 100), 30))
    burned_usd = metrics["price_usd"] * amt if metrics and metrics.get("price_usd") else None
    lines = [f"🔥🔥🔥  *${sym} BURNED!*  🔥🔥🔥", "", flames, "",
             f"{emoji} *Burned:* {fmt_amount(amt)} ${sym}"
             + (f"  ({fmt_usd(burned_usd)})" if burned_usd else ""),
             f"⚡ *Method:* {method_label}"]
    if metrics and metrics.get("supply") and amt > 0:
        pct = float(amt) / float(metrics["supply"]) * 100
        lines.append(f"📉 *Supply impact:* −{pct:.4f}%")
    lines.append("")
    if event.get("burner"):
        lines.append(f"👤 *Burner:* [{shorten(event['burner'])}]({explorer_address(event['burner'])})")
    lines.append(f"🔗 [TX]({explorer_tx(event['signature'])})")
    lines.append(""); lines.append(f"💀 *Less ${sym} in the world. The faithful are rewarded.*")
    lines.append(f"#x1brains #{sym}Burn #DeflationaryAF")
    return "\n".join(lines)


def build_lp_pair(event, metrics, xnt_usd) -> str:
    sym = event["token"]; emoji = config.TOKENS[sym]["emoji"]
    amt = event["amount"]; burned = event.get("burned", Decimal(0))
    burned_pct = float(burned) / float(amt) * 100 if amt > 0 and burned > 0 else 0
    lines = [f"💧💧  *NEW ${sym}/XNT LP PAIRED!*  💧💧", "", "🌊" * 12, "",
             f"{emoji} *${sym} paired:* {fmt_amount(amt)}"]
    if burned > 0:
        lines.append(f"🔥 *Burned:* {fmt_amount(burned)} ${sym}  ({burned_pct:.0f}% of pair)")
    else:
        lines.append(f"💧 *Burn:* none — full LP minted")
    if metrics and metrics.get("price_usd"):
        lp_value_usd = metrics["price_usd"] * amt * 2
        lines.append(f"💰 *Pair value:* {fmt_usd(lp_value_usd)}")
    lines.append("")
    if event.get("creator"):
        lines.append(f"👤 *LP Creator:* [{shorten(event['creator'])}]({explorer_address(event['creator'])})")
    lines.append(f"🔗 [TX]({explorer_tx(event['signature'])})")
    lines.append("")
    lines.append(f"⚗️ *More ${sym} liquidity locked.*" if burned > 0
                 else f"⚗️ *Fresh liquidity added to the ${sym} ecosystem!*")
    lines.append(f"#x1brains #{sym}LP #LabWork")
    return "\n".join(lines)


def build_stake(event, lb_tier) -> str:
    sym = event["token"]; emoji = config.TOKENS[sym]["emoji"]
    lp_amt = event["lp_amount"]
    lines = [f"🌾🌾  *${sym}/XNT LP STAKED!*  🌾🌾", "", "🌾" * 12, "",
             f"{emoji} *Staked:* {fmt_amount(lp_amt)} ${sym}/XNT LP",
             f"🔒 *Locked into farm — earning boosted rewards*", ""]
    if event.get("wallet"):
        lines.append(f"👤 *Farmer:* [{shorten(event['wallet'])}]({explorer_address(event['wallet'])})")
    if lb_tier:
        lines.append(f"   {lb_tier['name']} LB holder — reduced exit penalty")
    lines.append(f"🔗 [TX]({explorer_tx(event['signature'])})")
    lines.append(""); lines.append(f"🌱 *Diamond hands acquired. Yield begins. LB Points incoming.*")
    lines.append(f"#x1brains #{sym}Farm #LPStake")
    return "\n".join(lines)


def build_unstake(event) -> str:
    sym = event["token"]; emoji = config.TOKENS[sym]["emoji"]
    lp_amt = event["lp_amount"]
    lines = [f"📤  *${sym}/XNT LP UNSTAKED*  📤", "",
             f"{emoji} *Unstaked:* {fmt_amount(lp_amt)} ${sym}/XNT LP", ""]
    if event.get("wallet"):
        lines.append(f"👤 *Wallet:* [{shorten(event['wallet'])}]({explorer_address(event['wallet'])})")
    lines.append(f"🔗 [TX]({explorer_tx(event['signature'])})")
    lines.append(""); lines.append(f"💸 *LP withdrawn from the ${sym} farm.*")
    lines.append(f"#x1brains #{sym}Farm")
    return "\n".join(lines)


def build_claim(event, metrics, lb_tier) -> str:
    sym = event["token"]; emoji = config.TOKENS[sym]["emoji"]
    amt = event["amount"]
    usd_val = metrics["price_usd"] * amt if metrics and metrics.get("price_usd") else None
    coins = "💰" * max(6, min(int(float(amt) / 10), 28))
    is_big = usd_val is not None and float(usd_val) >= 100
    if is_big:
        header = f"💎💰  *MASSIVE ${sym} REWARD CLAIM!*  💰💎"
        vibe = f"🌟 *The yield is paid. Diamond hands rewarded.* 🌟"
    else:
        header = f"💰💰  *${sym} REWARDS CLAIMED!*  💰💰"
        vibe = f"🌱 *Yield harvested. Compounding the brains.* 🌱"
    lines = [header, "", coins, "",
             f"{emoji} *Claimed:* {fmt_amount(amt)} ${sym}"
             + (f"  ({fmt_usd(usd_val)})" if usd_val else "")]
    if metrics and metrics.get("price_usd"):
        lines.append(f"💲 *Reward Price:* {fmt_usd(metrics['price_usd'])}")
    lines.append("")
    if event.get("wallet"):
        lines.append(f"👤 *Farmer:* [{shorten(event['wallet'])}]({explorer_address(event['wallet'])})")
    if lb_tier:
        lines.append(f"   {lb_tier['name']} LB holder — earning boosted")
    lines.append(f"🔗 [TX]({explorer_tx(event['signature'])})")
    lines.append(""); lines.append(vibe); lines.append(f"#x1brains #{sym}Farm #YieldClaimed")
    return "\n".join(lines)


def build_message(event, metrics, lb_tier, xnt_usd, settings) -> str:
    t = event["type"]
    if t == "buy": return build_buy(event, metrics, lb_tier, xnt_usd, settings)
    if t == "burn": return build_burn(event, metrics)
    if t == "lp_pair": return build_lp_pair(event, metrics, xnt_usd)
    if t == "stake": return build_stake(event, lb_tier)
    if t == "unstake": return build_unstake(event)
    if t == "claim": return build_claim(event, metrics, lb_tier)
    return f"⚠️ Unknown event: {t}"
