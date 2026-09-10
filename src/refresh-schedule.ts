const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const REFRESH_CADENCES_MS = Object.freeze({
  normal: 6 * HOUR_MS,
  withinDay: HOUR_MS,
  withinHour: 10 * MINUTE_MS,
  withinFiveMinutes: MINUTE_MS,
});

export function refreshCadenceMs(activeRentalEndsAtMs: number | null, nowMs = Date.now()): number {
  if (activeRentalEndsAtMs === null || !Number.isFinite(activeRentalEndsAtMs)) return REFRESH_CADENCES_MS.normal;
  const remainingMs = activeRentalEndsAtMs - nowMs;
  if (remainingMs <= 5 * MINUTE_MS) return REFRESH_CADENCES_MS.withinFiveMinutes;
  if (remainingMs <= HOUR_MS) return REFRESH_CADENCES_MS.withinHour;
  if (remainingMs <= DAY_MS) return REFRESH_CADENCES_MS.withinDay;
  return REFRESH_CADENCES_MS.normal;
}

function delayToNextThreshold(activeRentalEndsAtMs: number | null, nowMs: number): number {
  if (activeRentalEndsAtMs === null || !Number.isFinite(activeRentalEndsAtMs)) return Number.POSITIVE_INFINITY;
  const remainingMs = activeRentalEndsAtMs - nowMs;
  if (remainingMs > DAY_MS) return remainingMs - DAY_MS;
  if (remainingMs > HOUR_MS) return remainingMs - HOUR_MS;
  if (remainingMs > 5 * MINUTE_MS) return remainingMs - 5 * MINUTE_MS;
  return Number.POSITIVE_INFINITY;
}

export function nextRefreshDelayMs(activeRentalEndTimesMs: Array<number | null>, nowMs = Date.now()): number {
  if (!activeRentalEndTimesMs.length) return REFRESH_CADENCES_MS.normal;
  return Math.max(SECOND_MS, Math.min(...activeRentalEndTimesMs.map((endsAtMs) => Math.min(
    refreshCadenceMs(endsAtMs, nowMs),
    delayToNextThreshold(endsAtMs, nowMs),
  ))));
}
