// Farm ix executors — wraps stake / fund_farm against brains_farm program.
// Constants + PDA helpers are re-exported from pages/LpFarms.tsx (the canonical
// v1 source of truth) so we never drift.

import {
  PublicKey, Transaction, TransactionInstruction, SystemProgram,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import {
  FARM_PROGRAM_ID, TREASURY, LOCK_TIERS,
  disc, deriveFarmGlobal, derivePosition, getTokenProgram, pow10,
  type LockId, type FarmOnChain, type PositionOnChain,
} from '../pages/LpFarms';
import { LB_MINT } from '../constants';

type SignFn = (tx: Transaction) => Promise<Transaction>;

async function confirmSig(connection: any, sig: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const st = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
    if (st?.value?.err) throw new Error('Tx failed: ' + JSON.stringify(st.value.err));
    const conf = st?.value?.confirmationStatus;
    if (conf === 'confirmed' || conf === 'finalized') return;
  }
  throw new Error('Confirmation timeout');
}

export type ExecResult = { sig: string };

export async function executeStake(opts: {
  connection: any;
  publicKey: PublicKey;
  signTransaction: SignFn;
  farm: FarmOnChain;
  amountUi: number;
  lockId: LockId;
  onStatus?: (msg: string) => void;
}): Promise<ExecResult> {
  const { connection, publicKey, signTransaction, farm, amountUi, lockId, onStatus } = opts;
  const status = (m: string) => onStatus?.(m);

  if (!(amountUi > 0)) throw new Error('Invalid stake amount');
  const tier = LOCK_TIERS.find(t => t.id === lockId);
  if (!tier) throw new Error('Invalid lock tier');

  status('Building transaction…');
  const programPk  = new PublicKey(FARM_PROGRAM_ID);
  const lpMintPk   = new PublicKey(farm.lpMint);
  const farmPk     = new PublicKey(farm.pubkey);
  const [globalPk] = deriveFarmGlobal();

  const lpTokenProg = await getTokenProgram(lpMintPk, connection);
  const lpAta       = getAssociatedTokenAddressSync(lpMintPk, publicKey, false, lpTokenProg);

  // Find first unused position nonce.
  let nonce = 0;
  for (let i = 0; i < 100; i++) {
    const [p] = derivePosition(publicKey, farmPk, i);
    const info = await connection.getAccountInfo(p);
    if (!info) { nonce = i; break; }
  }
  const [positionPk] = derivePosition(publicKey, farmPk, nonce);

  const lockTypeByte = lockId === 'locked30' ? 0 : lockId === 'locked90' ? 1 : 2;
  const rawAmt       = BigInt(Math.floor(amountUi * pow10(farm.lpDecimals)));

  const d = await disc('stake');
  const params = Buffer.alloc(8 + 1 + 4);
  params.writeBigUInt64LE(rawAmt, 0);
  params.writeUInt8(lockTypeByte, 8);
  params.writeUInt32LE(nonce, 9);
  const data = Buffer.concat([d, params]);

  const keys = [
    { pubkey: publicKey,                          isSigner: true,  isWritable: true  },
    { pubkey: globalPk,                           isSigner: false, isWritable: true  },
    { pubkey: farmPk,                             isSigner: false, isWritable: true  },
    { pubkey: lpMintPk,                           isSigner: false, isWritable: false },
    { pubkey: lpAta,                              isSigner: false, isWritable: true  },
    { pubkey: new PublicKey(farm.lpVault),        isSigner: false, isWritable: true  },
    { pubkey: new PublicKey(farm.rewardVault),    isSigner: false, isWritable: false },
    { pubkey: positionPk,                         isSigner: false, isWritable: true  },
    { pubkey: new PublicKey(TREASURY),            isSigner: false, isWritable: true  },
    { pubkey: lpTokenProg,                        isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId,            isSigner: false, isWritable: false },
    { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
  ];

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });
  tx.add(new TransactionInstruction({ programId: programPk, keys, data }));

  status('Waiting for wallet approval…');
  const signed = await signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  status(`Confirming ${sig.slice(0, 12)}…`);
  await confirmSig(connection, sig);
  return { sig };
}

export async function executeDonate(opts: {
  connection: any;
  publicKey: PublicKey;
  signTransaction: SignFn;
  farm: FarmOnChain;
  amountUi: number;
  onStatus?: (msg: string) => void;
}): Promise<ExecResult> {
  const { connection, publicKey, signTransaction, farm, amountUi, onStatus } = opts;
  const status = (m: string) => onStatus?.(m);

  if (!(amountUi > 0)) throw new Error('Invalid donation amount');

  status('Building transaction…');
  const programPk = new PublicKey(FARM_PROGRAM_ID);
  const farmPk    = new PublicKey(farm.pubkey);
  const rewardPk  = new PublicKey(farm.rewardMint);
  const prog      = await getTokenProgram(rewardPk, connection);
  const funderAta = getAssociatedTokenAddressSync(rewardPk, publicKey, false, prog);

  const rawAmt = BigInt(Math.floor(amountUi * pow10(farm.rewardDecimals)));
  const d = await disc('fund_farm');
  const params = Buffer.alloc(8);
  params.writeBigUInt64LE(rawAmt, 0);
  const data = Buffer.concat([d, params]);

  const keys = [
    { pubkey: publicKey,                       isSigner: true,  isWritable: true  },
    { pubkey: farmPk,                          isSigner: false, isWritable: true  },
    { pubkey: rewardPk,                        isSigner: false, isWritable: false },
    { pubkey: funderAta,                       isSigner: false, isWritable: true  },
    { pubkey: new PublicKey(farm.rewardVault), isSigner: false, isWritable: true  },
    { pubkey: prog,                            isSigner: false, isWritable: false },
  ];

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });
  tx.add(new TransactionInstruction({ programId: programPk, keys, data }));

  status('Waiting for wallet approval…');
  const signed = await signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  status(`Confirming ${sig.slice(0, 12)}…`);
  await confirmSig(connection, sig);
  return { sig };
}


// Unstake / early-exit. On-chain program reads the optional LB ATA to decide
// the early-exit penalty tier (0% if matured, otherwise a sliding scale with
// LB-holder discount). Pass the program ID itself as the `lbAccount` sentinel
// when the citizen has no LB ATA — the program treats that as "no LB".
export async function executeUnstake(opts: {
  connection: any;
  publicKey: PublicKey;
  signTransaction: SignFn;
  farm: FarmOnChain;
  position: PositionOnChain;
  onStatus?: (msg: string) => void;
}): Promise<ExecResult> {
  const { connection, publicKey, signTransaction, farm, position, onStatus } = opts;
  const status = (m: string) => onStatus?.(m);

  status('Building transaction…');
  const programPk   = new PublicKey(FARM_PROGRAM_ID);
  const farmPk      = new PublicKey(farm.pubkey);
  const lpMintPk    = new PublicKey(farm.lpMint);
  const rewardPk    = new PublicKey(farm.rewardMint);
  const treasuryPk  = new PublicKey(TREASURY);
  const [globalPk]  = deriveFarmGlobal();
  const [positionPk] = derivePosition(publicKey, farmPk, position.nonce);

  const lpProg     = await getTokenProgram(lpMintPk, connection);
  const rewardProg = await getTokenProgram(rewardPk, connection);

  const lpAta      = getAssociatedTokenAddressSync(lpMintPk, publicKey, false, lpProg);
  const rewardAta  = getAssociatedTokenAddressSync(rewardPk, publicKey, false, rewardProg);
  const treasLpAta = getAssociatedTokenAddressSync(lpMintPk, treasuryPk, true, lpProg);
  const lbAta      = getAssociatedTokenAddressSync(new PublicKey(LB_MINT), publicKey, false, TOKEN_2022_PROGRAM_ID);
  const lbAtaInfo  = await connection.getAccountInfo(lbAta);
  const lbAccount  = lbAtaInfo ? lbAta : programPk; // sentinel for "no LB"

  const d = await disc('unstake');
  const params = Buffer.alloc(4);
  params.writeUInt32LE(position.nonce, 0);
  const data = Buffer.concat([d, params]);

  const keys = [
    { pubkey: publicKey,                       isSigner: true,  isWritable: true  },
    { pubkey: globalPk,                        isSigner: false, isWritable: true  },
    { pubkey: farmPk,                          isSigner: false, isWritable: true  },
    { pubkey: positionPk,                      isSigner: false, isWritable: true  },
    { pubkey: lpMintPk,                        isSigner: false, isWritable: false },
    { pubkey: rewardPk,                        isSigner: false, isWritable: false },
    { pubkey: lpAta,                           isSigner: false, isWritable: true  },
    { pubkey: rewardAta,                       isSigner: false, isWritable: true  },
    { pubkey: new PublicKey(farm.lpVault),     isSigner: false, isWritable: true  },
    { pubkey: new PublicKey(farm.rewardVault), isSigner: false, isWritable: true  },
    { pubkey: treasLpAta,                      isSigner: false, isWritable: true  },
    { pubkey: treasuryPk,                      isSigner: false, isWritable: false },
    { pubkey: lbAccount,                       isSigner: false, isWritable: false },
    { pubkey: lpProg,                          isSigner: false, isWritable: false },
    { pubkey: rewardProg,                      isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId,         isSigner: false, isWritable: false },
  ];

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });

  // Idempotently create the destination ATAs that the program will write to.
  const ensureAta = async (ata: PublicKey, owner: PublicKey, mint: PublicKey, prog: PublicKey) => {
    const info = await connection.getAccountInfo(ata);
    if (!info) {
      tx.add(createAssociatedTokenAccountIdempotentInstruction(publicKey, ata, owner, mint, prog));
    }
  };
  await ensureAta(lpAta,      publicKey,  lpMintPk, lpProg);
  await ensureAta(rewardAta,  publicKey,  rewardPk, rewardProg);
  await ensureAta(treasLpAta, treasuryPk, lpMintPk, lpProg);

  tx.add(new TransactionInstruction({ programId: programPk, keys, data }));

  status('Waiting for wallet…');
  const signed = await signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  status(`Confirming ${sig.slice(0, 12)}…`);
  await confirmSig(connection, sig);
  return { sig };
}


export async function executeClaim(opts: {
  connection: any;
  publicKey: PublicKey;
  signTransaction: SignFn;
  farm: FarmOnChain;
  position: PositionOnChain;
  onStatus?: (msg: string) => void;
}): Promise<ExecResult> {
  const { connection, publicKey, signTransaction, farm, position, onStatus } = opts;
  const status = (m: string) => onStatus?.(m);

  status('Building transaction…');
  const programPk  = new PublicKey(FARM_PROGRAM_ID);
  const farmPk     = new PublicKey(farm.pubkey);
  const rewardPk   = new PublicKey(farm.rewardMint);
  const [globalPk] = deriveFarmGlobal();
  const [positionPk] = derivePosition(publicKey, farmPk, position.nonce);

  const rewardProg = await getTokenProgram(rewardPk, connection);
  const rewardAta  = getAssociatedTokenAddressSync(rewardPk, publicKey, false, rewardProg);

  const d = await disc('claim');
  const params = Buffer.alloc(4);
  params.writeUInt32LE(position.nonce, 0);
  const data = Buffer.concat([d, params]);

  const keys = [
    { pubkey: publicKey, isSigner: true,  isWritable: true  },
    { pubkey: globalPk,  isSigner: false, isWritable: true  },
    { pubkey: farmPk,    isSigner: false, isWritable: true  },
    { pubkey: positionPk, isSigner: false, isWritable: true  },
    { pubkey: rewardPk,  isSigner: false, isWritable: false },
    { pubkey: rewardAta, isSigner: false, isWritable: true  },
    { pubkey: new PublicKey(farm.rewardVault), isSigner: false, isWritable: true  },
    { pubkey: rewardProg, isSigner: false, isWritable: false },
  ];

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });
  const ataInfo = await connection.getAccountInfo(rewardAta);
  if (!ataInfo) {
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      publicKey, rewardAta, publicKey, rewardPk, rewardProg,
    ));
  }
  tx.add(new TransactionInstruction({ programId: programPk, keys, data }));

  status('Waiting for wallet…');
  const signed = await signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  status(`Confirming ${sig.slice(0, 12)}…`);
  await confirmSig(connection, sig);
  return { sig };
}

