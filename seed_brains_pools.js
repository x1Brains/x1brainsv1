// seed_brains_pools.js
// Seeds the 5 pre-existing BRAINS ecosystem pools into the brains_pairing PoolRecord accounts.
// Run: node seed_brains_pools.js
// Uses ~/.config/solana/id.json (admin keypair = CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2)

const {
  Connection, Keypair, PublicKey,
  Transaction, TransactionInstruction,
  SystemProgram, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const RPC        = 'https://rpc.mainnet.x1.xyz';
const PROGRAM_ID = new PublicKey('DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM');
const ADMIN_WALLET = 'CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2';

// ── The 5 BRAINS ecosystem pool addresses ─────────────────────────────────────
const POOL_ADDRESSES = [
  '7deZorr98nLdZhpmSdUgu8WY4NAjSpeLDGxHzaTAxrUg', // BRAINS/XNT main pair
  '4C4o1Zgzrt996t2BupL65WJvkifZZ3Ncv3oZxe2CxrW4',
  'AhgJp8b2aFu9dgFbZZwSs5QhQXWgvtiY6MFaMzxriApb',
  'HWmgietnQGE3eK11PhaCsZi6E3iFzCK3n8wTDrYoiLoP',
  'DjaYfY2s7BFxs8Se13ZVcHS48UCvZgFFuxaWgPiabYve',
];

function readPk(d, o)  { return new PublicKey(d.slice(o, o + 32)).toBase58(); }
function readU64(d, o) { return new DataView(d.buffer, d.byteOffset + o, 8).getBigUint64(0, true); }

async function rpc(conn, method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

// Read XDEX pool state — same layout as PoolsTab/PairingMarketplace
async function readPoolState(poolAddr) {
  const res = await rpc(null, 'getAccountInfo', [poolAddr, { encoding: 'base64' }]);
  if (!res?.value) throw new Error(`Pool account not found: ${poolAddr}`);
  const d = new Uint8Array(Buffer.from(res.value.data[0], 'base64'));
  const D = 8;
  return {
    token0Mint: readPk(d, D + 160),
    token1Mint: readPk(d, D + 192),
    lpMint:     readPk(d, D + 128),
  };
}

// Read token symbol from mint metadata (Token-2022 ext → fallback to truncated address)
async function getSymbol(mint) {
  const KNOWN = {
    'EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN': 'BRAINS',
    'Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6': 'LB',
    'So11111111111111111111111111111111111111112':     'XNT',
    'XNMbEwZFFBKQhqyW3taa8cAUp1xBUHfyzRFJQvZET4m':  'XNM',
    'XUNigZPoe8f657NkRf7KF8tqj9ekouT4SoECsD6G2Bm':  'XUNI',
    'XBLKLmxhADMVX3DsdwymvHyYbBYfKa5eKhtpiQ2kj7T':  'XBLK',
  };
  if (KNOWN[mint]) return KNOWN[mint];
  return mint.slice(0, 6).toUpperCase();
}

// Encode symbol as [u8; 12] padded with zeros (matches SeedPoolParams)
function encodeSymbol(sym) {
  const buf = Buffer.alloc(12, 0);
  Buffer.from(sym.slice(0, 12), 'utf8').copy(buf);
  return buf;
}

// Anchor discriminator: first 8 bytes of sha256("global:<name>")
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

  const [globalState] = PublicKey.findProgramAddressSync([Buffer.from('global_state')], PROGRAM_ID);

  // ── Check each pool: skip if already seeded ──────────────────────────────────
  const poolsToSeed = [];
  console.log('\n── Checking pools ──────────────────────────────────────────────');
  for (const poolAddr of POOL_ADDRESSES) {
    const [poolRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('pool_record'), new PublicKey(poolAddr).toBuffer()],
      PROGRAM_ID
    );
    const existing = await conn.getAccountInfo(poolRecordPda);
    if (existing) {
      console.log(`SKIP (already seeded): ${poolAddr.slice(0,8)}… → PDA ${poolRecordPda.toBase58().slice(0,8)}…`);
      continue;
    }
    // Read XDEX pool state
    let state;
    try { state = await readPoolState(poolAddr); }
    catch (e) { console.log(`SKIP (pool not found on-chain): ${poolAddr.slice(0,8)}… — ${e.message}`); continue; }

    const symA = await getSymbol(state.token0Mint);
    const symB = await getSymbol(state.token1Mint);
    console.log(`QUEUE: ${poolAddr.slice(0,8)}… → ${symA}/${symB} LP=${state.lpMint.slice(0,8)}…`);
    poolsToSeed.push({ poolAddr, state, symA, symB, poolRecordPda });
  }

  if (poolsToSeed.length === 0) {
    console.log('\n✅ All pools already seeded — nothing to do.');
    return;
  }

  console.log(`\n── Seeding ${poolsToSeed.length} pool(s) ────────────────────────────────────`);

  const DISC_SEED = disc('seed_pool_record');

  for (const { poolAddr, state, symA, symB, poolRecordPda } of poolsToSeed) {
    console.log(`\nSeeding ${symA}/${symB} (${poolAddr.slice(0,8)}…)`);

    // Encode SeedPoolParams:
    //   pool_address: Pubkey  32
    //   lp_mint:      Pubkey  32
    //   token_a_mint: Pubkey  32
    //   token_b_mint: Pubkey  32
    //   sym_a:        [u8;12] 12
    //   sym_b:        [u8;12] 12
    // Total params: 152 bytes
    const params = Buffer.alloc(152);
    let off = 0;
    new PublicKey(poolAddr).toBuffer().copy(params, off);          off += 32; // pool_address
    new PublicKey(state.lpMint).toBuffer().copy(params, off);      off += 32; // lp_mint
    new PublicKey(state.token0Mint).toBuffer().copy(params, off);  off += 32; // token_a_mint
    new PublicKey(state.token1Mint).toBuffer().copy(params, off);  off += 32; // token_b_mint
    encodeSymbol(symA).copy(params, off);                          off += 12; // sym_a
    encodeSymbol(symB).copy(params, off);                                     // sym_b

    const ixData = Buffer.concat([DISC_SEED, params]);

    const keys = [
      { pubkey: admin.publicKey, isSigner: true,  isWritable: true  }, // admin
      { pubkey: globalState,     isSigner: false, isWritable: false }, // global_state
      { pubkey: poolRecordPda,   isSigner: false, isWritable: true  }, // pool_record (init)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    ];

    const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data: ixData });
    const tx = new Transaction();
    tx.add(ix);

    try {
      const sig = await sendAndConfirm(conn, tx, admin);
      console.log(`  ✅ Seeded! https://explorer.x1.xyz/tx/${sig}`);
    } catch (e) {
      console.error(`  ❌ Failed: ${e.message}`);
    }
  }

  console.log('\n── Done ─────────────────────────────────────────────────────────');
}

main().catch(console.error);
