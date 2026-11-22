import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { calculateAtlasEarnings, readAtlasEarnings, recordEarningsWalletScope } from '../src/atlas-earnings.js';
import { backfillEarningsEvidence, historyEvidence, type HistoryEvidence } from '../src/history-backfill.js';
import { readRentalHistory } from '../src/rental-history.js';
import { NEXT_GEN_SRSLY_PROGRAM_ID as PROGRAM } from '../src/model.js';

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

test('annualizes verified ATLAS over capital-time, includes zero-bonus capital, and keeps unmatched bonuses out of APR', () => {
  const report = calculateAtlasEarnings([
    outbid(6, 15, 'unknown start', 12), outbid(4, 13, 'second', 0),
    place(2, 3, 'second', 10_000, 0), place(1, 1, 'first'), outbid(3, 11, 'first', 100),
    outbid(7, 16, 'unverified mint', null), outbid(6, 15, 'unknown start', 12),
  ], profile, scope);
  assert.deepEqual(report.rows.map(row => [row.contract, row.heldMs, row.atlasLocked, row.bonusAtlas, row.aprPct]), [
    ['unverified mint', null, null, null, null], ['unknown start', null, null, 12, null],
    ['second', 10 * DAY, 10000, 0, 0], ['first', 10 * DAY, 5000, 100, 73],
  ]);
  assert.equal(report.totalBonusAtlas, 112);
  assert.equal(report.aprCount, 2);
  assert.equal(report.verifiedCount, 3);
  assert.equal(report.aprPct, 100 / 150_000 * 365 * 100);
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
  const evidence = historyEvidence(tx, sig);
  const payout = evidence.find(e => e.event.type === 'ReservationKnockedOff')!;
  const placed = evidence.find(e => e.event.type === 'ReservationPlaced')!;
  assert.equal(payout.bonusAtlasUnits, '64943700000');
  assert.equal(payout.event.refund, 129943700000n);
  assert.equal(placed.reservationProfile, 'ArUBNzxRcyseGSLbp2jjo4HLooEsEpdCTnFitutk82Cr');
  assert.equal(calculateAtlasEarnings(evidence, profile, [payout.event.displacedBorrower]).totalBonusAtlas, 649.437);
  tx.meta.logMessages = tx.meta.logMessages.map((line: string) => line.includes('ATLAS to defender') ? line.replace('ATLAS to defender', 'Points to defender') : line);
  const points = historyEvidence(tx, sig);
  assert.equal(calculateAtlasEarnings(points, profile, [payout.event.displacedBorrower]).totalBonusAtlas, null);
  tx.meta.err = { InstructionError: [2, 'InvalidAccountData'] };
  assert.deepEqual(historyEvidence(tx, sig), []);
  assert.ok(tx.meta.logMessages.some((log: string) => log.startsWith(`Program ${PROGRAM} invoke`)));
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
