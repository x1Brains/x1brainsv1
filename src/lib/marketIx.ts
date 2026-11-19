// Marketplace ix executors — wraps list_nft / buy_nft / cancel_listing.
// PDA + discriminator + program-id helpers all re-used from LBComponents,
// so this is just the small surface the v2 UI needs.

import {
  PublicKey, Transaction, SystemProgram,
  SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import { parseCoreAsset } from './coreAssets';
import {
  DISC_LIST_NFT, DISC_BUY_NFT, DISC_CANCEL,
  DISC_LIST_NFT_CORE, DISC_BUY_NFT_CORE, DISC_CANCEL_CORE,
  getSalePda, getVaultPda, getMarketplaceProgramId,
  PLATFORM_WALLET, sendTx, saveTrade,
} from '../components/LBComponents';

type SignFn = ((tx: Transaction) => Promise<Transaction>) | null | undefined;

// ─── Brains Elite fee waiver ──────────────────────────────────────────────
// The program charges 0 platform fee on a sale and 0 cancel fee on an unlist
// when the SELLER holds a Brains Elite at that moment. It cannot look inside a
// wallet, so the proof has to ride along as two extra accounts:
//   [0] a token account for some Elite mint (owner = seller, amount >= 1)
//   [1] that mint's ["mint_record", mint] PDA under the genesis program
// They go on the END of the key list as `remaining_accounts`, which is why no
// existing account position moved and the on-chain IDL did not change.
//
// ⛔ If this returns [] the fee is simply charged as before — never block a
// sale or a cancel because the proof could not be built.
const GENESIS_PROGRAM = new PublicKey('GQPGh1M6xwwWLdGCmWum2BhPi6gkJaoNFXyyuXpgN59v');

export async function eliteProofAccounts(connection: any, holder: PublicKey): Promise<
  { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]
> {
  try {
    // Every NFT-looking SPL token account the holder owns (decimals 0, amount 1).
    const res = await connection.getParsedTokenAccountsByOwner(holder, { programId: TOKEN_PROGRAM_ID });
    const candidates = (res?.value ?? []).filter((a: any) => {
      const t = a.account?.data?.parsed?.info?.tokenAmount;
      return t && t.decimals === 0 && Number(t.amount) >= 1;
    });
    if (candidates.length === 0) return [];

    // Which of them is a genuine Elite? The mint_record PDA only exists for the
    // 444, so one batched read answers it for all of them at once.
    const pairs = candidates.map((a: any) => {
      const mint = new PublicKey(a.account.data.parsed.info.mint);
      const [rec] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode('mint_record'), mint.toBuffer()], GENESIS_PROGRAM);
      return { tokenAccount: a.pubkey as PublicKey, rec };
    });
    for (let i = 0; i < pairs.length; i += 100) {
      const slice = pairs.slice(i, i + 100);
      const infos = await connection.getMultipleAccountsInfo(slice.map((x: any) => x.rec));
      for (let j = 0; j < slice.length; j++) {
        const info = infos[j];
        if (info && info.owner?.equals?.(GENESIS_PROGRAM) && (info.data?.length ?? 0) > 0) {
          return [
            { pubkey: slice[j].tokenAccount, isSigner: false, isWritable: false },
            { pubkey: slice[j].rec,          isSigner: false, isWritable: false },
          ];
        }
      }
    }
    return [];
  } catch { return []; }
}



async function confirmSig(connection: any, sig: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1500));
    const st  = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
    const conf = st?.value?.confirmationStatus;
    const err  = st?.value?.err;
    if (err) throw new Error('On-chain error: ' + JSON.stringify(err));
    if (conf === 'confirmed' || conf === 'finalized') return;
  }
  throw new Error(`Confirmation timed out: ${sig}`);
}

export type ExecResult = { sig: string };

export async function executeList(opts: {
  connection: any;
  publicKey: PublicKey;
  sendTransaction: any;
  signTransaction: SignFn;
  nftMint: string;
  priceXnt: number;
  onStatus?: (msg: string) => void;
}): Promise<ExecResult> {
  const { connection, publicKey, sendTransaction, signTransaction, nftMint, priceXnt, onStatus } = opts;
  const status = (m: string) => onStatus?.(m);

  const lamports = Math.round(priceXnt * LAMPORTS_PER_SOL);
  if (!isFinite(lamports) || lamports <= 0) throw new Error('Invalid price');

  status('Preparing transaction…');
  const mintPk    = new PublicKey(nftMint);
  const [salePda]  = getSalePda(mintPk, publicKey);
  const [vaultPda] = getVaultPda(mintPk, publicKey);
  const sellerAta  = getAssociatedTokenAddressSync(mintPk, publicKey);

  const disc      = Buffer.from(DISC_LIST_NFT, 'hex');
  const priceData = Buffer.alloc(8);
  priceData.writeBigUInt64LE(BigInt(lamports));
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const ix = {
    programId: getMarketplaceProgramId(),
    keys: [
      { pubkey: publicKey,               isSigner: true,  isWritable: true  },
      { pubkey: mintPk,                  isSigner: false, isWritable: false },
      { pubkey: sellerAta,               isSigner: false, isWritable: true  },
      { pubkey: vaultPda,                isSigner: false, isWritable: true  },
      { pubkey: salePda,                 isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc, priceData]),
  };
  const tx = new Transaction().add(ix as any);
  tx.recentBlockhash = blockhash;
  tx.feePayer = publicKey;

  status('Awaiting wallet approval…');
  const sig = await sendTx(tx, connection, sendTransaction, signTransaction);
  status(`Confirming ${sig.slice(0, 12)}…`);
  await confirmSig(connection, sig);
  saveTrade({ sig, type: 'list', nftMint, price: lamports, seller: publicKey.toBase58(), timestamp: Math.floor(Date.now() / 1000) });
  return { sig };
}

export async function executeBuy(opts: {
  connection: any;
  publicKey: PublicKey;
  sendTransaction: any;
  signTransaction: SignFn;
  nftMint: string;
  seller: string;
  priceLamports: number;
  onStatus?: (msg: string) => void;
}): Promise<ExecResult> {
  const { connection, publicKey, sendTransaction, signTransaction, nftMint, seller, priceLamports, onStatus } = opts;
  const status = (m: string) => onStatus?.(m);
  if (!PLATFORM_WALLET) throw new Error('Platform wallet not configured');

  status('Preparing transaction…');
  const mintPk    = new PublicKey(nftMint);
  const sellerPk  = new PublicKey(seller);
  const [salePda]  = getSalePda(mintPk, sellerPk);
  const [vaultPda] = getVaultPda(mintPk, sellerPk);
  const buyerAta   = getAssociatedTokenAddressSync(mintPk, publicKey);

  const preIxs: any[] = [];
  if (!(await connection.getAccountInfo(buyerAta))) {
    preIxs.push(createAssociatedTokenAccountInstruction(publicKey, buyerAta, publicKey, mintPk));
  }

  const disc = Buffer.from(DISC_BUY_NFT, 'hex');
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const ix = {
    programId: getMarketplaceProgramId(),
    keys: [
      { pubkey: publicKey,               isSigner: true,  isWritable: true  },
      { pubkey: mintPk,                  isSigner: false, isWritable: false },
      { pubkey: buyerAta,                isSigner: false, isWritable: true  },
      { pubkey: vaultPda,                isSigner: false, isWritable: true  },
      { pubkey: salePda,                 isSigner: false, isWritable: true  },
      { pubkey: sellerPk,                isSigner: false, isWritable: true  },
      { pubkey: PLATFORM_WALLET,         isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // Elite proof for the SELLER — the buyer pays nothing either way, this
      // just lets an Elite seller keep the full price.
      ...(await eliteProofAccounts(connection, sellerPk)),
    ],
    data: disc,
  };
  const tx = new Transaction().add(...preIxs, ix as any);
  tx.recentBlockhash = blockhash;
  tx.feePayer = publicKey;

  status('Awaiting wallet approval…');
  const sig = await sendTx(tx, connection, sendTransaction, signTransaction);
  status(`Confirming ${sig.slice(0, 12)}…`);
  await confirmSig(connection, sig);
  saveTrade({ sig, type: 'buy', nftMint, price: priceLamports, seller, buyer: publicKey.toBase58(), timestamp: Math.floor(Date.now() / 1000) });
  return { sig };
}

export async function executeCancel(opts: {
  connection: any;
  publicKey: PublicKey;
  sendTransaction: any;
  signTransaction: SignFn;
  nftMint: string;
  priceLamports: number;
  onStatus?: (msg: string) => void;
}): Promise<ExecResult> {
  const { connection, publicKey, sendTransaction, signTransaction, nftMint, priceLamports, onStatus } = opts;
  const status = (m: string) => onStatus?.(m);
  if (!PLATFORM_WALLET) throw new Error('Platform wallet not configured');

  status('Preparing transaction…');
  const mintPk    = new PublicKey(nftMint);
  const [salePda]  = getSalePda(mintPk, publicKey);
  const [vaultPda] = getVaultPda(mintPk, publicKey);
  const sellerAta  = getAssociatedTokenAddressSync(mintPk, publicKey);

  const disc = Buffer.from(DISC_CANCEL, 'hex');
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const ix = {
    programId: getMarketplaceProgramId(),
    keys: [
      { pubkey: publicKey,               isSigner: true,  isWritable: true  },
      { pubkey: mintPk,                  isSigner: false, isWritable: false },
      { pubkey: sellerAta,               isSigner: false, isWritable: true  },
      { pubkey: vaultPda,                isSigner: false, isWritable: true  },
      { pubkey: salePda,                 isSigner: false, isWritable: true  },
      { pubkey: PLATFORM_WALLET,         isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // Elite proof for the seller, who is the signer here.
      ...(await eliteProofAccounts(connection, publicKey)),
    ],
    data: disc,
  };
  const tx = new Transaction().add(ix as any);
  tx.recentBlockhash = blockhash;
  tx.feePayer = publicKey;

  status('Awaiting wallet approval…');
  const sig = await sendTx(tx, connection, sendTransaction, signTransaction, false);
  status(`Confirming ${sig.slice(0, 12)}…`);
  await confirmSig(connection, sig);
  saveTrade({ sig, type: 'delist', nftMint, price: priceLamports, seller: publicKey.toBase58(), timestamp: Math.floor(Date.now() / 1000) });
  return { sig };
}

// ─── Metaplex Core listings ───────────────────────────────────────────────
// x1 Inscriptions assets — inscriptions, maps, districts, parcels, editions —
// are Core, which has no token account. So there is no ATA and no vault: the
// SALE PDA ITSELF holds the asset while it is listed.
//
// Fees match the SPL path exactly (1.888% sale, 0.888% unlist, both waived for
// Brains Elite holders). On top of that the asset's own advertised creator
// royalty is paid on a sale — read off the asset by the program, which is why
// the creator account below must be the real one or the transaction fails.

const CORE_PROGRAM_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');

/** Core sale PDA — ["sale", asset, seller]. Same seeds as the SPL path, with
 *  the asset address standing in for the mint, so getSalePda is reused. */
function coreSalePda(asset: PublicKey, seller: PublicKey) {
  return getSalePda(asset, seller);
}

/** The collection and royalty creator an instruction needs, read from the asset
 *  itself rather than passed in by a caller. */
async function coreAssetAccounts(connection: any, asset: PublicKey): Promise<{
  collection: PublicKey; creator: PublicKey | null; frozen: boolean; name: string;
}> {
  const info = await connection.getAccountInfo(asset);
  if (!info?.data) throw new Error('Core asset not found on chain');
  const raw = info.data;
  const d: Uint8Array = raw instanceof Uint8Array ? raw
          : typeof raw === 'string' ? Uint8Array.from(atob(raw), c => c.charCodeAt(0))
          : Uint8Array.from(raw);
  const parsed = parseCoreAsset(asset.toBase58(), d);
  if (!parsed) throw new Error('Not a Metaplex Core asset');
  return {
    // Core validates the collection against the asset, so a wrong one simply fails
    collection: parsed.collection ? new PublicKey(parsed.collection) : CORE_PROGRAM_ID,
    creator:    parsed.royaltyCreator ? new PublicKey(parsed.royaltyCreator) : null,
    frozen:     parsed.frozen,
    name:       parsed.name,
  };
}

export async function executeListCore(opts: {
  connection: any;
  publicKey: PublicKey;
  sendTransaction: any;
  signTransaction: SignFn;
  /** the Core asset address */
  nftMint: string;
  priceXnt: number;
  onStatus?: (msg: string) => void;
}): Promise<ExecResult> {
  const { connection, publicKey, sendTransaction, signTransaction, nftMint, priceXnt, onStatus } = opts;
  const status = (m: string) => onStatus?.(m);

  const lamports = Math.round(priceXnt * LAMPORTS_PER_SOL);
  if (!isFinite(lamports) || lamports <= 0) throw new Error('Invalid price');

  status('Reading the asset…');
  const assetPk = new PublicKey(nftMint);
  const { collection, frozen } = await coreAssetAccounts(connection, assetPk);
  // ⛔ Say why up front instead of letting the wallet throw a Core error: a
  // permanently frozen asset (release master, soulbound) or an inscription that
  // has not been sealed yet simply cannot be escrowed by anyone.
  if (frozen) throw new Error('This asset is frozen and cannot be listed. Release masters and unsealed inscriptions can never be transferred.');

  const [salePda] = coreSalePda(assetPk, publicKey);
  const priceData = Buffer.alloc(8);
  priceData.writeBigUInt64LE(BigInt(lamports));
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const ix = {
    programId: getMarketplaceProgramId(),
    keys: [
      { pubkey: publicKey,               isSigner: true,  isWritable: true  },
      { pubkey: assetPk,                 isSigner: false, isWritable: true  },
      { pubkey: collection,              isSigner: false, isWritable: false },
      { pubkey: salePda,                 isSigner: false, isWritable: true  },
      { pubkey: CORE_PROGRAM_ID,         isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from(DISC_LIST_NFT_CORE, 'hex'), priceData]),
  };
  const tx = new Transaction().add(ix as any);
  tx.recentBlockhash = blockhash;
  tx.feePayer = publicKey;

  status('Awaiting wallet approval…');
  const sig = await sendTx(tx, connection, sendTransaction, signTransaction);
  status(`Confirming ${sig.slice(0, 12)}…`);
  await confirmSig(connection, sig);
  saveTrade({ sig, type: 'list', nftMint, price: lamports, seller: publicKey.toBase58(), timestamp: Math.floor(Date.now() / 1000) });
  return { sig };
}

export async function executeBuyCore(opts: {
  connection: any;
  publicKey: PublicKey;
  sendTransaction: any;
  signTransaction: SignFn;
  nftMint: string;
  seller: string;
  priceLamports: number;
  onStatus?: (msg: string) => void;
}): Promise<ExecResult> {
  const { connection, publicKey, sendTransaction, signTransaction, nftMint, seller, priceLamports, onStatus } = opts;
  const status = (m: string) => onStatus?.(m);

  status('Reading the asset…');
  const assetPk  = new PublicKey(nftMint);
  const sellerPk = new PublicKey(seller);
  const { collection, creator } = await coreAssetAccounts(connection, assetPk);
  const [salePda] = coreSalePda(assetPk, sellerPk);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const ix = {
    programId: getMarketplaceProgramId(),
    keys: [
      { pubkey: publicKey,               isSigner: true,  isWritable: true  },
      { pubkey: assetPk,                 isSigner: false, isWritable: true  },
      { pubkey: collection,              isSigner: false, isWritable: false },
      { pubkey: salePda,                 isSigner: false, isWritable: true  },
      { pubkey: sellerPk,                isSigner: false, isWritable: true  },
      // The royalty recipient. The program checks this against the creator
      // stored in the asset, so it cannot be redirected. When the asset
      // advertises no royalty, the seller stands in and receives 0.
      { pubkey: creator ?? sellerPk,     isSigner: false, isWritable: true  },
      { pubkey: PLATFORM_WALLET,         isSigner: false, isWritable: true  },
      { pubkey: CORE_PROGRAM_ID,         isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // Elite proof for the SELLER — the waiver follows whoever is selling.
      ...(await eliteProofAccounts(connection, sellerPk)),
    ],
    data: Buffer.from(DISC_BUY_NFT_CORE, 'hex'),
  };
  const tx = new Transaction().add(ix as any);
  tx.recentBlockhash = blockhash;
  tx.feePayer = publicKey;

  status('Awaiting wallet approval…');
  const sig = await sendTx(tx, connection, sendTransaction, signTransaction);
  status(`Confirming ${sig.slice(0, 12)}…`);
  await confirmSig(connection, sig);
  saveTrade({ sig, type: 'buy', nftMint, price: priceLamports, seller, buyer: publicKey.toBase58(), timestamp: Math.floor(Date.now() / 1000) });
  return { sig };
}

export async function executeCancelCore(opts: {
  connection: any;
  publicKey: PublicKey;
  sendTransaction: any;
  signTransaction: SignFn;
  nftMint: string;
  priceLamports: number;
  onStatus?: (msg: string) => void;
}): Promise<ExecResult> {
  const { connection, publicKey, sendTransaction, signTransaction, nftMint, priceLamports, onStatus } = opts;
  const status = (m: string) => onStatus?.(m);

  status('Reading the asset…');
  const assetPk = new PublicKey(nftMint);
  const { collection } = await coreAssetAccounts(connection, assetPk);
  const [salePda] = coreSalePda(assetPk, publicKey);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const ix = {
    programId: getMarketplaceProgramId(),
    keys: [
      { pubkey: publicKey,               isSigner: true,  isWritable: true  },
      { pubkey: assetPk,                 isSigner: false, isWritable: true  },
      { pubkey: collection,              isSigner: false, isWritable: false },
      { pubkey: salePda,                 isSigner: false, isWritable: true  },
      { pubkey: PLATFORM_WALLET,         isSigner: false, isWritable: true  },
      { pubkey: CORE_PROGRAM_ID,         isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...(await eliteProofAccounts(connection, publicKey)),
    ],
    data: Buffer.from(DISC_CANCEL_CORE, 'hex'),
  };
  const tx = new Transaction().add(ix as any);
  tx.recentBlockhash = blockhash;
  tx.feePayer = publicKey;

  status('Awaiting wallet approval…');
  const sig = await sendTx(tx, connection, sendTransaction, signTransaction, false);
  status(`Confirming ${sig.slice(0, 12)}…`);
  await confirmSig(connection, sig);
  saveTrade({ sig, type: 'delist', nftMint, price: priceLamports, seller: publicKey.toBase58(), timestamp: Math.floor(Date.now() / 1000) });
  return { sig };
}
