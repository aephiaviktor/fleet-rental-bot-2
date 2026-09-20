/* Shared pure display helpers, also exercised by the Node regression tests. */
globalThis.RulesDisplay = {
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
