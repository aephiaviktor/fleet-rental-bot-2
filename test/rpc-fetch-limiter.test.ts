import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLimitedRpcFetch, withUrgentRpcPriority } from '../src/rpc-fetch-limiter.js';
import { deferNormalRpcUntil } from '../src/fleet-database.js';

async function temporaryDatabase(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-rental-bot-2-fetch-'));
  return { path: join(directory, 'shared.sqlite'), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('paces JSON-RPC requests and retries reads after a shared Retry-After cooldown', async () => {
  const database = await temporaryDatabase();
  let nowMs = 10_000;
  const sleeps: number[] = [];
  const calls: number[] = [];
  const responses = [
    new Response('{}', { status: 429, headers: { 'retry-after': '0.5' } }),
    new Response('{"jsonrpc":"2.0","result":{}}', { status: 200 }),
  ];
  try {
    const limitedFetch = createLimitedRpcFetch(database.path, async () => {
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
    assert.deepEqual(calls, [10_000, 10_500]);
    assert.deepEqual(sleeps, [500]);
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
    const limitedFetch = createLimitedRpcFetch(database.path, async () => {
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
  try {
    const limitedFetch = createLimitedRpcFetch(database.path, async () => {
      calls += 1;
      return new Response('{}', { status: 429, headers: { 'retry-after': '1' } });
    });
    const response = await limitedFetch('https://sender.example.test', {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [] }),
    });
    assert.equal(response.status, 429);
    assert.equal(calls, 1);
  } finally {
    await database.cleanup();
  }
});
