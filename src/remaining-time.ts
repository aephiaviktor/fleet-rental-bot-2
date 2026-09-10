export function formatRemainingRentalTime(endsAtMs: number | null, nowMs = Date.now()): string {
  if (endsAtMs == null) return '—';
  const remainingHours = Math.floor(Math.max(0, endsAtMs - nowMs) / 3_600_000);
  return `${Math.floor(remainingHours / 24)}d ${remainingHours % 24}h`;
}
