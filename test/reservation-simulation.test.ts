import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContractSnapshot } from '@sly-rentals/core';
import type { FleetContractSnapshot, FleetWatchEntry } from '../src/model.js';
import { simulateReservation } from '../src/reservation-simulation.js';
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

test('refetches and replans before returning a serializable simulation result', async () => {
  const result = await simulateReservation(entry, settings, 10_000, {
    fetchBundle: async () => ({ raw: {} as ContractSnapshot, mapped }),
    build: async () => [{ programAddress: 'program', accounts: [], data: new Uint8Array() }],
    simulate: async () => ({ ok: true, error: null, logs: ['ok'], unitsConsumed: 123, lastValidBlockHeight: 247526n }),
  });
  assert.deepEqual(result, {
    kind: 'simulated', plan: { kind: 'ready', action: 'reserve', contractAddress: entry.contractAddress,
      bidAtlas: 95, requestedDurationSeconds: 86_400, maximumBidAtlas: 120,
      maximumRentalRateAtlasPerDay: 100, activeRentalEndsAtMs: 20_000, expiresAtMs: 20_000 },
    simulation: { ok: true, error: null, logs: ['ok'], unitsConsumed: 123, lastValidBlockHeight: '247526' },
  });
});

test('does not build or simulate when the fresh plan is blocked', async () => {
  let touched = false;
  const result = await simulateReservation({ ...entry, maximumReservationBidAtlas: 90 }, settings, 10_000, {
    fetchBundle: async () => ({ raw: {} as ContractSnapshot, mapped }),
    build: async () => { touched = true; return []; },
    simulate: async () => { touched = true; throw new Error('must not run'); },
  });
  assert.equal(result.kind, 'blocked');
  assert.equal(touched, false);
});
