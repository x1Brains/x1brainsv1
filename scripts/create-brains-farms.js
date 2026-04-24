// create-brains-farms.js
// Creates the 2 launch farms:
//   1. BRAINS/XNT LP  →  BRAINS rewards  (seed 444k BRAINS over 365 days)
//   2. LB/XNT LP      →  LB rewards      (seed 5k LB over 365 days)
//
// Reads LP mints from the XDEX pool accounts and passes them to create_farm.
// LpSource::Xdex means the program verifies LP mint authority = XDEX_LP_AUTH.
//
// Run: node scripts/create-brains-farms.js
// Uses ~/.config/solana/id.json (admin keypair)

const {
  Connection, Keypair, PublicKey,
  Transaction, TransactionInstruction,
  SystemProgram, SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const RPC          = 'https://rpc.mainnet.x1.xyz';
const FARM_PROGRAM = new PublicKey('Ci1qDtdoSh8mCtJTVoX1tArbnLydQUZYu9RiqukRFJpg');
const ADMIN_WALLET = 'CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2';

// Token programs
const TOKEN_PROGRAM      = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

// Ecosystem mints
const BRAINS_MINT = new PublicKey('EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN');
const LB_MINT     = new PublicKey('Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6');

// Pools (verified in seed_brains_pools.js)
const BRAINS_XNT_POOL = '7deZorr98nLdZhpmSdUgu8WY4NAjSpeLDGxHzaTAxrUg';
const LB_XNT_POOL     = 'CKtXmX82rLBqNkfpCBPUoHLmtZhgBdVWpVPW93hHHCCK';

// XDEX LP authority (hardcoded in program constants) — used for LpSource::Xdex provenance check
const XDEX_LP_AUTH = '9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU';

// Farm params
const ONE_YEAR_SECS = 365 * 24 * 60 * 60;

const FARMS = [
  {
    label:       'BRAINS farm (BRAINS/XNT LP → BRAINS)',
    poolAddr:    BRAINS_XNT_POOL,
    rewardMint:  BRAINS_MINT,
    rewardName:  'BRAINS',
    seedHuman:   444_000,       // 444,000 BRAINS
    rewardDec:   9,             // BRAINS decimals
  },
  {
    label:       'LB farm (LB/XNT LP → LB)',
    poolAddr:    LB_XNT_POOL,
    rewardMint:  LB_MINT,
    rewardName:  'LB',
    seedHuman:   5_000,         // 5,000 LB
    rewardDec:   2,             // LB decimals
  },
];

function readPk(d, o) { return new PublicKey(d.slice(o, o + 32)).toBase58(); }

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

// Same layout as seed_brains_pools.js: lpMint at offset 8+128=136
async function readPoolState(poolAddr) {
  const res = await rpc('getAccountInfo', [poolAddr, { encoding: 'base64' }]);
  if (!res?.value) throw new Error(`Pool account not found: ${poolAddr}`);
  const d = new Uint8Array(Buffer.from(res.value.data[0], 'base64'));
  const D = 8;
  return {
    lpMint:     readPk(d, D + 128),
    token0Mint: readPk(d, D + 160),
    token1Mint: readPk(d, D + 192),
  };
}

// Determine if a mint is Token-2022 or classic SPL by checking account owner
async function getMintProgram(mintPubkey) {
  const res = await rpc('getAccountInfo', [mintPubkey.toBase58(), { encoding: 'jsonParsed' }]);
  if (!res?.value) throw new Error(`Mint not found: ${mintPubkey}`);
  const owner = res.value.owner;
  if (owner === TOKEN_2022_PROGRAM.toBase58()) return TOKEN_2022_PROGRAM;
  if (owner === TOKEN_PROGRAM.toBase58())       return TOKEN_PROGRAM;
  throw new Error(`Mint ${mintPubkey.toBase58()} has unknown owner ${owner}`);
}

function disc(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

// Encode CreateFarmParams: { seed_amount: u64, target_duration_secs: i64, source: LpSource }
// LpSource: Anchor enum encoded as u8 (BrainsPairing=0, Xdex=1)
function encodeCreateFarmParams(seedRaw, durationSecs, sourceEnum) {
  const buf = Buffer.alloc(8 + 8 + 1);
  buf.writeBigUInt64LE(BigInt(seedRaw), 0);
  buf.writeBigInt64LE(BigInt(durationSecs), 8);
  buf.writeUInt8(sourceEnum, 16);
  return buf;
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
  if (bal < 1 * LAMPORTS_PER_SOL) throw new Error('Insufficient balance — need at least 1 XNT');

  const [globalPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('farm_global')],
    FARM_PROGRAM,
  );
  const globalInfo = await conn.getAccountInfo(globalPda);
  if (!globalInfo) {
    throw new Error('FarmGlobal not initialized. Run initialize-farm-global.js first.');
  }
  console.log('✓ FarmGlobal found');

  console.log('\n══════════════════════════════════════════════════════════════════');
  for (const farm of FARMS) {
    console.log(`\n── ${farm.label} ──`);

    // Read LP mint from pool
    console.log(`  Pool: ${farm.poolAddr}`);
    const pool = await readPoolState(farm.poolAddr);
    console.log(`  LP mint:    ${pool.lpMint}`);
    console.log(`  Token0:     ${pool.token0Mint}`);
    console.log(`  Token1:     ${pool.token1Mint}`);

    const lpMintPk = new PublicKey(pool.lpMint);

    // Determine token programs (LP mints on XDEX are classic SPL; rewards could be either)
    const lpProg     = await getMintProgram(lpMintPk);
    const rewardProg = await getMintProgram(farm.rewardMint);
    console.log(`  LP token program:     ${lpProg.toBase58() === TOKEN_2022_PROGRAM.toBase58() ? 'Token-2022' : 'Token'}`);
    console.log(`  Reward token program: ${rewardProg.toBase58() === TOKEN_2022_PROGRAM.toBase58() ? 'Token-2022' : 'Token'}`);

    // Derive farm + vault PDAs
    const [farmPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('farm'), lpMintPk.toBuffer(), farm.rewardMint.toBuffer()],
      FARM_PROGRAM,
    );
    const [lpVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('lp_vault'), farmPda.toBuffer()],
      FARM_PROGRAM,
    );
    const [rewardVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('reward_vault'), farmPda.toBuffer()],
      FARM_PROGRAM,
    );
    console.log(`  Farm PDA:         ${farmPda.toBase58()}`);
    console.log(`  LP vault PDA:     ${lpVaultPda.toBase58()}`);
    console.log(`  Reward vault PDA: ${rewardVaultPda.toBase58()}`);

    // Check if already created
    const existing = await conn.getAccountInfo(farmPda);
    if (existing) {
      console.log(`  ✓ Farm already exists (${existing.data.length} bytes). Skipping.`);
      continue;
    }

    // Compute seed raw amount
    const seedRaw = BigInt(farm.seedHuman) * (10n ** BigInt(farm.rewardDec));
    const rateScaled = (seedRaw * (10n ** 18n)) / BigInt(ONE_YEAR_SECS);
    console.log(`  Seed:     ${farm.seedHuman.toLocaleString()} ${farm.rewardName} (${seedRaw} raw)`);
    console.log(`  Duration: ${ONE_YEAR_SECS} secs (365 days)`);
    console.log(`  Computed reward_rate_per_sec (scaled): ${rateScaled}`);

    // For LpSource::Xdex, lp_provenance_account is the program_id as sentinel.
    // The program checks lp_mint.mint_authority == XDEX_LP_AUTH instead of
    // reading a PoolRecord. But we must still pass *some* account — program_id
    // is safe since handler does not read from it when source = Xdex.
    const lpProvenance = FARM_PROGRAM;

    // Encode params
    const params = encodeCreateFarmParams(
      seedRaw,
      ONE_YEAR_SECS,
      1, // LpSource::Xdex
    );
    const data = Buffer.concat([disc('create_farm'), params]);

    const keys = [
      { pubkey: admin.publicKey,       isSigner: true,  isWritable: true  }, // admin
      { pubkey: globalPda,             isSigner: false, isWritable: true  }, // global_state
      { pubkey: lpMintPk,              isSigner: false, isWritable: false }, // lp_mint
      { pubkey: farm.rewardMint,       isSigner: false, isWritable: false }, // reward_mint
      { pubkey: farmPda,               isSigner: false, isWritable: true  }, // farm
      { pubkey: lpVaultPda,            isSigner: false, isWritable: true  }, // lp_vault
      { pubkey: rewardVaultPda,        isSigner: false, isWritable: true  }, // reward_vault
      { pubkey: lpProvenance,          isSigner: false, isWritable: false }, // lp_provenance_account
      { pubkey: lpProg,                isSigner: false, isWritable: false }, // lp_token_program
      { pubkey: rewardProg,            isSigner: false, isWritable: false }, // reward_token_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      { pubkey: SYSVAR_RENT_PUBKEY,    isSigner: false, isWritable: false }, // rent
    ];

    const ix = new TransactionInstruction({ programId: FARM_PROGRAM, keys, data });
    const tx = new Transaction().add(ix);

    console.log('  Sending create_farm...');
    await sendAndConfirm(conn, tx, admin);

    const created = await conn.getAccountInfo(farmPda);
    console.log(`  ✓ Farm created (${created.data.length} bytes)`);
  }

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('✓ All farms processed');
  console.log('  Next: node scripts/fund-brains-farms.js');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
