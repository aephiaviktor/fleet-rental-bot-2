import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_VISIBLE_COLUMNS } from '../src/columns.js';
import { loadWatchlist, parseWatchlist, saveWatchlist, type WatchlistDocument } from '../src/watchlist-store.js';

const entry = {
  id: 'fleet-1', label: 'Fleet One', contractAddress: 'FiELMQBWWxRtv78dQQcpD2McCsrRZMhgbXETrH1EyMk7', requestedDurationSeconds: 3600,
  estimatedOperatingValueAtlas: 50, maximumRentalRateAtlasPerDay: 100,
  maximumReservationBidAtlas: 20, canSafelyOperate: true, enabled: true, comment: 'Attractive',
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

test('normalizes selectable columns and ignores unknown values', () => {
  const document = parseWatchlist(JSON.stringify({ version: 1, entries: [entry], visibleColumns: ['label', 'unknown', 'label'] }));
  assert.deepEqual(document.visibleColumns, ['label']);
});

test('saves atomically and round-trips a validated document', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fleet-rental-bot-2-'));
  const filePath = path.join(directory, 'watchlist.json');
  const document: WatchlistDocument = { version: 1, entries: [entry], visibleColumns: ['label', 'recommendation'] };
  await saveWatchlist(filePath, document);
  assert.deepEqual(await loadWatchlist(filePath), document);
  assert.match(await readFile(filePath, 'utf8'), /Fleet One/);
});
