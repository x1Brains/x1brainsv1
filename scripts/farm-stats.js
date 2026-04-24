// scripts/farm-stats.js
// Query both farms on-chain and report:
//   - Active positions count per farm
//   - TVL staked (raw + USD)
//   - Total rewards emitted
//   - Current vault balance
//   - Runway remaining

const { Connection, PublicKey } = require('@solana/web3.js');

const RPC = 'https://rpc.mainnet.x1.xyz';
const PROGRAM_ID = new PublicKey('Ci1qDtdoSh8mCtJTVoX1tArbnLydQUZYu9RiqukRFJpg');

const BRAINS_MINT = 'EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN';
const LB_MINT     = 'Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6';

function readU64(d, o)  { return d.readBigUInt64LE(o); }
function readI64(d, o)  { return d.readBigInt64LE(o); }
function readU128(d, o) {
  const lo = d.readBigUInt64LE(o);
  const hi = d.readBigUInt64LE(o + 8);
  return (hi << 64n) | lo;
}

function parseFarm(data) {
  let o = 8;
  const lpMint      = new PublicKey(data.slice(o, o + 32)).toBase58(); o += 32;
  const rewardMint  = new PublicKey(data.slice(o, o + 32)).toBase58(); o += 32;
  const lpVault     = new PublicKey(data.slice(o, o + 32)).toBase58(); o += 32;
  const rewardVault = new PublicKey(data.slice(o, o + 32)).toBase58(); o += 32;
  const rewardRate  = readU128(data, o); o += 16;
  const accRewardPerShare = readU128(data, o); o += 16;
  const lastUpdateTs = readI64(data, o); o += 8;
  const totalStaked = readU64(data, o); o += 8;
  const totalEffective = readU64(data, o); o += 8;
  const totalPendingRewards = readU64(data, o); o += 8;
  const totalEmitted = readU64(data, o); o += 8;
  const startTs = readI64(data, o); o += 8;
  const createdAt = readI64(data, o); o += 8;
  const paused = data[o] === 1; o += 1;
  const closed = data[o] === 1; o += 1;
  return {
    lpMint, rewardMint, lpVault, rewardVault,
    rewardRate, accRewardPerShare,
    lastUpdateTs: Number(lastUpdateTs),
    totalStaked, totalEffective, totalPendingRewards, totalEmitted,
    startTs: Number(startTs), createdAt: Number(createdAt),
    paused, closed,
  };
}

function parsePosition(data) {
  let o = 8;
  const owner = new PublicKey(data.slice(o, o + 32)).toBase58(); o += 32;
  const farm  = new PublicKey(data.slice(o, o + 32)).toBase58(); o += 32;
  const nonce = data.readUInt32LE(o); o += 4;
  const amount = readU64(data, o); o += 8;
  const effectiveAmount = readU64(data, o); o += 8;
  const lockTypeByte = data[o]; o += 1;
  const rewardDebt = readU128(data, o); o += 16;
  const pendingRewards = readU64(data, o); o += 8;
  const startTs = readI64(data, o); o += 8;
  const graceEndTs = readI64(data, o); o += 8;
  const unlockTs = readI64(data, o); o += 8;
  const lockDuration = readI64(data, o); o += 8;
  const lastClaimTs = readI64(data, o); o += 8;
  return {
    owner, farm, nonce, amount, effectiveAmount,
    lockType: lockTypeByte === 0 ? 'L30' : lockTypeByte === 1 ? 'L90' : 'L365',
    pendingRewards,
    startTs: Number(startTs),
    graceEndTs: Number(graceEndTs),
    unlockTs: Number(unlockTs),
    lockDuration: Number(lockDuration),
    lastClaimTs: Number(lastClaimTs),
  };
}

function fmtDate(unix) {
  if (unix === 0) return 'never';
  return new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function fmtDuration(secs) {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs/60)}m`;
  if (secs < 86400) return `${(secs/3600).toFixed(1)}h`;
  return `${(secs/86400).toFixed(1)}d`;
}

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const now = Math.floor(Date.now() / 1000);

  // Fetch all farm accounts (dataSize 229)
  const farmAccounts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: 229 }],
  });

  // Fetch all position accounts (dataSize 158)
  const posAccounts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: 158 }],
  });

  console.log(`\n════════════════════════════════════════════════════════════`);
  console.log(`  X1 BRAINS FARM — PROTOCOL STATS`);
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Slot query time: ${now}`);
  console.log(`════════════════════════════════════════════════════════════\n`);

  console.log(`Farms found:     ${farmAccounts.length}`);
  console.log(`Positions found: ${posAccounts.length} (across all farms)\n`);

  // Parse and organize by farm
  const farms = farmAccounts.map(a => ({
    pubkey: a.pubkey.toBase58(),
    ...parseFarm(a.account.data),
  }));

  const positions = posAccounts.map(a => parsePosition(a.account.data));

  for (const farm of farms) {
    const symbol = farm.rewardMint === BRAINS_MINT ? 'BRAINS'
                 : farm.rewardMint === LB_MINT     ? 'LB'
                 : farm.rewardMint.slice(0, 6);
    const decimals = farm.rewardMint === LB_MINT ? 2 : 9;
    const pow = 10 ** decimals;
    const lpPow = 10 ** 9; // both LP mints are 9-dec

    // Get vault balance
    let vaultBalance = 0n;
    try {
      const v = await conn.getAccountInfo(new PublicKey(farm.rewardVault));
      if (v && v.data.length >= 72) {
        vaultBalance = readU64(v.data, 64);
      }
    } catch {}

    // Filter positions for this farm
    const farmPositions = positions.filter(p => p.farm === farm.pubkey);
    const activeStakers = new Set(farmPositions.map(p => p.owner)).size;

    // Rate per second (unscaled)
    const ratePerSec = Number(farm.rewardRate) / 1e18;
    const runwaySecs = ratePerSec > 0 ? Number(vaultBalance) / (ratePerSec * pow) * pow : 0;

    console.log(`┌─ FARM: ${symbol} (pubkey ${farm.pubkey.slice(0, 8)}…${farm.pubkey.slice(-4)})`);
    console.log(`│  Reward mint:    ${farm.rewardMint}`);
    console.log(`│  LP mint:        ${farm.lpMint}`);
    console.log(`│  Status:         ${farm.paused ? 'PAUSED' : farm.closed ? 'CLOSED' : 'ACTIVE'}`);
    console.log(`│  Created:        ${fmtDate(farm.createdAt)}`);
    console.log(`│  Last settle:    ${fmtDate(farm.lastUpdateTs)} (${fmtDuration(now - farm.lastUpdateTs)} ago)`);
    console.log(`│`);
    console.log(`│  POSITIONS`);
    console.log(`│    Active positions:  ${farmPositions.length}`);
    console.log(`│    Unique stakers:    ${activeStakers}`);
    console.log(`│    Total staked LP:   ${(Number(farm.totalStaked)/lpPow).toFixed(6)}`);
    console.log(`│    Total effective:   ${(Number(farm.totalEffective)/lpPow).toFixed(6)} (weighted)`);
    console.log(`│`);
    console.log(`│  REWARDS`);
    console.log(`│    Total emitted:     ${(Number(farm.totalEmitted)/pow).toFixed(decimals)} ${symbol}`);
    console.log(`│    Pending (earmark): ${(Number(farm.totalPendingRewards)/pow).toFixed(decimals)} ${symbol}`);
    console.log(`│    Vault balance:     ${(Number(vaultBalance)/pow).toFixed(decimals)} ${symbol}`);
    console.log(`│    Emission rate:     ${(ratePerSec/pow).toFixed(decimals+4)} ${symbol}/sec`);
    console.log(`│    Runway:            ${fmtDuration(runwaySecs)}`);
    console.log(`│`);

    if (farmPositions.length > 0) {
      console.log(`│  POSITION DETAIL`);
      // sort by amount desc
      farmPositions.sort((a, b) => (b.amount > a.amount) ? 1 : -1);
      for (const p of farmPositions) {
        const ageHours  = (now - p.startTs) / 3600;
        const isMature  = now >= p.unlockTs;
        const isInGrace = now <= p.graceEndTs;
        const status = isMature ? 'MATURE' : isInGrace ? 'GRACE' : 'ACTIVE';
        console.log(`│    ${p.owner.slice(0,8)}…${p.owner.slice(-4)} ` +
                    `n=${p.nonce} ${p.lockType} ` +
                    `${(Number(p.amount)/lpPow).toFixed(4)} LP ` +
                    `(${(Number(p.effectiveAmount)/lpPow).toFixed(4)} eff) ` +
                    `[${status}] ${ageHours.toFixed(1)}h old ` +
                    `pending=${(Number(p.pendingRewards)/pow).toFixed(decimals)}`);
      }
    }
    console.log(`└──────────────────────────────────────────────────────────\n`);
  }

  // Summary
  let totalEmitted = { BRAINS: 0, LB: 0 };
  let totalVault   = { BRAINS: 0, LB: 0 };
  for (const farm of farms) {
    const symbol = farm.rewardMint === BRAINS_MINT ? 'BRAINS'
                 : farm.rewardMint === LB_MINT     ? 'LB' : null;
    if (!symbol) continue;
    const decimals = farm.rewardMint === LB_MINT ? 2 : 9;
    const pow = 10 ** decimals;
    totalEmitted[symbol] += Number(farm.totalEmitted) / pow;
    try {
      const v = await conn.getAccountInfo(new PublicKey(farm.rewardVault));
      if (v && v.data.length >= 72) {
        totalVault[symbol] += Number(readU64(v.data, 64)) / pow;
      }
    } catch {}
  }

  console.log(`════════════════════════════════════════════════════════════`);
  console.log(`  TOTALS`);
  console.log(`════════════════════════════════════════════════════════════`);
  console.log(`  Active positions (all farms): ${positions.length}`);
  console.log(`  Unique stakers (dedup):       ${new Set(positions.map(p => p.owner)).size}`);
  console.log(`  Total BRAINS emitted:         ${totalEmitted.BRAINS.toFixed(9)}`);
  console.log(`  Total LB emitted:             ${totalEmitted.LB.toFixed(2)}`);
  console.log(`  Current BRAINS vault:         ${totalVault.BRAINS.toFixed(2)}`);
  console.log(`  Current LB vault:             ${totalVault.LB.toFixed(2)}`);
  console.log(``);
}

main().catch(e => { console.error(e); process.exit(1); });
