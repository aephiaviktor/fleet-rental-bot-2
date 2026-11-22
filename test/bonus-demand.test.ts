import assert from 'node:assert/strict';
import test from 'node:test';
import { lastReservationDemand } from '../src/bonus-demand.js';
import type { HistoryEvidence } from '../src/history-backfill.js';

const contract = 'contract';
const rentalState = 'active';
const borrower = 'renter';
const close = (seconds = 1_020) => event('RentalClosed', seconds, { rentalState, borrower });
const accepted = (endTime = 1_000) => event('RentalAccepted', 100, { rentalState, borrower, startTime: 100n, endTime: BigInt(endTime) });
const placed = (seconds: number, profile: string | null) => event('ReservationPlaced', seconds, { rentalState: 'queue' }, profile);

function event(type: string, seconds: number, fields: object = {}, reservationProfile?: string | null): HistoryEvidence {
  return { event: { type, contract, ...fields }, at: seconds * 1_000, slot: seconds, index: 0, signature: 'signature', keys: [], reservationProfile };
}

test('counts distinct verified profiles in the final minute of the latest closed rental', () => {
  const entries = [
    placed(1_200, 'next-cycle'),
    close(),
    placed(1_012, 'keeper-delay'),
    placed(1_000, 'upper-bound'),
    placed(999, 'profile-a'),
    placed(985, 'profile-a'),
    placed(950, null),
    placed(940, 'profile-b'),
    placed(939, 'previous-minute'),
    accepted(),
    close(99),
    placed(90, 'older-profile'),
  ];
  assert.equal(lastReservationDemand(contract, entries), 2);
  assert.equal(lastReservationDemand(contract, entries.filter(item => item.reservationProfile !== 'profile-b')), 1);
});

test('uses the revised reservation deadline after a rental cancellation', () => {
  assert.equal(lastReservationDemand(contract, [
    close(920), placed(897, 'rival-a'),
    event('RentalCancelled', 890, { rentalState, borrower, newEndTime: 900n }),
    placed(841, 'rival-b'), placed(839, 'too-early'), accepted(1_200),
  ]), 2);
});

test('rejects new contracts and incomplete history and ignores a same-renter handover', () => {
  assert.equal(lastReservationDemand(contract, [placed(999, 'profile-a'), event('ContractCreated', 100)]), null);
  assert.equal(lastReservationDemand(contract, [close(), placed(970, 'profile-a')]), undefined);
  const newRental = event('RentalAccepted', 1_020, { rentalState, borrower, startTime: 1_000n, endTime: 2_000n });
  assert.equal(lastReservationDemand(contract, [close(), newRental, placed(970, 'profile-a'), accepted()]), 1);
});
