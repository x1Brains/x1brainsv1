import { Connection, PublicKey } from "@solana/web3.js";

const connection = new Connection("https://rpc.mainnet.x1.xyz", "confirmed");
const PROGRAM_ID = new PublicKey("3B6oAfmL7aGVAbBdu7zW3jqEVWK6o1nwFiufuSuFV6tN");
const [lbMintPda] = PublicKey.findProgramAddressSync([Buffer.from("lb_mint")], PROGRAM_ID);
const [statePda]  = PublicKey.findProgramAddressSync([Buffer.from("lb_state")], PROGRAM_ID);

(async () => {
  const mintInfo  = await connection.getAccountInfo(lbMintPda);
  const stateInfo = await connection.getAccountInfo(statePda);
  console.log("LB Mint:", lbMintPda.toBase58());
  console.log("Mint size:", mintInfo?.data.length, "bytes");
  console.log("Mint lamports:", mintInfo?.lamports);
  console.log("State size:", stateInfo?.data.length, "bytes");
})();
