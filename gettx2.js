const {Connection,PublicKey}=require('@solana/web3.js');
const c=new Connection('https://rpc.mainnet.x1.xyz','confirmed');
c.getTransaction('2s3CQqN1ARiv37t4u9zXy61eanRq1acfguuUySVF7jqek6vvJkgXJNug8wu4m9D5YVQJLCQhkYvCo3a817Mzd47K',
  {maxSupportedTransactionVersion:0}).then(tx=>{
  if (!tx) { console.log('tx not found'); process.exit(1); }
  console.log('Accounts used:');
  const keys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
  keys.forEach((k,i)=>console.log(i, k.toBase58()));
  console.log('\nLogs:');
  tx.meta.logMessages.forEach(l=>console.log(l));
  process.exit(0);
});
