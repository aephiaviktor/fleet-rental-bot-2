import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  deferNormalRpcUntil,
  deferRpcUntil,
  getRpcRequestsPerSecond,
  loadCachedRows,
  saveCachedRow,
  setRpcRequestsPerSecond,
  tryClaimRpcSlot,
} from '../src/fleet-database.js';
import type { FleetTableRow } from '../src/model.js';

async function temporaryDatabase(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-rental-bot-2-'));
  return { path: join(directory, 'shared.sqlite'), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const row = {
  entry: { id: 'fleet-1', contractAddress: 'contract-1' },
  snapshot: { fleetName: 'Cached Fleet', activeRentalEndsAtMs: 12345 },
  position: { status: 'none', atlasLocked: 0, reservedAtMs: null },
} as FleetTableRow;

test('stores and restores the last good row per Fleet Rental Bot 2 instance', async () => {
  const database = await temporaryDatabase();
  try {
    saveCachedRow(database.path, 'UST', row, 1_789_000_000_000);
    assert.deepEqual(loadCachedRows(database.path, 'UST'), [{ row, fetchedAtMs: 1_789_000_000_000 }]);
    assert.deepEqual(loadCachedRows(database.path, 'MUD'), []);
  } finally {
    await database.cleanup();
  }
});

test('ignores a corrupted cached row instead of blocking app startup', async () => {
  const database = await temporaryDatabase();
  try {
    saveCachedRow(database.path, 'UST', row, 1_789_000_000_000);
    const sqlite = new DatabaseSync(database.path);
    sqlite.prepare('UPDATE fleet_snapshot_cache SET row_json = ?').run('{broken');
    sqlite.close();
    assert.deepEqual(loadCachedRows(database.path, 'UST'), []);
  } finally {
    await database.cleanup();
  }
});

test('shares a conservative five request-per-second limiter across instances', async () => {
  const database = await temporaryDatabase();
  try {
    assert.equal(getRpcRequestsPerSecond(database.path), 5);
    assert.deepEqual(tryClaimRpcSlot(database.path, 10_000), { claimed: true, waitMs: 0 });
    assert.deepEqual(tryClaimRpcSlot(database.path, 10_000), { claimed: false, waitMs: 200 });
    assert.deepEqual(tryClaimRpcSlot(database.path, 10_200), { claimed: true, waitMs: 0 });
    setRpcRequestsPerSecond(database.path, 10);
    assert.equal(getRpcRequestsPerSecond(database.path), 10);
    assert.deepEqual(tryClaimRpcSlot(database.path, 11_000), { claimed: true, waitMs: 0 });
    assert.deepEqual(tryClaimRpcSlot(database.path, 11_000), { claimed: false, waitMs: 100 });
  } finally {
    await database.cleanup();
  }
});

test('urgent LCFS work pauses normal refreshes without exceeding the shared rate', async () => {
  const database = await temporaryDatabase();
  try {
    assert.deepEqual(tryClaimRpcSlot(database.path, 10_000, false), { claimed: true, waitMs: 0 });
    assert.deepEqual(tryClaimRpcSlot(database.path, 10_000, false), { claimed: false, waitMs: 200 });
    deferNormalRpcUntil(database.path, 12_000);
    assert.deepEqual(tryClaimRpcSlot(database.path, 10_200, false), { claimed: false, waitMs: 1_800 });
    assert.deepEqual(tryClaimRpcSlot(database.path, 10_200, true), { claimed: true, waitMs: 0 });
    assert.deepEqual(tryClaimRpcSlot(database.path, 10_200, true), { claimed: false, waitMs: 200 });
  } finally {
    await database.cleanup();
  }
});

test('shares a 429 cooldown with all Fleet Rental Bot 2 instances', async () => {
  const database = await temporaryDatabase();
  try {
    deferRpcUntil(database.path, 25_000);
    assert.deepEqual(tryClaimRpcSlot(database.path, 20_000), { claimed: false, waitMs: 5_000 });
    assert.deepEqual(tryClaimRpcSlot(database.path, 25_000), { claimed: true, waitMs: 0 });
    assert.deepEqual(tryClaimRpcSlot(database.path, 25_000), { claimed: false, waitMs: 200 });
  } finally {
    await database.cleanup();
  }
});
