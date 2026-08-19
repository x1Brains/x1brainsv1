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
  Connection, PublicKey, Transaction, TransactionInstruction, SYSVAR_INSTRUCTIONS_PUBKEY,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, ExtensionType, createReallocateInstruction,
} from '@solana/spl-token';
import { Buffer } from 'buffer';   // web3.js types TransactionInstruction.data as Buffer
import { ed25519 } from '@noble/curves/ed25519';
import { sha512, sha256 } from '@noble/hashes/sha2';

export const ZK_ELGAMAL_PROOF_PROGRAM = new PublicKey('ZkE1Gama1Proof11111111111111111111111111111');

/** Token-2022 extension + sub-instruction discriminators, confirmed on chain. */
const EXT_CONFIDENTIAL_TRANSFER = 27;
const IX_CONFIGURE_ACCOUNT      = 2;
/** ZkElGamalProof: VerifyPubkeyValidity. */
const PROOF_VERIFY_PUBKEY_VALIDITY = 4;
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

/** Ready-to-sign transaction that opts `tokenAccount` into confidential transfers. */
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
 * Decrypt this holder's own available balance — the number no wallet can show.
 * Uses the AES copy the program keeps for exactly this purpose; ElGamal
 * decryption of an arbitrary u64 is a discrete log and far too slow.
 */
export async function readConfidentialBalance(
  connection: Connection, tokenAccount: PublicKey, keys: ConfidentialKeys,
): Promise<bigint | null> {
  const zk = await loadZk();
  const ai = await connection.getParsedAccountInfo(tokenAccount);
  const ct = ((ai.value as any)?.data?.parsed?.info?.extensions ?? [])
    .find((e: any) => e.extension === 'confidentialTransferAccount');
  if (!ct) return null;
  try {
    const bytes = Uint8Array.from(atob(ct.state.decryptableAvailableBalance), c => c.charCodeAt(0));
    return keys.ae.decrypt(zk.AeCiphertext.fromBytes(bytes));
  } catch { return null; }   // wrong key, or configured by different software
}
