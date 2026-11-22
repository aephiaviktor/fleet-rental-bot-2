import assert from 'node:assert/strict';
import test from 'node:test';
import { address, getCompiledTransactionMessageDecoder, getTransactionDecoder, type Instruction } from '@solana/kit';
import type { ContractSnapshot } from '@sly-rentals/core';
import { DEFAULT_SETTINGS } from '../src/settings-store.js';
import { mapContractSnapshot } from '../src/protocol-snapshot.js';
import { buildFleetTableRow } from '../src/table-row.js';
import { NEXT_GEN_SRSLY_PROGRAM_ID, type FleetWatchEntry } from '../src/model.js';
import { checkReservationPreflight, classifyReservationSimulation, collectReservationPreflights } from '../src/reservation-preflight.js';

const wallet = 'So11111111111111111111111111111111111111112';
const rental: Instruction = { programAddress: address(NEXT_GEN_SRSLY_PROGRAM_ID), data: Uint8Array.of(1) };
const settings = { ...DEFAULT_SETTINGS, walletAddress: wallet, playerProfile: wallet, useHeliusSender: true, rpcUrl: 'https://rpc.example.test' };
const entry: FleetWatchEntry = { id: 'one', label: 'Fleet', contractAddress: wallet, requestedDurationSeconds: 86_400,
  estimatedNetValueAtlas: null, maximumRentalRateAtlasPerDay: 100, maximumReservationBidAtlas: 10,
  enabled: true, canSafelyOperate: true, lcfs: true, comment: '' };
const snapshotAt = (endSeconds: number) => ({
  config: { data: { stardustToAtlas: 100_000_000n, pointsPerDay: 1_000_000_000n, captureRateBps: 10500n,
    contestedMultiplierMaxBps: 110, atlasPerPoint: 100n, minCaptureThreshold: 100_000_000n, reservationsEnabled: true } },
  contract: { data: { weight: 1, reservationsDisabled: false, rate: 2_500_000_000n, durationMinSeconds: 3600n, durationMaxSeconds: 8_035_200n } },
  activeRental: { address: wallet, data: { borrower: wallet, startTime: BigInt(endSeconds - 3600), endTime: BigInt(endSeconds) } },
  queuedRental: null, nowSeconds: endSeconds - 1800, effectiveRate: 2_500_000_000n,
}) as unknown as ContractSnapshot;

const position = { status: 'none', reservedAtMs: null, atlasLocked: null } as const;

test('real preflight compiles the LCFS tip and priority fee, withholds simulation for a known SOL shortfall, and reports account rent errors', async () => {
  const snapshot = snapshotAt(Math.ceil(Date.now() / 1000) + 3600);
  const row = buildFleetTableRow(entry, mapContractSnapshot(snapshot), position);
  const dependencies = { loadSnapshot: async () => snapshot, build: async () => [rental] };
  const methods: string[] = [];
  let walletBalance = 205_299;
  let simulationError: unknown = { InsufficientFundsForRent: { account_index: 2 } };
  const initialFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    methods.push(request.method);
    let value: unknown;
    switch (request.method) {
      case 'getBalance': value = walletBalance; break;
      case 'getLatestBlockhash': value = { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 }; break;
      case 'getFeeForMessage': {
        const compiled = getCompiledTransactionMessageDecoder().decode(Buffer.from(request.params[0], 'base64'));
        const [price, tip] = compiled.instructions;
        assert.equal(Buffer.from(price.data!).readBigUInt64LE(1), 1000n);
        assert.equal(Buffer.from(tip.data!).readBigUInt64LE(4), 200_000n);
        value = 5300;
        break;
      }
      case 'simulateTransaction': {
        const tx = getTransactionDecoder().decode(Buffer.from(request.params[0], 'base64'));
        assert.ok(Object.values(tx.signatures).every(signature => signature === null));
        assert.equal(request.params[1].sigVerify, false);
        assert.equal(request.params[1].replaceRecentBlockhash, true);
        value = { err: simulationError, logs: [] };
        break;
      }
      default: throw new Error(`Unexpected RPC method ${request.method}`);
    }
    return Response.json({ jsonrpc: '2.0', id: request.id, result: { context: { slot: 10 }, value } });
  };
  try {
    const check = () => checkReservationPreflight(row, settings, new AbortController().signal, dependencies);
    const low = await check();
    assert.equal(low.status, 'low-sol');
    assert.match(low.detail, /0\.0002053 SOL/);
    assert.ok(!methods.includes('simulateTransaction'));
    walletBalance++;
    assert.equal((await check()).status, 'low-sol');
    simulationError = { InstructionError: [2, { Custom: 6053 }] };
    assert.equal((await check()).status, 'missing-account');
    simulationError = { InstructionError: [2, { Custom: 6026 }] };
    assert.equal((await check()).status, 'authority');
    simulationError = null;
    assert.equal((await check()).status, 'passed');
    assert.ok(!methods.includes('sendTransaction'));
  } finally {
    globalThis.fetch = initialFetch;
  }
});

test('simulation distinguishes system rent debits from SPL token errors and SRSLY codes from unrelated programs', () => {
  assert.equal(classifyReservationSimulation({ InstructionError: [0, { Custom: 1 }] }, ['Program log: Error: insufficient funds'], [rental]).status, 'simulation-failed');
  assert.equal(classifyReservationSimulation({ InstructionError: [0, { Custom: 1 }] }, ['Program log: Create Account: insufficient lamports 1, need 5'], [rental]).status, 'low-sol');
  assert.equal(classifyReservationSimulation({ InstructionError: [0, { Custom: 6053 }] }, [], [{ programAddress: address(wallet) }]).status, 'simulation-failed');
  assert.equal(classifyReservationSimulation('BlockhashNotFound', [], [rental]).status, 'unavailable');
});

test('background preflight yields when a different fleet has an imminent LCFS attempt', async () => {
  const now = Date.now();
  const early = buildFleetTableRow(entry, mapContractSnapshot(snapshotAt(Math.ceil(now / 1000) + 40)), position);
  const later = buildFleetTableRow({ ...entry, id: 'two' }, mapContractSnapshot(snapshotAt(Math.ceil(now / 1000) + 3600)), position);
  let calls = 0;
  const initialFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected RPC before close'); };
  try {
    assert.equal(collectReservationPreflights([later, early], settings, now).size, 0);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = initialFetch;
  }
});
