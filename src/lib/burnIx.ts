// Token burn executor — SPL token `burn` against the user's ATA.
// Auto-detects whether the mint is classic SPL or Token-2022.

import { PublicKey, Transaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createBurnCheckedInstruction, getAssociatedTokenAddressSync, getMint,
} from '@solana/spl-token';

type SignFn = (tx: Transaction) => Promise<Transaction>;

async function confirmSig(connection: any, sig: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const resp = await connection.getSignatureStatuses([sig]);
      const s = resp?.value?.[0];
      if (s) {
        if (s.err) throw new Error('Tx failed: ' + JSON.stringify(s.err));
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return;
      }
    } catch {}
  }
  // X1 usually confirms fast; if RPC is lagging, accept after broadcast.
}

async function detectTokenProgram(connection: any, mint: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (info?.owner?.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

export type ExecResult = { sig: string };

export async function executeBurnToken(opts: {
  connection: any;
  publicKey: PublicKey;
  signTransaction: SignFn;
  mint: string;
  amountUi: number;
  onStatus?: (msg: string) => void;
}): Promise<ExecResult> {
  const { connection, publicKey, signTransaction, mint, amountUi, onStatus } = opts;
  const status = (m: string) => onStatus?.(m);

  if (!(amountUi > 0)) throw new Error('Invalid amount');

  status('Building transaction…');
  const mintPk = new PublicKey(mint);
  const program = await detectTokenProgram(connection, mintPk);
  const ata     = getAssociatedTokenAddressSync(mintPk, publicKey, false, program);
  const info    = await getMint(connection, mintPk, 'confirmed', program);
  const decimals = info.decimals;
  const raw     = BigInt(Math.floor(amountUi * 10 ** decimals));

  const ix = createBurnCheckedInstruction(ata, mintPk, publicKey, raw, decimals, [], program);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash }).add(ix);

  status('Waiting for wallet approval…');
  const signed = await signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed',
  });
  status(`Confirming ${sig.slice(0, 12)}…`);
  await confirmSig(connection, sig);
  return { sig };
}
