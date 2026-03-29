// scripts/initialize-lb-mint.ts
// ─────────────────────────────────────────────────────────────────────────────
// Call once after deploying lb_mint to testnet or mainnet.
// Creates GlobalState PDA + LB Token-2022 mint with all extensions.
//
// Usage:
//   npx ts-node scripts/initialize-lb-mint.ts --cluster testnet
//   npx ts-node scripts/initialize-lb-mint.ts --cluster mainnet
// ─────────────────────────────────────────────────────────────────────────────

import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, clusterApiUrl
} from "@solana/web3.js";
import fs from "fs";
import path from "path";

// ─── Config ──────────────────────────────────────────────────────────────────

const CLUSTER = process.argv.includes("--cluster")
  ? process.argv[process.argv.indexOf("--cluster") + 1]
  : "testnet";

const RPC_ENDPOINTS: Record<string, string> = {
  testnet: "https://rpc.testnet.x1.xyz",
  mainnet: "https://rpc.mainnet.x1.xyz",
};

// Fill in after anchor build
const PROGRAM_ID = "3B6oAfmL7aGVAbBdu7zW3jqEVWK6o1nwFiufuSuFV6tN";

// Seeds — must match lib.rs
const STATE_SEED     = Buffer.from("lb_state");
const MINT_AUTH_SEED = Buffer.from("lb_mint_auth");
const LB_MINT_SEED   = Buffer.from("lb_mint");

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rpc = RPC_ENDPOINTS[CLUSTER];
  if (!rpc) throw new Error(`Unknown cluster: ${CLUSTER}`);

  console.log(`\n══ LB MINT INITIALIZE ══`);
  console.log(`Cluster:    ${CLUSTER}`);
  console.log(`RPC:        ${rpc}`);
  console.log(`Program ID: ${PROGRAM_ID}\n`);

  // Load wallet
  const keypairPath = path.resolve(process.env.HOME!, ".config/solana/id.json");
  const secretKey   = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")));
  const adminKeypair = Keypair.fromSecretKey(secretKey);
  console.log(`Admin wallet: ${adminKeypair.publicKey.toBase58()}`);

  const connection = new Connection(rpc, "confirmed");
  const balance    = await connection.getBalance(adminKeypair.publicKey);
  console.log(`Balance: ${balance / 1e9} XNT`);

  if (balance < 0.1 * 1e9) {
    console.error("⚠️  Low balance! Need at least 0.1 XNT for deploy fees.");
    if (CLUSTER === "testnet") {
      console.log("Faucet: https://docs.x1.xyz/validating/testnet-faucet");
    }
    process.exit(1);
  }

  const programId = new PublicKey(PROGRAM_ID);

  // Derive PDAs
  const [statePda]      = PublicKey.findProgramAddressSync([STATE_SEED],     programId);
  const [mintAuthPda]   = PublicKey.findProgramAddressSync([MINT_AUTH_SEED], programId);
  const [lbMintPda]     = PublicKey.findProgramAddressSync([LB_MINT_SEED],   programId);

  console.log(`\nDerived PDAs:`);
  console.log(`  GlobalState:      ${statePda.toBase58()}`);
  console.log(`  MintAuthority:    ${mintAuthPda.toBase58()}`);
  console.log(`  LB Mint:          ${lbMintPda.toBase58()}`);

  // Check if already initialized
  const stateInfo = await connection.getAccountInfo(statePda);
  if (stateInfo) {
    console.log("\n⚠️  GlobalState already exists — program already initialized.");
    console.log("   If you need to re-initialize, deploy a fresh program.");
    process.exit(0);
  }

  // Load IDL
  const idlPath = path.resolve("target/idl/lb_mint.json");
  if (!fs.existsSync(idlPath)) {
    throw new Error(`IDL not found at ${idlPath}. Run 'anchor build' first.`);
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  // Create provider + program
  const wallet   = new Wallet(adminKeypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new Program(idl, provider);

  console.log("\n▶ Calling initialize...");

  const tx = await (program.methods as any)
    .initialize()
    .accounts({
      admin:           adminKeypair.publicKey,
      state:           statePda,
      lbMint:          lbMintPda,
      lbMintAuthority: mintAuthPda,
      token2022Program: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
      systemProgram:   anchor.web3.SystemProgram.programId,
    })
    .signers([adminKeypair])
    .rpc({ commitment: "confirmed" });

  console.log(`\n✅ Initialized!`);
  console.log(`   Tx: ${tx}`);
  console.log(`   LB Mint: ${lbMintPda.toBase58()}`);
  console.log(`   GlobalState: ${statePda.toBase58()}`);
  console.log(`\n   Explorer: https://explorer.${CLUSTER}.x1.xyz/tx/${tx}`);
  console.log(`\n📝 Save these addresses — you'll need them for the frontend:`);
  console.log(`   LB_MINT_PROGRAM_ID = "${PROGRAM_ID}"`);
  console.log(`   LB_MINT_ADDRESS    = "${lbMintPda.toBase58()}"`);
}

main().catch(e => {
  console.error("\n❌ Error:", e.message);
  process.exit(1);
});
