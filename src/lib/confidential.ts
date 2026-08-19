// ─────────────────────────────────────────────────────────────────────────────
// Token-2022 confidential transfers, client side.
//
// ⛔ THE VERSION RULE — read PROJECT.md §17.1 before touching this file.
// X1's ZkElGamalProof program ONLY accepts proofs from @solana/zk-sdk <= 0.3.1.
// Proofs from 0.4.x / 0.5.x verify LOCALLY and are rejected on chain as
// `SigmaProof(_, AlgebraicRelation)` — a maths error, not a parse error, so it
// reads exactly like a broken construction. The version is pinned deliberately.
//
// The ~2.6 MB WASM is behind a dynamic import so nobody pays for it unless they
// actually opt into a confidential feature.
// ─────────────────────────────────────────────────────────────────────────────
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, ExtensionType, createReallocateInstruction,
  createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Buffer } from 'buffer';   // web3.js types TransactionInstruction.data as Buffer
import { ed25519, RistrettoPoint } from '@noble/curves/ed25519';
import { sha512, sha256 } from '@noble/hashes/sha2';
import { sha3_512 } from '@noble/hashes/sha3';
import { hkdf } from '@noble/hashes/hkdf';

export const ZK_ELGAMAL_PROOF_PROGRAM = new PublicKey('ZkE1Gama1Proof11111111111111111111111111111');

/** Token-2022 extension + sub-instruction discriminators, confirmed on chain. */
const EXT_CONFIDENTIAL_TRANSFER = 27;
const IX_CONFIGURE_ACCOUNT      = 2;
const IX_DEPOSIT                = 5;
const IX_WITHDRAW               = 6;
const IX_TRANSFER               = 7;
const IX_APPLY_PENDING_BALANCE  = 8;
const IX_EMPTY_ACCOUNT          = 4;
/** ConfidentialMintBurn is its OWN extension, so a different outer byte. */
const EXT_CONFIDENTIAL_MINT_BURN = 42;
const IX_CMB_UPDATE_SUPPLY      = 2;
const IX_CMB_MINT               = 3;
const IX_CMB_BURN               = 4;
const IX_CMB_APPLY_PENDING_BURN = 5;

/**
 * ZkElGamalProof instruction discriminators.
 *
 * 4 is confirmed by a working transaction on chain (ENABLE). The rest are read
 * off the same enum ordering, and every one of them is exercised end to end by
 * scripts/confidential-transfer-probe.ts against X1 before shipping — a wrong
 * value here fails as a maths error, not a parse error, so it must be tested
 * rather than reasoned about.
 */
const PROOF_CLOSE_CONTEXT_STATE      = 0;
const PROOF_VERIFY_ZERO_CIPHERTEXT   = 1;
const PROOF_VERIFY_EQUALITY          = 3;
const PROOF_VERIFY_PUBKEY_VALIDITY   = 4;
const PROOF_VERIFY_RANGE_U64         = 6;
const PROOF_VERIFY_RANGE_U128        = 7;
const PROOF_VERIFY_VALIDITY_3HANDLES = 12;

/** Context-state account sizes: 33-byte header (authority + proof type) + context. */
const CTX_LEN_EQUALITY = 161;
const CTX_LEN_VALIDITY = 385;
const CTX_LEN_RANGE    = 297;
const CTX_LEN_RANGE_U64 = 297;

/** The program splits a transfer amount at 16 bits; the high half carries 32. */
const XFER_LO_BITS = 16n;
const XFER_LO_MASK = 0xffffn;
const XFER_HI_SCALE = 1n << XFER_LO_BITS;
/** 48 bits total, so this is the largest amount a single transfer can move. */
export const MAX_CONFIDENTIAL_TRANSFER = (1n << 48n) - 1n;
/** What the spl-token CLI uses; matching it keeps accounts consistent. */
const MAX_PENDING_BALANCE_CREDIT_COUNTER = 65536n;

type SignMessage = (m: Uint8Array) => Promise<Uint8Array>;

// ── WASM, loaded once, on demand ─────────────────────────────────────────────
let _zk: any = null;
let _zkLoading: Promise<any> | null = null;

/**
 * Load and initialise the proof WASM, once.
 *
 * Uses the `/web` entry, NOT `/bundler`: the bundler build relies on the ESM
 * WebAssembly integration proposal, which Vite refuses to bundle
 * ("`ESM integration proposal for Wasm` is not supported currently") unless you
 * add vite-plugin-wasm. The `/web` build instead exposes an explicit init that
 * takes a URL, and Vite emits the .wasm as a plain asset via `?url` — no extra
 * plugins, and the ~2.6 MB payload is only fetched on first use.
 */
/**
 * Hand in an already-initialised module.
 *
 * The node probe (scripts/confidential-transfer-probe.ts) uses this to run the
 * `/node` build through these exact functions. Testing a reimplementation would
 * prove nothing about the code that ships.
 */
export function provideZk(mod: any) { _zk = mod; }

export async function loadZk(): Promise<any> {
  if (_zk) return _zk;
  if (!_zkLoading) {
    _zkLoading = (async () => {
      const [mod, wasmUrl] = await Promise.all([
        import('@solana/zk-sdk/web'),
        // Relative path on purpose: the package's `exports` map does not expose
        // the raw .wasm, so `@solana/zk-sdk/dist/...` is unresolvable. Vite emits
        // it as a hashed asset and keeps the 2.6 MB binary out of git.
        import('../../node_modules/@solana/zk-sdk/dist/web/solana_zk_sdk_wasm_js_bg.wasm?url').then(m => m.default),
      ]);
      await (mod as any).default(wasmUrl);
      _zk = mod;
      return mod;
    })();
  }
  return _zkLoading;
}

/**
 * The two messages a wallet signs to derive its confidential keys.
 *
 * This is the spl-token CLI's scheme, reproduced byte for byte, so that an
 * account configured here is readable by the CLI and an account configured by
 * the CLI is readable here. Reconstructing it took reading the Rust: the
 * signature is hashed TWICE with SHA3-512 — once by `seed_from_signature` and
 * again by `from_seed` — which is the step every earlier attempt missed, and
 * which fails silently by producing a perfectly valid key for the wrong account.
 *
 * The public seed is EMPTY, exactly as the CLI passes it, so the key is per
 * WALLET rather than per token account: two signatures unlock every
 * confidential token the wallet holds, not two per token.
 */
export const ELGAMAL_MESSAGE = new TextEncoder().encode('ElGamalSecretKey');
export const AE_MESSAGE      = new TextEncoder().encode('AeKey');

/**
 * ⚠️ LEGACY — the derivation this app used before the CLI's was reproduced.
 *
 * Accounts configured with it are stuck with it: ConfigureAccount is not
 * idempotent, so a key cannot be rotated in place. Kept as a read fallback and
 * never used for new accounts.
 */
export const legacyKeyMessage = (tokenAccount: PublicKey) =>
  new TextEncoder().encode(`x1brains.confidential.v1:${tokenAccount.toBase58()}`);

export interface ConfidentialKeys {
  elgamal: any;            // ElGamalKeypair
  ae: any;                 // AeKey
  elgamalPubkeyB64: string;
}

/** Scalar::from_bytes_mod_order_wide over a 64-byte little-endian hash. */
function scalarFromWide(wide: Uint8Array): Uint8Array {
  let x = 0n;
  for (let i = 63; i >= 0; i--) x = (x << 8n) | BigInt(wide[i]);
  let s = x % ed25519.CURVE.n;
  const le = new Uint8Array(32);
  for (let i = 0; i < 32; i++) { le[i] = Number(s & 0xffn); s >>= 8n; }
  return le;
}

/** Build a key pair from the two raw signatures, whichever scheme produced them. */
function keysFrom(zk: any, elgamalSig: Uint8Array, aeSig: Uint8Array, legacy: boolean): ConfidentialKeys {
  const elgamal = zk.ElGamalKeypair.fromSecretKey(zk.ElGamalSecretKey.fromBytes(
    legacy ? scalarFromWide(sha512(elgamalSig))
           // seed_from_signature hashes the signature, then from_seed hashes
           // the seed. Two rounds, not one.
           : scalarFromWide(sha3_512(sha3_512(elgamalSig))),
  ));
  const ae = zk.AeKey.fromBytes(
    legacy ? sha256(new Uint8Array([...new TextEncoder().encode('ae:'), ...aeSig])).slice(0, 16)
           : sha3_512(sha3_512(aeSig)).slice(0, 16),
  );
  return {
    elgamal, ae,
    elgamalPubkeyB64: btoa(String.fromCharCode(...elgamal.pubkey().toBytes())),
  };
}

/**
 * solana-conf-bal/v1 — the current standard, and ONE signature for both keys.
 *
 * zk-sdk 7 replaced the two-message SHA3 scheme with a single HKDF-SHA512
 * chain, explicitly so that a wallet-adapter flow signs once:
 *
 *   prk        = HKDF-Extract(salt = "solana-conf-bal/v1", ikm = signature)
 *   ae_key     = HKDF-Expand(prk, "ae",      16)
 *   elgamal_sk = wide_reduce(HKDF-Expand(prk, "elgamal", 64))
 *
 * The signed message is the salt followed by the public seed, and the seed is
 * empty here for the same reason as the older scheme: one key per wallet
 * rather than one per token account.
 *
 * Used for every account this app configures from now on. The spl-token CLI we
 * run locally is 5.5 and predates it, so it cannot read these — the older
 * scheme stays supported for reading, which is what the treasury needs.
 */
const HKDF_SALT = new TextEncoder().encode('solana-conf-bal/v1');
const HKDF_INFO_AE = new TextEncoder().encode('ae');
const HKDF_INFO_ELGAMAL = new TextEncoder().encode('elgamal');

export async function deriveKeysHkdf(signMessage: SignMessage): Promise<ConfidentialKeys> {
  const zk = await loadZk();
  const sig = await signMessage(HKDF_SALT);          // salt || empty public seed
  const elgamal = zk.ElGamalKeypair.fromSecretKey(zk.ElGamalSecretKey.fromBytes(
    scalarFromWide(hkdf(sha512, sig, HKDF_SALT, HKDF_INFO_ELGAMAL, 64)),
  ));
  const ae = zk.AeKey.fromBytes(hkdf(sha512, sig, HKDF_SALT, HKDF_INFO_AE, 16));
  return {
    elgamal, ae,
    elgamalPubkeyB64: btoa(String.fromCharCode(...elgamal.pubkey().toBytes())),
  };
}

/**
 * Derive this wallet's confidential keys the older standard way.
 *
 * Two signatures because the scheme signs a different message per key. They are
 * per wallet, so this happens once no matter how many private tokens are held.
 */
export async function deriveKeys(signMessage: SignMessage): Promise<ConfidentialKeys> {
  const zk = await loadZk();
  const [eg, ae] = [await signMessage(ELGAMAL_MESSAGE), await signMessage(AE_MESSAGE)];
  return keysFrom(zk, eg, ae, false);
}

/** Derive the pre-interop keys for an account this app configured. */
export async function deriveLegacyKeys(
  tokenAccount: PublicKey, signMessage: SignMessage,
): Promise<ConfidentialKeys> {
  const zk = await loadZk();
  const sig = await signMessage(legacyKeyMessage(tokenAccount));
  return keysFrom(zk, sig, sig, true);
}

/**
 * Reallocate + ConfigureAccount + its proof.
 *
 * ⛔ The REALLOCATE is not optional. A plain ATA is 170 bytes and
 * ConfigureAccount fails with `InvalidAccountData` because there is nowhere to
 * put the extension — the error names neither the account nor the size, so it
 * reads like a malformed instruction. The account must first grow to 469 bytes
 * (getAccountLen([ConfidentialTransferAccount, ImmutableOwner])), which is
 * exactly the size of a working CLI-configured account. The owner pays the
 * extra rent.
 *
 * ConfigureAccount + its proof are then two top-level instructions.
 *
 * Layout decoded from a real CLI transaction on chain rather than guessed:
 *   accounts  [tokenAccount, mint, instructionsSysvar, authority(signer)]
 *   data      [27][2][decryptableZeroBalance:36][maxPendingCreditCounter u64][proofOffset i8]
 * The proof rides INLINE at offset +1 (the next instruction), which is why the
 * instructions sysvar is in the account list — the program reads it to find the
 * proof. `proofOffset` is relative, so ConfigureAccount must come first.
 */
export async function buildConfigureAccountIxs(
  mint: PublicKey, tokenAccount: PublicKey, authority: PublicKey, keys: ConfidentialKeys,
): Promise<TransactionInstruction[]> {
  const zk = await loadZk();

  const proof = new zk.PubkeyValidityProofData(keys.elgamal);
  proof.verify();   // local sanity only — the chain re-verifies and is the real judge

  const zeroBalance: Uint8Array = keys.ae.encrypt(0n).toBytes();       // 36 bytes
  if (zeroBalance.length !== 36) throw new Error(`AE ciphertext ${zeroBalance.length}B, expected 36`);

  // Uint8Array, not Buffer: this is browser code and Buffer only exists here
  // through a polyfill.
  const data = new Uint8Array(47);
  const dv = new DataView(data.buffer);
  data[0] = EXT_CONFIDENTIAL_TRANSFER;
  data[1] = IX_CONFIGURE_ACCOUNT;
  data.set(zeroBalance, 2);
  dv.setBigUint64(38, MAX_PENDING_BALANCE_CREDIT_COUNTER, true);       // little-endian
  dv.setInt8(46, 1);                                                   // proof is the NEXT instruction

  return [
    // Idempotent on purpose: a holder may not have an account for this mint at
    // all. Creating it here means ENABLE is one click from a standing start
    // instead of failing on an account that was never opened — and if the
    // account already exists this is a no-op rather than an error. A fresh ATA
    // is still only 170 bytes, so the reallocate below is needed either way.
    createAssociatedTokenAccountIdempotentInstruction(
      authority, tokenAccount, authority, mint, TOKEN_2022_PROGRAM_ID,
    ),
    createReallocateInstruction(
      tokenAccount, authority, [ExtensionType.ConfidentialTransferAccount], authority,
      [], TOKEN_2022_PROGRAM_ID,
    ),
    new TransactionInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      keys: [
        { pubkey: tokenAccount,               isSigner: false, isWritable: true  },
        { pubkey: mint,                       isSigner: false, isWritable: false },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: authority,                  isSigner: true,  isWritable: false },
      ],
      data: Buffer.from(data),
    }),
    new TransactionInstruction({
      programId: ZK_ELGAMAL_PROOF_PROGRAM,
      keys: [],
      data: (() => {
        const p: Uint8Array = proof.toBytes();
        const out = new Uint8Array(1 + p.length);
        out[0] = PROOF_VERIFY_PUBKEY_VALIDITY;
        out.set(p, 1);
        return Buffer.from(out);
      })(),
    }),
  ];
}

/** The associated token account this wallet uses for a Token-2022 mint. */
export const ataFor = (mint: PublicKey, owner: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);

/**
 * Ready-to-sign transaction that opts a wallet into confidential transfers for
 * one mint — creating the token account first if it does not exist yet.
 */
export async function buildConfigureAccountTx(
  connection: Connection, mint: PublicKey, tokenAccount: PublicKey,
  authority: PublicKey, signMessage: SignMessage,
): Promise<Transaction> {
  // hkdf, not the two-message scheme: this account is being created right now,
  // so nothing constrains which standard it adopts, and the current one costs
  // the user a single signature.
  const keys = await deriveKeysHkdf(signMessage);
  const tx = new Transaction().add(...await buildConfigureAccountIxs(mint, tokenAccount, authority, keys));
  tx.feePayer = authority;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return tx;
}

/** True when the account already carries the confidentialTransferAccount extension. */
export async function isConfigured(connection: Connection, tokenAccount: PublicKey): Promise<boolean> {
  const ai = await connection.getParsedAccountInfo(tokenAccount);
  const exts = (ai.value as any)?.data?.parsed?.info?.extensions ?? [];
  return exts.some((e: any) => e.extension === 'confidentialTransferAccount');
}

/**
 * Derived keys, cached for the session, keyed by token account.
 *
 * ⛔ IN MEMORY ONLY — never localStorage, never sessionStorage. These decrypt
 * the balance the whole feature exists to hide; a copy on disk is a copy an
 * XSS or a shared machine can read. The cost of losing them is one wallet
 * signature, so there is no reason to take that risk.
 */
const _keyCache = new Map<string, ConfidentialKeys>();

export type Scheme = 'hkdf' | 'sha3' | 'legacy';

/**
 * Which scheme last opened a given account.
 *
 * Only the NAME is stored, never key material — knowing an account uses
 * "sha3" tells an attacker nothing they could not read off the chain. That is
 * what makes it safe to persist, and persisting it is the whole point: without
 * it every session re-discovers the scheme by deriving the wrong one first,
 * and each wrong guess costs the user a signature prompt for nothing.
 */
const schemeHintKey = (wallet: PublicKey, account: PublicKey) =>
  `x1b.cfd.scheme.${wallet.toBase58()}.${account.toBase58()}`;

const readHint = (wallet: PublicKey, account: PublicKey): Scheme | null => {
  try {
    const v = localStorage.getItem(schemeHintKey(wallet, account));
    return v === 'hkdf' || v === 'sha3' || v === 'legacy' ? v : null;
  } catch { return null; }
};
const writeHint = (wallet: PublicKey, account: PublicKey, scheme: Scheme) => {
  try { localStorage.setItem(schemeHintKey(wallet, account), scheme); } catch { /* private mode */ }
};

/**
 * The keys that actually open this account, cached for the session.
 *
 * Every candidate is checked against the account's published `elgamalPubkey`
 * BEFORE being trusted. A wrong key is not an error — it is a valid key for a
 * different account — so without that check it would decrypt to nonsense or
 * fail deep inside a proof.
 *
 * Order matters because each miss costs a wallet prompt. A remembered scheme is
 * tried first, so a returning user pays exactly what their account needs: one
 * signature for hkdf or legacy, two for sha3 (that scheme signs twice by
 * design). Only a first encounter can cost a wasted prompt.
 *
 * Returns null when nothing fits: the account belongs to a third
 * implementation and cannot be opened from here.
 */
export async function getSessionKeys(
  connection: Connection, tokenAccount: PublicKey, wallet: PublicKey, signMessage: SignMessage,
  /** Fires before each signature so the UI can say what is being asked for. */
  onStep?: (step: Scheme) => void,
): Promise<ConfidentialKeys | null> {
  const ai = await connection.getParsedAccountInfo(tokenAccount);
  const onChain: string | undefined = ((ai.value as any)?.data?.parsed?.info?.extensions ?? [])
    .find((e: any) => e.extension === 'confidentialTransferAccount')?.state?.elgamalPubkey;

  // hkdf and sha3 are per WALLET, so one derivation serves every token it holds;
  // legacy predates that and is per account.
  const cacheKey = (sch: Scheme) => sch === 'legacy'
    ? `legacy:${wallet.toBase58()}:${tokenAccount.toBase58()}`
    : `${sch}:${wallet.toBase58()}`;

  const derive = async (sch: Scheme): Promise<ConfidentialKeys> => {
    const hit = _keyCache.get(cacheKey(sch));
    if (hit) return hit;
    onStep?.(sch);
    const keys = sch === 'hkdf' ? await deriveKeysHkdf(signMessage)
               : sch === 'sha3' ? await deriveKeys(signMessage)
               : await deriveLegacyKeys(tokenAccount, signMessage);
    _keyCache.set(cacheKey(sch), keys);
    return keys;
  };

  // A fresh account has no extension to match against, so it is whatever we are
  // configuring it as — which is the current standard.
  if (!onChain) return derive('hkdf');

  const hint = readHint(wallet, tokenAccount);
  const order: Scheme[] = hint
    ? [hint, ...(['hkdf', 'sha3', 'legacy'] as Scheme[]).filter(x => x !== hint)]
    : ['hkdf', 'sha3', 'legacy'];

  for (const sch of order) {
    const keys = await derive(sch);
    if (keys.elgamalPubkeyB64 === onChain) {
      writeHint(wallet, tokenAccount, sch);
      return keys;
    }
  }
  return null;
}

/** Drop every cached key — call on wallet disconnect. */
export const clearSessionKeys = () => _keyCache.clear();

export interface ConfidentialBalances {
  /** Spendable now. */
  available: bigint;
  /** Received but not yet applied — real, but not spendable until ApplyPendingBalance. */
  pending: bigint;
  /** How many incoming credits are sitting in `pending`. */
  pendingCredits: number;
  /** False when `pending` could not be decrypted; `pending` is 0 and unknown. */
  pendingKnown: boolean;
}

/** Base64 -> bytes, without pulling Buffer into a hot path. */
const b64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** Low half of a pending balance is 16 bits; the high half carries the rest. */
const PENDING_LO_BITS = 16n;

/**
 * Decrypt this holder's own confidential balance — the number no wallet shows.
 *
 * Two different mechanisms, because the account stores the same value twice:
 *
 *  - `decryptableAvailableBalance` is AES, and the program keeps it current for
 *    exactly this purpose. Instant.
 *  - `pendingBalanceLo/Hi` are ElGamal only, so reading them is a discrete log.
 *    Tolerable here because the SDK uses a precomputed table and the halves are
 *    bounded: ~166 ms each, flat, whatever the value. Anything past u32 is
 *    beyond the table and comes back as unknown rather than wrong — apply the
 *    pending balance and it folds into the AES side where size stops mattering.
 *
 * Returns null when the account is not configured, or when the keys do not fit
 * it — which is the expected outcome for an account configured by the spl-token
 * CLI, whose key derivation is not ours (see `keyMessage`).
 */
export async function readConfidentialBalances(
  connection: Connection, tokenAccount: PublicKey, keys: ConfidentialKeys,
): Promise<ConfidentialBalances | null> {
  const zk = await loadZk();
  const ai = await connection.getParsedAccountInfo(tokenAccount);
  const ct = ((ai.value as any)?.data?.parsed?.info?.extensions ?? [])
    .find((e: any) => e.extension === 'confidentialTransferAccount');
  if (!ct) return null;

  let available: bigint;
  try {
    available = keys.ae.decrypt(zk.AeCiphertext.fromBytes(b64(ct.state.decryptableAvailableBalance)));
  } catch {
    return null;   // wrong key — almost always "configured by different software"
  }

  const credits = Number(ct.state.pendingBalanceCreditCounter ?? 0);
  let pending = 0n, pendingKnown = true;
  if (credits > 0) {
    try {
      const sk = keys.elgamal.secret();
      const half = (field: string) =>
        sk.decrypt(zk.ElGamalCiphertext.fromBytes(b64(ct.state[field])));
      pending = half('pendingBalanceLo') + (half('pendingBalanceHi') << PENDING_LO_BITS);
    } catch {
      pending = 0n; pendingKnown = false;   // past the discrete-log table
    }
  }
  return { available, pending, pendingCredits: credits, pendingKnown };
}

// ─────────────────────────────────────────────────────────────────────────────
// SENDING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ElGamal ciphertext arithmetic, done here because the WASM binding does not
 * expose any.
 *
 * A ciphertext is two Ristretto points laid end to end — a Pedersen commitment
 * and a decryption handle — and the scheme is additively homomorphic, so
 * operating on the two halves separately with plain point arithmetic is exactly
 * the operation on the encrypted value. `@noble/curves` gives us the group.
 */
const pt = (b: Uint8Array) => RistrettoPoint.fromBytes(b);
const ctBytes = (commitment: any, handle: any) => {
  const out = new Uint8Array(64);
  out.set(commitment.toBytes(), 0);
  out.set(handle.toBytes(), 32);
  return out;
};

/** A 128-byte grouped ciphertext: commitment, then one handle per recipient. */
const groupedParts = (bytes: Uint8Array) => ({
  commitment: bytes.slice(0, 32),
  source:     bytes.slice(32, 64),
  dest:       bytes.slice(64, 96),
  auditor:    bytes.slice(96, 128),
});

export interface TransferPlan {
  /** Sign all of these, then send them IN ORDER — each depends on the last. */
  transactions: Transaction[];
  /** What the sender will hold afterwards, for optimistic display. */
  newSourceBalance: bigint;
}

/**
 * Everything needed to move a confidential balance, as a sequence of
 * transactions.
 *
 * Why it is not one transaction: the three proofs are 320 + 544 + 1000 bytes
 * against a 1232-byte transaction limit, so they cannot ride inline the way
 * ENABLE's 96-byte pubkey-validity proof does. Each has to be verified into a
 * context-state account first, and the transfer then points at those accounts.
 *
 *   1. allocate the three context accounts
 *   2. verify equality + ciphertext validity into two of them
 *   3. verify the range proof into the third (it is 1000 B and travels alone)
 *   4. transfer, then close all three to refund their rent
 *
 * The context accounts are ephemeral keypairs generated here and partial-signed
 * before the wallet ever sees the batch, so the user approves once via
 * signAllTransactions rather than four times.
 */
export async function planConfidentialTransfer(
  connection: Connection,
  opts: {
    mint: PublicKey;
    sourceAccount: PublicKey;
    destAccount: PublicKey;
    /** Base units, not display units. */
    amount: bigint;
    /** Sender's derived keys. */
    keys: ConfidentialKeys;
    /** Sender's wallet — signs the transfer and owns the context accounts. */
    authority: PublicKey;
  },
): Promise<TransferPlan> {
  const zk = await loadZk();
  const { mint, sourceAccount, destAccount, amount, keys, authority } = opts;

  if (amount <= 0n) throw new Error('Amount must be greater than zero.');
  if (amount > MAX_CONFIDENTIAL_TRANSFER) {
    throw new Error('Amount is above the 2^48 limit for a single confidential transfer.');
  }

  // ── read both accounts and the mint ───────────────────────────────────────
  const [srcInfo, dstInfo, mintInfo] = await Promise.all(
    [sourceAccount, destAccount, mint].map(k => connection.getParsedAccountInfo(k)),
  );
  const extOf = (i: any, name: string) =>
    ((i.value as any)?.data?.parsed?.info?.extensions ?? []).find((e: any) => e.extension === name)?.state;

  const src = extOf(srcInfo, 'confidentialTransferAccount');
  if (!src) throw new Error('Your account is not enabled for confidential transfers.');
  const dst = extOf(dstInfo, 'confidentialTransferAccount');
  if (!dst) throw new Error('The recipient has not enabled this token for private transfers yet.');
  if (dst.allowConfidentialCredits === false) {
    throw new Error('The recipient has turned off incoming private transfers.');
  }

  // ── what the sender actually holds ────────────────────────────────────────
  const available: bigint = keys.ae.decrypt(
    zk.AeCiphertext.fromBytes(b64(src.decryptableAvailableBalance)),
  );
  if (amount > available) {
    throw new Error(`Not enough spendable private balance — you have ${available} in base units.`);
  }
  const newBalance = available - amount;

  // ── the three public keys the amount is encrypted to ──────────────────────
  const srcPub = keys.elgamal.pubkey();
  const dstPub = zk.ElGamalPubkey.fromBytes(b64(dst.elgamalPubkey));
  // With no auditor the program substitutes the default pubkey, which is the
  // identity point. Passing anything else makes the proof fail on chain.
  const mintCt = extOf(mintInfo, 'confidentialTransferMint');
  const auditorPub = mintCt?.auditorElgamalPubkey
    ? zk.ElGamalPubkey.fromBytes(b64(mintCt.auditorElgamalPubkey))
    : zk.ElGamalPubkey.fromBytes(new Uint8Array(32));

  // ── ciphertext validity: the amount is well formed for all three parties ──
  const lo = amount & XFER_LO_MASK;
  const hi = amount >> XFER_LO_BITS;
  const openLo = new zk.PedersenOpening();
  const openHi = new zk.PedersenOpening();
  const groupedLo = zk.GroupedElGamalCiphertext3Handles.encryptWith(srcPub, dstPub, auditorPub, lo, openLo);
  const groupedHi = zk.GroupedElGamalCiphertext3Handles.encryptWith(srcPub, dstPub, auditorPub, hi, openHi);
  const validityProof = new zk.BatchedGroupedCiphertext3HandlesValidityProofData(
    srcPub, dstPub, auditorPub, groupedLo, groupedHi, lo, hi, openLo, openHi,
  );
  validityProof.verify();

  const gLo = groupedParts(groupedLo.toBytes());
  const gHi = groupedParts(groupedHi.toBytes());

  // ── equality: the new source ciphertext really holds `newBalance` ─────────
  // available - (lo + hi * 2^16), computed on the source's own handles.
  const availBytes = b64(src.availableBalance);
  const newSourceCt = zk.ElGamalCiphertext.fromBytes(ctBytes(
    pt(availBytes.slice(0, 32)).subtract(pt(gLo.commitment).add(pt(gHi.commitment).multiply(XFER_HI_SCALE))),
    pt(availBytes.slice(32, 64)).subtract(pt(gLo.source).add(pt(gHi.source).multiply(XFER_HI_SCALE))),
  ));
  const openNew = new zk.PedersenOpening();
  const commitNew = zk.PedersenCommitment.from(newBalance, openNew);
  const equalityProof = new zk.CiphertextCommitmentEqualityProofData(
    keys.elgamal, newSourceCt, commitNew, openNew, newBalance,
  );
  equalityProof.verify();

  // ── range: nothing went negative ──────────────────────────────────────────
  // 64 + 16 + 32 = 112, but a U128 batched proof must total EXACTLY 128, so a
  // fourth commitment to zero pads the remaining 16 bits. Without it the
  // program rejects the proof as an illegal amount bit length.
  const openPad = new zk.PedersenOpening();
  const rangeProof = new zk.BatchedRangeProofU128Data(
    [commitNew,
     zk.PedersenCommitment.fromBytes(gLo.commitment),
     zk.PedersenCommitment.fromBytes(gHi.commitment),
     zk.PedersenCommitment.from(0n, openPad)],
    new BigUint64Array([newBalance, lo, hi, 0n]),
    new Uint8Array([64, 16, 32, 16]),
    [openNew, openLo, openHi, openPad],
  );
  rangeProof.verify();

  // ── context accounts ──────────────────────────────────────────────────────
  const eqKp = Keypair.generate(), vaKp = Keypair.generate(), rgKp = Keypair.generate();
  const rents = await Promise.all(
    [CTX_LEN_EQUALITY, CTX_LEN_VALIDITY, CTX_LEN_RANGE]
      .map(n => connection.getMinimumBalanceForRentExemption(n)),
  );
  const alloc = (kp: Keypair, space: number, lamports: number) => SystemProgram.createAccount({
    fromPubkey: authority, newAccountPubkey: kp.publicKey, lamports, space,
    programId: ZK_ELGAMAL_PROOF_PROGRAM,
  });

  /** A verify instruction WITH accounts writes its context; without, it only checks. */
  const verifyIx = (discriminator: number, proof: any, ctx: PublicKey) => new TransactionInstruction({
    programId: ZK_ELGAMAL_PROOF_PROGRAM,
    keys: [
      { pubkey: ctx,       isSigner: false, isWritable: true  },
      { pubkey: authority, isSigner: false, isWritable: false },   // context authority
    ],
    data: Buffer.from([discriminator, ...proof.toBytes()]),
  });

  const closeIx = (ctx: PublicKey) => new TransactionInstruction({
    programId: ZK_ELGAMAL_PROOF_PROGRAM,
    keys: [
      { pubkey: ctx,       isSigner: false, isWritable: true  },
      { pubkey: authority, isSigner: false, isWritable: true  },   // rent refund
      { pubkey: authority, isSigner: true,  isWritable: false },
    ],
    data: Buffer.from([PROOF_CLOSE_CONTEXT_STATE]),
  });

  // ── the transfer itself ───────────────────────────────────────────────────
  // [27][7][newSourceDecryptable:36][auditorLo:64][auditorHi:64][3 x i8 offset]
  // The offsets are 0 because every proof is in a context account rather than
  // an instruction in this transaction.
  const data = new Uint8Array(169);
  data[0] = EXT_CONFIDENTIAL_TRANSFER;
  data[1] = IX_TRANSFER;
  const newDecryptable: Uint8Array = keys.ae.encrypt(newBalance).toBytes();
  if (newDecryptable.length !== 36) throw new Error(`AE ciphertext ${newDecryptable.length}B, expected 36`);
  data.set(newDecryptable, 2);
  // The auditor's copies of the amount, so an auditor key can read the transfer.
  data.set(ctBytes(pt(gLo.commitment), pt(gLo.auditor)), 38);
  data.set(ctBytes(pt(gHi.commitment), pt(gHi.auditor)), 102);
  // offsets at 166,167,168 stay 0

  const transferIx = new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: sourceAccount,  isSigner: false, isWritable: true  },
      { pubkey: mint,           isSigner: false, isWritable: false },
      { pubkey: destAccount,    isSigner: false, isWritable: true  },
      { pubkey: eqKp.publicKey, isSigner: false, isWritable: false },
      { pubkey: vaKp.publicKey, isSigner: false, isWritable: false },
      { pubkey: rgKp.publicKey, isSigner: false, isWritable: false },
      { pubkey: authority,      isSigner: true,  isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const mk = (ixs: TransactionInstruction[], signers: Keypair[] = []) => {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = authority;
    tx.recentBlockhash = blockhash;
    if (signers.length) tx.partialSign(...signers);
    return tx;
  };

  return {
    newSourceBalance: newBalance,
    transactions: [
      mk([alloc(eqKp, CTX_LEN_EQUALITY, rents[0]),
          alloc(vaKp, CTX_LEN_VALIDITY, rents[1]),
          alloc(rgKp, CTX_LEN_RANGE,    rents[2])], [eqKp, vaKp, rgKp]),
      mk([verifyIx(PROOF_VERIFY_EQUALITY,          equalityProof, eqKp.publicKey),
          verifyIx(PROOF_VERIFY_VALIDITY_3HANDLES, validityProof, vaKp.publicKey)]),
      // 1000 B of proof travels alone — nothing else fits beside it.
      mk([verifyIx(PROOF_VERIFY_RANGE_U128, rangeProof, rgKp.publicKey)]),
      mk([transferIx, closeIx(eqKp.publicKey), closeIx(vaKp.publicKey), closeIx(rgKp.publicKey)]),
    ],
  };
}

/**
 * Move a received balance from pending into spendable.
 *
 * Incoming transfers land in a pending compartment so that a sender cannot
 * invalidate a spend the receiver is midway through building. Applying folds
 * pending into available and rewrites the AES copy, which is why the client
 * has to supply the new figure — the program cannot compute it, having no key.
 *
 * No proof, and therefore no context accounts: one small instruction.
 */
export function buildApplyPendingBalanceIx(
  tokenAccount: PublicKey, authority: PublicKey,
  expectedPendingCreditCounter: bigint, newDecryptableBalance: Uint8Array,
): TransactionInstruction {
  if (newDecryptableBalance.length !== 36) {
    throw new Error(`AE ciphertext ${newDecryptableBalance.length}B, expected 36`);
  }
  const data = new Uint8Array(46);
  data[0] = EXT_CONFIDENTIAL_TRANSFER;
  data[1] = IX_APPLY_PENDING_BALANCE;
  new DataView(data.buffer).setBigUint64(2, expectedPendingCreditCounter, true);
  data.set(newDecryptableBalance, 10);
  return new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true  },
      { pubkey: authority,    isSigner: true,  isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

/** Ready-to-sign transaction that makes a pending balance spendable. */
export async function buildApplyPendingBalanceTx(
  connection: Connection, tokenAccount: PublicKey, authority: PublicKey, keys: ConfidentialKeys,
): Promise<Transaction | null> {
  const balances = await readConfidentialBalances(connection, tokenAccount, keys);
  if (!balances) throw new Error('Could not read this account with your key.');
  if (balances.pendingCredits === 0) return null;              // nothing to do
  if (!balances.pendingKnown) throw new Error('Pending balance is too large to decrypt.');

  const ai = await connection.getParsedAccountInfo(tokenAccount);
  const st = ((ai.value as any)?.data?.parsed?.info?.extensions ?? [])
    .find((e: any) => e.extension === 'confidentialTransferAccount')?.state;

  const tx = new Transaction().add(buildApplyPendingBalanceIx(
    tokenAccount, authority,
    BigInt(st?.pendingBalanceCreditCounter ?? 0),
    keys.ae.encrypt(balances.available + balances.pending).toBytes(),
  ));
  tx.feePayer = authority;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return tx;
}

/**
 * Move a public balance into the private compartment.
 *
 * No proof: the amount is public on the way in, which is the whole point of the
 * bridge — value becomes hidden from here on, but its arrival is not.
 * Only meaningful on a plain ConfidentialTransfer mint; a ConfidentialMintBurn
 * mint has no public side and rejects this with 0x41.
 *
 * Layout matches a Deposit observed on chain: 11 bytes, 3 accounts.
 */
export function buildDepositIx(
  tokenAccount: PublicKey, mint: PublicKey, authority: PublicKey,
  amount: bigint, decimals: number,
): TransactionInstruction {
  const data = new Uint8Array(11);
  data[0] = EXT_CONFIDENTIAL_TRANSFER;
  data[1] = IX_DEPOSIT;
  new DataView(data.buffer).setBigUint64(2, amount, true);
  data[10] = decimals;
  return new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true  },
      { pubkey: mint,         isSigner: false, isWritable: false },
      { pubkey: authority,    isSigner: true,  isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

/**
 * The Pedersen value base point, recovered from the commitment scheme itself.
 *
 * Withdraw has to subtract a PUBLIC amount from an encrypted balance, which
 * means building the ciphertext `(amount * G, identity)` — an encryption with a
 * zero opening. 0.3.1 exposes no zero opening and no base point, but a
 * commitment is `v*G + r*H`, so reusing ONE opening across two values cancels
 * `r*H` and leaves `G` exactly:  from(1, o) - from(0, o) == G.
 */
let _G: any = null;
function valueBasepoint(zk: any) {
  if (_G) return _G;
  const o = new zk.PedersenOpening();
  _G = RistrettoPoint.fromBytes(zk.PedersenCommitment.from(1n, o).toBytes())
    .subtract(RistrettoPoint.fromBytes(zk.PedersenCommitment.from(0n, o).toBytes()));
  return _G;
}

/**
 * Move a private balance back out to the public one.
 *
 * The mirror of DEPOSIT, and the reason it needs proofs where deposit does not:
 * going in, the program can see the amount leave a public balance it controls;
 * coming out it has to be convinced that the encrypted balance really covered
 * the amount and that what remains has not gone negative. Hence an equality
 * proof over the new balance ciphertext and a 64-bit range proof over the
 * remainder.
 *
 * Meaningless on a ConfidentialMintBurn mint — there is no public balance to
 * withdraw to, and the program rejects it.
 *
 * Three transactions: the proofs are 320 + 936 bytes and the pair does not fit
 * beside the instruction, so they are verified into context accounts first and
 * closed at the end to refund their rent.
 */
export async function planConfidentialWithdraw(
  connection: Connection,
  opts: {
    mint: PublicKey; tokenAccount: PublicKey; amount: bigint; decimals: number;
    keys: ConfidentialKeys; authority: PublicKey;
  },
): Promise<TransferPlan> {
  const zk = await loadZk();
  const { mint, tokenAccount, amount, decimals, keys, authority } = opts;
  if (amount <= 0n) throw new Error('Amount must be greater than zero.');

  const ai = await connection.getParsedAccountInfo(tokenAccount);
  const st = ((ai.value as any)?.data?.parsed?.info?.extensions ?? [])
    .find((e: any) => e.extension === 'confidentialTransferAccount')?.state;
  if (!st) throw new Error('This account is not enabled for confidential transfers.');

  const available: bigint = keys.ae.decrypt(
    zk.AeCiphertext.fromBytes(b64(st.decryptableAvailableBalance)));
  if (amount > available) {
    throw new Error(`Not enough private balance — you have ${available} in base units.`);
  }
  const remaining = available - amount;

  // available - (amount * G, identity): the handle is untouched because a
  // plaintext amount carries no randomness for the key to absorb.
  const G = valueBasepoint(zk);
  const availBytes = b64(st.availableBalance);
  const newCt = zk.ElGamalCiphertext.fromBytes(ctBytes(
    pt(availBytes.slice(0, 32)).subtract(G.multiply(amount)),
    pt(availBytes.slice(32, 64)),
  ));

  const openNew = new zk.PedersenOpening();
  const commitNew = zk.PedersenCommitment.from(remaining, openNew);
  const equalityProof = new zk.CiphertextCommitmentEqualityProofData(
    keys.elgamal, newCt, commitNew, openNew, remaining);
  equalityProof.verify();

  const rangeProof = new zk.BatchedRangeProofU64Data(
    [commitNew], new BigUint64Array([remaining]), new Uint8Array([64]), [openNew]);
  rangeProof.verify();

  const eqKp = Keypair.generate(), rgKp = Keypair.generate();
  const rents = await Promise.all([CTX_LEN_EQUALITY, CTX_LEN_RANGE_U64]
    .map(n => connection.getMinimumBalanceForRentExemption(n)));
  const alloc = (kp: Keypair, space: number, lamports: number) => SystemProgram.createAccount({
    fromPubkey: authority, newAccountPubkey: kp.publicKey, lamports, space,
    programId: ZK_ELGAMAL_PROOF_PROGRAM,
  });
  const verifyIx = (d: number, proof: any, ctx: PublicKey) => new TransactionInstruction({
    programId: ZK_ELGAMAL_PROOF_PROGRAM,
    keys: [{ pubkey: ctx, isSigner: false, isWritable: true },
           { pubkey: authority, isSigner: false, isWritable: false }],
    data: Buffer.from([d, ...proof.toBytes()]),
  });
  const closeIx = (ctx: PublicKey) => new TransactionInstruction({
    programId: ZK_ELGAMAL_PROOF_PROGRAM,
    keys: [{ pubkey: ctx, isSigner: false, isWritable: true },
           { pubkey: authority, isSigner: false, isWritable: true },
           { pubkey: authority, isSigner: true, isWritable: false }],
    data: Buffer.from([PROOF_CLOSE_CONTEXT_STATE]),
  });

  // [27][6][u64 amount][u8 decimals][newDecryptable:36][i8 eq][i8 range]
  const data = new Uint8Array(49);
  const dv = new DataView(data.buffer);
  data[0] = EXT_CONFIDENTIAL_TRANSFER;
  data[1] = IX_WITHDRAW;
  dv.setBigUint64(2, amount, true);
  data[10] = decimals;
  const newDecryptable: Uint8Array = keys.ae.encrypt(remaining).toBytes();
  if (newDecryptable.length !== 36) throw new Error(`AE ciphertext ${newDecryptable.length}B, expected 36`);
  data.set(newDecryptable, 11);
  // offsets at 47,48 stay 0 — both proofs live in context accounts

  const withdrawIx = new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: tokenAccount,   isSigner: false, isWritable: true  },
      { pubkey: mint,           isSigner: false, isWritable: false },
      { pubkey: eqKp.publicKey, isSigner: false, isWritable: false },
      { pubkey: rgKp.publicKey, isSigner: false, isWritable: false },
      { pubkey: authority,      isSigner: true,  isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const mk = (ixs: TransactionInstruction[], signers: Keypair[] = []) => {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = authority; tx.recentBlockhash = blockhash;
    if (signers.length) tx.partialSign(...signers);
    return tx;
  };
  return {
    newSourceBalance: remaining,
    transactions: [
      mk([alloc(eqKp, CTX_LEN_EQUALITY, rents[0]), alloc(rgKp, CTX_LEN_RANGE_U64, rents[1]),
          verifyIx(PROOF_VERIFY_EQUALITY, equalityProof, eqKp.publicKey)], [eqKp, rgKp]),
      mk([verifyIx(PROOF_VERIFY_RANGE_U64, rangeProof, rgKp.publicKey)]),
      mk([withdrawIx, closeIx(eqKp.publicKey), closeIx(rgKp.publicKey)]),
    ],
  };
}

/**
 * The mint's supply keys, for a ConfidentialMintBurn token.
 *
 * A separate key from any holder's: it is what the encrypted TOTAL SUPPLY is
 * encrypted to. Seeded with the mint address rather than the empty seed the
 * account keys use, because the supply belongs to the mint and not to a wallet
 * — confirmed against BM on chain, where this reproduces both the published
 * supplyElgamalPubkey and an AES key that decrypts decryptableSupply.
 *
 * Only the mint authority can produce it, since only their signature seeds it.
 */
export async function deriveSupplyKeys(
  mint: PublicKey, signMessage: SignMessage,
): Promise<ConfidentialKeys> {
  const zk = await loadZk();
  const seed = new Uint8Array([...HKDF_SALT, ...mint.toBytes()]);
  const sig = await signMessage(seed);
  const elgamal = zk.ElGamalKeypair.fromSecretKey(zk.ElGamalSecretKey.fromBytes(
    scalarFromWide(hkdf(sha512, sig, HKDF_SALT, HKDF_INFO_ELGAMAL, 64))));
  const ae = zk.AeKey.fromBytes(hkdf(sha512, sig, HKDF_SALT, HKDF_INFO_AE, 16));
  return { elgamal, ae, elgamalPubkeyB64: btoa(String.fromCharCode(...elgamal.pubkey().toBytes())) };
}

/**
 * Release a token account from confidential transfers so it can be closed.
 *
 * The program will not let go until it is satisfied the encrypted balance is
 * actually empty — otherwise closing the account would burn tokens nobody can
 * see. That is a zero-ciphertext proof, and at 192 bytes it is small enough to
 * ride inline the way ENABLE's does, so this is one transaction with no context
 * accounts to allocate or reclaim.
 *
 * Apply any pending balance first: pending is part of the balance and the
 * program checks it too.
 */
export async function buildEmptyAccountTx(
  connection: Connection, tokenAccount: PublicKey, authority: PublicKey, keys: ConfidentialKeys,
): Promise<Transaction> {
  const zk = await loadZk();
  const ai = await connection.getParsedAccountInfo(tokenAccount);
  const st = ((ai.value as any)?.data?.parsed?.info?.extensions ?? [])
    .find((e: any) => e.extension === 'confidentialTransferAccount')?.state;
  if (!st) throw new Error('This account is not enabled for confidential transfers.');
  if (Number(st.pendingBalanceCreditCounter ?? 0) > 0) {
    throw new Error('Apply your pending balance first — the program counts it as part of the balance.');
  }

  const proof = new zk.ZeroCiphertextProofData(
    keys.elgamal, zk.ElGamalCiphertext.fromBytes(b64(st.availableBalance)));
  proof.verify();

  const tx = new Transaction().add(
    new TransactionInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      keys: [
        { pubkey: tokenAccount,               isSigner: false, isWritable: true  },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: authority,                  isSigner: true,  isWritable: false },
      ],
      data: Buffer.from([EXT_CONFIDENTIAL_TRANSFER, IX_EMPTY_ACCOUNT, 1]),   // proof is next
    }),
    new TransactionInstruction({
      programId: ZK_ELGAMAL_PROOF_PROGRAM,
      keys: [],
      data: Buffer.from([PROOF_VERIFY_ZERO_CIPHERTEXT, ...proof.toBytes()]),
    }),
  );
  tx.feePayer = authority;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return tx;
}

/**
 * The proof triple shared by transfer, mint and burn.
 *
 * All three move an amount between two encrypted figures and must show the
 * same three things: the amount is well formed for every party (validity), the
 * figure it leaves behind really holds what we claim (equality), and nothing
 * went negative (range). Only which keys play which role differs.
 */
async function buildAmountProofs(zk: any, opts: {
  /** Whose balance the equality proof is about. */
  ownerKeys: ConfidentialKeys;
  first: any; second: any; auditor: any;    // the three pubkeys, in instruction order
  amount: bigint;
  /** The ciphertext being reduced or increased, 64 bytes. */
  baseCiphertext: Uint8Array;
  /** The value that ciphertext will hold afterwards. */
  resultValue: bigint;
  /** Add instead of subtract — minting grows the supply. */
  add?: boolean;
}) {
  const { ownerKeys, first, second, auditor, amount, baseCiphertext, resultValue, add } = opts;
  const lo = amount & XFER_LO_MASK;
  const hi = amount >> XFER_LO_BITS;
  const openLo = new zk.PedersenOpening(), openHi = new zk.PedersenOpening();
  const groupedLo = zk.GroupedElGamalCiphertext3Handles.encryptWith(first, second, auditor, lo, openLo);
  const groupedHi = zk.GroupedElGamalCiphertext3Handles.encryptWith(first, second, auditor, hi, openHi);
  const validityProof = new zk.BatchedGroupedCiphertext3HandlesValidityProofData(
    first, second, auditor, groupedLo, groupedHi, lo, hi, openLo, openHi);
  validityProof.verify();

  const gLo = groupedParts(groupedLo.toBytes()), gHi = groupedParts(groupedHi.toBytes());
  // Which handle to fold in is the one belonging to whoever owns `baseCiphertext`:
  // the first party for a transfer or burn source, the second for a mint's supply.
  const handleLo = opts.add ? gLo.dest : gLo.source;
  const handleHi = opts.add ? gHi.dest : gHi.source;
  const deltaC = pt(gLo.commitment).add(pt(gHi.commitment).multiply(XFER_HI_SCALE));
  const deltaH = pt(handleLo).add(pt(handleHi).multiply(XFER_HI_SCALE));
  const baseC = pt(baseCiphertext.slice(0, 32)), baseH = pt(baseCiphertext.slice(32, 64));
  const resultCt = zk.ElGamalCiphertext.fromBytes(ctBytes(
    add ? baseC.add(deltaC) : baseC.subtract(deltaC),
    add ? baseH.add(deltaH) : baseH.subtract(deltaH),
  ));

  const openNew = new zk.PedersenOpening();
  const commitNew = zk.PedersenCommitment.from(resultValue, openNew);
  const equalityProof = new zk.CiphertextCommitmentEqualityProofData(
    ownerKeys.elgamal, resultCt, commitNew, openNew, resultValue);
  equalityProof.verify();

  const openPad = new zk.PedersenOpening();
  const rangeProof = new zk.BatchedRangeProofU128Data(
    [commitNew, zk.PedersenCommitment.fromBytes(gLo.commitment),
     zk.PedersenCommitment.fromBytes(gHi.commitment), zk.PedersenCommitment.from(0n, openPad)],
    new BigUint64Array([resultValue, lo, hi, 0n]),
    new Uint8Array([64, 16, 32, 16]),
    [openNew, openLo, openHi, openPad]);
  rangeProof.verify();

  return { equalityProof, validityProof, rangeProof, gLo, gHi };
}

/** Allocate three context accounts, verify into them, act, then close them. */
function threeProofPlan(opts: {
  authority: PublicKey; rents: number[];
  equalityProof: any; validityProof: any; rangeProof: any;
  /** Built with the three context pubkeys, in equality/validity/range order. */
  action: (eq: PublicKey, va: PublicKey, rg: PublicKey) => TransactionInstruction;
  blockhash: string;
}): Transaction[] {
  const { authority, rents, equalityProof, validityProof, rangeProof, action, blockhash } = opts;
  const eqKp = Keypair.generate(), vaKp = Keypair.generate(), rgKp = Keypair.generate();
  const alloc = (kp: Keypair, space: number, lamports: number) => SystemProgram.createAccount({
    fromPubkey: authority, newAccountPubkey: kp.publicKey, lamports, space,
    programId: ZK_ELGAMAL_PROOF_PROGRAM,
  });
  const verifyIx = (d: number, proof: any, ctx: PublicKey) => new TransactionInstruction({
    programId: ZK_ELGAMAL_PROOF_PROGRAM,
    keys: [{ pubkey: ctx, isSigner: false, isWritable: true },
           { pubkey: authority, isSigner: false, isWritable: false }],
    data: Buffer.from([d, ...proof.toBytes()]),
  });
  const closeIx = (ctx: PublicKey) => new TransactionInstruction({
    programId: ZK_ELGAMAL_PROOF_PROGRAM,
    keys: [{ pubkey: ctx, isSigner: false, isWritable: true },
           { pubkey: authority, isSigner: false, isWritable: true },
           { pubkey: authority, isSigner: true, isWritable: false }],
    data: Buffer.from([PROOF_CLOSE_CONTEXT_STATE]),
  });
  const mk = (ixs: TransactionInstruction[], signers: Keypair[] = []) => {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = authority; tx.recentBlockhash = blockhash;
    if (signers.length) tx.partialSign(...signers);
    return tx;
  };
  return [
    mk([alloc(eqKp, CTX_LEN_EQUALITY, rents[0]), alloc(vaKp, CTX_LEN_VALIDITY, rents[1]),
        alloc(rgKp, CTX_LEN_RANGE, rents[2])], [eqKp, vaKp, rgKp]),
    mk([verifyIx(PROOF_VERIFY_EQUALITY, equalityProof, eqKp.publicKey),
        verifyIx(PROOF_VERIFY_VALIDITY_3HANDLES, validityProof, vaKp.publicKey)]),
    mk([verifyIx(PROOF_VERIFY_RANGE_U128, rangeProof, rgKp.publicKey)]),
    mk([action(eqKp.publicKey, vaKp.publicKey, rgKp.publicKey),
        closeIx(eqKp.publicKey), closeIx(vaKp.publicKey), closeIx(rgKp.publicKey)]),
  ];
}

/** [outer][sub][36-byte decryptable][auditor lo][auditor hi][3 zero offsets] */
function amountIxData(outer: number, sub: number, decryptable: Uint8Array, gLo: any, gHi: any) {
  if (decryptable.length !== 36) throw new Error(`AE ciphertext ${decryptable.length}B, expected 36`);
  const data = new Uint8Array(169);
  data[0] = outer; data[1] = sub;
  data.set(decryptable, 2);
  data.set(ctBytes(pt(gLo.commitment), pt(gLo.auditor)), 38);
  data.set(ctBytes(pt(gHi.commitment), pt(gHi.auditor)), 102);
  return data;
}

/**
 * Destroy tokens from your own private balance.
 *
 * The amount is encrypted to you, to the supply key and to any auditor, so the
 * program can shrink the encrypted total supply homomorphically without ever
 * learning the figure. Only meaningful on a ConfidentialMintBurn mint.
 */
export async function planConfidentialBurn(
  connection: Connection,
  opts: { mint: PublicKey; tokenAccount: PublicKey; amount: bigint;
          keys: ConfidentialKeys; authority: PublicKey },
): Promise<TransferPlan> {
  const zk = await loadZk();
  const { mint, tokenAccount, amount, keys, authority } = opts;
  if (amount <= 0n) throw new Error('Amount must be greater than zero.');

  const [accInfo, mintInfo] = await Promise.all(
    [tokenAccount, mint].map(k => connection.getParsedAccountInfo(k)));
  const extOf = (i: any, n: string) => ((i.value as any)?.data?.parsed?.info?.extensions ?? [])
    .find((e: any) => e.extension === n)?.state;
  const st = extOf(accInfo, 'confidentialTransferAccount');
  if (!st) throw new Error('This account is not enabled for confidential transfers.');
  const cmb = extOf(mintInfo, 'confidentialMintBurn');
  if (!cmb) throw new Error('This token does not support confidential burn.');

  const available: bigint = keys.ae.decrypt(
    zk.AeCiphertext.fromBytes(b64(st.decryptableAvailableBalance)));
  if (amount > available) throw new Error(`Not enough private balance — you have ${available} in base units.`);
  const remaining = available - amount;

  const mintCt = extOf(mintInfo, 'confidentialTransferMint');
  const proofs = await buildAmountProofs(zk, {
    ownerKeys: keys,
    first: keys.elgamal.pubkey(),
    second: zk.ElGamalPubkey.fromBytes(b64(cmb.supplyElgamalPubkey)),
    auditor: mintCt?.auditorElgamalPubkey
      ? zk.ElGamalPubkey.fromBytes(b64(mintCt.auditorElgamalPubkey))
      : zk.ElGamalPubkey.fromBytes(new Uint8Array(32)),
    amount, baseCiphertext: b64(st.availableBalance), resultValue: remaining,
  });

  const rents = await Promise.all([CTX_LEN_EQUALITY, CTX_LEN_VALIDITY, CTX_LEN_RANGE]
    .map(n => connection.getMinimumBalanceForRentExemption(n)));
  const { blockhash } = await connection.getLatestBlockhash();
  return {
    newSourceBalance: remaining,
    transactions: threeProofPlan({
      authority, rents, blockhash, ...proofs,
      action: (eq, va, rg) => new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [
          { pubkey: tokenAccount, isSigner: false, isWritable: true  },
          { pubkey: mint,         isSigner: false, isWritable: true  },
          { pubkey: eq,           isSigner: false, isWritable: false },
          { pubkey: va,           isSigner: false, isWritable: false },
          { pubkey: rg,           isSigner: false, isWritable: false },
          { pubkey: authority,    isSigner: true,  isWritable: false },
        ],
        data: Buffer.from(amountIxData(EXT_CONFIDENTIAL_MINT_BURN, IX_CMB_BURN,
          keys.ae.encrypt(remaining).toBytes(), proofs.gLo, proofs.gHi)),
      }),
    }),
  };
}

/**
 * Create new tokens straight into a private balance.
 *
 * Mint authority only, and it needs the SUPPLY keys as well as the recipient's
 * pubkey: the equality proof is about the new encrypted supply, and the
 * instruction carries a fresh AES copy of it that only the authority can
 * compute. Account layout confirmed against the original 1,000,000 BM mint on
 * chain rather than inferred.
 */
export async function planConfidentialMint(
  connection: Connection,
  opts: { mint: PublicKey; destination: PublicKey; amount: bigint;
          supplyKeys: ConfidentialKeys; authority: PublicKey },
): Promise<TransferPlan> {
  const zk = await loadZk();
  const { mint, destination, amount, supplyKeys, authority } = opts;
  if (amount <= 0n) throw new Error('Amount must be greater than zero.');

  const [dstInfo, mintInfo] = await Promise.all(
    [destination, mint].map(k => connection.getParsedAccountInfo(k)));
  const extOf = (i: any, n: string) => ((i.value as any)?.data?.parsed?.info?.extensions ?? [])
    .find((e: any) => e.extension === n)?.state;
  const dst = extOf(dstInfo, 'confidentialTransferAccount');
  if (!dst) throw new Error('The recipient has not enabled this token for private balances.');
  const cmb = extOf(mintInfo, 'confidentialMintBurn');
  if (!cmb) throw new Error('This token is not a ConfidentialMintBurn mint.');
  if (supplyKeys.elgamalPubkeyB64 !== cmb.supplyElgamalPubkey) {
    throw new Error('These are not this mint\u2019s supply keys — only the mint authority can mint.');
  }

  const supply: bigint = supplyKeys.ae.decrypt(
    zk.AeCiphertext.fromBytes(b64(cmb.decryptableSupply)));
  const newSupply = supply + amount;

  const mintCt = extOf(mintInfo, 'confidentialTransferMint');
  const proofs = await buildAmountProofs(zk, {
    ownerKeys: supplyKeys,                              // the equality proof is about the SUPPLY
    first: zk.ElGamalPubkey.fromBytes(b64(dst.elgamalPubkey)),
    second: supplyKeys.elgamal.pubkey(),
    auditor: mintCt?.auditorElgamalPubkey
      ? zk.ElGamalPubkey.fromBytes(b64(mintCt.auditorElgamalPubkey))
      : zk.ElGamalPubkey.fromBytes(new Uint8Array(32)),
    amount, baseCiphertext: b64(cmb.confidentialSupply), resultValue: newSupply, add: true,
  });

  const rents = await Promise.all([CTX_LEN_EQUALITY, CTX_LEN_VALIDITY, CTX_LEN_RANGE]
    .map(n => connection.getMinimumBalanceForRentExemption(n)));
  const { blockhash } = await connection.getLatestBlockhash();
  return {
    newSourceBalance: newSupply,
    transactions: threeProofPlan({
      authority, rents, blockhash, ...proofs,
      action: (eq, va, rg) => new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [
          { pubkey: destination, isSigner: false, isWritable: true  },
          { pubkey: mint,        isSigner: false, isWritable: true  },
          { pubkey: eq,          isSigner: false, isWritable: false },
          { pubkey: va,          isSigner: false, isWritable: false },
          { pubkey: rg,          isSigner: false, isWritable: false },
          { pubkey: authority,   isSigner: true,  isWritable: false },
        ],
        data: Buffer.from(amountIxData(EXT_CONFIDENTIAL_MINT_BURN, IX_CMB_MINT,
          supplyKeys.ae.encrypt(newSupply).toBytes(), proofs.gLo, proofs.gHi)),
      }),
    }),
  };
}

/**
 * Re-sync the readable copy of a ConfidentialMintBurn supply.
 *
 * ⛔ REQUIRED AFTER APPLYING A PENDING BURN — not after the burn itself.
 * Burning does NOT reduce the supply: it adds to `pendingBurn` and leaves both
 * `confidentialSupply` and its AES copy alone, which is why minting keeps
 * working in between. Applying is what moves the figure, and it cannot rewrite
 * the AES copy because that needs the supply key. The next mint reads that copy
 * to compute the new total, so leaving it stale makes the mint's equality proof
 * describe a supply the chain does not have, and it is rejected as a maths
 * error with nothing pointing at the cause.
 *
 * The authority has to supply the true figure. Where an auditor key exists it
 * can read each burn; without one — BM has none — burn amounts are unknowable
 * to anyone but the burner, so only a burner who is also the authority can
 * keep this correct. That is a property of the extension, not of this code.
 */
export async function buildUpdateDecryptableSupplyTx(
  connection: Connection, mint: PublicKey, authority: PublicKey,
  supplyKeys: ConfidentialKeys, trueSupply: bigint,
): Promise<Transaction> {
  const data = new Uint8Array(38);
  data[0] = EXT_CONFIDENTIAL_MINT_BURN;
  data[1] = IX_CMB_UPDATE_SUPPLY;
  const ct: Uint8Array = supplyKeys.ae.encrypt(trueSupply).toBytes();
  if (ct.length !== 36) throw new Error(`AE ciphertext ${ct.length}B, expected 36`);
  data.set(ct, 2);
  const tx = new Transaction().add(new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: mint,      isSigner: false, isWritable: true  },
      { pubkey: authority, isSigner: true,  isWritable: false },
    ],
    data: Buffer.from(data),
  }));
  tx.feePayer = authority;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return tx;
}

/**
 * Fold accumulated burns into the encrypted supply.
 *
 * Burning parks the amount in `pendingBurn` rather than shrinking the supply
 * on the spot, so that a burn by one holder cannot invalidate a mint another
 * party is midway through proving. The authority applies them in a batch.
 *
 * Two bytes and no proof — the arithmetic is homomorphic and the program does
 * it. Pair it with buildUpdateDecryptableSupplyTx: this moves the encrypted
 * figure and leaves the readable copy behind.
 */
export async function buildApplyPendingBurnTx(
  connection: Connection, mint: PublicKey, authority: PublicKey,
): Promise<Transaction> {
  const tx = new Transaction().add(new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: mint,      isSigner: false, isWritable: true  },
      { pubkey: authority, isSigner: true,  isWritable: false },
    ],
    data: Buffer.from([EXT_CONFIDENTIAL_MINT_BURN, IX_CMB_APPLY_PENDING_BURN]),
  }));
  tx.feePayer = authority;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return tx;
}

/**
 * Reclaim rent from proof context accounts a failed plan left behind.
 *
 * A transfer, mint or burn allocates three context accounts up front and closes
 * them in its last transaction. If anything in between fails — a dropped
 * blockhash, a rejected signature, a closed tab — the accounts survive with
 * their rent locked up and nothing referencing them. That is real money: about
 * 0.0075 XNT a time, and it accrues silently.
 *
 * Every context account stores its authority in the first 32 bytes, so a wallet
 * can find its own strays and close them. Safe to run at any time: a context
 * account is single-use, and one still in flight belongs to a transaction that
 * has not landed, so closing it costs nothing but a retry.
 */
export async function reclaimProofContexts(
  connection: Connection, authority: PublicKey,
): Promise<{ accounts: PublicKey[]; lamports: number; transactions: Transaction[] }> {
  const found = await connection.getProgramAccounts(ZK_ELGAMAL_PROOF_PROGRAM, {
    filters: [{ memcmp: { offset: 0, bytes: authority.toBase58() } }],
  });
  const accounts = found.map(f => f.pubkey);
  const lamports = found.reduce((n, f) => n + f.account.lamports, 0);
  if (!accounts.length) return { accounts, lamports, transactions: [] };

  const { blockhash } = await connection.getLatestBlockhash();
  const transactions: Transaction[] = [];
  // Four to a transaction keeps each well inside the size limit.
  for (let i = 0; i < accounts.length; i += 4) {
    const tx = new Transaction();
    for (const ctx of accounts.slice(i, i + 4)) {
      tx.add(new TransactionInstruction({
        programId: ZK_ELGAMAL_PROOF_PROGRAM,
        keys: [
          { pubkey: ctx,       isSigner: false, isWritable: true  },
          { pubkey: authority, isSigner: false, isWritable: true  },
          { pubkey: authority, isSigner: true,  isWritable: false },
        ],
        data: Buffer.from([PROOF_CLOSE_CONTEXT_STATE]),
      }));
    }
    tx.feePayer = authority;
    tx.recentBlockhash = blockhash;
    transactions.push(tx);
  }
  return { accounts, lamports, transactions };
}
