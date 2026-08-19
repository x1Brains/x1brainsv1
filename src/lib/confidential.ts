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

export const ZK_ELGAMAL_PROOF_PROGRAM = new PublicKey('ZkE1Gama1Proof11111111111111111111111111111');

/** Token-2022 extension + sub-instruction discriminators, confirmed on chain. */
const EXT_CONFIDENTIAL_TRANSFER = 27;
const IX_CONFIGURE_ACCOUNT      = 2;
const IX_DEPOSIT                = 5;
const IX_TRANSFER               = 7;
const IX_APPLY_PENDING_BALANCE  = 8;

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
const PROOF_VERIFY_EQUALITY          = 3;
const PROOF_VERIFY_PUBKEY_VALIDITY   = 4;
const PROOF_VERIFY_RANGE_U128        = 7;
const PROOF_VERIFY_VALIDITY_3HANDLES = 12;

/** Context-state account sizes: 33-byte header (authority + proof type) + context. */
const CTX_LEN_EQUALITY = 161;
const CTX_LEN_VALIDITY = 385;
const CTX_LEN_RANGE    = 297;

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
 * The message a wallet signs to derive its confidential keys for ONE token
 * account. Fixed prefix + the account address, so the same wallet gets a stable
 * key per account and a different one per account.
 *
 * ⚠️ This derivation is OURS, and deliberately so. The spl-token CLI uses a
 * different (older, undocumented) scheme — four reconstruction attempts failed
 * to reproduce its keys. An account configured HERE is readable here; one
 * configured by the CLI is not, and vice versa. Since no wallet on X1 can do
 * either, owning the whole lifecycle is the right trade — but it does mean the
 * CLI is not a fallback for an account this app configured.
 */
export const keyMessage = (tokenAccount: PublicKey) =>
  new TextEncoder().encode(`x1brains.confidential.v1:${tokenAccount.toBase58()}`);

export interface ConfidentialKeys {
  elgamal: any;            // ElGamalKeypair
  ae: any;                 // AeKey
  elgamalPubkeyB64: string;
}

/**
 * Derive both keys from one wallet signature.
 *
 * ElGamal secret must be a canonical Ristretto scalar, so the hash is reduced
 * mod L; AeKey wants exactly 16 bytes. 0.3.1's runtime exposes only
 * `fromBytes` on both types — no `fromSeed`, whatever the .d.ts claims.
 */
export async function deriveKeys(
  tokenAccount: PublicKey, signMessage: SignMessage,
): Promise<ConfidentialKeys> {
  const zk = await loadZk();
  const sig = await signMessage(keyMessage(tokenAccount));

  const wide = sha512(sig);
  let x = 0n;
  for (let i = 63; i >= 0; i--) x = (x << 8n) | BigInt(wide[i]);   // little-endian
  let s = x % ed25519.CURVE.n;
  const le = new Uint8Array(32);
  for (let i = 0; i < 32; i++) { le[i] = Number(s & 0xffn); s >>= 8n; }

  const elgamal = zk.ElGamalKeypair.fromSecretKey(zk.ElGamalSecretKey.fromBytes(le));
  const ae = zk.AeKey.fromBytes(
    sha256(new Uint8Array([...new TextEncoder().encode('ae:'), ...sig])).slice(0, 16),
  );
  return {
    elgamal, ae,
    elgamalPubkeyB64: btoa(String.fromCharCode(...elgamal.pubkey().toBytes())),
  };
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
  const keys = await deriveKeys(tokenAccount, signMessage);
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

/** Derive once per token account per page load, then reuse. */
export async function getSessionKeys(
  tokenAccount: PublicKey, signMessage: SignMessage,
): Promise<ConfidentialKeys> {
  const k = tokenAccount.toBase58();
  const hit = _keyCache.get(k);
  if (hit) return hit;
  const keys = await deriveKeys(tokenAccount, signMessage);
  _keyCache.set(k, keys);
  return keys;
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
