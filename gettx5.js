const {Connection}=require('@solana/web3.js');
const c=new Connection('https://rpc.mainnet.x1.xyz','confirmed');
c.getTransaction('3sK8BUenrZAtr9XY5Hcmnjmgp5R3ET6r4iu9p8ftrFK2QHd9wcK8XCNHqdnPPq7XhLwquEEBdynxPeFXsynjkkM3',
  {maxSupportedTransactionVersion:0}).then(tx=>{
  const keys=tx.transaction.message.staticAccountKeys||tx.transaction.message.accountKeys;
  console.log('Accounts:');
  keys.forEach((k,i)=>console.log(i,k.toBase58()));
  console.log('Logs:');
  tx.meta.logMessages.forEach(l=>console.log(l));
  process.exit(0);
});
