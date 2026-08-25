import {
  estimateDefenderBonusAtlas,
  estimatePoints,
  holdingFraction,
  recommendAction,
} from './metrics.js';
import type { FleetContractSnapshot, FleetTableRow, FleetWatchEntry, WalletPosition } from './model.js';

export function buildFleetTableRow(
  entry: FleetWatchEntry,
  snapshot: FleetContractSnapshot,
  position: WalletPosition,
  nowMs = Date.now(),
): FleetTableRow {
  const rentalCostAtlas = snapshot.rentalRateAtlasPerDay;
  const heldFraction = position.status === 'defending'
    ? holdingFraction(position.reservedAtMs, snapshot.activeRentalEndsAtMs, nowMs)
    : null;
  const reservationAgeMs = position.reservedAtMs == null ? null : Math.max(0, nowMs - position.reservedAtMs);
  const maximumRemainingLockMs = snapshot.activeRentalEndsAtMs == null
    ? null
    : Math.max(0, snapshot.activeRentalEndsAtMs - nowMs);
  const defenderBid = position.status === 'defending' && snapshot.reservationCurrency === 'ATLAS'
    ? snapshot.reservationBidAtlas
    : null;
  const bonusIfOutbidNowAtlas = defenderBid != null && snapshot.minimumTakeoverBidAtlas != null && heldFraction != null
    ? estimateDefenderBonusAtlas(defenderBid, snapshot.minimumTakeoverBidAtlas, heldFraction)
    : null;
  const projectedExpiryFloorBonusAtlas = defenderBid != null && snapshot.projectedExpiryTakeoverBidAtlas != null
    ? estimateDefenderBonusAtlas(defenderBid, snapshot.projectedExpiryTakeoverBidAtlas, 1)
    : null;
  const estimatedPoints = estimatePoints(
    snapshot.basePointsPerDay,
    snapshot.fleetWeight,
    entry.requestedDurationSeconds,
  );

  return {
    entry,
    snapshot,
    position,
    rentalCostAtlas,
    netOperatingValueAtlas: entry.estimatedOperatingValueAtlas == null
      ? null
      : entry.estimatedOperatingValueAtlas - rentalCostAtlas,
    reservationAgeMs,
    holdingFraction: heldFraction,
    bonusIfOutbidNowAtlas,
    projectedExpiryFloorBonusAtlas,
    maximumRemainingLockMs,
    estimatedPoints,
    pointsPerThousandAtlas: rentalCostAtlas > 0 ? snapshot.effectivePointsPerDay / rentalCostAtlas * 1_000 : null,
    recommendation: recommendAction(entry, snapshot, position),
  };
}
