const { Connection, PublicKey } = require('@solana/web3.js');

const PROGRAM_ID = new PublicKey('DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM');
const RPC = 'https://rpc.mainnet.x1.xyz';

(async () => {
  const conn = new Connection(RPC, 'confirmed');
  const [gsPda] = PublicKey.findProgramAddressSync([Buffer.from('global_state')], PROGRAM_ID);
  const acc = await conn.getAccountInfo(gsPda);

  console.log('Total size:', acc.data.length);
  console.log('');
  console.log('Byte-by-byte hex dump:');
  for (let i = 0; i < acc.data.length; i += 8) {
    const chunk = acc.data.slice(i, Math.min(i + 8, acc.data.length));
    console.log(`  [${String(i).padStart(3, ' ')}-${String(i + chunk.length - 1).padStart(3, ' ')}]  ${chunk.toString('hex').padEnd(16, ' ')}  ${chunk.toString('ascii').replace(/[^\x20-\x7e]/g, '.')}`);
  }
  console.log('');

  // Try reading fields at various offsets to guess the layout
  console.log('Candidate interpretations:');
  console.log('  admin (8-40): ', new PublicKey(acc.data.slice(8, 40)).toString());
  console.log('  treasury (40-72):', new PublicKey(acc.data.slice(40, 72)).toString());
  console.log('  [72-80] as u64:', acc.data.readBigUInt64LE(72).toString());
  console.log('  [80-88] as u64:', acc.data.readBigUInt64LE(80).toString());
  console.log('  [88-96] as u64:', acc.data.readBigUInt64LE(88).toString());
  console.log('  [96-104] as u64:', acc.data.readBigUInt64LE(96).toString());
  console.log('  [104-112] as u64:', acc.data.readBigUInt64LE(104).toString());
  console.log('  [112]:', acc.data[112]);
  console.log('  [113]:', acc.data[113]);
  console.log('  [114]:', acc.data[114]);
})();
