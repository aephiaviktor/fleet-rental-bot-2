import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_VISIBLE_COLUMNS } from '../src/columns.js';
import { loadWatchlist, parseWatchlist, saveWatchlist, type WatchlistDocument } from '../src/watchlist-store.js';

const entry = {
  id: 'fleet-1', label: 'Fleet One', contractAddress: 'FiELMQBWWxRtv78dQQcpD2McCsrRZMhgbXETrH1EyMk7', requestedDurationSeconds: 3600,
  estimatedNetValueAtlas: 50, maximumRentalRateAtlasPerDay: 100,
  maximumReservationBidAtlas: 20, canSafelyOperate: true, enabled: true, comment: 'Attractive', lcfs: false,
};

test('missing watchlist loads as an empty safe document', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fleet-rental-bot-2-'));
  const document = await loadWatchlist(path.join(directory, 'missing.json'));
  assert.deepEqual(document.entries, []);
  assert.deepEqual(document.visibleColumns, DEFAULT_VISIBLE_COLUMNS);
});

test('rejects duplicate contracts', () => {
  assert.throws(() => parseWatchlist(JSON.stringify({ version: 1, entries: [entry, { ...entry, id: 'fleet-2' }] })), /unique/);
});

test('allows an empty display label because fleet names resolve from chain', () => {
  const document = parseWatchlist(JSON.stringify({ version: 1, entries: [{ ...entry, label: '' }] }));
  assert.equal(document.entries[0].label, '');
});

test('rejects malformed Solana contract addresses before persistence', () => {
  assert.throws(
    () => parseWatchlist(JSON.stringify({ version: 1, entries: [{ ...entry, contractAddress: 'not-a-solana-address' }] })),
    /valid Solana address/,
  );
});

test('does not silently relabel legacy gross operating values as net values', () => {
  const legacy = { ...entry, estimatedNetValueAtlas: undefined, estimatedOperatingValueAtlas: 150 };
  const document = parseWatchlist(JSON.stringify({ version: 1, entries: [legacy] }));
  assert.equal(document.entries[0].estimatedNetValueAtlas, null);
  assert.equal('estimatedOperatingValueAtlas' in document.entries[0], false);
});

test('all current table columns are selectable and visible by default', () => {
  for (const id of ['enabled', 'label', 'contractAddress', 'requestedDuration', 'estimatedNetValueAtlas',
    'maximumRentalRate', 'maximumReservationBid', 'canSafelyOperate', 'comment', 'endingIn', 'lcfs']) {
    assert.equal(DEFAULT_VISIBLE_COLUMNS.includes(id as never), true, `${id} should default visible`);
  }
  assert.equal(DEFAULT_VISIBLE_COLUMNS.includes('canSafelyOperate'), true);
  assert.equal(DEFAULT_VISIBLE_COLUMNS.includes('comment'), true);
  assert.equal(DEFAULT_VISIBLE_COLUMNS.includes('netValue' as never), false);
  assert.equal(DEFAULT_VISIBLE_COLUMNS.includes('recommendation' as never), false);
});

test('normalizes selectable columns and ignores unknown values', () => {
  const document = parseWatchlist(JSON.stringify({ version: 1, entries: [entry], visibleColumns: ['label', 'unknown', 'label'] }));
  assert.equal(document.version, 3);
  assert.equal(document.visibleColumns.includes('label'), true);
  assert.equal(document.visibleColumns.includes('lcfs'), true);
  assert.equal(document.visibleColumns.includes('endingIn'), true);
});

test('saves atomically and round-trips a validated document', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fleet-rental-bot-2-'));
  const filePath = path.join(directory, 'watchlist.json');
  const document: WatchlistDocument = { version: 3, entries: [entry], visibleColumns: ['label', 'comment'] };
  await saveWatchlist(filePath, document);
  assert.deepEqual(await loadWatchlist(filePath), document);
  assert.match(await readFile(filePath, 'utf8'), /Fleet One/);
});
