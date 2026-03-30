const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } = require('@solana/web3.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROGRAM_ID    = new PublicKey('3B6oAfmL7aGVAbBdu7zW3jqEVWK6o1nwFiufuSuFV6tN');
const [statePda]    = PublicKey.findProgramAddressSync([Buffer.from('lb_state')],    PROGRAM_ID);
const [lbMintPda]   = PublicKey.findProgramAddressSync([Buffer.from('lb_mint')],      PROGRAM_ID);
const [mintAuthPda] = PublicKey.findProgramAddressSync([Buffer.from('lb_mint_auth')], PROGRAM_ID);

const disc = Buffer.from(crypto.createHash('sha256').update('global:update_tier_rates').digest()).slice(0,8);

const TIERS = [
  [8,  500000000],
  [18, 750000000],
  [26, 1000000000],
  [33, 1500000000],
];

function encodeU64LE(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

async function main() {
  const keypairPath  = path.resolve(process.env.HOME, '.config/solana/id.json');
  const adminKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath))));
  const conn         = new Connection('https://rpc.mainnet.x1.xyz', 'confirmed');

  const tierData = Buffer.concat(TIERS.map(([b, x]) => Buffer.concat([encodeU64LE(b), encodeU64LE(x)])));
  const data     = Buffer.concat([disc, tierData]);

  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: adminKeypair.publicKey, recentBlockhash: blockhash });
  tx.add(new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: adminKeypair.publicKey, isSigner: true,  isWritable: true  },
      { pubkey: statePda,               isSigner: false, isWritable: true  },
      { pubkey: lbMintPda,              isSigner: false, isWritable: true  },
      { pubkey: mintAuthPda,            isSigner: false, isWritable: false },
      { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
    ],
    data,
  }));
  tx.sign(adminKeypair);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  console.log('Tx:', sig);
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const s = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
    const c = s?.value?.confirmationStatus;
    if (s?.value?.err) { console.log('Error:', s.value.err); break; }
    if (c === 'confirmed' || c === 'finalized') { console.log('Confirmed!'); break; }
  }
  console.log('Tier 1: 8 BRAINS | 0.50 XNT');
  console.log('Tier 2: 18 BRAINS | 0.75 XNT');
  console.log('Tier 3: 26 BRAINS | 1.00 XNT');
  console.log('Tier 4: 33 BRAINS | 1.50 XNT');
}
main().catch(console.error);
