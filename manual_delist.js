// manual_delist.js — emergency delist for BRAINS listing with broken escrow
// Uses brainsdev.json to sign. Run: node manual_delist.js
//
// This bypasses the UI entirely and calls the delist instruction directly.
// The delist program now harvests BEFORE transfer, so this should work.
// If it still fails due to escrow extension issue, we use withdrawWithheldTokensFromAccounts first.

const { Connection, PublicKey, Transaction, TransactionInstruction,
        SystemProgram, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const fs   = require('fs');
const path = require('path');

const RPC          = 'https://rpc.mainnet.x1.xyz';
const PROGRAM_ID   = new PublicKey('DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM');
const TREASURY     = new PublicKey('CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF');
const BRAINS_MINT  = new PublicKey('EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN');

// Known listing details — admin wallet (2nVaSvCq...) BRAINS listing
const LISTING_PDA  = new PublicKey('EkJre96BsoSVhfdSvoi65ydn39Vi21bMfbF6aTTQHU7J');
const ESCROW_PDA   = new PublicKey('Gcnuo5iUjjBFL84bHMxkm2HdVVkLfjAXbqVSGNTKk83X');
const ESCROW_AUTH  = new PublicKey('CpWkznu24kESBuKwEXtdC7aF11fvCZSjTEtNh9WcPb2M');
const CREATOR_ATA  = new PublicKey('59oW24sqcSFjtAbx9hptGriMkAuyb32GFocdRFUPncRe');

// Load brainsdev.json keypair
const keypairPath = path.join(process.env.HOME, '.config/solana/brainsdev.json');
const keypair     = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8')))
);
console.log('Signer:', keypair.publicKey.toBase58());

async function fetchXntPrice(connection) {
  // Read XNT/USDC.X pool vaults directly (same as program does)
  const XNT_VAULT  = new PublicKey('8wvV4HKBDFMLEUkVWp1WPNa5ano99XCm3f9t3troyLb');
  const USDC_VAULT = new PublicKey('7iw2adw8Af7x3pY7gj5RwczFXuGjCoX92Gfy3avwXQtg');
  const [xntInfo, usdcInfo] = await Promise.all([
    connection.getAccountInfo(XNT_VAULT),
    connection.getAccountInfo(USDC_VAULT),
  ]);
  const xntBal  = xntInfo.data.readBigUInt64LE(64);
  const usdcBal = usdcInfo.data.readBigUInt64LE(64);
  // price = usdc_balance * 1e9 / xnt_balance (6 decimal USD per XNT)
  const price6 = Number(usdcBal) * 1_000_000_000 / Number(xntBal);
  console.log(`XNT price: $${(price6 / 1_000_000).toFixed(6)} (${Math.round(price6)} micro-USD)`);
  return Math.round(price6);
}

async function buildDelistIx(xntPrice6) {
  // Anchor discriminator for 'global:delist'
  const crypto   = require('crypto');
  const hash     = crypto.createHash('sha256').update('global:delist').digest();
  const disc     = hash.slice(0, 8);
  const params   = Buffer.alloc(8);
  params.writeBigUInt64LE(BigInt(xntPrice6), 0);
  const data     = Buffer.concat([disc, params]);

  const [globalState] = PublicKey.findProgramAddressSync(
    [Buffer.from('global_state')], PROGRAM_ID
  );

  const keys = [
    { pubkey: keypair.publicKey, isSigner: true,  isWritable: true  }, // creator
    { pubkey: globalState,       isSigner: false, isWritable: true  }, // global_state
    { pubkey: LISTING_PDA,       isSigner: false, isWritable: true  }, // listing_state
    { pubkey: ESCROW_PDA,        isSigner: false, isWritable: true  }, // escrow
    { pubkey: ESCROW_AUTH,       isSigner: false, isWritable: false }, // escrow_authority
    { pubkey: BRAINS_MINT,       isSigner: false, isWritable: true  }, // token_a_mint
    { pubkey: CREATOR_ATA,       isSigner: false, isWritable: true  }, // creator_token_a
    { pubkey: TREASURY,          isSigner: false, isWritable: true  }, // treasury
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
  ];

  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

async function main() {
  const connection = new Connection(RPC, 'confirmed');

  // Check escrow balance
  const escrowInfo = await connection.getAccountInfo(ESCROW_PDA);
  if (!escrowInfo) { console.error('Escrow not found'); process.exit(1); }
  const escrowAmount = escrowInfo.data.readBigUInt64LE(64);
  console.log('Escrow amount:', escrowAmount.toString(), 'raw (3000 BRAINS = 3000000000000)');

  // Check creator ATA exists
  const ataInfo = await connection.getAccountInfo(CREATOR_ATA);
  if (!ataInfo) {
    console.error('Creator ATA does not exist:', CREATOR_ATA.toBase58());
    console.error('Create it first with: spl-token create-account', BRAINS_MINT.toBase58(), '--owner', keypair.publicKey.toBase58(), '--fee-payer', keypairPath);
    process.exit(1);
  }
  console.log('Creator ATA exists ✅');

  const xntPrice6 = await fetchXntPrice(connection);
  const ix        = await buildDelistIx(xntPrice6);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: keypair.publicKey, recentBlockhash: blockhash });
  tx.add(ix);
  tx.sign(keypair);

  console.log('\nSending delist transaction...');
  try {
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    console.log('Sig:', sig);
    console.log('Confirming...');
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const st = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
      if (st?.value?.err) {
        console.error('TX failed:', JSON.stringify(st.value.err));
        // Fetch logs
        const tx2 = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
        console.error('Logs:', tx2?.meta?.logMessages);
        process.exit(1);
      }
      const conf = st?.value?.confirmationStatus;
      if (conf === 'confirmed' || conf === 'finalized') {
        console.log('✅ Delisted! Tx:', sig);
        console.log('Explorer: https://explorer.x1.xyz/tx/' + sig);
        return;
      }
    }
    console.error('Confirmation timeout');
  } catch (e) {
    console.error('Send error:', e.message);
    if (e.logs) console.error('Logs:', e.logs);
  }
}

main().catch(console.error);
