const {Connection}=require('@solana/web3.js');
const c=new Connection('https://rpc.mainnet.x1.xyz','confirmed');
c.getTransaction('4qU3r4HNLxA73v2knRGES9DBNdbbD78kdJai4T1uYAhU2AngV9JLrP1Cvt63ipobncCsbCMZDHToNqtsktKJ1GsA',
  {maxSupportedTransactionVersion:0}).then(tx=>{
  const keys=tx.transaction.message.staticAccountKeys||tx.transaction.message.accountKeys;
  console.log('Accounts:');
  keys.forEach((k,i)=>console.log(i,k.toBase58()));
  console.log('Logs:');
  tx.meta.logMessages.forEach(l=>console.log(l));
  process.exit(0);
});
