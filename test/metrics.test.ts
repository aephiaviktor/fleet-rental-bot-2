import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateDefenderBonusAtlas, estimatePoints, estimateRentalCostAtlas, holdingFraction, recommendAction } from '../src/metrics.js';
import type { FleetContractSnapshot, FleetWatchEntry, WalletPosition } from '../src/model.js';

test('prorates rental cost to the requested duration', () => {
  assert.equal(estimateRentalCostAtlas(240, 12 * 60 * 60), 120);
});

test('computes holding fraction over the time available since reservation', () => {
  assert.equal(holdingFraction(1_000, 11_000, 6_000), 0.5);
});

test('caps defender bonus at the challenger bid difference', () => {
  assert.equal(estimateDefenderBonusAtlas(100, 110, 0.5), 5);
  assert.equal(estimateDefenderBonusAtlas(100, 110, 1, 2), 10);
});

test('estimates weighted points for partial days', () => {
  assert.equal(estimatePoints(10, 3, 12 * 60 * 60), 15);
});

const entry: FleetWatchEntry = {
  id: 'fleet-1', label: 'Fleet 1', contractAddress: 'contract', requestedDurationSeconds: 86_400,
  estimatedOperatingValueAtlas: 500, maximumRentalRateAtlasPerDay: 100,
  maximumReservationBidAtlas: 120, canSafelyOperate: true, enabled: true, comment: '',
};
const snapshot: FleetContractSnapshot = {
  rentalRateAtlasPerDay: 90, activeRentalEndsAtMs: null, reservationCurrency: 'ATLAS',
  reservationDefender: 'wallet', reservationBidAtlas: 100, reservationBidPoints: 0,
  minimumTakeoverBidAtlas: 110, minimumTakeoverBidPoints: 1.1, reservationCreatedAtMs: null,
  fleetWeight: 2, basePointsPerDay: 10, effectivePointsPerDay: 20,
};

test('recommends reserve, hold, rebid, and stop from the same curated entry', () => {
  const position = (status: WalletPosition['status']): WalletPosition => ({ status, atlasLocked: 0, reservedAtMs: null });
  assert.equal(recommendAction(entry, snapshot, position('none')), 'reserve-now');
  assert.equal(recommendAction(entry, snapshot, position('defending')), 'hold');
  assert.equal(recommendAction(entry, snapshot, position('outbid')), 'rebid');
  assert.equal(recommendAction(entry, { ...snapshot, minimumTakeoverBidAtlas: 121 }, position('outbid')), 'stop');
});
