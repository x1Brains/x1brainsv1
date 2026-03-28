import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LabworkMarketplace } from "../target/types/labwork_marketplace";
import {
  createMint, createAccount, mintTo, getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

const PLATFORM_WALLET = new anchor.web3.PublicKey(
  "CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF"
);

describe("labwork_marketplace", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LabworkMarketplace as Program<LabworkMarketplace>;

  let seller: anchor.web3.Keypair;
  let buyer:  anchor.web3.Keypair;
  let nftMint: anchor.web3.PublicKey;
  let sellerTokenAccount: anchor.web3.PublicKey;
  let buyerTokenAccount:  anchor.web3.PublicKey;
  // v2 PDA names — seeds are ["sale", mint, seller] and ["vault", mint, seller]
  let salePda:  anchor.web3.PublicKey;
  let vaultPda: anchor.web3.PublicKey;

  const PRICE = new anchor.BN(5_000_000_000); // 5 XNT

  before(async () => {
    seller = anchor.web3.Keypair.generate();
    buyer  = anchor.web3.Keypair.generate();

    // Airdrop to seller and buyer
    await Promise.all([
      provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(seller.publicKey, 10_000_000_000)
      ),
      provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(buyer.publicKey, 10_000_000_000)
      ),
      provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(PLATFORM_WALLET, 1_000_000_000)
      ),
    ]);

    // Create NFT mint (decimals=0)
    nftMint = await createMint(
      provider.connection, seller, seller.publicKey, null, 0
    );

    // Create token accounts
    sellerTokenAccount = await createAccount(
      provider.connection, seller, nftMint, seller.publicKey
    );
    buyerTokenAccount = await createAccount(
      provider.connection, buyer, nftMint, buyer.publicKey
    );

    // Mint 1 NFT to seller
    await mintTo(
      provider.connection, seller, nftMint, sellerTokenAccount, seller, 1
    );

    // Derive PDAs — seeds MUST match lib.rs:
    //   SaleAccount : ["sale",  nft_mint, seller]
    //   vault token : ["vault", nft_mint, seller]
    [salePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("sale"), nftMint.toBuffer(), seller.publicKey.toBuffer()],
      program.programId
    );
    [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), nftMint.toBuffer(), seller.publicKey.toBuffer()],
      program.programId
    );
  });

  it("Lists an NFT for 5 XNT", async () => {
    await program.methods
      .listNft(PRICE)
      .accounts({
        seller:             seller.publicKey,
        nftMint,
        sellerNftAccount:   sellerTokenAccount,
        vaultNftAccount:    vaultPda,
        sale:               salePda,
        tokenProgram:       TOKEN_PROGRAM_ID,
        systemProgram:      anchor.web3.SystemProgram.programId,
        rent:               anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([seller])
      .rpc();

    // Fetch the SaleAccount (not listingAccount)
    const sale = await program.account.saleAccount.fetch(salePda);
    assert.equal(sale.seller.toBase58(), seller.publicKey.toBase58());
    assert.equal(sale.price.toNumber(), PRICE.toNumber());

    // NFT should now be in vault
    const vaultBalance = await getAccount(provider.connection, vaultPda);
    assert.equal(Number(vaultBalance.amount), 1);

    // Seller's token account should be empty
    const sellerBalance = await getAccount(provider.connection, sellerTokenAccount);
    assert.equal(Number(sellerBalance.amount), 0);

    console.log("✅ NFT listed. Vault holds NFT.");
  });

  it("Buys the NFT — platform gets 1.888% fee", async () => {
    const platformBefore = await provider.connection.getBalance(PLATFORM_WALLET);
    const sellerBefore   = await provider.connection.getBalance(seller.publicKey);

    await program.methods
      .buyNft()
      .accounts({
        buyer:            buyer.publicKey,
        nftMint,
        buyerNftAccount:  buyerTokenAccount,
        vaultNftAccount:  vaultPda,
        sale:             salePda,
        sellerWallet:     seller.publicKey,
        platformWallet:   PLATFORM_WALLET,
        tokenProgram:     TOKEN_PROGRAM_ID,
        systemProgram:    anchor.web3.SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    const platformAfter = await provider.connection.getBalance(PLATFORM_WALLET);
    const sellerAfter   = await provider.connection.getBalance(seller.publicKey);

    // Platform fee: 1.888% of 5 XNT = 5_000_000_000 * 1888 / 100_000 = 94_400_000
    const expectedFee      = Math.floor(5_000_000_000 * 1888 / 100_000);
    const expectedProceeds = 5_000_000_000 - expectedFee;

    console.log(`Platform fee received: ${platformAfter - platformBefore} lamports (expected: ${expectedFee})`);
    console.log(`Seller proceeds: ~${sellerAfter - sellerBefore} lamports (expected ~${expectedProceeds})`);

    assert.equal(platformAfter - platformBefore, expectedFee);

    // Buyer should have the NFT
    const buyerBalance = await getAccount(provider.connection, buyerTokenAccount);
    assert.equal(Number(buyerBalance.amount), 1);

    console.log("✅ NFT bought. Fees distributed correctly.");
  });

  it("Lists again and cancels — platform gets 0.888% cancel fee", async () => {
    // Create a fresh NFT for this test
    const nftMint2 = await createMint(
      provider.connection, seller, seller.publicKey, null, 0
    );
    const sellerAta2 = await createAccount(
      provider.connection, seller, nftMint2, seller.publicKey
    );
    await mintTo(provider.connection, seller, nftMint2, sellerAta2, seller, 1);

    // Derive v2 PDAs for the new mint
    const [sale2] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("sale"), nftMint2.toBuffer(), seller.publicKey.toBuffer()],
      program.programId
    );
    const [vault2] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), nftMint2.toBuffer(), seller.publicKey.toBuffer()],
      program.programId
    );

    // List at 10 XNT
    const PRICE2 = new anchor.BN(10_000_000_000);
    await program.methods
      .listNft(PRICE2)
      .accounts({
        seller:           seller.publicKey,
        nftMint:          nftMint2,
        sellerNftAccount: sellerAta2,
        vaultNftAccount:  vault2,
        sale:             sale2,
        tokenProgram:     TOKEN_PROGRAM_ID,
        systemProgram:    anchor.web3.SystemProgram.programId,
        rent:             anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([seller])
      .rpc();

    const platformBefore = await provider.connection.getBalance(PLATFORM_WALLET);

    // Cancel listing — method is cancelListing (not delistNft)
    await program.methods
      .cancelListing()
      .accounts({
        seller:           seller.publicKey,
        nftMint:          nftMint2,
        sellerNftAccount: sellerAta2,
        vaultNftAccount:  vault2,
        sale:             sale2,
        platformWallet:   PLATFORM_WALLET,
        tokenProgram:     TOKEN_PROGRAM_ID,
        systemProgram:    anchor.web3.SystemProgram.programId,
      })
      .signers([seller])
      .rpc();

    const platformAfter = await provider.connection.getBalance(PLATFORM_WALLET);

    // Cancel fee: 0.888% of 10 XNT = 10_000_000_000 * 888 / 100_000 = 88_800_000
    const expectedCancelFee = Math.floor(10_000_000_000 * 888 / 100_000);
    console.log(`Cancel fee received: ${platformAfter - platformBefore} (expected: ${expectedCancelFee})`);
    assert.equal(platformAfter - platformBefore, expectedCancelFee);

    // Seller should have NFT back
    const sellerBalance = await getAccount(provider.connection, sellerAta2);
    assert.equal(Number(sellerBalance.amount), 1);

    console.log("✅ Listing cancelled. Cancel fee charged correctly. NFT returned.");
  });
});