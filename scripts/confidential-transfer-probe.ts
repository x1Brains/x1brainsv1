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
  createCloseAccountInstruction,
} from '@solana/spl-token';
import nacl from 'tweetnacl';
import { readFileSync, writeFileSync, existsSync } from 'fs';

/** The scheme hint lives in localStorage; node has none, so stand one up. */
const _ls = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => _ls.get(k) ?? null,
  setItem: (k: string, v: string) => { _ls.set(k, v); },
  removeItem: (k: string) => { _ls.delete(k); },
};
import { homedir } from 'os';
import * as zkNode from '@solana/zk-sdk/node';
import {
  provideZk, deriveKeys, buildConfigureAccountIxs, buildDepositIx,
  buildApplyPendingBalanceTx, readConfidentialBalances, planConfidentialTransfer, ataFor,
  isConfigured, getSessionKeys, clearSessionKeys, buildConfigureAccountTx,
  planConfidentialWithdraw, buildEmptyAccountTx, planConfidentialBurn, planConfidentialMint,
  deriveSupplyKeys, buildUpdateDecryptableSupplyTx, buildApplyPendingBurnTx,
  reclaimProofContexts, checkApplyRace, repairDecryptableBalance, deriveKeysHkdf,
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

  const funder = load(`${homedir()}/.x1-token-keys/bm-mint.json`);        // pays XNT
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
  for (const [kp, want] of [[S, 60_000_000], [R, 30_000_000], [tokens, 20_000_000]] as const) {
    const have = await c.getBalance(kp.publicKey);
    if (have < want) topUp.push(SystemProgram.transfer(
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

async function signatureCost() {
  const c = new Connection(RPC, 'confirmed');
  head('how many signature prompts does opening an account actually cost?');

  /** Wraps a signer so every prompt is counted. */
  const counting = (kp: Keypair) => {
    const seen: string[] = [];
    const fn = async (m: Uint8Array) => {
      const t = new TextDecoder().decode(m);
      seen.push(t.startsWith('x1brains') ? 'legacy' : t);
      return nacl.sign.detached(m, kp.secretKey);
    };
    return { fn, seen };
  };

  // A legacy account, first ever encounter: nothing remembered, so the two
  // standard schemes are tried and missed before the right one.
  const S = load(`${process.env.PROBE_DIR ?? '/tmp'}/x1-probe-sender.json`);
  const srcAta = ataFor(X1B, S.publicKey);
  _ls.clear(); clearSessionKeys();
  const cold = counting(S);
  const k1 = await getSessionKeys(c, srcAta, S.publicKey, cold.fn);
  k1 ? ok(`cold : ${cold.seen.length} prompts  [${cold.seen.join(', ')}]`)
     : fail('cold open failed');

  // Same account, new session: the hint survives, so it goes straight there.
  clearSessionKeys();
  const warm = counting(S);
  const k2 = await getSessionKeys(c, srcAta, S.publicKey, warm.fn);
  if (!k2) return fail('warm open failed');
  k2.elgamalPubkeyB64 === k1!.elgamalPubkeyB64
    ? ok(`warm : ${warm.seen.length} prompt${warm.seen.length === 1 ? '' : 's'}   [${warm.seen.join(', ')}]  same key`)
    : fail('warm open produced a DIFFERENT key');
  warm.seen.length === 1 ? ok('hint cut it to a single signature')
                         : fail(`expected 1 prompt with a hint, got ${warm.seen.length}`);

  // Second token, same wallet, same session: per-wallet keys mean no prompt.
  const quiet = counting(S);
  await getSessionKeys(c, srcAta, S.publicKey, quiet.fn);
  quiet.seen.length === 0 ? ok('cached : 0 prompts for further tokens this session')
                          : fail(`expected 0 prompts, got ${quiet.seen.length}`);
}

async function hkdfRoundTrip() {
  const c = new Connection(RPC, 'confirmed');
  head('a NEW account: one signature, and it reads back');
  const funder = load(`${homedir()}/.x1-token-keys/bm-mint.json`);
  const W = Keypair.generate();
  await sendAndConfirmTransaction(c, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: W.publicKey, lamports: 20_000_000 }),
  ), [funder], { commitment: 'confirmed' });

  const ata = ataFor(X1B, W.publicKey);
  const seen: string[] = [];
  const sign = async (m: Uint8Array) => { seen.push(new TextDecoder().decode(m)); return nacl.sign.detached(m, W.secretKey); };

  // buildConfigureAccountTx is what the ENABLE button calls — test that, not a
  // neighbour of it.
  const tx = await buildConfigureAccountTx(c, X1B, ata, W.publicKey, sign);
  await sendAndConfirmTransaction(c, tx, [W], { commitment: 'confirmed' });
  seen.length === 1 ? ok(`ENABLE cost ${seen.length} signature  ["${seen[0]}"]`)
                    : fail(`expected 1 signature, got ${seen.length}: ${seen.join(', ')}`);

  clearSessionKeys();
  const seen2: string[] = [];
  const reopened = await getSessionKeys(c, ata, W.publicKey,
    async (m: Uint8Array) => { seen2.push('sig'); return nacl.sign.detached(m, W.secretKey); });
  reopened && (await readConfidentialBalances(c, ata, reopened))
    ? ok(`reopened with ${seen2.length} signature and decrypts`)
    : fail('could not reopen the account it just configured');
  await sweepBack(c, W, funder.publicKey);
}

async function withdrawRoundTrip() {
  const c = new Connection(RPC, 'confirmed');
  head('WITHDRAW: private balance back out to the public one');
  const S = load(`${process.env.PROBE_DIR ?? '/tmp'}/x1-probe-sender.json`);
  const ata = ataFor(X1B, S.publicKey);
  const keys = (await getSessionKeys(c, ata, S.publicKey, signerFor(S)))!;
  if (!keys) return fail('no key opens the probe sender');

  const before = (await readConfidentialBalances(c, ata, keys))!.available;
  const pubBefore = BigInt((await c.getTokenAccountBalance(ata)).value.amount);
  const amount = 7n * UNIT;

  const plan = await planConfidentialWithdraw(c, {
    mint: X1B, tokenAccount: ata, amount, decimals: DECIMALS,
    keys, authority: S.publicKey,
  });
  console.log(`  ${plan.transactions.length} transactions, sizes: ${plan.transactions
    .map(t => { t.partialSign(S); return t.serialize().length; }).join(', ')} bytes`);
  for (let i = 0; i < plan.transactions.length; i++) {
    const sig = await c.sendRawTransaction(plan.transactions[i].serialize(), { skipPreflight: false });
    const bh = await c.getLatestBlockhash();
    const r = await c.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
    if (r.value.err) return fail(`withdraw tx ${i + 1}: ${JSON.stringify(r.value.err)}`);
    ok(`tx ${i + 1}/${plan.transactions.length} ${sig}`);
  }
  const after = (await readConfidentialBalances(c, ata, keys))!.available;
  const pubAfter = BigInt((await c.getTokenAccountBalance(ata)).value.amount);
  after === before - amount ? ok(`private ${before} -> ${after}`)
                            : fail(`private ${after}, expected ${before - amount}`);
  pubAfter === pubBefore + amount ? ok(`public  ${pubBefore} -> ${pubAfter}  ✓ round trip`)
                                  : fail(`public ${pubAfter}, expected ${pubBefore + amount}`);
}

const BM = new PublicKey('AVEXYesqK3k4JyWaHhjCqaqZvkuMfmYi2JkPT6aCow9e');

/** Send a multi-transaction plan and confirm each step. */
async function runPlan(c: Connection, plan: { transactions: Transaction[] }, signer: Keypair, label: string) {
  console.log(`  ${plan.transactions.length} transactions, sizes: ${plan.transactions
    .map(t => { t.partialSign(signer); return t.serialize().length; }).join(', ')} bytes`);
  for (let i = 0; i < plan.transactions.length; i++) {
    const sig = await c.sendRawTransaction(plan.transactions[i].serialize(), { skipPreflight: false });
    const bh = await c.getLatestBlockhash();
    const r = await c.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
    if (r.value.err) throw new Error(`${label} tx ${i + 1}: ${JSON.stringify(r.value.err)}`);
    ok(`${label} tx ${i + 1}/${plan.transactions.length} ${sig.slice(0, 24)}…`);
  }
}

async function mintAndBurn() {
  const c = new Connection(RPC, 'confirmed');
  head('CONFIDENTIAL MINT and BURN on a ConfidentialMintBurn token');
  const auth = load(`${homedir()}/.x1-token-keys/bm-mint.json`);
  const ata = ataFor(BM, auth.publicKey);
  const sign = signerFor(auth);

  const supply = await deriveSupplyKeys(BM, sign);
  const cmbOf = async () => {
    const i: any = (await c.getParsedAccountInfo(BM)).value;
    return i.data.parsed.info.extensions.find((e: any) => e.extension === 'confidentialMintBurn').state;
  };
  const readSupply = async () => {
    const zk = zkNode as any;
    return supply.ae.decrypt(zk.AeCiphertext.fromBytes(
      Uint8Array.from(Buffer.from((await cmbOf()).decryptableSupply, 'base64'))));
  };
  const holder = (await getSessionKeys(c, ata, auth.publicKey, sign))!;
  if (!holder) return fail('no key opens the BM treasury account');

  const s0 = await readSupply();
  const b0 = (await readConfidentialBalances(c, ata, holder))!.available;
  ok(`before: supply ${s0}  treasury balance ${b0}`);

  const ONE = 1_000_000n;   // 1 BM
  await runPlan(c, await planConfidentialMint(c,
    { mint: BM, destination: ata, amount: ONE, supplyKeys: supply, authority: auth.publicKey }), auth, 'mint');
  const s1 = await readSupply();
  s1 === s0 + ONE ? ok(`supply ${s0} -> ${s1}`) : fail(`supply ${s1}, expected ${s0 + ONE}`);

  // Minted tokens land as pending, exactly like a received transfer.
  const applyTx = await buildApplyPendingBalanceTx(c, ata, auth.publicKey, holder);
  if (applyTx) await sendAndConfirmTransaction(c, applyTx, [auth], { commitment: 'confirmed' });
  const b1 = (await readConfidentialBalances(c, ata, holder))!.available;
  b1 === b0 + ONE ? ok(`treasury balance ${b0} -> ${b1}`) : fail(`balance ${b1}, expected ${b0 + ONE}`);

  await runPlan(c, await planConfidentialBurn(c,
    { mint: BM, tokenAccount: ata, amount: ONE, keys: holder, authority: auth.publicKey }), auth, 'burn');
  const b2 = (await readConfidentialBalances(c, ata, holder))!.available;
  b2 === b1 - ONE ? ok(`burned: balance ${b1} -> ${b2}`) : fail(`balance ${b2}, expected ${b1 - ONE}`);

  // Burning does NOT reduce the supply. It parks the amount in pendingBurn, so
  // a burn cannot invalidate a mint someone else is midway through proving.
  const sAfterBurn = await readSupply();
  sAfterBurn === s1 ? ok(`supply still reads ${sAfterBurn} — the burn is pending, not applied`)
                    : fail(`supply ${sAfterBurn}, expected it unchanged at ${s1}`);
  const pendingSet = !/^A*=*$/.test((await cmbOf()).pendingBurn);
  pendingSet ? ok('pendingBurn is set') : fail('pendingBurn is empty after a burn');

  // Applying is what moves the figure — and it is THEN that the readable copy
  // goes stale, because the program cannot rewrite it without the supply key.
  await sendAndConfirmTransaction(c, await buildApplyPendingBurnTx(c, BM, auth.publicKey),
    [auth], { commitment: 'confirmed' });
  const cleared = /^A*=*$/.test((await cmbOf()).pendingBurn);
  cleared ? ok('applied: pendingBurn cleared') : fail('pendingBurn survived the apply');
  const stale = await readSupply();
  stale === s1 ? ok(`decryptableSupply now STALE at ${stale} (true supply is ${s0})`)
               : fail(`expected a stale ${s1}, read ${stale}`);

  await sendAndConfirmTransaction(c,
    await buildUpdateDecryptableSupplyTx(c, BM, auth.publicKey, supply, s0), [auth],
    { commitment: 'confirmed' });
  const s2 = await readSupply();
  s2 === s0 ? ok(`re-synced: supply reads ${s2} again`) : fail(`supply ${s2}, expected ${s0}`);

  const bFinal = (await readConfidentialBalances(c, ata, holder))!.available;
  bFinal === b0 ? ok(`BM restored: supply ${s2}, treasury ${bFinal}  ✓ round trip`)
                : fail(`BM left at treasury ${bFinal}, expected ${b0}`);
}

async function emptyAndClose() {
  const c = new Connection(RPC, 'confirmed');
  head('EMPTY ACCOUNT, then close it and get the rent back');
  const funder = load(`${homedir()}/.x1-token-keys/bm-mint.json`);
  const W = Keypair.generate();
  await sendAndConfirmTransaction(c, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: W.publicKey, lamports: 20_000_000 }),
  ), [funder], { commitment: 'confirmed' });

  const ata = ataFor(X1B, W.publicKey);
  const keys = (await getSessionKeys(c, ata, W.publicKey, signerFor(W)))!;
  await sendAndConfirmTransaction(c,
    await buildConfigureAccountTx(c, X1B, ata, W.publicKey, signerFor(W)), [W], { commitment: 'confirmed' });
  ok('configured a throwaway account');

  const tx = await buildEmptyAccountTx(c, ata, W.publicKey, keys);
  console.log(`  1 transaction, ${(() => { tx.partialSign(W); return tx.serialize().length; })()} bytes (proof rides inline)`);
  const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const bh = await c.getLatestBlockhash();
  const r = await c.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
  if (r.value.err) return fail(`empty failed: ${JSON.stringify(r.value.err)}`);
  ok(`emptied ${sig.slice(0, 24)}…`);

  const before = await c.getBalance(W.publicKey);
  await sendAndConfirmTransaction(c, new Transaction().add(
    createCloseAccountInstruction(ata, W.publicKey, W.publicKey, [], TOKEN_2022_PROGRAM_ID),
  ), [W], { commitment: 'confirmed' });
  const gone = (await c.getParsedAccountInfo(ata)).value === null;
  const after = await c.getBalance(W.publicKey);
  gone && after > before ? ok(`account closed, ${after - before} lamports of rent refunded`)
                         : fail(`close failed (gone=${gone}, refund=${after - before})`);
  await sweepBack(c, W, funder.publicKey);
}

async function reclaimStrays() {
  const c = new Connection(RPC, 'confirmed');
  head('reclaim rent from context accounts any failed run left behind');
  const wallets: [string, Keypair][] = [
    ['probe-sender',    load(`${process.env.PROBE_DIR ?? '/tmp'}/x1-probe-sender.json`)],
    ['probe-recipient', load(`${process.env.PROBE_DIR ?? '/tmp'}/x1-probe-recipient.json`)],
    ['treasury',        load(`${homedir()}/.x1-token-keys/bm-mint.json`)],
  ];
  let total = 0;
  for (const [name, kp] of wallets) {
    const r = await reclaimProofContexts(c, kp.publicKey);
    if (!r.accounts.length) continue;
    for (const tx of r.transactions) await sendAndConfirmTransaction(c, tx, [kp], { commitment: 'confirmed' });
    total += r.lamports;
    ok(`${name}: closed ${r.accounts.length}, reclaimed ${r.lamports} lamports`);
  }
  total === 0 ? ok('nothing stranded') : ok(`reclaimed ${total} lamports in total`);
}

async function auditChecks() {
  const c = new Connection(RPC, 'confirmed');
  head('AUDIT: weak signatures must be refused, not stretched into a key');
  for (const [label, bad] of [
    ['all-zero (some wallets return this instead of erroring)', new Uint8Array(64)],
    ['truncated', new Uint8Array(8)],
  ] as const) {
    try {
      await deriveKeysHkdf(async () => bad);
      fail(`${label}: ACCEPTED — a predictable key was derived`);
    } catch (e: any) {
      ok(`${label}: refused (${String(e.message).slice(0, 48)}…)`);
    }
  }
  // and a real one still works
  const S = load(`${process.env.PROBE_DIR ?? '/tmp'}/x1-probe-sender.json`);
  const good = await deriveKeysHkdf(signerFor(S));
  good?.elgamalPubkeyB64 ? ok('a genuine signature still derives normally') : fail('real signature refused');

  head('AUDIT: apply-race detection and the repair primitive');
  const ata = ataFor(X1B, S.publicKey);
  const keys = (await getSessionKeys(c, ata, S.publicKey, signerFor(S)))!;
  const race = await checkApplyRace(c, ata);
  ok(`race check reads expected=${race.expected} actual=${race.actual} -> raced=${race.raced}`);

  // repairDecryptableBalance must be a NO-OP on a healthy account: it returns
  // null rather than rewriting a balance that is already correct.
  const before = (await readConfidentialBalances(c, ata, keys))!.available;
  let repaired;
  try { repaired = await repairDecryptableBalance(c, ata, S.publicKey, keys); }
  catch (e: any) { repaired = 'threw: ' + String(e.message).slice(0, 60); }
  if (repaired === null) ok('healthy account: repair correctly declines to act');
  else if (typeof repaired === 'string') ok(`balance beyond the u32 discrete log — ${repaired}`);
  else fail(`repair wanted to rewrite a healthy balance to ${(repaired as any).trueBalance}`);
  const after = (await readConfidentialBalances(c, ata, keys))!.available;
  after === before ? ok(`balance untouched by the audit (${after})`) : fail('audit changed the balance');
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

main().then(withdrawRoundTrip).then(emptyAndClose).then(mintAndBurn).then(auditChecks).then(reclaimStrays).then(crossCheck).then(signatureCost).then(hkdfRoundTrip).catch(e => { console.error('\n\x1b[31m' + (e?.stack ?? e) + '\x1b[0m'); process.exit(1); });
