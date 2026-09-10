import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeVisibleColumns, type ColumnId } from './columns.js';
import type { FleetWatchEntry } from './model.js';
import { requireSolanaAddress } from './solana-address.js';

export interface WatchlistDocument {
  version: 3;
  entries: FleetWatchEntry[];
  visibleColumns: ColumnId[];
}

function finiteNonNegative(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${field} must be a finite non-negative number`);
  return value;
}

export function validateWatchEntry(value: unknown): FleetWatchEntry {
  if (!value || typeof value !== 'object') throw new Error('Watchlist entry must be an object');
  const entry = value as Partial<FleetWatchEntry>;
  for (const field of ['id', 'contractAddress'] as const) {
    if (typeof entry[field] !== 'string' || !entry[field]!.trim()) throw new Error(`${field} is required`);
  }
  return {
    id: entry.id!.trim(),
    label: typeof entry.label === 'string' ? entry.label.trim() : '',
    contractAddress: requireSolanaAddress(entry.contractAddress!, 'contractAddress'),
    requestedDurationSeconds: finiteNonNegative(entry.requestedDurationSeconds, 'requestedDurationSeconds'),
    estimatedNetValueAtlas: entry.estimatedNetValueAtlas == null
      ? null
      : finiteNonNegative(entry.estimatedNetValueAtlas, 'estimatedNetValueAtlas'),
    maximumRentalRateAtlasPerDay: finiteNonNegative(entry.maximumRentalRateAtlasPerDay, 'maximumRentalRateAtlasPerDay'),
    maximumReservationBidAtlas: finiteNonNegative(entry.maximumReservationBidAtlas, 'maximumReservationBidAtlas'),
    canSafelyOperate: entry.canSafelyOperate !== false,
    enabled: entry.enabled !== false,
    comment: typeof entry.comment === 'string' ? entry.comment : '',
    lcfs: entry.lcfs === true,
  };
}

export function parseWatchlist(text: string): WatchlistDocument {
  const parsed = JSON.parse(text) as { version?: number; entries?: unknown[]; visibleColumns?: unknown };
  if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) throw new Error(`Unsupported watchlist version: ${String(parsed.version)}`);
  if (!Array.isArray(parsed.entries)) throw new Error('Watchlist entries must be an array');
  const entries = parsed.entries.map(validateWatchEntry);
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error('Watchlist entry IDs must be unique');
  if (new Set(entries.map((entry) => entry.contractAddress)).size !== entries.length) throw new Error('Contract addresses must be unique');
  const visibleColumns = normalizeVisibleColumns(parsed.visibleColumns);
  if (parsed.version === 1 || parsed.version === 2) {
    for (const column of ['enabled', 'label', 'contractAddress', 'requestedDuration', 'estimatedNetValueAtlas',
      'maximumRentalRate', 'maximumReservationBid', 'canSafelyOperate', 'comment', 'endingIn', 'lcfs'] as const) {
      if (!visibleColumns.includes(column)) visibleColumns.push(column);
    }
  }
  return { version: 3, entries, visibleColumns };
}

export async function loadWatchlist(filePath: string): Promise<WatchlistDocument> {
  try {
    return parseWatchlist(await readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 3, entries: [], visibleColumns: normalizeVisibleColumns(undefined) };
    }
    throw error;
  }
}

export async function saveWatchlist(filePath: string, document: WatchlistDocument): Promise<void> {
  const validated = parseWatchlist(JSON.stringify(document));
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}
