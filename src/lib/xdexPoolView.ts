// Build a PoolsTab `PoolView` from an arbitrary xDEX pool — so PoolsTab's
// already-tested DepositModal and WithdrawModal can act on ANY xDEX pool
// (not just brains_pairing-tracked ones).
//
// brains_pairing-specific fields (creatorA/B, burnBps, lpBurned/Treasury/UserA/B,
// pda, seeded) are filled with safe zero-defaults — the modals only read what
// they actually need to build CP-Swap deposit/withdraw ixs, which is the
// XDEX state + vault balances + wallet LP.

import { Connection, PublicKey } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { PoolView } from '../pages/PoolsTab';
import type { XdexPoolMeta } from './xdexPoolChart';
import type { IndexerPool } from './brainsIndexer';

/** Resolve the wallet's LP balance for a pool. Returns 0n if no ATA. */
export async function fetchWalletLp(
  connection: Connection,
  wallet: PublicKey,
  lpMint: string,
): Promise<bigint> {
  const lpMintPk = new PublicKey(lpMint);
  // Try classic SPL first (most LP mints are classic).
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const ata = getAssociatedTokenAddressSync(lpMintPk, wallet, false, program);
      const info = await connection.getParsedAccountInfo(ata).catch(() => null);
      const amt = (info?.value?.data as any)?.parsed?.info?.tokenAmount?.amount;
      if (amt && BigInt(amt) > 0n) return BigInt(amt);
    } catch {}
  }
  return 0n;
}

/**
 * Construct a `PoolView` from xDEX state + prism + (optional) wallet LP.
 * @param prismPool — the matching IndexerPool from prism (for symbols/logos/prices/tvl).
 *                   Pass null if not available; symbols/logos fall back to "T0"/"T1".
 */
export function buildXdexPoolView(opts: {
  poolAddr: string;
  state:    XdexPoolMeta;
  prismPool?: IndexerPool | null;
  walletLp:  bigint;
}): PoolView {
  const { poolAddr, state, prismPool, walletLp } = opts;

  // Figure out which prism side aligns to which on-chain token0/token1.
  // The prism pool's token1/token2 ordering doesn't always match xDEX's
  // token0/token1 (xDEX sorts the two mints lexicographically), so detect
  // by mint match instead of trusting the order.
  let p0 = prismPool?.token1;
  let p1 = prismPool?.token2;
  if (prismPool && prismPool.token1.address === state.token1Mint) {
    p0 = prismPool.token2;
    p1 = prismPool.token1;
  }

  return {
    pda:        '',                  // brains_pairing-only — unused by deposit/withdraw modals
    poolAddr,
    lpMint:     state.lpMint,
    tokenAMint: state.token0Mint,
    tokenBMint: state.token1Mint,
    burnBps:    0,
    lpBurned:   0n,
    lpTreasury: 0n,
    lpUserA:    0n,
    lpUserB:    0n,
    creatorA:   '',
    creatorB:   '',
    createdAt:  0,
    seeded:     false,
    state: {
      ammConfig:    '',
      token0Vault:  state.token0Vault,
      token1Vault:  state.token1Vault,
      lpMint:       state.lpMint,
      token0Mint:   state.token0Mint,
      token1Mint:   state.token1Mint,
      token0Prog:   TOKEN_PROGRAM_ID.toBase58(),
      token1Prog:   TOKEN_PROGRAM_ID.toBase58(),
      obsKey:       state.obsKey,
      authBump:     0,
      status:       0,
      lpDecimals:   state.lpDecimals,
      dec0:         state.dec0,
      dec1:         state.dec1,
      lpSupply:     state.lpSupply,
    },
    vault0Bal:  state.vault0,
    vault1Bal:  state.vault1,
    sym0:       p0?.symbol || state.token0Mint.slice(0, 4),
    sym1:       p1?.symbol || state.token1Mint.slice(0, 4),
    logo0:      p0?.logo,
    logo1:      p1?.logo,
    tvlUsd:     prismPool?.tvl ?? 0,
    price0:     p0?.price ?? 0,
    price1:     p1?.price ?? 0,
    lpPrice:    prismPool?.lp_price ?? 0,
    walletLp,
    lpDecimals: state.lpDecimals,
    dec0:       state.dec0,
    dec1:       state.dec1,
    loading:    false,
  };
}
