/**
 * End-to-end probe for the confidential transfer path, against X1 mainnet.
 *
 * ⛔ WHY THIS EXISTS
 * Every one of these instruction layouts, account orderings and proof
 * discriminators fails the same way when wrong: `SigmaProof(_,
 * AlgebraicRelation)` or a bare `InvalidAccountData`, with nothing naming the
 * field at fault. Local `proof.verify()` passes regardless — it checks our own
 * maths against itself, not against the program. The only real test is a
 * transaction that lands.
 *
 * It imports src/lib/confidential.ts DIRECTLY. Reimplementing the flow here
 * would prove something about the copy and nothing about what ships.
 *
 * Operator-only: reads keypairs from disk and spends real XNT. Never bundled.
 *
 *   npx esbuild scripts/confidential-transfer-probe.ts --bundle --platform=node \
 *     --format=esm --external:@solana/zk-sdk/web --external:*.wasm --outfile=/tmp/probe.mjs
 *   node /tmp/probe.mjs
 */
import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
} from '@solana/spl-token';
import nacl from 'tweetnacl';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import * as zkNode from '@solana/zk-sdk/node';
import {
  provideZk, deriveKeys, buildConfigureAccountIxs, buildDepositIx,
  buildApplyPendingBalanceTx, readConfidentialBalances, planConfidentialTransfer, ataFor,
  isConfigured, getSessionKeys,
} from '../src/lib/confidential';

const RPC = 'https://rpc.mainnet.x1.xyz';
const X1B = new PublicKey('3nkouZp3DvRsD3w8cPVWwGH1CMD9PUyc9CfjonYerBn8');
const DECIMALS = 6;   // read off the mint, not assumed
const UNIT = 10n ** BigInt(DECIMALS);

const load = (p: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));

/** Exactly what a wallet's signMessage does: detached ed25519 over the bytes. */
const signerFor = (kp: Keypair) => async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey);

let step = 0;
const ok = (m: string) => console.log(`  \x1b[32mok\x1b[0m   ${m}`);
const head = (m: string) => console.log(`\n[${++step}] ${m}`);
const fail = (m: string) => { console.error(`  \x1b[31mFAIL\x1b[0m ${m}`); process.exitCode = 1; };

async function main() {
  provideZk(zkNode);
  const c = new Connection(RPC, 'confirmed');
  const send = (tx: Transaction, signers: Keypair[]) =>
    sendAndConfirmTransaction(c, tx, signers, { commitment: 'confirmed' });

  const funder = load(`${homedir()}/.x1-token-keys/x1b-mint.json`);       // pays XNT
  const tokens = load(`${homedir()}/.x1-token-keys/x1b-recipient.json`);  // holds X1B

  // Fresh wallets: every existing account was configured by the spl-token CLI,
  // whose key derivation is not ours, so none of them can be driven from here.
  // Persisted so a rerun reuses them instead of stranding XNT in a new pair
  // each time — and so a failed run can be inspected afterwards.
  const stash = (name: string) => {
    const f = `${process.env.PROBE_DIR ?? '/tmp'}/x1-probe-${name}.json`;
    if (existsSync(f)) return load(f);
    const kp = Keypair.generate();
    writeFileSync(f, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
    return kp;
  };
  const S = stash('sender'), R = stash('recipient');
  console.log(`sender    ${S.publicKey.toBase58()}\nrecipient ${R.publicKey.toBase58()}`);

  head('fund both wallets with XNT');
  const topUp = [];
  for (const [kp, want] of [[S, 60_000_000], [R, 30_000_000]] as const) {
    const have = await c.getBalance(kp.publicKey);
    if (have < want / 2) topUp.push(SystemProgram.transfer(
      { fromPubkey: funder.publicKey, toPubkey: kp.publicKey, lamports: want - have }));
  }
  if (topUp.length) await send(new Transaction().add(...topUp), [funder]);
  ok(topUp.length ? 'topped up' : 'already funded');

  head('give the sender a public X1B balance to work with');
  const srcAta = ataFor(X1B, S.publicKey);
  await send(new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      tokens.publicKey, srcAta, S.publicKey, X1B, TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(
      getAssociatedTokenAddressSync(X1B, tokens.publicKey, false, TOKEN_2022_PROGRAM_ID),
      X1B, srcAta, tokens.publicKey, 1000n * UNIT, DECIMALS, [], TOKEN_2022_PROGRAM_ID),
  ), [tokens]);
  ok('1000 X1B sent publicly');

  head('ENABLE both accounts (this is the shipped ConfigureAccount path)');
  const dstAta = ataFor(X1B, R.publicKey);
  // getSessionKeys, not deriveKeys: it checks the derived key against the
  // account's published pubkey and falls back to the legacy scheme. On a rerun
  // these wallets are legacy-configured, so this exercises that path too.
  const sKeys = (await getSessionKeys(c, srcAta, S.publicKey, signerFor(S)))!;
  const rKeys = (await getSessionKeys(c, dstAta, R.publicKey, signerFor(R)))!;
  if (!sKeys || !rKeys) return fail('no key fits the probe accounts');
  for (const [who, kp, ata, keys] of [['sender', S, srcAta, sKeys], ['recipient', R, dstAta, rKeys]] as const) {
    // ConfigureAccount is NOT idempotent — a second one fails 0x16 "Extension
    // already initialized". Reruns must skip, and so must the UI.
    if (await isConfigured(c, ata)) { ok(`${who} already configured`); continue; }
    await send(new Transaction().add(
      ...await buildConfigureAccountIxs(X1B, ata, kp.publicKey, keys)), [kp]);
    ok(`${who} configured`);
  }

  head('DEPOSIT the whole public balance into the private compartment');
  const beforeDeposit = (await readConfidentialBalances(c, srcAta, sKeys))!.available;
  const publicBal = BigInt((await c.getTokenAccountBalance(srcAta)).value.amount);
  await send(new Transaction().add(
    buildDepositIx(srcAta, X1B, S.publicKey, publicBal, DECIMALS)), [S]);
  ok(`deposited ${publicBal}`);

  head('APPLY the pending balance so it becomes spendable');
  const applyTx = await buildApplyPendingBalanceTx(c, srcAta, S.publicKey, sKeys);
  if (!applyTx) return fail('nothing pending after a deposit');
  await send(applyTx, [S]);
  const afterApply = await readConfidentialBalances(c, srcAta, sKeys);
  const wantAvail = beforeDeposit + publicBal;
  afterApply?.available === wantAvail
    ? ok(`sender available = ${afterApply!.available} (pending ${afterApply!.pending})`)
    : fail(`sender available = ${afterApply?.available}, expected ${wantAvail}`);

  head('TRANSFER 123.456789 X1B privately');
  const amount = 123_456_789n;          // 123.456789 X1B
  const plan = await planConfidentialTransfer(c, {
    mint: X1B, sourceAccount: srcAta, destAccount: dstAta,
    amount, keys: sKeys, authority: S.publicKey,
  });
  console.log(`  ${plan.transactions.length} transactions, sizes: ${plan.transactions
    .map(t => { t.partialSign(S); return t.serialize().length; }).join(', ')} bytes`);
  for (let i = 0; i < plan.transactions.length; i++) {
    const sig = await c.sendRawTransaction(plan.transactions[i].serialize(), { skipPreflight: false });
    const bh = await c.getLatestBlockhash();
    const r = await c.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
    if (r.value.err) return fail(`tx ${i + 1} failed: ${JSON.stringify(r.value.err)}`);
    ok(`tx ${i + 1}/${plan.transactions.length} ${sig}`);
  }

  head('verify both sides');
  const sAfter = await readConfidentialBalances(c, srcAta, sKeys);
  sAfter?.available === wantAvail - amount
    ? ok(`sender available = ${sAfter!.available} (was ${wantAvail})`)
    : fail(`sender available = ${sAfter?.available}, expected ${wantAvail - amount}`);

  const rBefore = await readConfidentialBalances(c, dstAta, rKeys);
  rBefore?.pending === amount
    ? ok(`recipient pending = ${rBefore!.pending} (credits ${rBefore!.pendingCredits})`)
    : fail(`recipient pending = ${rBefore?.pending}, expected ${amount}`);

  const rApply = await buildApplyPendingBalanceTx(c, dstAta, R.publicKey, rKeys);
  if (!rApply) return fail('recipient had nothing to apply');
  const rWas = rBefore!.available;
  await send(rApply, [R]);
  const rAfter = await readConfidentialBalances(c, dstAta, rKeys);
  rAfter?.available === rWas + amount
    ? ok(`recipient available = ${rAfter!.available}  ✓ end to end`)
    : fail(`recipient available = ${rAfter?.available}, expected ${rWas + amount}`);

  head('the amount must NOT be readable by anyone else');
  // Neither scheme can produce this account's key from someone else's wallet,
  // so the selection must refuse rather than hand back a plausible wrong number.
  const nobody = Keypair.generate();
  (await getSessionKeys(c, dstAta, nobody.publicKey, signerFor(nobody))) === null
    ? ok('another wallet derives no key that opens this account')
    : fail('a stranger derived a key for someone else\u2019s account');
}

async function crossCheck() {
  const c = new Connection(RPC, 'confirmed');
  head('read accounts the spl-token CLI configured, through the shipped code');
  const t22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  for (const name of ['x1b-recipient', 'x1b-mint', 'bm-mint']) {
    const owner = load(`${homedir()}/.x1-token-keys/${name}.json`);
    const accs = await c.getParsedTokenAccountsByOwner(owner.publicKey, { programId: t22 });
    for (const a of accs.value) {
      const info: any = a.account.data.parsed.info;
      if (!(info.extensions ?? []).some((e: any) => e.extension === 'confidentialTransferAccount')) continue;
      const keys = await getSessionKeys(c, a.pubkey, owner.publicKey, signerFor(owner));
      if (!keys) { fail(`${name} ${info.mint.slice(0, 6)}: no key fits`); continue; }
      const bal = await readConfidentialBalances(c, a.pubkey, keys);
      bal ? ok(`${name.padEnd(14)} ${info.mint.slice(0, 6)}  available = ${bal.available}`)
          : fail(`${name}: keys matched but decrypt failed`);
    }
  }
}

main().then(crossCheck).catch(e => { console.error('\n\x1b[31m' + (e?.stack ?? e) + '\x1b[0m'); process.exit(1); });
