// src/lib/transferFee.ts
// Token-2022 transfer-fee ("tax") maths for any mint, read live from the chain.
//
// A taxed token is withheld on EVERY transfer, including the ones xDEX makes:
//   - sending `amount` delivers `amount - fee(amount)` to the other side;
//   - xDEX checks a swap's `minimum_amount_out` against what the wallet RECEIVES
//     (after the output-side tax), and a deposit's `maximum_token_*` against what
//     the wallet SENDS (vault amount + input-side tax).
// A quote that ignores the tax overstates by the tax rate and the swap dies with
// 6005 ExceededSlippage (verified on a local X1 fork at 0.04 / 4 / 8 %, 10-02).
//
// The maths here mirrors spl-token-2022 exactly (fee rounds UP, capped at
// maximum_fee; the inverse uses calculate_pre_fee_amount), so quotes match the
// program to the raw unit. `null` everywhere means "no tax": classic SPL mints,
// Token-2022 mints without the extension, and unreadable mints are all treated
// as untaxed, because guessing a tax would block every swap of that token.
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, unpackMint, getTransferFeeConfig, getEpochFee } from '@solana/spl-token';

export interface TransferFee {
  bps: number;     // basis points, 0..10_000
  max: bigint;     // maximum_fee per transfer, raw units
}

const ONE_IN_BASIS_POINTS = 10_000n;

/** Fee withheld when `amount` raw units are sent. */
export function feeOn(f: TransferFee | null, amount: bigint): bigint {
  if (!f || f.bps === 0 || amount <= 0n) return 0n;
  const raw = (amount * BigInt(f.bps) + ONE_IN_BASIS_POINTS - 1n) / ONE_IN_BASIS_POINTS; // ceil
  return raw > f.max ? f.max : raw;
}

/** What the receiver gets when `amount` raw units are sent. */
export function netOf(f: TransferFee | null, amount: bigint): bigint {
  return amount - feeOn(f, amount);
}

/** How much to send so the receiver gets exactly `net` (spl calculate_pre_fee_amount). */
export function grossFor(f: TransferFee | null, net: bigint): bigint {
  if (!f || f.bps === 0 || net <= 0n) return net;
  const bps = BigInt(f.bps);
  if (bps === ONE_IN_BASIS_POINTS) return net + f.max;
  const pre = (net * ONE_IN_BASIS_POINTS + (ONE_IN_BASIS_POINTS - bps) - 1n) / (ONE_IN_BASIS_POINTS - bps); // ceil
  return pre - net >= f.max ? net + f.max : pre;
}

/** Tax rate as a display string, e.g. "4%" / "0.04%"; '' when untaxed. */
export function feeLabel(f: TransferFee | null): string {
  if (!f || f.bps === 0) return '';
  return `${+(f.bps / 100).toFixed(2)}%`;
}

// ── live read ────────────────────────────────────────────────────────────────
const cache = new Map<string, { at: number; fee: TransferFee | null }>();
let epochCache: { at: number; epoch: bigint } | null = null;
const TTL_MS = 60_000;

async function currentEpoch(conn: Connection): Promise<bigint> {
  if (epochCache && Date.now() - epochCache.at < TTL_MS) return epochCache.epoch;
  const info = await conn.getEpochInfo('confirmed');
  epochCache = { at: Date.now(), epoch: BigInt(info.epoch) };
  return epochCache.epoch;
}

/** The tax in force THIS epoch for `mint` (a scheduled change counts once its epoch arrives). */
export async function getTransferFee(conn: Connection, mint: string): Promise<TransferFee | null> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.fee;
  let fee: TransferFee | null = null;
  try {
    const pk = new PublicKey(mint);
    const info = await conn.getAccountInfo(pk, 'confirmed');
    if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      const cfg = getTransferFeeConfig(unpackMint(pk, info, TOKEN_2022_PROGRAM_ID));
      if (cfg) {
        const e = getEpochFee(cfg, await currentEpoch(conn));
        if (e.transferFeeBasisPoints > 0) fee = { bps: e.transferFeeBasisPoints, max: e.maximumFee };
      }
    }
  } catch (err) {
    console.warn('[transferFee] could not read', mint, err);
    return hit?.fee ?? null; // keep the last good answer, don't cache the failure
  }
  cache.set(mint, { at: Date.now(), fee });
  return fee;
}
