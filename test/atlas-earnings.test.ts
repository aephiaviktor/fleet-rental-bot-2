import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getBase58Decoder } from '@solana/kit';
import test from 'node:test';
import { calculateAtlasEarnings, readAtlasEarnings, recordEarningsWalletScope } from '../src/atlas-earnings.js';
import { backfillEarningsEvidence, historyEvidence, type HistoryEvidence } from '../src/history-backfill.js';
import { readRentalHistory } from '../src/rental-history.js';
import { NEXT_GEN_SRSLY_PROGRAM_ID as PROGRAM } from '../src/model.js';
import { bidPriceDay, readEarningsRates, refreshEarningsRates } from '../src/earnings-prices.js';

const DAY = 86400000;
const profile = 'profile';
const wallet = 'borrower';
const scope = [wallet, 'second wallet'];
const dust = (value: number) => String(Math.round(value * 1e8));
const event = (slot: number, at: number, contract: string, event: Record<string, unknown>, proof: Partial<HistoryEvidence> = {}): HistoryEvidence => ({
  slot, at: at * DAY, signature: `tx${slot}-${contract}`, index: 0, keys: [], event: { contract, rentalState: `${contract}-queue`, ...event }, ...proof,
});
const place = (slot: number, at: number, contract: string, escrow = 4500, bid = 500, reserveProfile: string | null = profile) => event(slot, at, contract,
  { type: 'ReservationPlaced', borrower: wallet, escrow: dust(escrow), bidAtlas: dust(bid) }, { reservationProfile: reserveProfile });
const outbid = (slot: number, at: number, contract: string, bonus: number | null, newBorrower = 'other wallet') => event(slot, at, contract,
  { type: 'ReservationKnockedOff', displacedBorrower: wallet, newBorrower, refund: dust(400 + (bonus ?? 50)), bonus: dust(bonus ?? 50) },
  { bonusAtlasUnits: bonus === null ? null : dust(bonus) });

test('annualizes net profit over capital-time and reports a loss when a zero-bonus bid costs SOL', () => {
  const report = calculateAtlasEarnings([
    outbid(6, 15, 'unknown start', 12), outbid(4, 13, 'second', 0),
    { ...place(2, 3, 'second', 10_000, 0), bidCostLamports: '200000' },
    { ...place(1, 1, 'first'), bidCostLamports: '100000' }, outbid(3, 11, 'first', 100),
    outbid(7, 16, 'unverified mint', null), outbid(6, 15, 'unknown start', 12),
  ], profile, scope, new Map([[bidPriceDay(DAY), 100_000], [bidPriceDay(3 * DAY), 100_000]]));
  assert.deepEqual(report.rows.map(row => [row.contract, row.heldMs, row.atlasLocked, row.bonusAtlas, row.solFeesAtlas, row.netProfitAtlas, row.aprPct]), [
    ['unverified mint', null, null, null, null, null, null], ['unknown start', null, null, 12, null, null, null],
    ['second', 10 * DAY, 10000, 0, 20, -20, -7.3], ['first', 10 * DAY, 5000, 100, 10, 90, 65.7],
  ]);
  assert.equal(report.totalBonusAtlas, 112);
  assert.equal(report.aprCount, 2);
  assert.equal(report.verifiedCount, 3);
  assert.ok(Math.abs(report.aprPct! - 70 / 150_000 * 365 * 100) < 1e-12);
  const noRate = calculateAtlasEarnings([{ ...place(1, 1, 'first'), bidCostLamports: '100000' }, outbid(3, 11, 'first', 100)], profile, scope);
  assert.equal(noRate.rows[0].bidCostSol, 0.0001);
  assert.equal(noRate.rows[0].netProfitAtlas, null);
  assert.equal(noRate.aprPct, null);
});

test('does not confuse a reused queue, a different profile, an own-wallet replacement, or same-slot ambiguity with a known holding period', () => {
  const report = calculateAtlasEarnings([
    place(1, 1, 'accepted'), event(2, 2, 'accepted', { type: 'RentalAccepted' }), outbid(3, 3, 'accepted', 12),
    place(4, 4, 'other profile', 50, 10, 'other profile'), outbid(5, 5, 'other profile', 40),
    place(6, 6, 'own replacement'), outbid(7, 7, 'own replacement', 50, 'second wallet'),
    place(8, 8, 'same slot'), { ...outbid(8, 8, 'same slot', 0), signature: 'other-signature' },
    place(9, 9, 'active cancel'),
    event(10, 10, 'active cancel', { type: 'RentalCancelled', rentalState: 'active-account' }),
    outbid(11, 11, 'active cancel', 8),
    place(12, 12, 'expired delegate'),
    { ...outbid(13, 13, 'expired delegate', 4), event: { ...outbid(13, 13, 'expired delegate', 4).event, displacedBorrower: 'expired' } },
  ].map(e => e.slot === 12 ? { ...e, event: { ...e.event, borrower: 'expired' } } : e), profile, scope);
  assert.deepEqual(report.rows.map(row => [row.contract, row.heldMs, row.walletOnly]), [
    ['expired delegate', DAY, false], ['active cancel', 2 * DAY, false], ['same slot', null, true], ['accepted', null, true],
  ]);
  assert.equal(report.totalBonusAtlas, 24);
});

test('reports historical bids with their currency and distinguishes an unknown bid from zero', () => {
  const placed = place(1, 1, 'points bid', 4500, 0);
  placed.event.bidPoints = dust(12.345);
  const taken = outbid(2, 2, 'points bid', 100);
  taken.event.newBidAtlas = dust(1300.456);
  taken.event.newBidPoints = '0';
  const missing = outbid(3, 3, 'unmatched bid', 0);
  missing.event.newBidAtlas = missing.event.newBidPoints = '0';

  const [unmatched, matched] = calculateAtlasEarnings([placed, taken, missing], profile, scope).rows;
  assert.equal(unmatched.myBid, null);
  assert.deepEqual(unmatched.challengerBid, { amount: 0, currency: null });
  assert.deepEqual(matched.myBid, { amount: 12.345, currency: 'Points' });
  assert.deepEqual(matched.challengerBid, { amount: 1300.456, currency: 'ATLAS' });
  assert.equal(matched.atlasLocked, 4500);
});

test('reads the confirmed mainnet bonus instead of the refund and verifies the placement profile from the instruction', async () => {
  const tx = JSON.parse(await readFile('test/fixtures/history/264x.json', 'utf8'));
  const sig = tx.transaction.signatures[0];
  tx.meta.fee = 5300;
  const { accountKeys, instructions } = tx.transaction.message;
  const tipIndex = accountKeys.length + tx.meta.loadedAddresses.writable.length + tx.meta.loadedAddresses.readonly.length;
  tx.meta.loadedAddresses.readonly.push('4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE');
  const transfer = Buffer.alloc(12);
  transfer.writeUInt32LE(2);
  transfer.writeBigUInt64LE(200_000n, 4);
  instructions.push({ programIdIndex: accountKeys.indexOf('11111111111111111111111111111111'),
    accounts: [0, tipIndex], data: getBase58Decoder().decode(transfer) });
  const evidence = historyEvidence(tx, sig);
  const payout = evidence.find(e => e.event.type === 'ReservationKnockedOff')!;
  const placed = evidence.find(e => e.event.type === 'ReservationPlaced')!;
  assert.equal(payout.bonusAtlasUnits, '64943700000');
  assert.equal(payout.event.refund, 129943700000n);
  assert.equal(placed.bidCostLamports, '205300');
  assert.equal(payout.bidCostLamports, undefined);
  assert.equal(placed.reservationProfile, 'ArUBNzxRcyseGSLbp2jjo4HLooEsEpdCTnFitutk82Cr');
  assert.equal(calculateAtlasEarnings(evidence, profile, [payout.event.displacedBorrower]).totalBonusAtlas, 649.437);
  tx.meta.logMessages = tx.meta.logMessages.map((line: string) => line.includes('ATLAS to defender') ? line.replace('ATLAS to defender', 'Points to defender') : line);
  const points = historyEvidence(tx, sig);
  assert.equal(calculateAtlasEarnings(points, profile, [payout.event.displacedBorrower]).totalBonusAtlas, null);
  tx.meta.err = { InstructionError: [2, 'InvalidAccountData'] };
  assert.deepEqual(historyEvidence(tx, sig), []);
  assert.ok(tx.meta.logMessages.some((log: string) => log.startsWith(`Program ${PROGRAM} invoke`)));
});

test('uses authenticated Aephia prices, takes the last same-day observations, and ignores cached Kraken rates', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'priced-fees-'));
  const file = join(folder, 'history.sqlite');
  const fetchBefore = globalThis.fetch;
  const bidAt = Date.now();
  const day = bidPriceDay(bidAt);
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.aephia.com');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-key');
    assert.equal(init?.redirect, 'error');
    assert.equal(url.searchParams.get('from'), new Date((day - 86_400) * 1000).toISOString());
    assert.equal(url.searchParams.get('to'), new Date((day + 86_400) * 1000 - 1).toISOString());
    const token = url.pathname.split('/').at(-1)!;
    assert.equal(url.pathname, `/v1/market/tokens/${token}`);
    calls.push(token);
    const price = token === 'atlas' ? 0.001 : 100;
    const rows = [[price, day * 1000 + 600_000], [price * 2, day * 1000], [price * 3, (day + 86_400) * 1000]];
    if (token === 'sol') rows.push([100, (day - 86_400) * 1000]);
    return Response.json({ kind: 'token', token, columns: ['price', 'ts'], rows });
  };
  try {
    const legacy = new DatabaseSync(file);
    try {
      legacy.exec('CREATE TABLE earnings_rates(day INTEGER PRIMARY KEY, atlas_per_sol REAL NOT NULL)');
      legacy.prepare('INSERT INTO earnings_rates VALUES (?, ?)').run(day, 500);
      assert.equal(readEarningsRates(legacy).size, 0);
    } finally { legacy.close(); }
    await assert.rejects(refreshEarningsRates(file, [bidAt], ''), /API key is required/);
    await refreshEarningsRates(file, [bidAt, bidAt - DAY], 'test-key');
    await refreshEarningsRates(file, [bidAt], 'test-key');
    assert.deepEqual(calls.sort(), ['atlas', 'sol']);
    const db = new DatabaseSync(file);
    try { assert.deepEqual([...readEarningsRates(db)], [[day, 100_000]]); } finally { db.close(); }
  } finally {
    globalThis.fetch = fetchBefore;
    await rm(folder, { recursive: true, force: true });
  }
});

test('enriches legacy saved payout evidence with a read-only transaction lookup and keeps profile DB scopes separate', async () => {
  const tx = JSON.parse(await readFile('test/fixtures/history/264x.json', 'utf8'));
  const sig = tx.transaction.signatures[0];
  const evidence = historyEvidence(tx, sig);
  const payout = evidence.find(e => e.event.type === 'ReservationKnockedOff')!;
  const evidenceWithoutProof = { ...payout, bonusAtlasUnits: undefined };
  const folder = await mkdtemp(join(tmpdir(), 'earned-'));
  const file = join(folder, 'history.sqlite');
  const originalFetch = globalThis.fetch;
  let requests = 0;
  try {
    readRentalHistory(file, profile);
    recordEarningsWalletScope(file, profile, [payout.event.displacedBorrower]);
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE history_evidence(profile TEXT,signature TEXT,idx INTEGER,payload TEXT,PRIMARY KEY(profile,signature,idx))');
    db.prepare('INSERT INTO history_evidence VALUES (?,?,?,?)').run(profile, sig, payout.index,
      JSON.stringify(evidenceWithoutProof, (_key, value) => typeof value === 'bigint' ? String(value) : value));
    db.close();
    assert.equal(readAtlasEarnings(file, profile).totalBonusAtlas, null);
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      assert.equal(request.method, 'getTransaction');
      assert.equal(request.params[0], sig);
      requests++;
      return Response.json({ jsonrpc: '2.0', id: request.id, result: tx });
    };
    await backfillEarningsEvidence(file, profile, [payout.event.displacedBorrower], 'https://rpc.example.test');
    const report = readAtlasEarnings(file, profile);
    assert.equal(report.totalBonusAtlas, 649.437);
    assert.equal(report.aprPct, null);
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0].myBid, null);
    assert.deepEqual(report.rows[0].challengerBid, { amount: 710, currency: 'ATLAS' });
    assert.equal(readAtlasEarnings(file, 'other profile').rows.length, 0);
    assert.equal(readRentalHistory(file, profile).length, 0);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(folder, { recursive: true, force: true });
  }
});
