import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContractSnapshot } from '@sly-rentals/core';
import { buildUnsignedAtlasReservation } from '../src/unsigned-reservation.js';
import type { AtlasReservationPlan } from '../src/reservation-plan.js';

const plan: AtlasReservationPlan = {
  kind: 'ready', action: 'reserve',
  contractAddress: 'FiELMQBWWxRtv78dQQcpD2McCsrRZMhgbXETrH1EyMk7',
  bidAtlas: 95, requestedDurationSeconds: 86_400,
  maximumBidAtlas: 120, maximumRentalRateAtlasPerDay: 100,
  activeRentalEndsAtMs: 20_000, expiresAtMs: 20_000,
};
const wallet = 'Erdrp29yxiCVyYJgJtZz2ZYAbxiDV5UUDLNEZJsxSL7';
const profile = '11111111111111111111111111111111';
const snapshot = { contract: { data: { rate: 0n } } } as ContractSnapshot;

test('assembles official SDK parameters with a no-op signer and exact guarded values', async () => {
  let captured: Record<string, unknown> | null = null;
  const instructions = [{ programAddress: 'program', accounts: [], data: new Uint8Array() }];
  const result = await buildUnsignedAtlasReservation({
    plan, walletAddress: wallet, challengerProfile: profile,
    rpcUrl: 'https://api.mainnet-beta.solana.com', snapshot,
    initializeBorrower: async () => [],
    reserve: async (params) => { captured = params as unknown as Record<string, unknown>; return instructions as never; },
  });
  assert.deepEqual(result, instructions);
  assert.equal((captured!.challenger as { address: string }).address, wallet);
  assert.equal(captured!.challengerProfile, profile);
  assert.equal(captured!.contract, plan.contractAddress);
  assert.deepEqual(captured!.bidAtlas, { atlas: 95 });
  assert.deepEqual(captured!.duration, { seconds: 86_400 });
  assert.equal(captured!.autoMinBid, false);
  assert.equal(captured!.computeUnits, 300_000);
  assert.equal((captured!.rate as { stardust: bigint }).stardust, 0n);
});

test('unwraps the official SDK iterable instruction result', async () => {
  const instructions = [{ programAddress: 'program', accounts: [], data: new Uint8Array() }];
  const sdkResult = {
    instructions,
    *[Symbol.iterator]() { yield* instructions; },
  };
  const result = await buildUnsignedAtlasReservation({
    plan, walletAddress: wallet, challengerProfile: profile,
    rpcUrl: 'https://api.mainnet-beta.solana.com', snapshot,
    initializeBorrower: async () => [],
    reserve: async () => sdkResult,
  });
  assert.deepEqual(result, instructions);
});

test('prepends first-use borrower initialization before reserving', async () => {
  const initialize = [{ programAddress: 'initialize', accounts: [], data: new Uint8Array() }];
  const reserve = [{ programAddress: 'reserve', accounts: [], data: new Uint8Array() }];
  const result = await buildUnsignedAtlasReservation({
    plan, walletAddress: wallet, challengerProfile: profile,
    rpcUrl: 'https://api.mainnet-beta.solana.com', snapshot,
    initializeBorrower: async () => ({ *[Symbol.iterator]() { yield* initialize; } }),
    reserve: async () => ({ *[Symbol.iterator]() { yield* reserve; } }),
  });
  assert.deepEqual(result, [...initialize, ...reserve]);
});

test('refuses blocked plans and malformed wallet/profile addresses', async () => {
  const blocked: AtlasReservationPlan = { kind: 'blocked', reason: 'disabled', detail: 'disabled' };
  await assert.rejects(() => buildUnsignedAtlasReservation({ plan: blocked, walletAddress: wallet, challengerProfile: profile, rpcUrl: 'https://rpc', snapshot }), /ready reservation plan/);
  await assert.rejects(() => buildUnsignedAtlasReservation({ plan, walletAddress: 'bad', challengerProfile: profile, rpcUrl: 'https://rpc', snapshot }), /valid Solana address/);
  await assert.rejects(() => buildUnsignedAtlasReservation({ plan, walletAddress: wallet, challengerProfile: 'bad', rpcUrl: 'https://rpc', snapshot }), /valid Solana address/);
});
