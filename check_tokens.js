const { Connection, PublicKey } = require('@solana/web3.js');
const conn = new Connection('https://rpc.mainnet.x1.xyz', 'confirmed');
const tokens = {
  XNM:  'XNMbEwZFFBKQhqyW3taa8cAUp1xBUHfyzRFJQvZET4m',
  XUNI: 'XUNigZPoe8f657NkRf7KF8tqj9ekouT4SoECsD6G2Bm',
  XBLK: 'XBLKLmxhADMVX3DsdwymvHyYbBYfKa5eKhtpiQ2kj7T',
};
Promise.all(Object.entries(tokens).map(async ([name, addr]) => {
  const info = await conn.getAccountInfo(new PublicKey(addr));
  console.log(name, 'owner:', info.owner.toBase58());
}));
