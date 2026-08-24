import assert from 'node:assert/strict';
import test from 'node:test';
import type { FleetContractSnapshot, FleetWatchEntry, WalletPosition } from '../src/model.js';
import { buildFleetTableRow } from '../src/table-row.js';

const entry: FleetWatchEntry = {
  id: 'one', label: 'One', contractAddress: 'contract', requestedDurationSeconds: 2 * 86_400,
  estimatedOperatingValueAtlas: 300, maximumRentalRateAtlasPerDay: 110,
  maximumReservationBidAtlas: 120, canSafelyOperate: true, enabled: true, comment: '',
};
const snapshot: FleetContractSnapshot = {
  rentalRateAtlasPerDay: 100,
  activeRentalEndsAtMs: 11_000,
  reservationCurrency: 'ATLAS',
  reservationDefender: 'wallet',
  reservationBidAtlas: 100,
  reservationBidPoints: 0,
  minimumTakeoverBidAtlas: 106,
  minimumTakeoverBidPoints: 1.06,
  projectedExpiryTakeoverBidAtlas: 110,
  reservationCreatedAtMs: 1_000,
  fleetWeight: 2,
  basePointsPerDay: 10,
  effectivePointsPerDay: 20,
};
const position: WalletPosition = { status: 'defending', atlasLocked: 100, reservedAtMs: 1_000 };

test('builds all derived economics from one source of truth', () => {
  const row = buildFleetTableRow(entry, snapshot, position, 6_000);
  assert.equal(row.rentalCostAtlas, 200);
  assert.equal(row.netOperatingValueAtlas, 100);
  assert.equal(row.reservationAgeMs, 5_000);
  assert.equal(row.holdingFraction, 0.5);
  assert.equal(row.bonusIfOutbidNowAtlas, 3);
  assert.equal(row.projectedExpiryFloorBonusAtlas, 10);
  assert.equal(row.maximumRemainingLockMs, 5_000);
  assert.equal(row.estimatedPoints, 40);
  assert.equal(row.pointsPerThousandAtlas, 200);
  assert.equal(row.recommendation, 'hold');
});

test('does not invent bonus or net-value metrics when inputs are absent', () => {
  const row = buildFleetTableRow(
    { ...entry, estimatedOperatingValueAtlas: null },
    { ...snapshot, reservationCurrency: 'POINTS', reservationBidAtlas: 0, reservationBidPoints: 4 },
    { ...position, atlasLocked: 0 },
    6_000,
  );
  assert.equal(row.netOperatingValueAtlas, null);
  assert.equal(row.bonusIfOutbidNowAtlas, null);
  assert.equal(row.projectedExpiryFloorBonusAtlas, null);
});
