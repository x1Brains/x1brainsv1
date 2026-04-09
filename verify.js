const { PublicKey } = require('@solana/web3.js');
const PROGRAM  = new PublicKey('DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM');
const creator  = new PublicKey('CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2');
const mint     = new PublicKey('EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN');

const [listing] = PublicKey.findProgramAddressSync(
  [Buffer.from('listing'), creator.toBuffer(), mint.toBuffer()], PROGRAM
);
const [escrow] = PublicKey.findProgramAddressSync(
  [Buffer.from('escrow'), listing.toBuffer()], PROGRAM
);
const [escrowAuth] = PublicKey.findProgramAddressSync(
  [Buffer.from('escrow_auth'), listing.toBuffer()], PROGRAM
);

console.log('Derived listing:', listing.toBase58());
console.log('On-chain listing:', 'EkJre96BsoSVhfdSvoi65ydn39Vi21bMfbF6aTTQHU7J');
console.log('PDAs match:', listing.toBase58() === 'EkJre96BsoSVhfdSvoi65ydn39Vi21bMfbF6aTTQHU7J');
console.log('Escrow:', escrow.toBase58());
console.log('EscrowAuth:', escrowAuth.toBase58());
