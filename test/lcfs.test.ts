import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { AccountRole, address, createNoopSigner, type Instruction } from '@solana/kit';
import type { FleetContractSnapshot, FleetWatchEntry, WalletPosition } from '../src/model.js';
import {
  evaluateLcfsEligibility,
  executeLcfsAttempt,
  lcfsAttemptKey,
  lcfsSchedule,
  normalizeInstructionSigners,
  planLcfsReservation,
} from '../src/lcfs.js';
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

test('LCFS settings default to five seconds and migrate shorter legacy lead times', () => {
  assert.equal(DEFAULT_SETTINGS.lcfsLeadTimeSeconds, 5);
  const legacy = { ...DEFAULT_SETTINGS } as Partial<typeof DEFAULT_SETTINGS>;
  delete legacy.lcfsLeadTimeSeconds;
  assert.equal(validateSettings(legacy).lcfsLeadTimeSeconds, 5);
  assert.equal(validateSettings({ ...DEFAULT_SETTINGS, lcfsLeadTimeSeconds: 3 }).lcfsLeadTimeSeconds, 5);
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, lcfsLeadTimeSeconds: -1 }), /LCFS/);
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, lcfsLeadTimeSeconds: 1.5 }), /LCFS/);
});

test('LCFS schedules preparation, refresh, final check, and send with measured safety margins', () => {
  assert.deepEqual(lcfsSchedule(100_000, 5), {
    prepareAtMs: 70_000,
    refreshAtMs: 90_000,
    finalCheckAtMs: 93_000,
    sendAtMs: 95_000,
  });
});

test('LCFS bids 110% rounded up to a whole hundred and never exceeds Max bid', () => {
  const realisticEntry = { ...entry, maximumReservationBidAtlas: 20_000 };
  const normal = planLcfsReservation(
    realisticEntry,
    { ...snapshot, reservationBidAtlas: 13_119.52, minimumTakeoverBidAtlas: 14_431.472 },
    position,
    5_000,
  );
  assert.equal(normal.kind, 'ready');
  if (normal.kind === 'ready') assert.equal(normal.bidAtlas, 14_500);

  const exactHundred = planLcfsReservation(
    realisticEntry,
    { ...snapshot, reservationBidAtlas: 10_000, minimumTakeoverBidAtlas: 11_000 },
    position,
    5_000,
  );
  assert.equal(exactHundred.kind, 'ready');
  if (exactHundred.kind === 'ready') assert.equal(exactHundred.bidAtlas, 11_000);

  const blocked = planLcfsReservation(
    realisticEntry,
    { ...snapshot, reservationBidAtlas: 18_181.82, minimumTakeoverBidAtlas: 19_999.999 },
    position,
    5_000,
  );
  assert.equal(blocked.kind, 'blocked');
  if (blocked.kind === 'blocked') assert.match(blocked.detail, /rounded 110%.*maximum 20000/i);
});

test('LCFS does not overbid its own manual reservation (self-defender guard)', () => {
  const realisticEntry = { ...entry, maximumReservationBidAtlas: 20_000 };
  const defendingPosition: WalletPosition = { status: 'defending', atlasLocked: 10_000, reservedAtMs: 1_000 };
  const defendedSnapshot = {
    ...snapshot,
    reservationDefender: 'my-wallet',
    reservationBidAtlas: 10_000,
    minimumTakeoverBidAtlas: 11_000,
  };

  // The defender is our own wallet: the reservation is already held, so LCFS
  // must stay idle instead of bidding 110% against our own manual bid.
  const plan = planLcfsReservation(realisticEntry, defendedSnapshot, defendingPosition, 5_000);
  assert.equal(plan.kind, 'blocked');
  if (plan.kind === 'blocked') assert.match(plan.detail, /already the reservation defender/i);

  const decision = evaluateLcfsEligibility(realisticEntry, defendedSnapshot, defendingPosition, 5, 5_000);
  assert.equal(decision.kind, 'blocked');
  if (decision.kind === 'blocked') assert.match(decision.reason, /already the reservation defender/i);
});

test('LCFS keeps bidding when profile ownership is unknown', () => {
  const realisticEntry = { ...entry, maximumReservationBidAtlas: 20_000 };
  const unknownPosition: WalletPosition = { status: 'unknown', atlasLocked: 0, reservedAtMs: null };
  const unknownSnapshot = {
    ...snapshot,
    reservationDefender: 'possibly-ours',
    reservationBidAtlas: 1_600,
    minimumTakeoverBidAtlas: 1_760,
  };
  const decision = evaluateLcfsEligibility(realisticEntry, unknownSnapshot, unknownPosition, 5, 5_000);
  assert.equal(decision.kind, 'ready');
  if (decision.kind === 'ready') assert.equal(decision.plan.bidAtlas, 1_800);
});

test('LCFS still bids 110% after a real challenger outbids the bot', () => {
  const realisticEntry = { ...entry, maximumReservationBidAtlas: 20_000 };
  const challengerSnapshot = {
    ...snapshot,
    reservationDefender: 'challenger-wallet',
    reservationBidAtlas: 13_119.52,
    minimumTakeoverBidAtlas: 14_431.472,
  };
  const plan = planLcfsReservation(realisticEntry, challengerSnapshot, position, 5_000);
  assert.equal(plan.kind, 'ready');
  if (plan.kind === 'ready') assert.equal(plan.bidAtlas, 14_500);
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
  const decision = evaluateLcfsEligibility(
    { ...entry, maximumReservationBidAtlas: 20_000 },
    { ...snapshot, reservationBidAtlas: 18_000, minimumTakeoverBidAtlas: 20_000 },
    position,
    5,
    5_000,
  );
  assert.equal(decision.kind, 'ready');
  if (decision.kind === 'ready') {
    assert.equal(decision.plan.bidAtlas, 20_000);
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

test('LCFS prepares at T-30, rebuilds changed state, checks again, and sends by T-5', async () => {
  let nowMs = 60_000;
  const waits: number[] = [];
  const preparedBids: number[] = [];
  const sentCandidates: string[] = [];
  const accessChecks: boolean[] = [];
  const changed = { ...snapshot, activeRentalEndsAtMs: 100_000, reservationDefender: 'NewDefender', reservationBidAtlas: 12_000, minimumTakeoverBidAtlas: 13_200 };
  const snapshots = [
    { ...snapshot, activeRentalEndsAtMs: 100_000, reservationBidAtlas: 10_000, minimumTakeoverBidAtlas: 11_000 },
    changed,
    changed,
  ];
  const result = await executeLcfsAttempt({ ...entry, maximumReservationBidAtlas: 20_000 }, { ...DEFAULT_SETTINGS, useHeliusSender: true, playerProfile: 'FiELMQBWWxRtv78dQQcpD2McCsrRZMhgbXETrH1EyMk7' }, 'stored-secret', undefined, {
    resolveOwnedWallets: async () => [],
    now: () => nowMs,
    waitUntil: async (targetMs) => { waits.push(targetMs); nowMs = targetMs; },
    fetchBundle: async () => ({ raw: {} as never, mapped: snapshots.shift()! }),
    build: async ({ plan }) => { preparedBids.push(plan.kind === 'ready' ? plan.bidAtlas : -1); return []; },
    prepareTransaction: async () => `candidate-${preparedBids.length}`,
    submitPrepared: async (candidate) => { sentCandidates.push(candidate); return 'signature'; },
    validateAccess: async (force = false) => { accessChecks.push(force); },
  }, 100_000);
  assert.equal(result.kind, 'submitted');
  assert.deepEqual(waits, [70_000, 90_000, 93_000, 95_000]);
  assert.deepEqual(preparedBids, [11_000, 13_200]);
  assert.deepEqual(sentCandidates, ['candidate-2']);
  assert.deepEqual(accessChecks, [false, true, false]);
});

test('LCFS replaces SDK no-op signer identities before signing the prepared transaction', () => {
  const wallet = address('FiELMQBWWxRtv78dQQcpD2McCsrRZMhgbXETrH1EyMk7');
  const sdkSigner = createNoopSigner(wallet);
  const actualSigner = createNoopSigner(wallet);
  const instructions: Instruction[] = [{
    programAddress: address('11111111111111111111111111111111'),
    accounts: [{ address: wallet, role: AccountRole.WRITABLE_SIGNER, signer: sdkSigner } as never],
  }];
  const normalized = normalizeInstructionSigners(instructions, actualSigner);
  assert.equal((normalized[0].accounts?.[0] as { signer?: unknown }).signer, actualSigner);
});

test('LCFS blocks when the re-fetched rental end no longer matches the scheduled attempt', async () => {
  let submits = 0;
  const result = await executeLcfsAttempt(
    entry,
    { ...DEFAULT_SETTINGS, useHeliusSender: true, playerProfile: 'FiELMQBWWxRtv78dQQcpD2McCsrRZMhgbXETrH1EyMk7' },
    'stored-secret',
    undefined,
    {
      resolveOwnedWallets: async () => [],
      now: () => 5_000,
      waitUntil: async () => {},
      fetchBundle: async () => ({ raw: {} as never, mapped: { ...snapshot, activeRentalEndsAtMs: 9_000 } }),
      build: async () => [],
      prepareTransaction: async () => 'candidate',
      submitPrepared: async () => { submits += 1; return 'signature'; },
    },
    10_000,
  );
  assert.equal(result.kind, 'blocked');
  assert.equal(submits, 0);
});

test('LCFS sends nothing when Sender is disabled or the re-fetched next bid exceeds Max bid', async () => {
  let submits = 0;
  const submitPrepared = async () => { submits += 1; return 'signature'; };
  assert.equal((await executeLcfsAttempt(entry, DEFAULT_SETTINGS, 'stored-secret', 5_000, {
    fetchBundle: async () => ({ raw: {} as never, mapped: snapshot }), build: async () => [], submitPrepared,
  })).kind, 'blocked');
  assert.equal((await executeLcfsAttempt(entry, { ...DEFAULT_SETTINGS, useHeliusSender: true }, 'stored-secret', 5_000, {
    fetchBundle: async () => ({ raw: {} as never, mapped: { ...snapshot, minimumTakeoverBidAtlas: 21 } }),
    build: async () => [], submitPrepared,
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
  const [html, renderer, main, lcfs] = await Promise.all([
    readFile(new URL('../../ui/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../../ui/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../../electron/main.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../../src/lcfs.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="settings-lcfs-lead-time"[^>]*min="5"/);
  assert.match(html, /T-30.*T-10.*T-5/);
  assert.match(renderer, /lcfsLeadTimeSeconds/);
  assert.match(main, /decision\.prepareAtMs/);
  assert.match(main, /decision\.sendAtMs/);
  assert.doesNotMatch(lcfs, /simulateTransaction/);
});
