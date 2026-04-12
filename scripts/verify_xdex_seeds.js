// verify_xdex_seeds.js — confirm XDEX uses standard Raydium CP-swap seed derivation
const { PublicKey } = require('@solana/web3.js');

const XDEX_PROGRAM = new PublicKey('sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN');
const AMM_CONFIG_A = new PublicKey('2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c');

// Known BRAINS/WXNT pool — what we want to derive
const KNOWN_POOL = '7deZorr98nLdZhpmSdUgu8WY4NAjSpeLDGxHzaTAxrUg';
const KNOWN_LP_MINT = 'FSFjPXo9vAvVsjh6YuuNTjetZ6oZBgfYA6TLcWTYmwq3';

const BRAINS_MINT = new PublicKey('EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN');
const WXNT_MINT   = new PublicKey('So11111111111111111111111111111111111111112');

// IDL says: token_0 must be < token_1 lexicographically
function orderMints(a, b) {
  const ab = a.toBuffer();
  const bb = b.toBuffer();
  for (let i = 0; i < 32; i++) {
    if (ab[i] < bb[i]) return [a, b];
    if (ab[i] > bb[i]) return [b, a];
  }
  return [a, b];
}

const [token0, token1] = orderMints(BRAINS_MINT, WXNT_MINT);
console.log('Token0 (smaller):', token0.toBase58());
console.log('Token1 (larger): ', token1.toBase58());
console.log();

// Try standard Raydium CP-swap seeds
const seedAttempts = [
  { name: 'pool',          seeds: [Buffer.from('pool'),          AMM_CONFIG_A.toBuffer(), token0.toBuffer(), token1.toBuffer()] },
  { name: 'pool_state',    seeds: [Buffer.from('pool_state'),    AMM_CONFIG_A.toBuffer(), token0.toBuffer(), token1.toBuffer()] },
  { name: 'cp_pool',       seeds: [Buffer.from('cp_pool'),       AMM_CONFIG_A.toBuffer(), token0.toBuffer(), token1.toBuffer()] },
  { name: 'amm',           seeds: [Buffer.from('amm'),           AMM_CONFIG_A.toBuffer(), token0.toBuffer(), token1.toBuffer()] },
];

console.log('=== Pool address derivation ===');
console.log('Target:', KNOWN_POOL);
for (const a of seedAttempts) {
  try {
    const [pda, bump] = PublicKey.findProgramAddressSync(a.seeds, XDEX_PROGRAM);
    const match = pda.toBase58() === KNOWN_POOL ? ' ✅ MATCH' : '';
    console.log(`  ${a.name.padEnd(15)} → ${pda.toBase58()} (bump ${bump})${match}`);
  } catch (e) {
    console.log(`  ${a.name.padEnd(15)} → derivation failed: ${e.message}`);
  }
}

// Try LP mint seeds
const lpSeedAttempts = [
  { name: 'pool_lp_mint',  seeds: [Buffer.from('pool_lp_mint'), new PublicKey(KNOWN_POOL).toBuffer()] },
  { name: 'lp_mint',       seeds: [Buffer.from('lp_mint'),      new PublicKey(KNOWN_POOL).toBuffer()] },
];

console.log();
console.log('=== LP mint derivation ===');
console.log('Target:', KNOWN_LP_MINT);
for (const a of lpSeedAttempts) {
  const [pda, bump] = PublicKey.findProgramAddressSync(a.seeds, XDEX_PROGRAM);
  const match = pda.toBase58() === KNOWN_LP_MINT ? ' ✅ MATCH' : '';
  console.log(`  ${a.name.padEnd(15)} → ${pda.toBase58()} (bump ${bump})${match}`);
}

// Try vault seeds
const KNOWN_VAULT_XNT  = 'HJ5WsScycRCtp8yqGsLbcDAayMsbcYajELcALg6kaUaq';
const KNOWN_VAULT_BASE = 'HnUfCrgrhHzgML92ipbkLGhi2ggm1kdHDvvcqRtuUeb3';

console.log();
console.log('=== Vault derivation ===');
console.log('Target XNT vault: ', KNOWN_VAULT_XNT);
console.log('Target BASE vault:', KNOWN_VAULT_BASE);

const vaultSeedAttempts = [
  { name: 'pool_vault t0', seeds: [Buffer.from('pool_vault'), new PublicKey(KNOWN_POOL).toBuffer(), token0.toBuffer()] },
  { name: 'pool_vault t1', seeds: [Buffer.from('pool_vault'), new PublicKey(KNOWN_POOL).toBuffer(), token1.toBuffer()] },
  { name: 'vault t0',      seeds: [Buffer.from('vault'),      new PublicKey(KNOWN_POOL).toBuffer(), token0.toBuffer()] },
  { name: 'vault t1',      seeds: [Buffer.from('vault'),      new PublicKey(KNOWN_POOL).toBuffer(), token1.toBuffer()] },
];
for (const a of vaultSeedAttempts) {
  const [pda] = PublicKey.findProgramAddressSync(a.seeds, XDEX_PROGRAM);
  const matchXnt  = pda.toBase58() === KNOWN_VAULT_XNT  ? ' ✅ MATCH XNT'  : '';
  const matchBase = pda.toBase58() === KNOWN_VAULT_BASE ? ' ✅ MATCH BASE' : '';
  console.log(`  ${a.name.padEnd(15)} → ${pda.toBase58()}${matchXnt}${matchBase}`);
}

// Authority seed
console.log();
console.log('=== Authority derivation ===');
console.log('Target (XDEX_LP_AUTH): 9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU');

const authSeedAttempts = [
  { name: 'vault_and_lp_mint_auth_seed', seeds: [Buffer.from('vault_and_lp_mint_auth_seed')] },
  { name: 'authority',                   seeds: [Buffer.from('authority')] },
  { name: 'pool_authority',              seeds: [Buffer.from('pool_authority')] },
];
for (const a of authSeedAttempts) {
  const [pda] = PublicKey.findProgramAddressSync(a.seeds, XDEX_PROGRAM);
  const match = pda.toBase58() === '9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU' ? ' ✅ MATCH' : '';
  console.log(`  ${a.name.padEnd(35)} → ${pda.toBase58()}${match}`);
}

// Observation seed
console.log();
console.log('=== Observation derivation ===');
const obsSeedAttempts = [
  { name: 'observation', seeds: [Buffer.from('observation'), new PublicKey(KNOWN_POOL).toBuffer()] },
];
for (const a of obsSeedAttempts) {
  const [pda] = PublicKey.findProgramAddressSync(a.seeds, XDEX_PROGRAM);
  console.log(`  ${a.name.padEnd(15)} → ${pda.toBase58()}`);
}
