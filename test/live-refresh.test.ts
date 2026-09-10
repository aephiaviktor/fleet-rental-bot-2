import assert from 'node:assert/strict';
import test from 'node:test';
import type { FleetContractSnapshot, FleetWatchEntry } from '../src/model.js';
import { mergeRefreshWithCache, refreshWatchlist } from '../src/live-refresh.js';
import { DEFAULT_SETTINGS } from '../src/settings-store.js';

const entry = (id: string, enabled = true): FleetWatchEntry => ({
  id, label: id, contractAddress: `contract-${id}`, requestedDurationSeconds: 86_400,
  estimatedNetValueAtlas: null, maximumRentalRateAtlasPerDay: 100,
  maximumReservationBidAtlas: 100, canSafelyOperate: true, enabled, comment: '', lcfs: false,
});
const snapshot: FleetContractSnapshot = {
  reservationsAllowed: true, minimumDurationSeconds: 3_600, maximumDurationSeconds: 8_035_200,
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

test('uses a matching last-good cached row when a live RPC refresh fails', async () => {
  const [live] = await refreshWatchlist([entry('fleet')], DEFAULT_SETTINGS, async () => snapshot, 1_000);
  assert.equal(live.ok, true);
  if (!live.ok) return;
  const merged = mergeRefreshWithCache(
    [{ id: 'fleet', ok: false, error: 'HTTP 429' }],
    [{ row: live.row, fetchedAtMs: 500 }],
  );
  assert.deepEqual(merged, [{
    id: 'fleet', ok: true, row: live.row, source: 'cache', fetchedAtMs: 500, error: 'HTTP 429',
  }]);
});

test('does not use cache belonging to an old contract address', async () => {
  const [live] = await refreshWatchlist([entry('fleet')], DEFAULT_SETTINGS, async () => snapshot, 1_000);
  assert.equal(live.ok, true);
  if (!live.ok) return;
  const changedEntry = { ...live.row.entry, contractAddress: 'replacement-contract' };
  const merged = mergeRefreshWithCache(
    [{ id: 'fleet', ok: false, error: 'offline' }],
    [{ row: { ...live.row, entry: changedEntry }, fetchedAtMs: 500 }],
    new Map([['fleet', live.row.entry.contractAddress]]),
  );
  assert.deepEqual(merged, [{ id: 'fleet', ok: false, error: 'offline' }]);
});
