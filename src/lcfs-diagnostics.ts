import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createSolanaRpc, signature } from '@solana/kit';

export async function appendLcfsDiagnostic(directory: string, event: Record<string, unknown>): Promise<void> {
  const at = new Date().toISOString();
  const folder = path.join(directory, 'lcfs-diagnostics');
  await mkdir(folder, { recursive: true });
  // Error strings may contain provider URLs. Never persist URL credentials/query keys.
  const json = JSON.stringify({ at, ...event }).replace(/https?:\/\/[^\s"\\]+/g, '[provider URL redacted]');
  await appendFile(path.join(folder, `${at.slice(0, 10)}.jsonl`), json + '\n', { mode: 0o600 });
}

interface Confirmation {
  status: 'confirmed' | 'failed-on-chain' | 'confirmation-unknown';
  signature: string;
  observedAtMs: number;
  confirmationLatencyMs: number;
  slot?: string;
  blockTimeMs?: number | null;
  error?: unknown;
}
/** Runs in the background: confirmation latency is not asserted to be execution latency. */
export async function observeLcfsConfirmation(rpcUrl: string, sig: string, sentAtMs: number, record: (result: Confirmation) => Promise<unknown>): Promise<void> {
  const rpc = createSolanaRpc(rpcUrl);
  for (let attempt = 0; attempt < 18; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5_000));
    try {
      const result = await rpc.getSignatureStatuses([signature(sig)], { searchTransactionHistory: true }).send();
      const status = result.value[0];
      if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
        let blockTimeMs: number | null = null;
        try {
          const tx = await rpc.getTransaction(signature(sig), { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 0 }).send();
          if (tx?.blockTime != null) blockTimeMs = Number(tx.blockTime) * 1_000;
        } catch { /* Confirmation remains valid even if the block timestamp is unavailable. */ }
        await record({ blockTimeMs, status: status.err ? 'failed-on-chain' : 'confirmed', signature: sig, observedAtMs: Date.now(),
          confirmationLatencyMs: Date.now() - sentAtMs, slot: String(status.slot), error: status.err });
        return;
      }
    } catch { /* Keep trying without interrupting the bidding window. */ }
  }
  await record({ status: 'confirmation-unknown', signature: sig, observedAtMs: Date.now(), confirmationLatencyMs: Date.now() - sentAtMs });
}
