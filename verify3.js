const {Connection,PublicKey}=require('@solana/web3.js');
const c=new Connection('https://rpc.mainnet.x1.xyz','confirmed');
c.getAccountInfo(new PublicKey('EkJre96BsoSVhfdSvoi65ydn39Vi21bMfbF6aTTQHU7J')).then(a=>{
  console.log('Listing data size:',a.data.length);
  process.exit(0);
});
