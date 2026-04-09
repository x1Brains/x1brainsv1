const { Connection, PublicKey } = require('@solana/web3.js');
const conn = new Connection('https://rpc.mainnet.x1.xyz', 'confirmed');
const PROGRAM = new PublicKey('DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM');

conn.getProgramAccounts(PROGRAM, { filters: [{ dataSize: 127 }] }).then(accounts => {
  accounts.forEach(({ pubkey, account }) => {
    const data = account.data;
    // Skip 8 byte discriminator, then 32 bytes = creator pubkey
    const creator = new PublicKey(data.slice(8, 40));
    // Next 32 bytes = token_a_mint
    const mint = new PublicKey(data.slice(40, 72));
    console.log('Listing PDA:', pubkey.toBase58());
    console.log('Creator:', creator.toBase58());
    console.log('Mint:', mint.toBase58());
    // Verify derivation
    const [derived] = PublicKey.findProgramAddressSync(
      [Buffer.from('listing'), creator.toBuffer(), mint.toBuffer()], PROGRAM
    );
    console.log('Derived matches:', derived.toBase58() === pubkey.toBase58());
  });
  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
