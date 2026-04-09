const { Connection, PublicKey } = require('@solana/web3.js');
const conn = new Connection('https://rpc.mainnet.x1.xyz', 'confirmed');
const PROGRAM = new PublicKey('DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM');

conn.getProgramAccounts(PROGRAM, { filters: [{ dataSize: 127 }] }).then(accounts => {
  console.log('Listing accounts:', accounts.length);
  if (accounts.length === 0) { process.exit(0); }
  const pk = accounts[0].pubkey;
  console.log('Listing PDA:', pk.toBase58());
  const [escrow] = PublicKey.findProgramAddressSync([Buffer.from('escrow'), pk.toBuffer()], PROGRAM);
  const [escrowAuth] = PublicKey.findProgramAddressSync([Buffer.from('escrow_auth'), pk.toBuffer()], PROGRAM);
  console.log('Escrow PDA:', escrow.toBase58());
  console.log('EscrowAuth:', escrowAuth.toBase58());
  Promise.all([
    conn.getAccountInfo(pk),
    conn.getAccountInfo(escrow),
    conn.getAccountInfo(escrowAuth),
  ]).then(([l, e, ea]) => {
    console.log('listing exists:', !!l);
    console.log('escrow exists:', !!e);
    console.log('escrowAuth exists:', !!ea);
    process.exit(0);
  });
}).catch(e => { console.error(e.message); process.exit(1); });
