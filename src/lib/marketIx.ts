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
import {
  DISC_LIST_NFT, DISC_BUY_NFT, DISC_CANCEL,
  getSalePda, getVaultPda, getMarketplaceProgramId,
  PLATFORM_WALLET, sendTx, saveTrade,
} from '../components/LBComponents';

type SignFn = ((tx: Transaction) => Promise<Transaction>) | null | undefined;

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
