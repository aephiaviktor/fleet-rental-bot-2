import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContractSnapshot } from '@sly-rentals/core';
import type { FleetContractSnapshot, FleetWatchEntry } from '../src/model.js';
import { prepareReservationReview } from '../src/reservation-review.js';
import { DEFAULT_SETTINGS } from '../src/settings-store.js';

const entry: FleetWatchEntry = {
  id: 'fleet', label: 'Fleet', contractAddress: 'FiELMQBWWxRtv78dQQcpD2McCsrRZMhgbXETrH1EyMk7',
  requestedDurationSeconds: 86_400, estimatedOperatingValueAtlas: 200,
  maximumRentalRateAtlasPerDay: 100, maximumReservationBidAtlas: 120,
  canSafelyOperate: true, enabled: true, comment: '',
};
const mapped: FleetContractSnapshot = {
  rentalRateAtlasPerDay: 90, activeRentalEndsAtMs: 20_000, reservationCurrency: null,
  reservationDefender: null, reservationBidAtlas: null, reservationBidPoints: null,
  minimumTakeoverBidAtlas: 95, minimumTakeoverBidPoints: 0.95,
  projectedExpiryTakeoverBidAtlas: null, reservationCreatedAtMs: null,
  fleetWeight: 2, basePointsPerDay: 10, effectivePointsPerDay: 20,
};
const settings = {
  ...DEFAULT_SETTINGS,
  walletAddress: 'Erdrp29yxiCVyYJgJtZz2ZYAbxiDV5UUDLNEZJsxSL7',
  challengerProfileAddress: '11111111111111111111111111111111',
};

test('refetches, replans, and returns sanitized instruction metadata', async () => {
  const review = await prepareReservationReview(entry, settings, 10_000, {
    fetchBundle: async () => ({ raw: {} as ContractSnapshot, mapped }),
    build: async () => [
      { programAddress: 'ComputeBudget111111111111111111111111111111', accounts: [], data: new Uint8Array([1, 2]) },
      { programAddress: 'SRSLY11111111111111111111111111111111111', accounts: [
        { address: settings.walletAddress, role: 3 }, { address: entry.contractAddress, role: 0 },
      ], data: new Uint8Array([3, 4, 5]) },
    ],
  });
  assert.equal(review.kind, 'ready');
  if (review.kind !== 'ready') return;
  assert.equal(review.plan.bidAtlas, 95);
  assert.equal(review.instructionCount, 2);
  assert.deepEqual(review.instructions[1], {
    index: 1,
    programAddress: 'SRSLY11111111111111111111111111111111111',
    dataBytes: 3,
    accounts: [
      { address: settings.walletAddress, role: 3 }, { address: entry.contractAddress, role: 0 },
    ],
  });
});

test('returns blocked plans without building instructions', async () => {
  let built = false;
  const review = await prepareReservationReview({ ...entry, maximumReservationBidAtlas: 90 }, settings, 10_000, {
    fetchBundle: async () => ({ raw: {} as ContractSnapshot, mapped }),
    build: async () => { built = true; return []; },
  });
  assert.equal(review.kind, 'blocked');
  assert.equal(built, false);
});

test('requires public wallet and SAGE profile addresses', async () => {
  const deps = { fetchBundle: async () => ({ raw: {} as ContractSnapshot, mapped }), build: async () => [] };
  await assert.rejects(() => prepareReservationReview(entry, { ...settings, walletAddress: '' }, 10_000, deps), /Wallet address/);
  await assert.rejects(() => prepareReservationReview(entry, { ...settings, challengerProfileAddress: '' }, 10_000, deps), /SAGE profile/);
});
