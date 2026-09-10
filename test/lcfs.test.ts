import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { FleetContractSnapshot, FleetWatchEntry, WalletPosition } from '../src/model.js';
import { evaluateLcfsEligibility, executeLcfsAttempt, lcfsAttemptKey } from '../src/lcfs.js';
import { DEFAULT_SETTINGS, validateSettings } from '../src/settings-store.js';
import { parseWatchlist } from '../src/watchlist-store.js';

const entry: FleetWatchEntry = {
  id: 'fleet-1', label: 'Fleet One', contractAddress: 'FiELMQBWWxRtv78dQQcpD2McCsrRZMhgbXETrH1EyMk7',
  requestedDurationSeconds: 86_400, estimatedNetValueAtlas: null,
  maximumRentalRateAtlasPerDay: 100, maximumReservationBidAtlas: 20,
  canSafelyOperate: true, enabled: true, comment: '', lcfs: true,
};
const snapshot: FleetContractSnapshot = {
  reservationsAllowed: true, minimumDurationSeconds: 1, maximumDurationSeconds: 1_000_000,
  rentalRateAtlasPerDay: 100, activeRentalEndsAtMs: 10_000, reservationCurrency: 'ATLAS',
  reservationDefender: null, reservationBidAtlas: 10, reservationBidPoints: null,
  minimumTakeoverBidAtlas: 20, minimumTakeoverBidPoints: null,
  projectedExpiryTakeoverBidAtlas: 20, reservationCreatedAtMs: 1_000,
  fleetWeight: 1, basePointsPerDay: 1, effectivePointsPerDay: 1,
};
const position: WalletPosition = { status: 'none', atlasLocked: 0, reservedAtMs: null };

test('LCFS settings default to three seconds and require a non-negative integer', () => {
  assert.equal(DEFAULT_SETTINGS.lcfsLeadTimeSeconds, 3);
  const legacy = { ...DEFAULT_SETTINGS } as Partial<typeof DEFAULT_SETTINGS>;
  delete legacy.lcfsLeadTimeSeconds;
  assert.equal(validateSettings(legacy).lcfsLeadTimeSeconds, 3);
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, lcfsLeadTimeSeconds: -1 }), /LCFS/);
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, lcfsLeadTimeSeconds: 1.5 }), /LCFS/);
});

test('legacy watch rows default LCFS off and explicit values round-trip', () => {
  const legacyEntry = { ...entry } as Partial<FleetWatchEntry>;
  delete legacyEntry.lcfs;
  const legacy = parseWatchlist(JSON.stringify({ version: 2, entries: [legacyEntry], visibleColumns: [] }));
  assert.equal(legacy.entries[0].lcfs, false);
  const enabled = parseWatchlist(JSON.stringify({ version: 2, entries: [entry], visibleColumns: [] }));
  assert.equal(enabled.entries[0].lcfs, true);
});

test('LCFS is strictly opt-in and allows equality at both maximums', () => {
  assert.equal(evaluateLcfsEligibility({ ...entry, lcfs: false }, snapshot, position, 5, 5_000).kind, 'blocked');
  const decision = evaluateLcfsEligibility(entry, snapshot, position, 5, 5_000);
  assert.equal(decision.kind, 'ready');
  if (decision.kind === 'ready') {
    assert.equal(decision.plan.bidAtlas, 20);
    assert.equal(decision.executeAtMs, 5_000);
  }
});

test('LCFS rejects rates and next bids above their inclusive maximums', () => {
  assert.equal(evaluateLcfsEligibility(entry, { ...snapshot, rentalRateAtlasPerDay: 100.0001 }, position, 5, 5_000).kind, 'blocked');
  assert.equal(evaluateLcfsEligibility(entry, { ...snapshot, minimumTakeoverBidAtlas: 20.0001 }, position, 5, 5_000).kind, 'blocked');
});

test('LCFS attempt keys deduplicate an entry and rental end while allowing the next rental', () => {
  assert.equal(lcfsAttemptKey('fleet-1', 10_000), 'fleet-1:10000');
  assert.notEqual(lcfsAttemptKey('fleet-1', 10_000), lcfsAttemptKey('fleet-1', 20_000));
});

test('LCFS re-fetches at send time and submits the current next bid exactly once', async () => {
  let submittedBid: number | null = null;
  const result = await executeLcfsAttempt(entry, { ...DEFAULT_SETTINGS, useHeliusSender: true, playerProfile: 'FiELMQBWWxRtv78dQQcpD2McCsrRZMhgbXETrH1EyMk7' }, 'stored-secret', 7_000, {
    fetchBundle: async () => ({ raw: {} as never, mapped: snapshot }),
    build: async ({ plan }) => { submittedBid = plan.kind === 'ready' ? plan.bidAtlas : null; return []; },
    submit: async () => 'signature',
  });
  assert.equal(result.kind, 'submitted');
  assert.equal(submittedBid, 20);
});

test('LCFS blocks when the re-fetched rental end no longer matches the scheduled attempt', async () => {
  let submits = 0;
  const result = await executeLcfsAttempt(
    entry,
    { ...DEFAULT_SETTINGS, useHeliusSender: true, playerProfile: 'FiELMQBWWxRtv78dQQcpD2McCsrRZMhgbXETrH1EyMk7' },
    'stored-secret',
    5_000,
    { fetchBundle: async () => ({ raw: {} as never, mapped: { ...snapshot, activeRentalEndsAtMs: 9_000 } }), build: async () => [], submit: async () => { submits += 1; return 'signature'; } },
    10_000,
  );
  assert.equal(result.kind, 'blocked');
  assert.equal(submits, 0);
});

test('LCFS sends nothing when Sender is disabled or the re-fetched next bid exceeds Max bid', async () => {
  let submits = 0;
  const submit = async () => { submits += 1; return 'signature'; };
  assert.equal((await executeLcfsAttempt(entry, DEFAULT_SETTINGS, 'stored-secret', 5_000, {
    fetchBundle: async () => ({ raw: {} as never, mapped: snapshot }), build: async () => [], submit,
  })).kind, 'blocked');
  assert.equal((await executeLcfsAttempt(entry, { ...DEFAULT_SETTINGS, useHeliusSender: true }, 'stored-secret', 5_000, {
    fetchBundle: async () => ({ raw: {} as never, mapped: { ...snapshot, minimumTakeoverBidAtlas: 21 } }),
    build: async () => [], submit,
  })).kind, 'blocked');
  assert.equal(submits, 0);
});

test('sidebar selector order is sourced from the exact table column order', async () => {
  const renderer = await readFile(new URL('../../ui/app.js', import.meta.url), 'utf8');
  assert.match(renderer, /const tableColumnOrder=/);
  assert.match(renderer, /comment[^\n]*endingIn[^\n]*lcfs[^\n]*rentalRate/);
  assert.match(renderer, /for\(const c of tableColumnOrder\.filter/);
});

test('every displayed data column is selectable and LCFS and Ending In default visible', async () => {
  const renderer = await readFile(new URL('../../ui/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(renderer, /!c\.selectable\|\|/);
  assert.match(renderer, /S\.document\.visibleColumns\.includes\(id\)/);
  const legacy = parseWatchlist(JSON.stringify({ version: 2, entries: [entry], visibleColumns: ['comment'] }));
  assert.equal(legacy.version, 3);
  assert.equal(legacy.visibleColumns.includes('lcfs'), true);
  assert.equal(legacy.visibleColumns.includes('endingIn'), true);
});

test('Settings exposes LCFS lead time under the Helius section', async () => {
  const [html, renderer] = await Promise.all([
    readFile(new URL('../../ui/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../../ui/app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="settings-lcfs-lead-time"/);
  assert.match(renderer, /lcfsLeadTimeSeconds/);
});
