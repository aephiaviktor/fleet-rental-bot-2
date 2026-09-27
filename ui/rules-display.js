/* Shared pure display helpers, also exercised by the Node regression tests. */
globalThis.RulesDisplay = {
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
