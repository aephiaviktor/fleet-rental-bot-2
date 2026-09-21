/* Shared pure display helpers, also exercised by the Node regression tests. */
globalThis.RulesDisplay = {
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
};
