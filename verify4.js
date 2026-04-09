const {Connection,PublicKey}=require('@solana/web3.js');
const c=new Connection('https://rpc.mainnet.x1.xyz','confirmed');
const PROGRAM=new PublicKey('DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM');
const listing=new PublicKey('EkJre96BsoSVhfdSvoi65ydn39Vi21bMfbF6aTTQHU7J');
const mint=new PublicKey('EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN');
const creator=new PublicKey('2nVaSvCqrsdskcbtn47uquNDL7Q69To1k45FpYBvWnuC');
const TOKEN_2022=new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const [escrow]=PublicKey.findProgramAddressSync([Buffer.from('escrow'),listing.toBuffer()],PROGRAM);
const [escrowAuth]=PublicKey.findProgramAddressSync([Buffer.from('escrow_auth'),listing.toBuffer()],PROGRAM);
const [globalState]=PublicKey.findProgramAddressSync([Buffer.from('global_state')],PROGRAM);

// creator ATA for BRAINS (Token-2022)
const {getAssociatedTokenAddressSync}=require('@solana/spl-token');
const creatorAta=getAssociatedTokenAddressSync(mint,creator,false,TOKEN_2022);

const accounts=[
  {name:'creator',pk:creator},
  {name:'global_state',pk:globalState},
  {name:'listing_state',pk:listing},
  {name:'escrow',pk:escrow},
  {name:'escrowAuth',pk:escrowAuth},
  {name:'mint',pk:mint},
  {name:'creatorAta',pk:creatorAta},
];

Promise.all(accounts.map(a=>c.getAccountInfo(a.pk).then(info=>({...a,exists:!!info,owner:info?.owner?.toBase58()}))))
.then(results=>{
  results.forEach(r=>console.log(r.exists?'✓':'✗',r.name,r.pk.toBase58(),r.owner??''));
  process.exit(0);
});
