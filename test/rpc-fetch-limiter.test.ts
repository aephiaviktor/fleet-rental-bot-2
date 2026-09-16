import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLimitedRpcFetch, withUrgentRpcPriority } from '../src/rpc-fetch-limiter.js';
import { deferNormalRpcUntil, readRpcUsageDay } from '../src/fleet-database.js';

async function temporaryDatabase(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-rental-bot-2-fetch-'));
  return { path: join(directory, 'shared.sqlite'), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('paces JSON-RPC requests, retries reads, and records each wire attempt', async () => {
  const database = await temporaryDatabase();
  let nowMs = Date.parse('2026-09-16T10:00:00Z');
  const sleeps: number[] = [];
  const calls: number[] = [];
  const responses = [
    new Response('{}', { status: 429, headers: { 'retry-after': '0.5' } }),
    new Response('{"jsonrpc":"2.0","result":{}}', { status: 200 }),
  ];
  try {
    const limitedFetch = createLimitedRpcFetch(database.path, 'MUD', async () => {
      calls.push(nowMs);
      return responses.shift()!;
    }, {
      now: () => nowMs,
      sleep: async (delayMs) => { sleeps.push(delayMs); nowMs += delayMs; },
    });
    const response = await limitedFetch('https://rpc.example.test', {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [Date.parse('2026-09-16T10:00:00Z'), Date.parse('2026-09-16T10:00:00.500Z')]);
    assert.deepEqual(sleeps, [500]);
    assert.deepEqual(readRpcUsageDay(database.path, '2026-09-16'), {
      utcDate: '2026-09-16',
      available: true,
      availableDates: ['2026-09-16'],
      totalRequests: 2,
      totalRetries: 1,
      rows: [{ instance: 'MUD', method: 'getAccountInfo', provider: 'Direct RPC', requests: 2, retries: 1 }],
      lastUpdatedAt: Date.parse('2026-09-16T10:00:00.500Z'),
    });
  } finally {
    await database.cleanup();
  }
});

test('lets urgent LCFS requests bypass the normal-refresh priority pause', async () => {
  const database = await temporaryDatabase();
  const sleeps: number[] = [];
  let calls = 0;
  try {
    deferNormalRpcUntil(database.path, Date.now() + 5_000);
    const limitedFetch = createLimitedRpcFetch(database.path, 'ONI', async () => {
      calls += 1;
      return new Response('{"jsonrpc":"2.0","result":{}}', { status: 200 });
    }, { sleep: async (delayMs) => { sleeps.push(delayMs); } });
    await withUrgentRpcPriority(database.path, () => limitedFetch('https://rpc.example.test', {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [] }),
    }));
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
  } finally {
    await database.cleanup();
  }
});

test('does not automatically retry transaction submission after a 429', async () => {
  const database = await temporaryDatabase();
  let calls = 0;
  const nowMs = Date.parse('2026-09-16T11:00:00Z');
  try {
    const limitedFetch = createLimitedRpcFetch(database.path, 'USTUR', async () => {
      calls += 1;
      return new Response('{}', { status: 429, headers: { 'retry-after': '1' } });
    }, { now: () => nowMs });
    const response = await limitedFetch('https://sender.helius-rpc.com/fast', {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [] }),
    });
    assert.equal(response.status, 429);
    assert.equal(calls, 1);
    assert.deepEqual(readRpcUsageDay(database.path, '2026-09-16').rows, [
      { instance: 'USTUR', method: 'sendTransaction', provider: 'Helius Sender', requests: 1, retries: 0 },
    ]);
  } finally {
    await database.cleanup();
  }
});

test('usage telemetry stores only safe dimensions and validates UTC dates', async () => {
  const database = await temporaryDatabase();
  try {
    const limitedFetch = createLimitedRpcFetch(database.path, 'MUD', async () => new Response('{}', { status: 200 }), {
      now: () => Date.parse('2026-09-16T12:00:00Z'),
    });
    await limitedFetch('https://rpc.example.test/?api-key=secret', {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'https://secret.invalid', params: ['wallet-secret'] }),
    });
    const usage = readRpcUsageDay(database.path, '2026-09-16');
    assert.deepEqual(usage.rows, [
      { instance: 'MUD', method: 'unknown', provider: 'Direct RPC', requests: 1, retries: 0 },
    ]);
    assert.equal(JSON.stringify(usage).includes('secret'), false);
    assert.throws(() => readRpcUsageDay(database.path, '../2026-09-16'), /invalid UTC date/);
    assert.deepEqual(readRpcUsageDay(database.path, '2026-09-15'), {
      utcDate: '2026-09-15', available: false, availableDates: ['2026-09-16'], totalRequests: null,
      totalRetries: null, rows: [], lastUpdatedAt: null,
    });
  } finally {
    await database.cleanup();
  }
});
