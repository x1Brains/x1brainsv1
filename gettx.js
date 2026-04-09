const {Connection,PublicKey}=require('@solana/web3.js');
const c=new Connection('https://rpc.mainnet.x1.xyz','confirmed');
const wallet=new PublicKey('2nVaSvCqrsdskcbtn47uquNDL7Q69To1k45FpYBvWnuC');
c.getSignaturesForAddress(wallet,{limit:5}).then(sigs=>{
  sigs.forEach(s=>console.log(s.signature, s.err?'FAILED':'ok', JSON.stringify(s.err)));
  process.exit(0);
});
