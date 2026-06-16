// ── Shared 24h price-change source ──
// Both the header price strip and the landing ecosystem strip must show the
// SAME up/down badges. The old header computed change from a homegrown
// localStorage "anchor" (oldest sample within 24h, which is NOT actually 24h
// ago), so it drifted and disagreed with the landing strip. This module is the
// single source of truth: derive each token's real 24h change from on-chain
// chart-history bars, exactly the way the landing strip does.

import {
  fetchIndexerSnapshot, getCachedIndexerSnapshot,
  fetchChartHistory, pctChange24h,
  type IndexerSnapshot,
} from './brainsIndexer';

const WXNT = 'So11111111111111111111111111111111111111112';
const LB_MINT_ADDR = 'Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6';

export type TokenChange = { XNT: number | null; BRAINS: number | null; LB: number | null };

// Find the real on-chain USDC mint (USDC.X) by scanning prism pools for an
// XNT/USDC pair — same logic the landing card uses.
function deriveUsdcMintFromPrism(prism: IndexerSnapshot | null): string | null {
  if (!prism) return null;
  for (const p of prism.pools) {
    const a = p.token1, b = p.token2;
    const isAXnt  = a.address === WXNT;
    const isBXnt  = b.address === WXNT;
    const isAUsdc = /^USDC(\.X)?$/i.test(a.symbol);
    const isBUsdc = /^USDC(\.X)?$/i.test(b.symbol);
    if (isAXnt && isBUsdc) return b.address;
    if (isBXnt && isAUsdc) return a.address;
  }
  return null;
}

// Compute {XNT, BRAINS, LB} 24h change vs USD. brainsMint is passed in so it
// stays sourced from ../constants (single canonical value).
export async function fetch24hChanges(brainsMint: string): Promise<TokenChange> {
  let prism = getCachedIndexerSnapshot();
  let usdcMint = deriveUsdcMintFromPrism(prism);
  if (!usdcMint) {
    prism = await fetchIndexerSnapshot();
    usdcMint = deriveUsdcMintFromPrism(prism);
  }
  if (!usdcMint) return { XNT: null, BRAINS: null, LB: null };

  const [xntBars, brainsBars, lbBars] = await Promise.all([
    fetchChartHistory(WXNT, usdcMint, 24),
    fetchChartHistory(brainsMint, WXNT, 24),
    fetchChartHistory(LB_MINT_ADDR, WXNT, 24),
  ]);

  const xntChg = pctChange24h(xntBars);
  // token/USD change = compound(token-vs-XNT, XNT-vs-USD)
  const combine = (tokVsXnt: number | null) =>
    tokVsXnt == null || xntChg == null ? null : ((1 + tokVsXnt / 100) * (1 + xntChg / 100) - 1) * 100;

  return { XNT: xntChg, BRAINS: combine(pctChange24h(brainsBars)), LB: combine(pctChange24h(lbBars)) };
}
