import { address, createSolanaRpc } from '@solana/kit';
import type { ContractSnapshot } from '@sly-rentals/core';
import { historyEvidence, type HistoryEvidence } from './history-backfill.js';

export const MINIMUM_DEMAND_PROFILES = 2;
const FINAL_MINUTE_SECONDS = 60;

export interface BonusDemandContext {
  contractAddress: string;
  revision: string;
  createdAt: number;
}

export function bonusDemandContext(snapshot: ContractSnapshot): BonusDemandContext {
  const { createdAt, staleSince } = snapshot.contract.data;
  const active = snapshot.activeRental?.data;
  return {
    contractAddress: snapshot.contract.address,
    revision: `${createdAt}:${staleSince}:${active?.borrower ?? ''}:${active?.startTime ?? ''}:${active?.endTime ?? ''}`,
    createdAt: Number(createdAt),
  };
}

/** Consume events in reverse execution order. Undefined means more history is needed. */
export function lastReservationDemand(contract: string, evidence: Iterable<HistoryEvidence>): number | null | undefined {
  let close: HistoryEvidence | undefined;
  let revisedEnd: number | undefined;
  const bids: { at: number; profile: string }[] = [];
  for (const item of evidence) {
    const event = item.event;
    if (event.contract !== contract) continue;
    if (event.type === 'ContractCreated' || event.type === 'ContractClosed') return close ? undefined : null;
    if (!close) {
      if (event.type === 'RentalClosed') close = item;
      continue;
    }
    if (event.type === 'ReservationPlaced' && item.reservationProfile) {
      bids.push({ at: item.at / 1_000, profile: item.reservationProfile });
    }
    if (event.rentalState !== close.event.rentalState || event.borrower !== close.event.borrower) continue;
    if (event.type === 'RentalCancelled') revisedEnd ??= Number(event.newEndTime);
    if (event.type === 'RentalAccepted') {
      const end = revisedEnd ?? Number(event.endTime);
      const start = Number(event.startTime);
      if (start >= close.at / 1_000 || (Number(event.endTime) > close.at / 1_000 && revisedEnd === undefined)) continue;
      if (!Number.isSafeInteger(end) || end <= start || end > close.at / 1_000) return undefined;
      const lowerBound = Math.max(start, end - FINAL_MINUTE_SECONDS);
      return new Set(bids.filter(bid => bid.at >= lowerBound && bid.at < end).map(bid => bid.profile)).size;
    }
  }
  return undefined;
}

async function readLastReservationDemand(rpcUrl: string, context: BonusDemandContext): Promise<number | null> {
  const rpc = createSolanaRpc(rpcUrl);
  const contract = address(context.contractAddress);
  const evidence: HistoryEvidence[] = [];
  let before: Parameters<typeof rpc.getTransaction>[0] | undefined;
  for (let page = 0; page < 6; page += 1) {
    const signatures = await rpc.getSignaturesForAddress(contract, { limit: 100, commitment: 'finalized', before }).send();
    for (const item of signatures) {
      if (item.err) continue;
      if (item.blockTime != null && Number(item.blockTime) < context.createdAt) return null;
      const tx = await rpc.getTransaction(item.signature, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 }).send();
      const blockTime = tx?.blockTime ?? item.blockTime;
      if (!tx || blockTime == null) throw new Error('Historical transaction or block time unavailable');
      // The typed RPC client returns bigint block time, and the shared decoder expects seconds as a number.
      const events = historyEvidence({ ...tx, blockTime: Number(blockTime) }, item.signature);
      evidence.push(...events.reverse());
      const count = lastReservationDemand(context.contractAddress, evidence);
      if (count !== undefined) return count;
    }
    if (signatures.length < 100) return null;
    before = signatures.at(-1)?.signature;
  }
  throw new Error('Previous rental window is outside the history scan limit');
}

interface CachedDemand {
  revision: string;
  expiresAt: number;
  result: Promise<number | null>;
}
const cachedDemand = new Map<string, CachedDemand>();

export function verifyBonusDemand(rpcUrl: string, context: BonusDemandContext): Promise<number | null> {
  const key = `${rpcUrl}|${context.contractAddress}`;
  const cached = cachedDemand.get(key);
  if (cached?.revision === context.revision && cached.expiresAt > Date.now()) return cached.result;
  const item: CachedDemand = { revision: context.revision, expiresAt: Infinity, result: Promise.resolve(null) };
  item.result = readLastReservationDemand(rpcUrl, context).then(count => {
    item.expiresAt = Date.now() + (count == null ? 60_000 : 60 * 60_000);
    return count;
  }, error => {
    item.expiresAt = Date.now() + 15_000;
    throw error;
  });
  cachedDemand.set(key, item);
  return item.result;
}
