const {Connection,PublicKey}=require('@solana/web3.js');
const c=new Connection('https://rpc.mainnet.x1.xyz','confirmed');
const gs=new PublicKey('391eXwmvTeegtbJWCSo4afLLD4oJwLXXD1ocnH8TMCpn');
c.getAccountInfo(gs).then(a=>{
  const data=a.data;
  // GlobalState layout after 8 byte discriminator:
  // admin: 32, treasury: 32, total_fee_xnt: 8, total_listings: 8,
  // total_pools_created: 8, open_listings: 8, paused: 1, is_locked: 1, bump: 1
  let off=8;
  const admin=new PublicKey(data.slice(off,off+32)); off+=32;
  const treasury=new PublicKey(data.slice(off,off+32)); off+=32;
  const fee=data.readBigUInt64LE(off); off+=8;
  const total=data.readBigUInt64LE(off); off+=8;
  const pools=data.readBigUInt64LE(off); off+=8;
  const open=data.readBigUInt64LE(off); off+=8;
  const paused=data[off++];
  const locked=data[off++];
  const bump=data[off];
  console.log('admin:', admin.toBase58());
  console.log('total_listings:', total.toString());
  console.log('open_listings:', open.toString());
  console.log('paused:', paused);
  console.log('IS_LOCKED:', locked, locked===1?'<-- PROBLEM!':'OK');
  console.log('bump:', bump);
  process.exit(0);
});
