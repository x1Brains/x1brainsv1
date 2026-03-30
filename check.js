const { Connection, PublicKey } = require('@solana/web3.js');
const conn = new Connection('https://rpc.mainnet.x1.xyz', 'confirmed');
const programId = new PublicKey('3B6oAfmL7aGVAbBdu7zW3jqEVWK6o1nwFiufuSuFV6tN');
const [statePda] = PublicKey.findProgramAddressSync([Buffer.from('lb_state')], programId);
conn.getAccountInfo(statePda).then(info => {
  if (!info) return console.log('State not found');
  const minted = info.data.readBigUInt64LE(104);
  console.log('total_minted raw:', minted.toString());
  console.log('total_minted LB:', (Number(minted) / 100).toFixed(2));
  console.log('paused:', info.data[112] === 1);
});
