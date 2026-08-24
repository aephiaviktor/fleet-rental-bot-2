import type { FleetContractSnapshot, FleetWatchEntry, WalletPosition } from './model.js';

export type ReservationBlockReason =
  | 'disabled'
  | 'unsafe-operation'
  | 'rental-rate-limit'
  | 'bid-limit'
  | 'no-active-rental'
  | 'stale-snapshot'
  | 'minimum-bid-unavailable';

export type AtlasReservationPlan =
  | {
      kind: 'ready';
      action: 'reserve' | 'rebid';
      contractAddress: string;
      bidAtlas: number;
      requestedDurationSeconds: number;
      maximumBidAtlas: number;
      maximumRentalRateAtlasPerDay: number;
      activeRentalEndsAtMs: number;
      expiresAtMs: number;
    }
  | { kind: 'blocked'; reason: ReservationBlockReason; detail: string };

const blocked = (reason: ReservationBlockReason, detail: string): AtlasReservationPlan => ({ kind: 'blocked', reason, detail });

export function planAtlasReservation(
  entry: FleetWatchEntry,
  snapshot: FleetContractSnapshot,
  position: WalletPosition,
  nowMs = Date.now(),
): AtlasReservationPlan {
  if (!entry.enabled) return blocked('disabled', 'Fleet is disabled');
  if (!entry.canSafelyOperate) return blocked('unsafe-operation', 'Fleet is not marked safe to operate');
  if (snapshot.rentalRateAtlasPerDay > entry.maximumRentalRateAtlasPerDay) {
    return blocked(
      'rental-rate-limit',
      `Rental rate ${snapshot.rentalRateAtlasPerDay} exceeds maximum ${entry.maximumRentalRateAtlasPerDay}`,
    );
  }
  if (snapshot.activeRentalEndsAtMs == null) return blocked('no-active-rental', 'Contract has no active rental to queue behind');
  if (snapshot.activeRentalEndsAtMs <= nowMs) return blocked('stale-snapshot', 'Active rental has already ended; refresh required');
  const bidAtlas = snapshot.minimumTakeoverBidAtlas;
  if (bidAtlas == null || !Number.isFinite(bidAtlas) || bidAtlas < 0) {
    return blocked('minimum-bid-unavailable', 'Live minimum ATLAS bid is unavailable');
  }
  if (bidAtlas > entry.maximumReservationBidAtlas) {
    return blocked('bid-limit', `Minimum ATLAS bid ${bidAtlas} exceeds maximum ${entry.maximumReservationBidAtlas}`);
  }

  return {
    kind: 'ready',
    action: position.status === 'defending' ? 'rebid' : 'reserve',
    contractAddress: entry.contractAddress,
    bidAtlas,
    requestedDurationSeconds: entry.requestedDurationSeconds,
    maximumBidAtlas: entry.maximumReservationBidAtlas,
    maximumRentalRateAtlasPerDay: entry.maximumRentalRateAtlasPerDay,
    activeRentalEndsAtMs: snapshot.activeRentalEndsAtMs,
    expiresAtMs: snapshot.activeRentalEndsAtMs,
  };
}
