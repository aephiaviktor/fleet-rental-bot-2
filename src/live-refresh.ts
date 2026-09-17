import type { AppSettings } from './settings-store.js';
import type { CachedFleetRow } from './fleet-database.js';
import type { FleetContractSnapshot, FleetTableRow, FleetWatchEntry } from './model.js';
import { deriveWalletPosition, loadContractSnapshot } from './protocol-snapshot.js';
import { resolveOwnedWalletAddresses } from './player-profile.js';
import { buildFleetTableRow } from './table-row.js';

export type RefreshResult =
  | { id: string; ok: true; row: FleetTableRow; source: 'live' | 'cache'; fetchedAtMs: number; error?: string }
  | { id: string; ok: false; error: string };

export function mergeRefreshWithCache(
  results: RefreshResult[],
  cachedRows: CachedFleetRow[],
  expectedContracts = new Map<string, string>(),
): RefreshResult[] {
  const cachedById = new Map(cachedRows.map((cached) => [cached.row.entry.id, cached]));
  return results.map((result) => {
    if (result.ok) return result;
    const cached = cachedById.get(result.id);
    if (!cached) return result;
    const expectedContract = expectedContracts.get(result.id);
    if (expectedContract && cached.row.entry.contractAddress !== expectedContract) return result;
    return {
      id: result.id,
      ok: true,
      row: cached.row,
      source: 'cache',
      fetchedAtMs: cached.fetchedAtMs,
      error: result.error,
    };
  });
}

type SnapshotLoader = (contractAddress: string, rpcUrl: string) => Promise<FleetContractSnapshot>;

export async function refreshWatchlist(
  entries: FleetWatchEntry[],
  settings: AppSettings,
  loader: SnapshotLoader = loadContractSnapshot,
  nowMs = Date.now(),
  resolveOwnedWallets: typeof resolveOwnedWalletAddresses = resolveOwnedWalletAddresses,
): Promise<RefreshResult[]> {
  const enabled = entries.filter((entry) => entry.enabled);
  const results: RefreshResult[] = [];
  const concurrency = 3;
  let cursor = 0;
  const ownedWallets = await resolveOwnedWallets(settings, settings.rpcUrl);

  async function worker(): Promise<void> {
    while (cursor < enabled.length) {
      const entry = enabled[cursor++];
      try {
        const snapshot = await loader(entry.contractAddress, settings.rpcUrl);
        const position = deriveWalletPosition(snapshot, ownedWallets);
        results.push({ id: entry.id, ok: true, row: buildFleetTableRow(entry, snapshot, position, nowMs), source: 'live', fetchedAtMs: nowMs });
      } catch (error) {
        results.push({ id: entry.id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, enabled.length) }, () => worker()));
  return results;
}
