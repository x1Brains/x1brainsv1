// api/cron-collect-lb-fees.ts
// Vercel serverless cron — runs daily at midnight UTC.
// Sweeps all withheld LB transfer fees from holder ATAs → treasury.
//
// Required Vercel env vars (dashboard only, never in repo):
//   ADMIN_KEYPAIR_SECRET  = contents of ~/.config/solana/id.json (JSON array)
//   CRON_SECRET           = random string matching vercel.json cronSecret

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  Connection, Keypair, PublicKey,
  Transaction, TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
  getTransferFeeAmount,
  createHarvestWithheldTokensToMintInstruction,
} from '@solana/spl-token';
import * as crypto from 'crypto';

const PROGRAM_ID  = new PublicKey('3B6oAfmL7aGVAbBdu7zW3jqEVWK6o1nwFiufuSuFV6tN');
const LB_MINT     = new PublicKey('Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6');
const TREASURY    = new PublicKey('CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF');
const RPC         = 'https://rpc.mainnet.x1.xyz';
const CHUNK       = 20;

const DISC_COLLECT_FEES = Buffer.from(
  crypto.createHash('sha256').update('global:collect_fees').digest()
).slice(0, 8);

async function sendAndConfirm(conn: Connection, tx: Transaction, payer: Keypair): Promise<string> {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const s = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
    if (s?.value?.err) throw new Error('TX error: ' + JSON.stringify(s.value.err));
    const c = s?.value?.confirmationStatus;
    if (c === 'confirmed' || c === 'finalized') return sig;
  }
  throw new Error('TX timeout: ' + sig);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel cron sends Authorization: Bearer <CRON_SECRET>
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const secretEnv = process.env.ADMIN_KEYPAIR_SECRET;
  if (!secretEnv) return res.status(500).json({ error: 'ADMIN_KEYPAIR_SECRET not set' });

  try {
    const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secretEnv)));
    const conn  = new Connection(RPC, 'confirmed');

    const [statePda]    = PublicKey.findProgramAddressSync([Buffer.from('lb_state')],    PROGRAM_ID);
    const [mintAuthPda] = PublicKey.findProgramAddressSync([Buffer.from('lb_mint_auth')], PROGRAM_ID);
    const treasuryAta   = getAssociatedTokenAddressSync(LB_MINT, TREASURY, false, TOKEN_2022_PROGRAM_ID);

    // ── 1. Find all LB ATAs with withheld fees ────────────────────────────
    const allAccounts = await conn.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
      filters: [{ memcmp: { offset: 0, bytes: LB_MINT.toBase58() } }],
    });

    const withFees: PublicKey[] = [];
    for (const { pubkey, account } of allAccounts) {
      try {
        const unpacked = unpackAccount(pubkey, account, TOKEN_2022_PROGRAM_ID);
        const feeAmt   = getTransferFeeAmount(unpacked);
        if (feeAmt && feeAmt.withheldAmount > BigInt(0)) withFees.push(pubkey);
      } catch { continue; }
    }

    if (withFees.length === 0) {
      return res.status(200).json({ swept: false, message: 'No withheld fees', accounts: 0 });
    }

    const txs: string[] = [];

    // ── 2. Harvest ATAs → mint (permissionless, no authority needed) ──────
    for (let i = 0; i < withFees.length; i += CHUNK) {
      const chunk = withFees.slice(i, i + CHUNK);
      const tx = new Transaction();
      tx.add(createHarvestWithheldTokensToMintInstruction(
        LB_MINT, chunk, TOKEN_2022_PROGRAM_ID,
      ));
      const sig = await sendAndConfirm(conn, tx, admin);
      txs.push(sig);
    }

    // ── 3. Withdraw mint → treasury via Anchor collect_fees ───────────────
    const tx2 = new Transaction();
    tx2.add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true,  isWritable: true  }, // 0 admin
        { pubkey: statePda,        isSigner: false, isWritable: true  }, // 1 state
        { pubkey: LB_MINT,         isSigner: false, isWritable: true  }, // 2 lb_mint
        { pubkey: mintAuthPda,     isSigner: false, isWritable: false }, // 3 lb_mint_authority
        { pubkey: treasuryAta,     isSigner: false, isWritable: true  }, // 4 treasury_lb_ata
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // 5 token_program
      ],
      data: DISC_COLLECT_FEES,
    }));
    const sig2 = await sendAndConfirm(conn, tx2, admin);
    txs.push(sig2);

    return res.status(200).json({
      swept: true,
      accounts: withFees.length,
      txs,
      treasury: treasuryAta.toBase58(),
    });

  } catch (e: any) {
    console.error('cron-collect-lb-fees error:', e);
    return res.status(500).json({ error: e?.message ?? 'unknown' });
  }
}
