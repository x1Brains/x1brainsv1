const {Connection,PublicKey}=require('@solana/web3.js');
const c=new Connection('https://rpc.mainnet.x1.xyz','confirmed');
c.getTransaction('2RxmNFES2UzGaJY6qepvozmuZUJTSaWikPHoK4SEj4vYwpUcXUsMq3YgQvBTmPb2niQiCSZEKqdDNehy7TfWXcBX',
  {maxSupportedTransactionVersion:0}).then(tx=>{
  const keys=tx.transaction.message.staticAccountKeys||tx.transaction.message.accountKeys;
  console.log('Accounts:');
  keys.forEach((k,i)=>console.log(i,k.toBase58()));
  console.log('\nLogs:');
  tx.meta.logMessages.forEach(l=>console.log(l));
  process.exit(0);
});
