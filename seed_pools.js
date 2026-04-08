const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } = require('@solana/web3.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROGRAM_ID = new PublicKey('DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM');
const RPC        = 'https://rpc.mainnet.x1.xyz';

const disc = Buffer.from(
  crypto.createHash('sha256').update('global:seed_pool_record').digest()
).slice(0, 8);

const POOLS = [
  { pool: '7deZorr98nLdZhpmSdUgu8WY4NAjSpeLDGxHzaTAxrUg', lp: 'FSFjPXo9vAvVsjh6YuuNTjetZ6oZBgfYA6TLcWTYmwq3', symA: 'BRAINS', symB: 'WXNT', mintA: 'EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN', mintB: 'So11111111111111111111111111111111111111112' },
  { pool: '4g6UNwP23ABpwdJFdkHtwGV39qaX6GK5qwgCuyD2w7km', lp: '6ozdNEB3s23hFBH1VdYPUydQ1TEvxYKWivQf7VVHsR66', symA: 'BRAINS', symB: 'DGN',  mintA: 'EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN', mintB: '9B5wngHiCprCAPARSrdYbLaD9iwwpCzgJf4s3KYkPDiz' },
  { pool: '4C4o1Zgzrt996t2BupL65WJvkifZZ3Ncv3oZxe2CxrW4', lp: '2W9Wuu7Qmaa6BDD7sUmCypF8snFjLw3Sa78mixr6A15W', symA: 'BRAINS', symB: 'XBLK', mintA: 'EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN', mintB: 'XBLKLmxhADMVX3DsdwymvHyYbBYfKa5eKhtpiQ2kj7T' },
  { pool: 'HWmgietnQGE3eK11PhaCsZi6E3iFzCK3n8wTDrYoiLoP', lp: '3PDuk6PwPgmffYxkufdMhmKj1AbYQyjk5QAh1PmQiFdz', symA: 'BRAINS', symB: 'XUNI', mintA: 'EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN', mintB: 'XUNigZPoe8f657NkRf7KF8tqj9ekouT4SoECsD6G2Bm' },
  { pool: 'DjaYfY2s7BFxs8Se13ZVcHS48UCvZgFFuxaWgPiabYve', lp: '9qpcETqzHCfc1MtvDXasFYiwJYCCp8DC9BDdn7hs16vE', symA: 'BRAINS', symB: 'LB',   mintA: 'EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN', mintB: 'Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6' },
];

function padSymbol(s) {
  const buf = Buffer.alloc(12, 0);
  Buffer.from(s.slice(0, 12)).copy(buf);
  return buf;
}

function encodeParams(pool) {
  const buf = Buffer.alloc(32 + 32 + 32 + 32 + 12 + 12);
  let off = 0;
  new PublicKey(pool.pool).toBuffer().copy(buf, off);  off += 32;
  new PublicKey(pool.lp).toBuffer().copy(buf, off);    off += 32;
  new PublicKey(pool.mintA).toBuffer().copy(buf, off); off += 32;
  new PublicKey(pool.mintB).toBuffer().copy(buf, off); off += 32;
  padSymbol(pool.symA).copy(buf, off); off += 12;
  padSymbol(pool.symB).copy(buf, off);
  return buf;
}

async function sendAndConfirm(conn, tx, signer) {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  tx.sign(signer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const s = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
    if (s?.value?.err) throw new Error('TX error: ' + JSON.stringify(s.value.err));
    const c = s?.value?.confirmationStatus;
    if (c === 'confirmed' || c === 'finalized') return sig;
  }
  throw new Error('Timeout: ' + sig);
}

async function main() {
  const keypairPath = path.resolve(process.env.HOME, '.config/solana/id.json');
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath))));
  const conn  = new Connection(RPC, 'confirmed');
  const [globalStatePda] = PublicKey.findProgramAddressSync([Buffer.from('global_state')], PROGRAM_ID);

  console.log('Seeding 5 existing BRAINS pools...\n');

  for (const pool of POOLS) {
    const poolPk = new PublicKey(pool.pool);
    const [poolRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('pool_record'), poolPk.toBuffer()], PROGRAM_ID
    );

    const existing = await conn.getAccountInfo(poolRecordPda);
    if (existing) {
      console.log(`✅ Already seeded: ${pool.symA}/${pool.symB}`);
      continue;
    }

    const tx = new Transaction();
    tx.add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: globalStatePda,  isSigner: false, isWritable: false },
        { pubkey: poolRecordPda,   isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc, encodeParams(pool)]),
    }));

    try {
      const sig = await sendAndConfirm(conn, tx, admin);
      console.log(`✅ Seeded ${pool.symA}/${pool.symB} — ${sig.slice(0,20)}…`);
    } catch (e) {
      console.error(`❌ Failed ${pool.symA}/${pool.symB}:`, e.message);
    }
  }
  console.log('\nDone.');
}

main().catch(console.error);
