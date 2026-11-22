/* Shared pure display helpers, also exercised by the Node regression tests. */
globalThis.RulesDisplay = {
  preflightLabel(status) {
    switch (status) {
      case 'low-sol': return 'Low SOL';
      case 'missing-account': return 'Missing account';
      case 'authority': return 'Check authority';
      case 'simulation-failed': return 'Simulation failed';
      case 'unavailable': return 'Simulation unavailable';
      case 'stale': return 'Fleet data changed';
      default: return null;
    }
  },
  fundingLabel(estimate) {
    if (estimate?.status === 'bid-limit') return 'Bid limit';
    if (estimate?.status === 'rate-limit') return 'Rate limit';
    if (estimate?.status === 'ready') return 'Ready';
    if (estimate?.status === 'short' && Number.isFinite(estimate.shortfallAtlas)) {
      const amount = Math.ceil(estimate.shortfallAtlas * 100) / 100;
      return `Short ${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ATLAS`;
    }
    return 'Unknown';
  },
  allowedDays(snapshot) {
    const min = snapshot?.minimumDurationSeconds, max = snapshot?.maximumDurationSeconds;
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max < min) return '—';
    const days = seconds => (seconds / 86400).toLocaleString(undefined, { maximumFractionDigits: 6 });
    return `${days(min)}–${days(max)}`;
  },
  durationWarning(requestedSeconds, snapshot) {
    const range = RulesDisplay.allowedDays(snapshot);
    if (range === '—' || !Number.isFinite(requestedSeconds)) return null;
    if (requestedSeconds >= snapshot.minimumDurationSeconds && requestedSeconds <= snapshot.maximumDurationSeconds) return null;
    const days = (requestedSeconds / 86400).toLocaleString(undefined, { maximumFractionDigits: 6 });
    return `Requested ${days} days. Allowed Days: ${range}.`;
  },
  cancelDelay(seconds) {
    if (!Number.isSafeInteger(seconds) || seconds < 0) return '—';
    if (seconds === 0) return 'Instant';
    const units = [[86400, 'd'], [3600, 'h'], [60, 'm'], [1, 's']];
    const parts = [];
    for (const [size, suffix] of units) {
      const amount = Math.floor(seconds / size);
      if (amount) parts.push(`${amount}${suffix}`);
      seconds %= size;
    }
    return parts.join(' ');
  },
  historyCurrency(row) {
    return row.bidSource === 'reservation' && row.bid === 0 && row.currency === 'Unknown'
      ? 'Points*' : row.currency || '—';
  },
  reservationCurrency(snapshot) {
    if (!snapshot?.reservationCurrency) return '—';
    if (snapshot.reservationBidAtlas === 0 && snapshot.reservationBidPoints === 0) return 'Points*';
    return snapshot.reservationCurrency === 'POINTS' ? 'Points' : snapshot.reservationCurrency === 'ATLAS' ? 'Atlas' : '—';
  },
  nextBid(value) { return Number.isFinite(value) && value >= 0 ? Math.ceil(Number(value.toFixed(8))) : null; },
  historyClass(status) {
    return status === 'Active' ? 'history-active' : status === 'Completed' ? 'history-completed' : '';
  },
  historyAllIn(row) {
    const days = (row.end - row.start) / 86400000;
    if (!Number.isFinite(row.rate) || row.rate < 0 || !Number.isFinite(row.bid) || row.bid < 0 || !Number.isFinite(days) || days <= 0) return null;
    if (row.bid === 0 || row.currency === 'Points') return row.rate;
    return row.currency === 'Atlas' ? row.rate + row.bid / days : null;
  },
  utc(value) {
    return Number.isFinite(value) && value > 0
      ? new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
      : 'Unknown end time';
  },
  sorted(entries, live) {
    const end = entry => {
      const result = live.get(entry.id);
      const value = result?.ok ? result.row.snapshot.activeRentalEndsAtMs : null;
      return Number.isFinite(value) && value > 0 ? value : Infinity;
    };
    return [...entries].sort((a, b) => end(a) - end(b));
  },
  lcfsOutcomeLines(entries, attempts, live, nowMs = Date.now()) {
    const cutoffMs = nowMs - 48 * 60 * 60 * 1000;
    const reservationEndMs = (entryId, key) => {
      const directPrefix = `${entryId}:`;
      if (key.startsWith(directPrefix)) {
        const value = Number(key.slice(directPrefix.length).split(':')[0]);
        return Number.isFinite(value) ? value : null;
      }
      const blockedPrefix = `blocked:${entryId}:`;
      if (key.startsWith(blockedPrefix)) {
        const value = Number(key.slice(blockedPrefix.length).split(':')[0]);
        return Number.isFinite(value) ? value * 1000 : null;
      }
      return null;
    };
    const line = (name, attempt) => {
      const detail = String(attempt.detail || '').trim().replace(/ exceeds maximum /g, ' exceeded maximum ');
      if (attempt.status === 'submitted') return `${name}: LCFS bid sent — transaction ${detail.slice(0, 10)}…`;
      if (attempt.status === 'started') return `${name}: LCFS bid outcome incomplete — ${detail || 'last recorded as in progress'}`;
      if (attempt.status === 'failed') return `${name}: LCFS bid failed — ${detail || 'unknown error'}`;
      return `${name}: no LCFS bid sent — ${detail || 'reason not recorded'}`;
    };
    const lines = [];
    for (const entry of entries) {
      const recent = attempts
        .map(attempt => ({ attempt, endMs: reservationEndMs(entry.id, String(attempt.key || '')) }))
        .filter(event => event.endMs !== null && event.endMs >= cutoffMs && event.endMs <= nowMs)
        .sort((a, b) => b.endMs - a.endMs || String(b.attempt.updatedAt || '').localeCompare(String(a.attempt.updatedAt || '')));
      if (!recent.length) continue;
      const fleetName = String(live.get(entry.id)?.row?.snapshot?.fleetName || '').trim();
      const name = fleetName || String(entry.label || '').trim() || entry.contractAddress || 'Unnamed fleet';
      lines.push(line(name, recent[0].attempt));
    }
    return lines;
  },
};
