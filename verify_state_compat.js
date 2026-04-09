const { Connection, PublicKey } = require('@solana/web3.js');

const PROGRAM_ID = new PublicKey('DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM');
const RPC = 'https://rpc.mainnet.x1.xyz';

(async () => {
  const conn = new Connection(RPC, 'confirmed');
  const [gsPda] = PublicKey.findProgramAddressSync([Buffer.from('global_state')], PROGRAM_ID);
  console.log('GlobalState PDA:', gsPda.toString());

  const acc = await conn.getAccountInfo(gsPda);
  if (!acc) { console.log('ERROR: GlobalState not found'); return; }

  console.log('Size:', acc.data.length, 'bytes (expected 107)');
  console.log('Owner:', acc.owner.toString());
  console.log('Disc:', acc.data.slice(0, 8).toString('hex'));

  const admin = new PublicKey(acc.data.slice(8, 40));
  const totalPools = acc.data.readBigUInt64LE(88);
  const openListings = acc.data.readBigUInt64LE(96);
  const paused = acc.data[104];
  const isLocked = acc.data[105];
  const bump = acc.data[106];

  console.log('admin:      ', admin.toString());
  console.log('total_pools:', totalPools.toString());
  console.log('open:       ', openListings.toString());
  console.log('paused:     ', paused);
  console.log('locked:     ', isLocked);
  console.log('bump:       ', bump);
})();
