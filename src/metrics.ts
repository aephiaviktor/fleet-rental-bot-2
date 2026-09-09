const SECONDS_PER_DAY = 86_400;

export function estimateRentalCostAtlas(rateAtlasPerDay: number, durationSeconds: number): number {
  if (rateAtlasPerDay < 0 || durationSeconds < 0) throw new Error('Rate and duration must be non-negative');
  return rateAtlasPerDay * durationSeconds / SECONDS_PER_DAY;
}

export function holdingFraction(reservedAtMs: number | null, activeRentalEndsAtMs: number | null, nowMs: number): number | null {
  if (reservedAtMs == null || activeRentalEndsAtMs == null || activeRentalEndsAtMs <= reservedAtMs) return null;
  return Math.max(0, Math.min(1, (nowMs - reservedAtMs) / (activeRentalEndsAtMs - reservedAtMs)));
}

export function estimateDefenderBonusAtlas(
  defenderBidAtlas: number,
  challengerBidAtlas: number,
  heldFraction: number,
  bonusMultiplier = 1,
): number {
  const difference = Math.max(0, challengerBidAtlas - defenderBidAtlas);
  return Math.min(difference, difference * Math.max(0, Math.min(1, heldFraction)) * Math.max(0, bonusMultiplier));
}

export function estimatePoints(pointsPerDay: number, fleetWeight: number, durationSeconds: number): number {
  if (pointsPerDay < 0 || fleetWeight < 0 || durationSeconds < 0) throw new Error('Points inputs must be non-negative');
  return pointsPerDay * fleetWeight * durationSeconds / SECONDS_PER_DAY;
}
