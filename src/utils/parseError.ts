// parseError.ts
// Robust error parser for the brains_farm program.
//
// Handles:
//   - Anchor errors with named code (preferred — most reliable)
//   - Custom program errors as hex (fallback for raw simulation logs)
//   - Wallet rejections / cancels
//   - Insufficient funds (XNT for fees + 0.005 XNT stake fee)
//   - Network / RPC / blockhash issues
//   - Unknown errors (fail safe — generic message + console log for devs)

import { BRAINS_FARM_ERRORS, FarmErrorInfo } from './brainsFarmErrors';

export type ErrorSource = 'program' | 'wallet' | 'network' | 'unknown';

export type ParsedTxError = {
  source: ErrorSource;
  errorInfo: FarmErrorInfo | null;
  raw: string;
};

const HEX_RE     = /custom program error:\s*(0x[0-9a-fA-F]+)/i;
const ANCHOR_RE  = /Error Code:\s*(\w+)\.\s*Error Number:\s*(\d+)/i;

/**
 * Parse any error thrown by a tx send / simulate / wallet adapter into a
 * normalized ParsedTxError. Always returns a value — never throws.
 */
export function parseFarmError(err: unknown): ParsedTxError {
  const raw = stringifyError(err);

  // ── 1. User cancelled in wallet ─────────────────────────────────
  if (
    /user rejected|user denied|rejected the request|cancelled by user|user cancel/i.test(raw)
  ) {
    return {
      source: 'wallet',
      errorInfo: {
        code: -1, hex: 'N/A', name: 'UserRejected',
        title: 'Transaction cancelled',
        message: 'You cancelled the transaction in your wallet.',
        tone: 'info',
      },
      raw,
    };
  }

  // ── 2. Insufficient SOL/XNT for fees + stake fee ────────────────
  if (
    /insufficient funds|insufficient lamports|not enough.*lamports|0x1.*insufficient/i.test(raw)
  ) {
    return {
      source: 'wallet',
      errorInfo: {
        code: -2, hex: 'N/A', name: 'InsufficientFunds',
        title: 'Not enough XNT',
        message:
          'Your wallet needs a small amount of XNT to cover transaction fees. ' +
          'Staking also requires a 0.005 XNT fee.',
        tone: 'warning',
      },
      raw,
    };
  }

  // ── 3. Network / RPC / blockhash ────────────────────────────────
  if (
    /blockhash not found|node is behind|connection refused|timeout|fetch failed|network error|503|502|504/i
      .test(raw)
  ) {
    return {
      source: 'network',
      errorInfo: {
        code: -3, hex: 'N/A', name: 'NetworkIssue',
        title: 'Network hiccup',
        message: 'The X1 network is busy or your connection slipped. Try again in a moment.',
        tone: 'warning',
      },
      raw,
    };
  }

  // ── 4. Anchor named-error (most reliable when present) ──────────
  const anchorMatch = raw.match(ANCHOR_RE);
  if (anchorMatch) {
    const code = parseInt(anchorMatch[2], 10);
    return {
      source: 'program',
      errorInfo: BRAINS_FARM_ERRORS[code] ?? null,
      raw,
    };
  }

  // ── 5. Hex code (fallback for simulation logs) ──────────────────
  const hexMatch = raw.match(HEX_RE);
  if (hexMatch) {
    const code = parseInt(hexMatch[1], 16);
    return {
      source: 'program',
      errorInfo: BRAINS_FARM_ERRORS[code] ?? null,
      raw,
    };
  }

  return { source: 'unknown', errorInfo: null, raw };
}

/**
 * Best-effort stringification — pulls in everything useful that wallet
 * adapters and Anchor stash on Error subclasses (logs, simulationResponse,
 * etc.) so the regex matchers above have full context.
 */
function stringifyError(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;

  const parts: string[] = [];

  if (err instanceof Error) {
    parts.push(err.message);
    if (err.stack) parts.push(err.stack);
  }

  // Common shapes from @solana/web3.js, anchor, wallet adapters
  const any = err as any;

  if (any?.logs && Array.isArray(any.logs)) parts.push(any.logs.join('\n'));
  if (any?.transactionLogs && Array.isArray(any.transactionLogs)) {
    parts.push(any.transactionLogs.join('\n'));
  }
  if (any?.simulationResponse?.logs && Array.isArray(any.simulationResponse.logs)) {
    parts.push(any.simulationResponse.logs.join('\n'));
  }
  if (typeof any?.code === 'number') parts.push(`code=${any.code}`);
  if (typeof any?.error?.errorCode?.number === 'number') {
    parts.push(`Error Number: ${any.error.errorCode.number}`);
  }
  if (typeof any?.error?.errorCode?.code === 'string') {
    parts.push(`Error Code: ${any.error.errorCode.code}.`);
  }

  try {
    parts.push(JSON.stringify(err, Object.getOwnPropertyNames(err)));
  } catch {
    /* circular — ignore */
  }

  return parts.join('\n');
}

/** Generic fallback message for unknown errors — never show raw hex. */
export const UNKNOWN_ERROR_FALLBACK: FarmErrorInfo = {
  code: -999,
  hex: 'N/A',
  name: 'Unknown',
  title: 'Something went wrong',
  message: 'The transaction couldn\'t be completed. Please try again or contact support if it keeps happening.',
  tone: 'error',
};
