const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } = require('@solana/web3.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROGRAM_ID   = new PublicKey('DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM');
const RPC          = 'https://rpc.mainnet.x1.xyz';
const ADMIN_WALLET = 'CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2';

// Anchor discriminator for initialize_protocol
const disc = Buffer.from(
  crypto.createHash('sha256')
    .update('global:initialize_protocol')
    .digest()
).slice(0, 8);

async function main() {
  const keypairPath = path.resolve(process.env.HOME, '.config/solana/id.json');
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath)))
  );
  const conn = new Connection(RPC, 'confirmed');

  console.log('Admin:', admin.publicKey.toBase58());
  console.log('Program:', PROGRAM_ID.toBase58());

  // Derive GlobalState PDA
  const [globalStatePda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('global_state')],
    PROGRAM_ID
  );
  console.log('GlobalState PDA:', globalStatePda.toBase58(), 'bump:', bump);

  // Check if already initialized
  const existing = await conn.getAccountInfo(globalStatePda);
  if (existing) {
    console.log('✅ Already initialized! GlobalState exists:', globalStatePda.toBase58());
    console.log('Data length:', existing.data.length);
    return;
  }

  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: admin.publicKey, recentBlockhash: blockhash });

  tx.add(new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true,  isWritable: true  }, // admin
      { pubkey: globalStatePda,  isSigner: false, isWritable: true  }, // global_state
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    ],
    data: disc,
  }));

  tx.sign(admin);
  console.log('Sending initialize_protocol transaction…');
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  console.log('Tx sent:', sig);

  // Wait for confirmation
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const status = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
    const conf = status?.value?.confirmationStatus;
    const err  = status?.value?.err;
    if (err) { console.error('❌ TX error:', JSON.stringify(err)); break; }
    if (conf === 'confirmed' || conf === 'finalized') {
      console.log('✅ Protocol initialized!');
      console.log('GlobalState PDA:', globalStatePda.toBase58());
      console.log('Tx:', sig);
      console.log(`Explorer: https://explorer.mainnet.x1.xyz/tx/${sig}`);
      break;
    }
    process.stdout.write('.');
  }
}

main().catch(console.error);
