import assert from 'node:assert/strict';
import test from 'node:test';
import type { FleetContractSnapshot, FleetWatchEntry, WalletPosition } from '../src/model.js';
import { planAtlasReservation } from '../src/reservation-plan.js';

const entry: FleetWatchEntry = {
  id: 'fleet', label: 'Fleet', contractAddress: 'FiELMQBWWxRtv78dQQcpD2McCsrRZMhgbXETrH1EyMk7',
  requestedDurationSeconds: 86_400, estimatedOperatingValueAtlas: 200,
  maximumRentalRateAtlasPerDay: 100, maximumReservationBidAtlas: 120,
  canSafelyOperate: true, enabled: true, comment: '',
};
const snapshot: FleetContractSnapshot = {
  reservationsAllowed: true, minimumDurationSeconds: 3_600, maximumDurationSeconds: 8_035_200,
  rentalRateAtlasPerDay: 90, activeRentalEndsAtMs: 20_000, reservationCurrency: null,
  reservationDefender: null, reservationBidAtlas: null, reservationBidPoints: null,
  minimumTakeoverBidAtlas: 95, minimumTakeoverBidPoints: 0.95,
  projectedExpiryTakeoverBidAtlas: null, reservationCreatedAtMs: null,
  fleetWeight: 2, basePointsPerDay: 10, effectivePointsPerDay: 20,
};
const none: WalletPosition = { status: 'none', atlasLocked: 0, reservedAtMs: null };

test('plans the live minimum ATLAS bid without revealing the configured maximum', () => {
  assert.deepEqual(planAtlasReservation(entry, snapshot, none, 10_000), {
    kind: 'ready', action: 'reserve', contractAddress: entry.contractAddress,
    bidAtlas: 95, requestedDurationSeconds: 86_400,
    maximumBidAtlas: 120, maximumRentalRateAtlasPerDay: 100,
    activeRentalEndsAtMs: 20_000, expiresAtMs: 20_000,
  });
});

test('blocks plans that exceed either independent user limit', () => {
  assert.deepEqual(
    planAtlasReservation({ ...entry, maximumReservationBidAtlas: 94 }, snapshot, none, 10_000),
    { kind: 'blocked', reason: 'bid-limit', detail: 'Minimum ATLAS bid 95 exceeds maximum 94' },
  );
  assert.equal(
    planAtlasReservation({ ...entry, maximumRentalRateAtlasPerDay: 89 }, snapshot, none, 10_000).kind,
    'blocked',
  );
});

test('blocks disabled, unsafe, stale, and unavailable-bid states', () => {
  assert.equal(planAtlasReservation({ ...entry, enabled: false }, snapshot, none, 10_000).kind, 'blocked');
  assert.equal(planAtlasReservation({ ...entry, canSafelyOperate: false }, snapshot, none, 10_000).kind, 'blocked');
  assert.equal(planAtlasReservation(entry, { ...snapshot, activeRentalEndsAtMs: 9_999 }, none, 10_000).kind, 'blocked');
  assert.equal(planAtlasReservation(entry, { ...snapshot, minimumTakeoverBidAtlas: null }, none, 10_000).kind, 'blocked');
});

test('blocks owner opt-out and contract-specific duration violations', () => {
  assert.deepEqual(planAtlasReservation(entry, { ...snapshot, reservationsAllowed: false }, none, 10_000), {
    kind: 'blocked', reason: 'reservations-disabled', detail: 'Reservations are disabled for this contract',
  });
  assert.equal(planAtlasReservation({ ...entry, requestedDurationSeconds: 3_599 }, snapshot, none, 10_000).kind, 'blocked');
  assert.equal(planAtlasReservation({ ...entry, requestedDurationSeconds: 8_035_201 }, snapshot, none, 10_000).kind, 'blocked');
});

test('can challenge a Points defender using the protocol ATLAS minimum', () => {
  const plan = planAtlasReservation(entry, { ...snapshot, reservationCurrency: 'POINTS' }, none, 10_000);
  assert.equal(plan.kind, 'ready');
  if (plan.kind === 'ready') assert.equal(plan.bidAtlas, 95);
});

test('plans a minimum-bid self-rebid after the official SDK path was verified', () => {
  const defending: WalletPosition = { status: 'defending', atlasLocked: 90, reservedAtMs: 1_000 };
  const plan = planAtlasReservation(entry, { ...snapshot, reservationCurrency: 'ATLAS', reservationDefender: 'wallet' }, defending, 10_000);
  assert.equal(plan.kind, 'ready');
  if (plan.kind === 'ready') {
    assert.equal(plan.action, 'rebid');
    assert.equal(plan.bidAtlas, 95);
  }
});
