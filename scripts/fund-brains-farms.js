// fund-brains-farms.js
// Transfers 444,000 BRAINS and 5,000 LB from admin wallet into the respective
// farm reward vaults via the permissionless fund_farm instruction.
//
// Prerequisites:
//   1. initialize-farm-global.js has run
//   2. create-brains-farms.js has run (both farms exist)
//   3. Admin wallet has at least 444k BRAINS and 5k LB in its ATAs
//
// Run: node scripts/fund-brains-farms.js

const {
  Connection, Keypair, PublicKey,
  Transaction, TransactionInstruction,
  SystemProgram, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const RPC          = 'https://rpc.mainnet.x1.xyz';
const FARM_PROGRAM = new PublicKey('Ci1qDtdoSh8mCtJTVoX1tArbnLydQUZYu9RiqukRFJpg');
const ADMIN_WALLET = 'CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2';

const BRAINS_MINT = new PublicKey('EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN');
const LB_MINT     = new PublicKey('Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6');

const BRAINS_XNT_POOL = '7deZorr98nLdZhpmSdUgu8WY4NAjSpeLDGxHzaTAxrUg';
const LB_XNT_POOL     = 'CKtXmX82rLBqNkfpCBPUoHLmtZhgBdVWpVPW93hHHCCK';

const FUNDING = [
  { name: 'BRAINS', poolAddr: BRAINS_XNT_POOL, rewardMint: BRAINS_MINT, amount: 444_000, decimals: 9 },
  { name: 'LB',     poolAddr: LB_XNT_POOL,     rewardMint: LB_MINT,     amount:   5_000, decimals: 2 },
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

async function readPoolState(poolAddr) {
  const res = await rpc('getAccountInfo', [poolAddr, { encoding: 'base64' }]);
  if (!res?.value) throw new Error(`Pool not found: ${poolAddr}`);
  const d = new Uint8Array(Buffer.from(res.value.data[0], 'base64'));
  return { lpMint: readPk(d, 8 + 128) };
}

async function getMintProgram(mintPubkey) {
  const res = await rpc('getAccountInfo', [mintPubkey.toBase58(), { encoding: 'jsonParsed' }]);
  if (!res?.value) throw new Error(`Mint not found: ${mintPubkey}`);
  if (res.value.owner === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

function disc(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

// Encode FundFarmParams: { amount: u64 }
function encodeFundFarmParams(amountRaw) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(amountRaw), 0);
  return buf;
}

async function getAtaBalance(conn, ata) {
  try {
    const info = await conn.getParsedAccountInfo(ata);
    const amt = info?.value?.data?.parsed?.info?.tokenAmount?.amount;
    return amt ? BigInt(amt) : 0n;
  } catch { return 0n; }
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
    throw new Error(`Wrong keypair!`);
  }

  const conn = new Connection(RPC, 'confirmed');
  const bal  = await conn.getBalance(admin.publicKey);
  console.log(`Balance: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} XNT`);

  console.log('\n══════════════════════════════════════════════════════════════════');
  for (const fund of FUNDING) {
    console.log(`\n── Funding ${fund.name} farm ──`);

    // Read LP mint + derive farm PDA
    const pool = await readPoolState(fund.poolAddr);
    const lpMintPk = new PublicKey(pool.lpMint);
    const [farmPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('farm'), lpMintPk.toBuffer(), fund.rewardMint.toBuffer()],
      FARM_PROGRAM,
    );
    const [rewardVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('reward_vault'), farmPda.toBuffer()],
      FARM_PROGRAM,
    );

    const farmInfo = await conn.getAccountInfo(farmPda);
    if (!farmInfo) {
      console.log(`  ✗ Farm does not exist. Run create-brains-farms.js first. Skipping.`);
      continue;
    }
    console.log(`  Farm PDA:         ${farmPda.toBase58()}`);
    console.log(`  Reward vault:     ${rewardVaultPda.toBase58()}`);

    // Token program
    const tokenProg = await getMintProgram(fund.rewardMint);

    // Admin's reward ATA
    const adminAta = getAssociatedTokenAddressSync(fund.rewardMint, admin.publicKey, false, tokenProg);
    console.log(`  Admin ATA:        ${adminAta.toBase58()}`);

    const adminBal = await getAtaBalance(conn, adminAta);
    const amountRaw = BigInt(fund.amount) * (10n ** BigInt(fund.decimals));
    console.log(`  Admin balance:    ${adminBal} raw (${Number(adminBal) / 10**fund.decimals} ${fund.name})`);
    console.log(`  Required:         ${amountRaw} raw (${fund.amount} ${fund.name})`);

    if (adminBal < amountRaw) {
      console.log(`  ✗ Insufficient balance. Need ${amountRaw - adminBal} more raw units.`);
      continue;
    }

    // Check current vault balance — skip if already funded enough
    const vaultBal = await getAtaBalance(conn, rewardVaultPda);
    console.log(`  Current vault:    ${vaultBal} raw`);
    if (vaultBal >= amountRaw) {
      console.log(`  ✓ Vault already has ≥ target amount. Skipping.`);
      continue;
    }

    // Build fund_farm ix
    const data = Buffer.concat([disc('fund_farm'), encodeFundFarmParams(amountRaw)]);

    const keys = [
      { pubkey: admin.publicKey,  isSigner: true,  isWritable: true  }, // funder
      { pubkey: farmPda,          isSigner: false, isWritable: true  }, // farm
      { pubkey: fund.rewardMint,  isSigner: false, isWritable: false }, // reward_mint
      { pubkey: adminAta,         isSigner: false, isWritable: true  }, // funder_reward_ata
      { pubkey: rewardVaultPda,   isSigner: false, isWritable: true  }, // reward_vault
      { pubkey: tokenProg,        isSigner: false, isWritable: false }, // token_program
    ];

    const ix = new TransactionInstruction({ programId: FARM_PROGRAM, keys, data });
    const tx = new Transaction().add(ix);

    console.log('  Sending fund_farm...');
    await sendAndConfirm(conn, tx, admin);

    const newVaultBal = await getAtaBalance(conn, rewardVaultPda);
    console.log(`  ✓ Vault now has ${newVaultBal} raw (${Number(newVaultBal) / 10**fund.decimals} ${fund.name})`);
  }

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('✓ Funding complete');
  console.log('');
  console.log('Both farms are now live. Users can start staking at /lpfarms');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
