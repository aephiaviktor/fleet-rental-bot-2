import type { AppSettings } from './settings-store.js';
import type { FleetContractSnapshot, FleetTableRow, FleetWatchEntry } from './model.js';
import { deriveWalletPosition, loadContractSnapshot } from './protocol-snapshot.js';
import { buildFleetTableRow } from './table-row.js';

export type RefreshResult =
  | { id: string; ok: true; row: FleetTableRow }
  | { id: string; ok: false; error: string };

type SnapshotLoader = (contractAddress: string, rpcUrl: string) => Promise<FleetContractSnapshot>;

export async function refreshWatchlist(
  entries: FleetWatchEntry[],
  settings: AppSettings,
  loader: SnapshotLoader = loadContractSnapshot,
  nowMs = Date.now(),
): Promise<RefreshResult[]> {
  const enabled = entries.filter((entry) => entry.enabled);
  const results: RefreshResult[] = [];
  const concurrency = 3;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < enabled.length) {
      const entry = enabled[cursor++];
      try {
        const snapshot = await loader(entry.contractAddress, settings.rpcUrl);
        const position = deriveWalletPosition(snapshot, settings.walletAddress);
        results.push({ id: entry.id, ok: true, row: buildFleetTableRow(entry, snapshot, position, nowMs) });
      } catch (error) {
        results.push({ id: entry.id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, enabled.length) }, () => worker()));
  return results;
}
