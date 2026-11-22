import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { address } from '@solana/kit';
import type { ContractSnapshot } from '@sly-rentals/core';
import { NEXT_GEN_SRSLY_PROGRAM_ID } from '../src/model.js';
import { deriveWalletPosition, findChangedReservations, mapContractSnapshot } from '../src/protocol-snapshot.js';
import { rentalSdk } from '../src/rental-sdk.js';

function fixture(): ContractSnapshot {
  return {
    config: { address: 'config' as never, data: {
      stardustToAtlas: 100_000_000n,
      pointsPerDay: 1_000_000_000n,
      captureRateBps: 10_500n,
      contestedMultiplierMaxBps: 110,
      atlasPerPoint: 100n,
      minCaptureThreshold: 100_000_000n,
      reservationsEnabled: true,
    } as never },
    contract: { address: 'contract' as never, data: {
      weight: 3, reservationsDisabled: false, rate: 2_500_000_000n,
      durationMinSeconds: 3_600n, durationMaxSeconds: 8_035_200n, cancelDelayMin: 43_200n,
    } as never },
    activeRental: { address: 'active' as never, data: { startTime: 1_000n, endTime: 2_000n } as never },
    queuedRental: { address: 'queued' as never, data: {
      borrower: { toString: () => 'wallet-1' },
      bidAtlas: 2_500_000_000n,
      bidPoints: 0n,
      escrow: 18_000_000_000n,
      createdAt: 1_000n,
    } as never },
    minimumBid: { atlas: 2_625_000_000n, points: 26_250_000n, current: { atlas: 2_500_000_000n, points: 0n }, now: 1_500 },
    nowSeconds: 1_500,
    effectiveRate: 9_000_000_000n,
  };
}

test('maps official SRSLY snapshot units without losing reservation currency', () => {
  const mapped = mapContractSnapshot(fixture(), 'Chain Fleet');
  assert.equal(mapped.fleetName, 'Chain Fleet');
  assert.equal(mapped.rentalRateAtlasPerDay, 90);
  assert.equal(mapped.reservationsAllowed, true);
  assert.equal(mapped.minimumDurationSeconds, 3_600);
  assert.equal(mapped.maximumDurationSeconds, 8_035_200);
  assert.equal(mapped.cancelDelaySeconds, 43_200);
  assert.equal(mapped.reservationCurrency, 'ATLAS');
  assert.equal(mapped.reservationBidAtlas, 25);
  assert.equal(mapped.minimumTakeoverBidAtlas, 26.25);
  assert.equal(mapped.currentMinimumBidAtlas, 26.25);
  assert.equal(mapped.projectedExpiryTakeoverBidAtlas, 99);
  assert.equal(mapped.activeRentalEndsAtMs, 2_000_000);
  assert.equal(mapped.basePointsPerDay, 10);
  assert.equal(mapped.effectivePointsPerDay, 30);
});

test('derives locked ATLAS only when this wallet is the defender', () => {
  const mapped = mapContractSnapshot(fixture());
  assert.deepEqual(deriveWalletPosition(mapped, 'wallet-1'), {
    status: 'defending', atlasLocked: 205, reservedAtMs: 1_000_000,
  });
  assert.deepEqual(deriveWalletPosition(mapped, 'someone-else'), {
    status: 'none', atlasLocked: 0, reservedAtMs: null,
  });
});

test('finds new zero bids, takeovers, and removals in one queued rental account read', async () => {
  const { getRentalStateEncoder, RentalStatus } = createRequire(import.meta.url)('@sly-rentals/core/codama') as typeof import('@sly-rentals/core/codama');
  const contracts = ['11111111111111111111111111111111', 'So11111111111111111111111111111111111111112',
    NEXT_GEN_SRSLY_PROGRAM_ID, 'SysvarC1ock11111111111111111111111111111111'].map(address);
  const borrower = contracts[1];
  const base = { version: 2, bump: 255, borrower, borrowerState: borrower, borrowerProfile: borrower, rate: 25,
    lastPayment: 0, escrow: 1000, startTime: 0, endTime: 0, serviceFee: 0, feeBps: 0, referrer: null,
    discountBps: 0, bidPoints: 0, bidAtlas: 0, cancelDelayMin: 0, status: RentalStatus.Queued, updatedAt: 10, createdAt: 10 };
  function account(contract: ReturnType<typeof address>, bidAtlas = 0) {
    const bytes = getRentalStateEncoder().encode({ ...base, contract, bidAtlas });
    return { owner: NEXT_GEN_SRSLY_PROGRAM_ID, data: [Buffer.from(bytes).toString('base64'), 'base64'], executable: false, lamports: 1 };
  }
  const accounts = [account(contracts[0]), account(contracts[1], 12), null, account(contracts[3])];
  const queued = `${borrower}:10:0:0:1000`;
  const rows = [null, queued, queued, queued].map((reservationIdentity, i) => ({
    entry: { id: `${i}`, contractAddress: contracts[i] },
    snapshot: { reservationIdentity, reservationDefender: reservationIdentity ? borrower : null },
  }));
  const expectedAddresses = await Promise.all(contracts.map(contract => rentalSdk().deriveQueuedRental(contract, NEXT_GEN_SRSLY_PROGRAM_ID)));
  const savedFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const { id, method, params } = JSON.parse(String(init?.body));
    assert.equal(method, 'getMultipleAccounts');
    assert.deepEqual(params[0], expectedAddresses);
    return Response.json({ jsonrpc: '2.0', id, result: { context: { slot: 1 }, value: accounts } });
  };
  try {
    assert.deepEqual([...await findChangedReservations(rows, 'https://rpc.example.test')], ['0', '1', '2']);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('treats any owned player wallet (signer, main, or lancer) as the defender', () => {
  const mapped = mapContractSnapshot(fixture());
  // The defender 'wallet-1' is any one of the owned set.
  assert.deepEqual(deriveWalletPosition(mapped, ['signer', 'wallet-1']), {
    status: 'defending', atlasLocked: 205, reservedAtMs: 1_000_000,
  });
  assert.deepEqual(deriveWalletPosition(mapped, ['main-wallet', 'lancer-wallet', 'someone-else']), {
    status: 'none', atlasLocked: 0, reservedAtMs: null,
  });
});

test('shows unknown ownership as acquisition-first bidding unless the known signer is the defender', () => {
  const mapped = mapContractSnapshot(fixture());
  assert.deepEqual(deriveWalletPosition(mapped, { status: 'unknown', addresses: ['signer'] }), {
    status: 'unknown', atlasLocked: 0, reservedAtMs: null,
  });
  assert.deepEqual(deriveWalletPosition(mapped, { status: 'unknown', addresses: ['wallet-1'] }), {
    status: 'defending', atlasLocked: 205, reservedAtMs: 1_000_000,
  });
});

test('points reservations lock prepaid ATLAS rent but not an ATLAS-equivalent points bid', () => {
  const raw = fixture();
  raw.queuedRental = { ...raw.queuedRental!, data: {
    ...raw.queuedRental!.data, bidAtlas: 0n, bidPoints: 400_000_000n,
  }};
  const mapped = mapContractSnapshot(raw);
  assert.equal(mapped.reservationCurrency, 'POINTS');
  assert.equal(mapped.reservationBidPoints, 4);
  assert.equal(deriveWalletPosition(mapped, 'wallet-1').atlasLocked, 180);
});

test('uses configured 100 ATLAS per point for current and projected takeover floors', () => {
  const raw = fixture();
  raw.contract.data.rate = 149_900_000_000n;
  raw.activeRental = { ...raw.activeRental!, data: { startTime: 0n, endTime: 2_000n } as never };
  raw.queuedRental = { ...raw.queuedRental!, data: {
    ...raw.queuedRental!.data, bidAtlas: 0n, bidPoints: 400_000_000_000n,
  }};
  raw.nowSeconds = 1_999;

  const mapped = mapContractSnapshot(raw);
  assert.equal(mapped.reservationCurrency, 'POINTS');
  assert.equal(mapped.reservationBidPoints, 4_000);
  assert.equal(mapped.minimumTakeoverBidAtlas, 439_960);
  assert.equal(mapped.projectedExpiryTakeoverBidAtlas, 440_000);
});

test('uses the legal zero bid for the first reservation with no defender', () => {
  const raw = fixture();
  raw.queuedRental = null;
  const mapped = mapContractSnapshot(raw);
  assert.equal(mapped.minimumTakeoverBidAtlas, 0);
  assert.equal(mapped.minimumTakeoverBidPoints, 0);
  assert.equal(mapped.projectedExpiryTakeoverBidAtlas, null);
});

test('honours configured point conversion rather than hardcoding 100', () => {
  const raw = fixture();
  raw.config.data.atlasPerPoint = 50n;
  raw.queuedRental!.data.bidAtlas = 0n;
  raw.queuedRental!.data.bidPoints = 1_000_000_000n;
  const mapped = mapContractSnapshot(raw);
  assert.equal(mapped.minimumTakeoverBidAtlas, 525);
  assert.equal(mapped.projectedExpiryTakeoverBidAtlas, 550);
});

test('ten points require more than 1000 ATLAS with the configured takeover premium', () => {
  const raw = fixture();
  raw.queuedRental!.data.bidAtlas = 0n;
  raw.queuedRental!.data.bidPoints = 1_000_000_000n;
  const mapped = mapContractSnapshot(raw);
  assert.equal(mapped.minimumTakeoverBidAtlas, 1050);
  assert.equal(mapped.projectedExpiryTakeoverBidAtlas, 1100);
});

test('zero-bid reservations still lock rent and missing cached escrow stays unknown', () => {
  const raw = fixture();
  raw.queuedRental!.data.bidAtlas = 0n;
  const mapped = mapContractSnapshot(raw);
  assert.equal(deriveWalletPosition(mapped, 'wallet-1').atlasLocked, 180);
  delete mapped.reservationRentEscrowAtlas;
  assert.equal(deriveWalletPosition(mapped, 'wallet-1').atlasLocked, null);
  assert.equal(deriveWalletPosition(mapped, 'someone-else').atlasLocked, 0);
});

test('closing contracts reject reservations and rental identity changes even with the same end time', () => {
  const raw = fixture();
  raw.contract.data.toClose = true;
  const before = mapContractSnapshot(raw);
  assert.equal(before.reservationsAllowed, false);
  raw.activeRental!.data.startTime += 1n;
  const after = mapContractSnapshot(raw);
  assert.notEqual(before.activeRentalIdentity, after.activeRentalIdentity);
  assert.equal(before.activeRentalEndsAtMs, after.activeRentalEndsAtMs);
});
