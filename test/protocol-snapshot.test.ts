import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContractSnapshot } from '@sly-rentals/core';
import { deriveWalletPosition, mapContractSnapshot } from '../src/protocol-snapshot.js';

function fixture(): ContractSnapshot {
  return {
    config: { address: 'config' as never, data: {
      stardustToAtlas: 100_000_000n,
      pointsPerDay: 1_000_000_000n,
      captureRateBps: 10_500n,
      contestedMultiplierMaxBps: 110,
    } as never },
    contract: { address: 'contract' as never, data: { weight: 3 } as never },
    activeRental: { address: 'active' as never, data: { endTime: 2_000n } as never },
    queuedRental: { address: 'queued' as never, data: {
      borrower: { toString: () => 'wallet-1' },
      bidAtlas: 2_500_000_000n,
      bidPoints: 0n,
      createdAt: 1_000n,
    } as never },
    minimumBid: { atlas: 2_625_000_000n, points: 26_250_000n, current: { atlas: 2_500_000_000n, points: 0n }, now: 1_500 },
    nowSeconds: 1_500,
    effectiveRate: 9_000_000_000n,
  };
}

test('maps official SRSLY snapshot units without losing reservation currency', () => {
  const mapped = mapContractSnapshot(fixture());
  assert.equal(mapped.rentalRateAtlasPerDay, 90);
  assert.equal(mapped.reservationCurrency, 'ATLAS');
  assert.equal(mapped.reservationBidAtlas, 25);
  assert.equal(mapped.minimumTakeoverBidAtlas, 26.25);
  assert.equal(mapped.projectedExpiryTakeoverBidAtlas, 99);
  assert.equal(mapped.activeRentalEndsAtMs, 2_000_000);
  assert.equal(mapped.basePointsPerDay, 10);
  assert.equal(mapped.effectivePointsPerDay, 30);
});

test('derives locked ATLAS only when this wallet is the defender', () => {
  const mapped = mapContractSnapshot(fixture());
  assert.deepEqual(deriveWalletPosition(mapped, 'wallet-1'), {
    status: 'defending', atlasLocked: 25, reservedAtMs: 1_000_000,
  });
  assert.deepEqual(deriveWalletPosition(mapped, 'someone-else'), {
    status: 'none', atlasLocked: 0, reservedAtMs: null,
  });
});

test('preserves points reservations and does not report ATLAS as locked', () => {
  const raw = fixture();
  raw.queuedRental = { ...raw.queuedRental!, data: {
    ...raw.queuedRental!.data, bidAtlas: 0n, bidPoints: 400_000_000n,
  }};
  const mapped = mapContractSnapshot(raw);
  assert.equal(mapped.reservationCurrency, 'POINTS');
  assert.equal(mapped.reservationBidPoints, 4);
  assert.equal(deriveWalletPosition(mapped, 'wallet-1').atlasLocked, 0);
});
