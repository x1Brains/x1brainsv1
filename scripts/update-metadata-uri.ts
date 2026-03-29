// scripts/update-metadata-uri.ts
// Metadata already initialized — just update the URI

import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, SystemProgram,
} from "@solana/web3.js";
import * as crypto from "crypto";
import fs from "fs";
import path from "path";

const CLUSTER = process.argv.includes("--cluster")
  ? process.argv[process.argv.indexOf("--cluster") + 1]
  : "mainnet";

const RPC: Record<string, string> = {
  testnet: "https://rpc.testnet.x1.xyz",
  mainnet: "https://rpc.mainnet.x1.xyz",
};

const PROGRAM_ID   = "3B6oAfmL7aGVAbBdu7zW3jqEVWK6o1nwFiufuSuFV6tN";
const METADATA_URI = "https://arweave.net/UOmOXr_4gkpPUSOA2W530El_GH-aCapEIiVhWf01t00";
const TOKEN_2022   = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

function disc(name: string): Buffer {
  return Buffer.from(
    crypto.createHash("sha256").update(`global:${name}`).digest()
  ).slice(0, 8);
}

function encodeString(s: string): Buffer {
  const b = Buffer.from(s, "utf-8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
}

async function sendAndConfirm(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  label: string,
): Promise<string> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false, preflightCommitment: "confirmed",
  });
  for (let i = 0; i < 40; i++) {
    if (i) await new Promise(r => setTimeout(r, 1500));
    const s = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
    if (s?.value?.err) throw new Error("On-chain error: " + JSON.stringify(s.value.err));
    const c = s?.value?.confirmationStatus;
    if (c === "confirmed" || c === "finalized") break;
  }
  console.log(`  ✅ ${label}: ${sig}`);
  console.log(`     https://explorer.mainnet.x1.xyz/tx/${sig}`);
  return sig;
}

async function main() {
  const rpc = RPC[CLUSTER];
  console.log(`\n══ UPDATE METADATA URI ══`);
  console.log(`URI: ${METADATA_URI}\n`);

  const keypairPath  = path.resolve(process.env.HOME!, ".config/solana/id.json");
  const secretKey    = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")));
  const adminKeypair = Keypair.fromSecretKey(secretKey);

  const connection = new Connection(rpc, "confirmed");
  const balance    = await connection.getBalance(adminKeypair.publicKey);
  console.log(`Admin:   ${adminKeypair.publicKey.toBase58()}`);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} XNT\n`);

  const programId    = new PublicKey(PROGRAM_ID);
  const [statePda]   = PublicKey.findProgramAddressSync([Buffer.from("lb_state")],    programId);
  const [lbMintPda]  = PublicKey.findProgramAddressSync([Buffer.from("lb_mint")],      programId);
  const [mintAuthPda]= PublicKey.findProgramAddressSync([Buffer.from("lb_mint_auth")], programId);

  console.log(`State:    ${statePda.toBase58()}`);
  console.log(`Mint:     ${lbMintPda.toBase58()}`);
  console.log(`MintAuth: ${mintAuthPda.toBase58()}\n`);

  // update_metadata_uri — AdminOnly context: admin, state, lb_mint, lb_mint_authority, system_program
  console.log("▶ Calling update_metadata_uri...");
  const updateData = Buffer.concat([
    disc("update_metadata_uri"),
    encodeString(METADATA_URI),
  ]);

  const updateTx = new Transaction();
  updateTx.add(new TransactionInstruction({
    programId,
    keys: [
      { pubkey: adminKeypair.publicKey, isSigner: true,  isWritable: true  }, // admin
      { pubkey: statePda,               isSigner: false, isWritable: true  }, // state
      { pubkey: lbMintPda,              isSigner: false, isWritable: true  }, // lb_mint
      { pubkey: mintAuthPda,            isSigner: false, isWritable: false }, // lb_mint_authority
      { pubkey: SystemProgram.programId,isSigner: false, isWritable: false }, // system_program
      { pubkey: TOKEN_2022,             isSigner: false, isWritable: false }, // token_2022 remaining
    ],
    data: updateData,
  }));

  await sendAndConfirm(connection, updateTx, [adminKeypair], "update_metadata_uri");

  console.log(`\n🎉 LB token metadata URI set!`);
  console.log(`   URI: ${METADATA_URI}`);
}

main().catch(e => {
  console.error("\n❌ Error:", e.message);
  if (e?.logs) console.error("Logs:", e.logs);
  process.exit(1);
});
