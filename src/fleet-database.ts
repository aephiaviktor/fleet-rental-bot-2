import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FleetTableRow } from './model.js';

const DEFAULT_RPC_REQUESTS_PER_SECOND = 5;
const MIN_RPC_REQUESTS_PER_SECOND = 1;
const MAX_RPC_REQUESTS_PER_SECOND = 10;
const initializedDatabases = new Set<string>();

export interface CachedFleetRow {
  row: FleetTableRow;
  fetchedAtMs: number;
}

function openDatabase(databasePath: string): DatabaseSync {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA busy_timeout = 5000');
  if (!initializedDatabases.has(databasePath)) {
    database.exec('PRAGMA journal_mode = WAL');
    database.exec(`
    CREATE TABLE IF NOT EXISTS fleet_snapshot_cache (
      instance TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      contract_address TEXT NOT NULL,
      row_json TEXT NOT NULL,
      fetched_at_ms INTEGER NOT NULL,
      PRIMARY KEY (instance, entry_id)
    );
    CREATE TABLE IF NOT EXISTS rpc_limiter_config (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      requests_per_second REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rpc_limiter_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      next_slot_ms INTEGER NOT NULL,
      blocked_until_ms INTEGER NOT NULL,
      priority_until_ms INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO rpc_limiter_config (singleton, requests_per_second)
      VALUES (1, ${DEFAULT_RPC_REQUESTS_PER_SECOND});
    INSERT OR IGNORE INTO rpc_limiter_state (singleton, next_slot_ms, blocked_until_ms, priority_until_ms)
      VALUES (1, 0, 0, 0);
  `);
    const limiterColumns = database.prepare('PRAGMA table_info(rpc_limiter_state)').all() as Array<{ name: string }>;
    if (!limiterColumns.some((column) => column.name === 'priority_until_ms')) {
      database.exec('ALTER TABLE rpc_limiter_state ADD COLUMN priority_until_ms INTEGER NOT NULL DEFAULT 0');
    }
    initializedDatabases.add(databasePath);
  }
  return database;
}

export function saveCachedRow(databasePath: string, instance: string, row: FleetTableRow, fetchedAtMs = Date.now()): void {
  const database = openDatabase(databasePath);
  try {
    database.prepare(`
      INSERT INTO fleet_snapshot_cache (instance, entry_id, contract_address, row_json, fetched_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(instance, entry_id) DO UPDATE SET
        contract_address = excluded.contract_address,
        row_json = excluded.row_json,
        fetched_at_ms = excluded.fetched_at_ms
    `).run(instance, row.entry.id, row.entry.contractAddress, JSON.stringify(row), fetchedAtMs);
  } finally {
    database.close();
  }
}

export function loadCachedRows(databasePath: string, instance: string): CachedFleetRow[] {
  const database = openDatabase(databasePath);
  try {
    const rows = database.prepare(`
      SELECT row_json, fetched_at_ms
      FROM fleet_snapshot_cache
      WHERE instance = ?
      ORDER BY entry_id
    `).all(instance) as Array<{ row_json: string; fetched_at_ms: number }>;
    return rows.flatMap((value) => {
      try {
        const row = JSON.parse(value.row_json) as FleetTableRow;
        if (!row || typeof row !== 'object' || typeof row.entry?.id !== 'string' || typeof row.entry?.contractAddress !== 'string' || !row.snapshot) return [];
        return [{ row, fetchedAtMs: Number(value.fetched_at_ms) }];
      } catch {
        return [];
      }
    });
  } finally {
    database.close();
  }
}

export function getRpcRequestsPerSecond(databasePath: string): number {
  const database = openDatabase(databasePath);
  try {
    const row = database.prepare('SELECT requests_per_second FROM rpc_limiter_config WHERE singleton = 1').get() as { requests_per_second: number };
    return Number(row.requests_per_second);
  } finally {
    database.close();
  }
}

export function setRpcRequestsPerSecond(databasePath: string, requestsPerSecond: number): void {
  if (!Number.isFinite(requestsPerSecond) || requestsPerSecond < MIN_RPC_REQUESTS_PER_SECOND || requestsPerSecond > MAX_RPC_REQUESTS_PER_SECOND) {
    throw new Error(`Fleet Rental Bot 2 RPC rate must be between ${MIN_RPC_REQUESTS_PER_SECOND} and ${MAX_RPC_REQUESTS_PER_SECOND} requests per second`);
  }
  const database = openDatabase(databasePath);
  try {
    database.prepare('UPDATE rpc_limiter_config SET requests_per_second = ? WHERE singleton = 1').run(requestsPerSecond);
  } finally {
    database.close();
  }
}

export interface RpcSlotClaim {
  claimed: boolean;
  waitMs: number;
}

export function tryClaimRpcSlot(databasePath: string, nowMs = Date.now(), urgent = false): RpcSlotClaim {
  const database = openDatabase(databasePath);
  try {
    database.exec('BEGIN IMMEDIATE');
    const config = database.prepare('SELECT requests_per_second FROM rpc_limiter_config WHERE singleton = 1').get() as { requests_per_second: number };
    const state = database.prepare(`
      SELECT next_slot_ms, blocked_until_ms, priority_until_ms
      FROM rpc_limiter_state WHERE singleton = 1
    `).get() as { next_slot_ms: number; blocked_until_ms: number; priority_until_ms: number };
    const priorityWaitMs = urgent ? 0 : Math.max(0, Number(state.priority_until_ms) - nowMs);
    const availableAtMs = Math.max(Number(state.next_slot_ms), Number(state.blocked_until_ms));
    const waitMs = Math.max(priorityWaitMs, availableAtMs - nowMs, 0);
    if (waitMs > 0) {
      database.exec('COMMIT');
      return { claimed: false, waitMs };
    }
    const intervalMs = Math.ceil(1_000 / Number(config.requests_per_second));
    database.prepare('UPDATE rpc_limiter_state SET next_slot_ms = ? WHERE singleton = 1').run(nowMs + intervalMs);
    database.exec('COMMIT');
    return { claimed: true, waitMs: 0 };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    database.close();
  }
}

export function deferNormalRpcUntil(databasePath: string, priorityUntilMs: number): void {
  const database = openDatabase(databasePath);
  try {
    database.prepare(`
      UPDATE rpc_limiter_state
      SET priority_until_ms = MAX(priority_until_ms, ?)
      WHERE singleton = 1
    `).run(priorityUntilMs);
  } finally {
    database.close();
  }
}

export function deferRpcUntil(databasePath: string, blockedUntilMs: number): void {
  const database = openDatabase(databasePath);
  try {
    database.prepare(`
      UPDATE rpc_limiter_state
      SET blocked_until_ms = MAX(blocked_until_ms, ?),
          next_slot_ms = MAX(next_slot_ms, ?)
      WHERE singleton = 1
    `).run(blockedUntilMs, blockedUntilMs);
  } finally {
    database.close();
  }
}
