import assert from 'node:assert/strict';
import test from 'node:test';
import type { FleetContractSnapshot, FleetWatchEntry } from '../src/model.js';
import { refreshWatchlist } from '../src/live-refresh.js';
import { DEFAULT_SETTINGS } from '../src/settings-store.js';

const entry = (id: string, enabled = true): FleetWatchEntry => ({
  id, label: id, contractAddress: `contract-${id}`, requestedDurationSeconds: 86_400,
  estimatedOperatingValueAtlas: null, maximumRentalRateAtlasPerDay: 100,
  maximumReservationBidAtlas: 100, canSafelyOperate: true, enabled, comment: '',
});
const snapshot: FleetContractSnapshot = {
  rentalRateAtlasPerDay: 90, activeRentalEndsAtMs: null, reservationCurrency: null,
  reservationDefender: null, reservationBidAtlas: null, reservationBidPoints: null,
  minimumTakeoverBidAtlas: 90, minimumTakeoverBidPoints: 0.9,
  projectedExpiryTakeoverBidAtlas: null, reservationCreatedAtMs: null,
  fleetWeight: 2, basePointsPerDay: 10, effectivePointsPerDay: 20,
};

test('refreshes enabled rows and isolates individual RPC failures', async () => {
  const results = await refreshWatchlist(
    [entry('good'), entry('bad'), entry('disabled', false)],
    DEFAULT_SETTINGS,
    async (contract) => { if (contract.endsWith('bad')) throw new Error('not found'); return snapshot; },
    1_000,
  );
  assert.equal(results.length, 2);
  assert.equal(results.find((result) => result.id === 'good')?.ok, true);
  assert.deepEqual(results.find((result) => result.id === 'bad'), { id: 'bad', ok: false, error: 'not found' });
});
