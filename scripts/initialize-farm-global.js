// initialize-farm-global.js
// One-time: creates the FarmGlobal singleton PDA for brains_farm.
// Run: node scripts/initialize-farm-global.js
// Uses ~/.config/solana/id.json (admin keypair = CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2)

const {
  Connection, Keypair, PublicKey,
  Transaction, TransactionInstruction,
  SystemProgram, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const RPC          = 'https://rpc.mainnet.x1.xyz';
const FARM_PROGRAM = new PublicKey('Ci1qDtdoSh8mCtJTVoX1tArbnLydQUZYu9RiqukRFJpg');
const ADMIN_WALLET = 'CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2';

function disc(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

async function sendAndConfirm(conn, tx, payer) {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  console.log(`  Sig: ${sig}`);
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const st = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
    if (st?.value?.err) throw new Error('TX failed: ' + JSON.stringify(st.value.err));
    const c = st?.value?.confirmationStatus;
    if (c === 'confirmed' || c === 'finalized') return sig;
  }
  throw new Error('Confirmation timeout: ' + sig);
}

async function main() {
  const keypairPath = path.resolve(process.env.HOME, '.config/solana/id.json');
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath)))
  );
  console.log('Admin:', admin.publicKey.toBase58());
  if (admin.publicKey.toBase58() !== ADMIN_WALLET) {
    throw new Error(`Wrong keypair! Expected ${ADMIN_WALLET}, got ${admin.publicKey.toBase58()}`);
  }

  const conn = new Connection(RPC, 'confirmed');
  const bal  = await conn.getBalance(admin.publicKey);
  console.log(`Balance: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} XNT`);
  if (bal < 0.1 * LAMPORTS_PER_SOL) throw new Error('Insufficient balance — need at least 0.1 XNT');

  // Derive FarmGlobal PDA
  const [globalPda, globalBump] = PublicKey.findProgramAddressSync(
    [Buffer.from('farm_global')],
    FARM_PROGRAM,
  );
  console.log(`\nFarmGlobal PDA: ${globalPda.toBase58()} (bump=${globalBump})`);

  // Check if already initialized
  const existing = await conn.getAccountInfo(globalPda);
  if (existing) {
    console.log(`✓ FarmGlobal already exists (${existing.data.length} bytes). Nothing to do.`);
    return;
  }

  console.log('\n── Sending initialize_global ──');
  const data = disc('initialize_global'); // no params

  const keys = [
    { pubkey: admin.publicKey,        isSigner: true,  isWritable: true  }, // admin
    { pubkey: globalPda,              isSigner: false, isWritable: true  }, // global_state
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
  ];

  const ix = new TransactionInstruction({ programId: FARM_PROGRAM, keys, data });
  const tx = new Transaction().add(ix);
  await sendAndConfirm(conn, tx, admin);

  const created = await conn.getAccountInfo(globalPda);
  console.log(`\n✓ FarmGlobal initialized (${created.data.length} bytes)`);
  console.log(`  Next: node scripts/create-brains-farms.js`);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
