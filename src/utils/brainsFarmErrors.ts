// brainsFarmErrors.ts
// User-friendly mapping for every error thrown by the brains_farm program.
//
// Anchor user errors start at 6000. Codes match the order of variants in
// programs/brains_farm/src/errors.rs.
//
// IMPORTANT: error 6028 (ClaimTooSoon) is overloaded — it fires for both
// "still in grace period" and "24h cooldown not elapsed". Use
// resolveClaimTooSoon() to disambiguate based on the position state.

export type ErrorTone = 'info' | 'warning' | 'error';

export type FarmErrorInfo = {
  code: number;
  hex: string;
  name: string;
  title: string;
  message: string;
  tone: ErrorTone;
};

export const BRAINS_FARM_ERRORS: Record<number, FarmErrorInfo> = {
  // ── Program state ───────────────────────────────────────────────
  6000: {
    code: 6000, hex: '0x1770', name: 'Paused',
    title: 'Protocol paused',
    message: 'The X1 Brains farm is temporarily paused for maintenance. Your funds are safe — staking will reopen shortly.',
    tone: 'info',
  },
  6001: {
    code: 6001, hex: '0x1771', name: 'FarmPaused',
    title: 'Farm paused',
    message: 'This farm is temporarily paused. New stakes are disabled, but you can still unstake your existing positions.',
    tone: 'info',
  },
  6002: {
    code: 6002, hex: '0x1772', name: 'Reentrancy',
    title: 'Please try again',
    message: 'Another action is currently being processed. Wait a moment and try again.',
    tone: 'warning',
  },
  6003: {
    code: 6003, hex: '0x1773', name: 'Overflow',
    title: 'Amount out of range',
    message: 'The amount you entered is too large. Try a smaller value.',
    tone: 'error',
  },
  6004: {
    code: 6004, hex: '0x1774', name: 'FarmClosed',
    title: 'Farm closed',
    message: 'This farm has been permanently closed and is no longer accepting deposits.',
    tone: 'info',
  },
  6005: {
    code: 6005, hex: '0x1775', name: 'ClockDrift',
    title: 'Network sync issue',
    message: 'Network time appears out of sync. Please try again in a few seconds.',
    tone: 'warning',
  },

  // ── Authorization ───────────────────────────────────────────────
  6006: {
    code: 6006, hex: '0x1776', name: 'Unauthorized',
    title: 'Not authorized',
    message: "Your wallet doesn't have permission to perform this action.",
    tone: 'error',
  },
  6007: {
    code: 6007, hex: '0x1777', name: 'NotPositionOwner',
    title: 'Position not yours',
    message: 'This position belongs to a different wallet. Switch wallets or pick one of your own positions.',
    tone: 'error',
  },
  6008: {
    code: 6008, hex: '0x1778', name: 'InvalidTreasury',
    title: 'Invalid treasury',
    message: "Transaction couldn't be built correctly. Refresh the page and try again.",
    tone: 'error',
  },

  // ── Farm validation ─────────────────────────────────────────────
  6009: {
    code: 6009, hex: '0x1779', name: 'RateZero',
    title: 'Invalid rate',
    message: 'Reward rate must be greater than zero.',
    tone: 'error',
  },
  6010: {
    code: 6010, hex: '0x177a', name: 'RateTooHigh',
    title: 'Rate change too large',
    message: 'Rate change exceeds the safety limit. This protects stakers from sudden emission spikes.',
    tone: 'warning',
  },
  6011: {
    code: 6011, hex: '0x177b', name: 'DurationTooShort',
    title: 'Duration too short',
    message: 'Farm duration must be at least 7 days.',
    tone: 'error',
  },
  6012: {
    code: 6012, hex: '0x177c', name: 'DurationTooLong',
    title: 'Duration too long',
    message: 'Farm duration cannot exceed 2 years.',
    tone: 'error',
  },
  6013: {
    code: 6013, hex: '0x177d', name: 'SeedZero',
    title: 'Invalid seed',
    message: 'Seed amount must be greater than zero.',
    tone: 'error',
  },

  // ── LP mint provenance ──────────────────────────────────────────
  6014: {
    code: 6014, hex: '0x177e', name: 'InvalidLpMint',
    title: 'Unsupported LP token',
    message: "This LP token isn't supported. Only LP tokens from XDEX or X1 Brains pairing pools can be staked.",
    tone: 'error',
  },
  6015: {
    code: 6015, hex: '0x177f', name: 'PoolRecordMismatch',
    title: 'Pool mismatch',
    message: "The selected pool doesn't match this LP token. Refresh and try again.",
    tone: 'error',
  },
  6016: {
    code: 6016, hex: '0x1780', name: 'NotXdexLpMint',
    title: 'Not an XDEX LP token',
    message: 'Only XDEX LP tokens can be staked here.',
    tone: 'error',
  },
  6017: {
    code: 6017, hex: '0x1781', name: 'InvalidPairingProgram',
    title: 'Invalid pairing source',
    message: 'The pool source could not be verified.',
    tone: 'error',
  },

  // ── Reward vault / funding ──────────────────────────────────────
  6018: {
    code: 6018, hex: '0x1782', name: 'InsufficientRewardVault',
    title: 'Reward pool low',
    message: 'The reward vault is running low. Try again later or claim a smaller amount.',
    tone: 'warning',
  },
  6019: {
    code: 6019, hex: '0x1783', name: 'RewardsEarmarked',
    title: 'Reserved for stakers',
    message: 'These rewards are reserved for active stakers and cannot be withdrawn.',
    tone: 'info',
  },
  6020: {
    code: 6020, hex: '0x1784', name: 'RewardMintMismatch',
    title: 'Wrong reward token',
    message: "The token in your wallet doesn't match this farm's reward. Refresh the page.",
    tone: 'error',
  },
  6021: {
    code: 6021, hex: '0x1785', name: 'LpMintMismatch',
    title: 'Wrong LP token',
    message: "The LP token doesn't match this farm. Refresh the page.",
    tone: 'error',
  },

  // ── Staking ─────────────────────────────────────────────────────
  6022: {
    code: 6022, hex: '0x1786', name: 'StakeTooSmall',
    title: 'Stake too small',
    message: 'The minimum stake is 100 raw LP units. Increase your amount and try again.',
    tone: 'warning',
  },
  6023: {
    code: 6023, hex: '0x1787', name: 'ZeroAmount',
    title: 'Enter an amount',
    message: 'Please enter an amount greater than zero.',
    tone: 'warning',
  },
  6024: {
    code: 6024, hex: '0x1788', name: 'TooManyPositions',
    title: 'Position limit reached',
    message: "You've reached the maximum of 100 positions in this farm. Close an existing position to open a new one.",
    tone: 'warning',
  },
  6025: {
    code: 6025, hex: '0x1789', name: 'NonceTaken',
    title: 'Try again',
    message: 'A position with this ID already exists. Refresh and retry — a new ID will be picked.',
    tone: 'warning',
  },
  6026: {
    code: 6026, hex: '0x178a', name: 'InvalidLockType',
    title: 'Invalid lock',
    message: 'Pick a valid lock period (30, 90, or 365 days).',
    tone: 'error',
  },

  // ── Claim ───────────────────────────────────────────────────────
  6027: {
    code: 6027, hex: '0x178b', name: 'NothingToClaim',
    title: 'Nothing to claim yet',
    message: 'Your rewards are still accruing. Check back soon — rewards stream continuously.',
    tone: 'info',
  },
  6028: {
    code: 6028, hex: '0x178c', name: 'ClaimTooSoon',
    // Generic fallback — prefer resolveClaimTooSoon() to get a precise message
    title: 'Claim not ready yet',
    message: 'Your claim window has not opened yet. Try again shortly.',
    tone: 'info',
  },

  // ── Unstake ─────────────────────────────────────────────────────
  6029: {
    code: 6029, hex: '0x178d', name: 'WrongFarm',
    title: 'Position not in this farm',
    message: 'This position belongs to a different farm.',
    tone: 'error',
  },

  // ── Lifecycle ───────────────────────────────────────────────────
  6030: {
    code: 6030, hex: '0x178e', name: 'FarmHasStakers',
    title: 'Farm has active stakers',
    message: 'This farm still has active positions and cannot be closed.',
    tone: 'info',
  },
  6031: {
    code: 6031, hex: '0x178f', name: 'VaultNotEmpty',
    title: 'Vault not empty',
    message: 'Reward vault still holds tokens.',
    tone: 'info',
  },

  // ── General ─────────────────────────────────────────────────────
  6032: {
    code: 6032, hex: '0x1790', name: 'InvalidBump',
    title: 'Account error',
    message: 'Account derivation failed. Refresh the page and try again.',
    tone: 'error',
  },
  6033: {
    code: 6033, hex: '0x1791', name: 'InvalidAccountData',
    title: 'Invalid account',
    message: 'One of the accounts in the transaction is invalid. Refresh and retry.',
    tone: 'error',
  },
};

// ── Helpers ───────────────────────────────────────────────────────

/** Format seconds into a friendly "X hours Y minutes" / "Z days" string. */
export function formatDuration(secs: number): string {
  if (secs <= 0) return 'a moment';
  if (secs < 60) return `${Math.ceil(secs)} seconds`;
  if (secs < 3600) {
    const m = Math.ceil(secs / 60);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  if (secs < 86400) {
    const h = Math.floor(secs / 3600);
    const m = Math.ceil((secs - h * 3600) / 60);
    if (m === 0 || m === 60) return `${h} hour${h === 1 ? '' : 's'}`;
    return `${h}h ${m}m`;
  }
  const d = Math.floor(secs / 86400);
  const h = Math.ceil((secs - d * 86400) / 3600);
  if (h === 0 || h === 24) return `${d} day${d === 1 ? '' : 's'}`;
  return `${d}d ${h}h`;
}

/** Position state needed to disambiguate ClaimTooSoon. */
export type PositionTimes = {
  graceEndTs: number;    // unix seconds
  lastClaimTs: number;   // unix seconds
};

const CLAIM_COOLDOWN_SECS = 24 * 60 * 60;

/**
 * Disambiguate the overloaded ClaimTooSoon (6028) based on position state.
 * Pass the cluster's current unix time (e.g. via getBlockTime/getSlot)
 */
export function resolveClaimTooSoon(
  pos: PositionTimes,
  nowUnix: number,
): FarmErrorInfo {
  // Grace branch: claim.rs requires `now > position.grace_end_ts`
  if (nowUnix <= pos.graceEndTs) {
    const left = pos.graceEndTs - nowUnix + 1; // +1 because gate is strict >
    return {
      code: 6028,
      hex: '0x178c',
      name: 'ClaimDuringGrace',
      title: '3-day grace period active',
      message:
        `Rewards aren't claimable during the first 3 days of a stake. ` +
        `This is a safety feature — you can exit anytime in this window with no penalty. ` +
        `Claiming opens in ${formatDuration(left)}.`,
      tone: 'info',
    };
  }

  // Cooldown branch: now < last_claim_ts + 86400
  const nextAt = pos.lastClaimTs + CLAIM_COOLDOWN_SECS;
  const left = nextAt - nowUnix;
  return {
    code: 6028,
    hex: '0x178c',
    name: 'ClaimCooldown',
    title: 'Claim cooldown active',
    message:
      `You can claim once every 24 hours. ` +
      `Next claim available in ${formatDuration(left)}.`,
    tone: 'info',
  };
}
