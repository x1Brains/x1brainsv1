// collect_lb_fees.js
// Standalone script — also called by the Vercel cron endpoint.
// Two-step sweep: harvest from ATAs → mint, then withdraw mint → treasury.
// Uses raw Token-2022 instructions since both authorities are the program PDA
// and the Anchor program's collect_fees instruction handles the PDA signing.

const {
  Connection, Keypair, PublicKey,
  Transaction, TransactionInstruction,
} = require('@solana/web3.js');
const {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
  getTransferFeeAmount,
  createHarvestWithheldTokensToMintInstruction,
} = require('@solana/spl-token');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const PROGRAM_ID  = new PublicKey('3B6oAfmL7aGVAbBdu7zW3jqEVWK6o1nwFiufuSuFV6tN');
const LB_MINT     = new PublicKey('Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6');
const TREASURY    = new PublicKey('CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF');
const RPC         = 'https://rpc.mainnet.x1.xyz';
const CHUNK       = 20;

// Anchor discriminator for collect_fees
const DISC_COLLECT_FEES = Buffer.from(
  crypto.createHash('sha256').update('global:collect_fees').digest()
).slice(0, 8);

async function sendAndConfirm(conn, tx, payer) {
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

async function collectLbFees(adminKeypair) {
  const conn = new Connection(RPC, 'confirmed');

  const [statePda]    = PublicKey.findProgramAddressSync([Buffer.from('lb_state')],    PROGRAM_ID);
  const [mintAuthPda] = PublicKey.findProgramAddressSync([Buffer.from('lb_mint_auth')], PROGRAM_ID);
  const treasuryAta   = getAssociatedTokenAddressSync(LB_MINT, TREASURY, false, TOKEN_2022_PROGRAM_ID);

  // ── 1. Find all LB ATAs with withheld fees ──────────────────────────────
  const allAccounts = await conn.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: LB_MINT.toBase58() } }],
  });

  const withFees = [];
  for (const { pubkey, account } of allAccounts) {
    try {
      const unpacked = unpackAccount(pubkey, account, TOKEN_2022_PROGRAM_ID);
      const feeAmt   = getTransferFeeAmount(unpacked);
      if (feeAmt && feeAmt.withheldAmount > BigInt(0)) withFees.push(pubkey);
    } catch { continue; }
  }

  if (withFees.length === 0) {
    return { swept: false, message: 'No withheld fees found', txs: [] };
  }

  const txs = [];

  // ── 2. Harvest from ATAs → mint (no authority needed) ───────────────────
  for (let i = 0; i < withFees.length; i += CHUNK) {
    const chunk = withFees.slice(i, i + CHUNK);
    const tx = new Transaction();
    tx.add(createHarvestWithheldTokensToMintInstruction(
      LB_MINT, chunk, TOKEN_2022_PROGRAM_ID,
    ));
    const sig = await sendAndConfirm(conn, tx, adminKeypair);
    txs.push({ step: 'harvest', sig });
  }

  // ── 3. Withdraw from mint → treasury via Anchor collect_fees ─────────────
  // The program PDA (mintAuthPda) signs as withdrawWithheldAuthority
  const tx2 = new Transaction();
  tx2.add(new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: adminKeypair.publicKey, isSigner: true,  isWritable: true  }, // 0 admin
      { pubkey: statePda,               isSigner: false, isWritable: true  }, // 1 state
      { pubkey: LB_MINT,                isSigner: false, isWritable: true  }, // 2 lb_mint
      { pubkey: mintAuthPda,            isSigner: false, isWritable: false }, // 3 lb_mint_authority (PDA signs)
      { pubkey: treasuryAta,            isSigner: false, isWritable: true  }, // 4 treasury_lb_ata
      { pubkey: TOKEN_2022_PROGRAM_ID,  isSigner: false, isWritable: false }, // 5 token_2022_program
    ],
    data: DISC_COLLECT_FEES,
  }));
  const sig2 = await sendAndConfirm(conn, tx2, adminKeypair);
  txs.push({ step: 'withdraw_to_treasury', sig: sig2 });

  return { swept: true, accounts: withFees.length, txs };
}

// ── Run directly ────────────────────────────────────────────────────────────
if (require.main === module) {
  const keypairPath = path.resolve(process.env.HOME, '.config/solana/id.json');
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath))));
  collectLbFees(admin)
    .then(r => console.log('Result:', JSON.stringify(r, null, 2)))
    .catch(console.error);
}

module.exports = { collectLbFees };
