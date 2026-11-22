import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ContractSnapshot } from '@sly-rentals/core';
import { clearPendingBonusBid, loadBonusSettings, readPendingBonusBid, saveBonusSettings, savePendingBonusBid } from '../src/bonus-store.js';
import { BONUS_OVERBID_MIN_REMAINING_MS, ourBonusDefender, planBonusReservation } from '../src/bonus-strategy.js';
import type { FleetContractSnapshot, FleetWatchEntry } from '../src/model.js';

const contractAddress = 'FiELMQBWWxRtv78dQQcpD2McCsrRZMhgbXETrH1EyMk7';
const profile = '85BbUrMbPGDekp8mfSznWaSujHKaHrSgsTmiRfVr62Bo';
const wallet = 'gQxJAPtmHYAfhLZFxipsESMxKiLkbARNcSpG63dKm8x';
const entry: FleetWatchEntry = {
  id: 'fleet', label: 'Fleet', contractAddress, enabled: true, canSafelyOperate: true,
  requestedDurationSeconds: 86_400 * 24, maximumRentalRateAtlasPerDay: 1_000, maximumReservationBidAtlas: 1_000,
  estimatedNetValueAtlas: null, comment: '', lcfs: false,
};
const rule = { contractAddress, fcfs: true, maximumBidAtlas: 4_500 };
const endsAt = 2_000_000_000_000;
const snapshot: FleetContractSnapshot = {
  reservationsAllowed: true, minimumDurationSeconds: 86_400, maximumDurationSeconds: 86_400 * 24,
  rentalRateAtlasPerDay: 3_000, activeRentalEndsAtMs: endsAt,
  reservationCurrency: null, reservationDefender: null, reservationBidAtlas: null, reservationBidPoints: null,
  minimumTakeoverBidAtlas: 0, minimumTakeoverBidPoints: 0, currentMinimumBidAtlas: 3_000,
  projectedExpiryTakeoverBidAtlas: null, reservationCreatedAtMs: null,
  fleetWeight: 1, basePointsPerDay: 1, effectivePointsPerDay: 1,
};

test('an open slot uses the minimum contract duration and one day of rent as premium, even in the final 24 hours', () => {
  const plan = planBonusReservation(entry, rule, snapshot, false, endsAt - 30_000);
  assert.equal(plan.kind, 'ready');
  if (plan.kind !== 'ready') return;
  assert.equal(plan.requestedDurationSeconds, 86_400);
  assert.equal(plan.bidAtlas, 3_000);
  assert.equal(plan.requiredAtlas, 6_000);
  assert.equal(plan.overbid, false);
  const higherFloor = planBonusReservation(entry, rule, { ...snapshot, currentMinimumBidAtlas: 3_100 }, false, endsAt - 30_000);
  assert.equal(higherFloor.kind === 'ready' && higherFloor.bidAtlas, 3_100);
});

test('successive challengers in a single rental cycle can be overbid through the exact 24-hour and Max bid boundaries', () => {
  const cutoff = endsAt - BONUS_OVERBID_MIN_REMAINING_MS;
  const rivals = [
    { reservationDefender: 'rival-1', currentMinimumBidAtlas: 3_600 },
    { reservationDefender: 'rival-2', currentMinimumBidAtlas: 4_500 },
  ];
  for (const [index, rival] of rivals.entries()) {
    const live = { ...snapshot, ...rival, reservationCurrency: 'POINTS' as const };
    const plan = planBonusReservation(entry, rule, live, false, cutoff - (1 - index) * 60_000);
    assert.equal(plan.kind, 'ready');
    if (plan.kind !== 'ready') continue;
    assert.equal(plan.bidAtlas, rival.currentMinimumBidAtlas);
    assert.equal(plan.requiredAtlas, 3_000 + rival.currentMinimumBidAtlas);
    assert.equal(plan.overbid, true);
    assert.equal(plan.sendDeadlineMs, cutoff);
  }
  const defended = { ...snapshot, ...rivals[1] };
  assert.match((planBonusReservation(entry, rule, defended, false, cutoff + 1) as { detail: string }).detail, /under 24h/);
  assert.match((planBonusReservation(entry, { ...rule, maximumBidAtlas: 4_499.99 }, defended, false, cutoff) as { detail: string }).detail, /Max bid/);
});

test('fractional-day minimums use exact seconds and expired, disabled, unsafe, and closed slots are blocked', () => {
  const plan = planBonusReservation(entry, rule, { ...snapshot, minimumDurationSeconds: 3_600 }, false, endsAt - 60_000);
  assert.equal(plan.kind === 'ready' && plan.requestedDurationSeconds, 3_600);
  assert.equal(plan.kind === 'ready' && plan.requiredAtlas, 3_125);
  assert.equal(planBonusReservation(entry, { ...rule, fcfs: false }, snapshot, false, endsAt - 1).kind, 'blocked');
  assert.equal(planBonusReservation({ ...entry, enabled: false }, rule, snapshot, false, endsAt - 1).kind, 'blocked');
  assert.equal(planBonusReservation({ ...entry, canSafelyOperate: false }, rule, snapshot, false, endsAt - 1).kind, 'blocked');
  assert.equal(planBonusReservation(entry, rule, { ...snapshot, reservationsAllowed: false }, false, endsAt - 1).kind, 'blocked');
  assert.equal(planBonusReservation(entry, rule, snapshot, false, endsAt).kind, 'blocked');
});

test('does not overbid the configured profile or wallet', () => {
  const defender = (borrowerProfile: string, borrower: string) => ({ queuedRental: { data: { borrowerProfile, borrower } } }) as ContractSnapshot;
  const settings = { playerProfile: profile, walletAddress: wallet };
  assert.equal(ourBonusDefender(defender(profile, 'another profile wallet'), settings), true);
  assert.equal(ourBonusDefender(defender('another profile', wallet), settings), true);
  assert.equal(ourBonusDefender(defender('another profile', 'another wallet'), settings), false);
  const defended = { ...snapshot, reservationDefender: wallet };
  assert.match((planBonusReservation(entry, rule, defended, true, endsAt - 2 * BONUS_OVERBID_MIN_REMAINING_MS) as { detail: string }).detail, /Our bid is holding/);
});

test('FCFS starts disabled and rules are isolated by Player Profile', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fleet-bonus-test-'));
  try {
    assert.deepEqual(await loadBonusSettings(directory, profile), { minimumRateAtlasPerDay: 3_000, rules: [] });
    const settings = { minimumRateAtlasPerDay: 3_200, rules: [rule] };
    await saveBonusSettings(directory, profile, settings);
    assert.deepEqual(await loadBonusSettings(directory, profile), settings);
    assert.deepEqual(await loadBonusSettings(directory, wallet), { minimumRateAtlasPerDay: 3_000, rules: [] });
    await assert.rejects(saveBonusSettings(directory, profile, { ...settings, rules: [{ ...rule, maximumBidAtlas: 0 }] }), /positive Max bid/);
    assert.deepEqual(await loadBonusSettings(directory, profile), settings);
    await assert.rejects(saveBonusSettings(directory, profile, { ...settings, rules: [rule, rule] }), /unique/);
    const pending = { signature: 'pending-signature', lastValidBlockHeight: '22' };
    await savePendingBonusBid(directory, wallet, contractAddress, pending);
    assert.deepEqual(await readPendingBonusBid(directory, wallet, contractAddress), pending);
    assert.equal(await readPendingBonusBid(directory, profile, contractAddress), undefined);
    await clearPendingBonusBid(directory, wallet, contractAddress);
    assert.equal(await readPendingBonusBid(directory, wallet, contractAddress), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
