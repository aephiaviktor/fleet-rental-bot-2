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
  const durationDays = entry.requestedDurationSeconds / 86_400;
  const takeoverPremiumAtlas = snapshot.minimumTakeoverBidAtlas;
  const reservationPremiumPerDayAtlas = takeoverPremiumAtlas == null || durationDays <= 0
    ? null
    : takeoverPremiumAtlas / durationDays;
  const heldFraction = holdingFraction(snapshot.reservationCreatedAtMs, snapshot.activeRentalEndsAtMs, nowMs);
  const reservationAgeMs = snapshot.reservationCreatedAtMs == null
    ? null
    : Math.max(0, nowMs - snapshot.reservationCreatedAtMs);
  const maximumRemainingLockMs = snapshot.activeRentalEndsAtMs == null
    ? null
    : Math.max(0, snapshot.activeRentalEndsAtMs - nowMs);
  const defenderBid = snapshot.reservationCurrency === 'ATLAS'
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
    reservationPremiumPerDayAtlas,
    allInCostPerDayAtlas: reservationPremiumPerDayAtlas == null
      ? null
      : rentalCostAtlas + reservationPremiumPerDayAtlas,
    defenderPrincipalRefundAtlas: defenderBid,
    ownerPremiumShareIfOutbidNowAtlas: defenderBid == null || takeoverPremiumAtlas == null || bonusIfOutbidNowAtlas == null
      ? null
      : Math.max(0, takeoverPremiumAtlas - defenderBid - bonusIfOutbidNowAtlas),
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
