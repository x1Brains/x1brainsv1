// Run: npx ts-node scripts/check_program.ts
// Checks what instructions are in the currently deployed program

import { Connection, PublicKey } from "@solana/web3.js";

const connection = new Connection("https://rpc.mainnet.x1.xyz", "confirmed");
const PROGRAM_ID = new PublicKey("3B6oAfmL7aGVAbBdu7zW3jqEVWK6o1nwFiufuSuFV6tN");
const [statePda]   = PublicKey.findProgramAddressSync([Buffer.from("lb_state")], PROGRAM_ID);
const [lbMintPda]  = PublicKey.findProgramAddressSync([Buffer.from("lb_mint")],  PROGRAM_ID);

(async () => {
  const progInfo  = await connection.getAccountInfo(PROGRAM_ID);
  const mintInfo  = await connection.getAccountInfo(lbMintPda);
  const stateInfo = await connection.getAccountInfo(statePda);

  console.log("Program last deployed slot:", progInfo ? "exists" : "NOT FOUND");
  console.log("Mint size:", mintInfo?.data.length, "bytes");
  console.log("State size:", stateInfo?.data.length, "bytes");

  // Try to simulate initialize_metadata to see if it exists in the program
  const crypto = await import("crypto");
  const disc = (name: string) => Buffer.from(
    crypto.createHash("sha256").update(`global:${name}`).digest()
  ).slice(0, 8);

  console.log("\nDiscriminators:");
  console.log("  initialize_metadata:", disc("initialize_metadata").toString("hex"));
  console.log("  update_metadata_uri:", disc("update_metadata_uri").toString("hex"));
})();
