import { createRequire } from 'node:module';
import { address, createSolanaRpc } from '@solana/kit';
import type { ContractSnapshot } from '@sly-rentals/core';
import type { AuditEvent, RentalClosedEvent } from '@sly-rentals/core/audit';
import { NEXT_GEN_SRSLY_PROGRAM_ID } from './model.js';

const { parseAnchorEvents } = createRequire(import.meta.url)('@sly-rentals/core/audit') as typeof import('@sly-rentals/core/audit');
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

interface DemandBid {
  at: number;
  wallet: string;
  signature: string;
}

interface DemandWindow {
  start: number;
  end: number;
  closedAt: number;
  closeSignature: string;
  wallets: number;
  bids: DemandBid[];
}

export type BonusDemandDiagnostic = { transactionsScanned: number } & (
  | ({ status: 'verified' } & DemandWindow)
  | { status: 'no-completed-period' | 'incomplete-history' | 'rpc-error' | 'state-unavailable'; detail: string }
);

/** Consume events in reverse execution order. Undefined means more history is needed. */
export function lastReservationDemand(contract: string, evidence: Iterable<{ event: AuditEvent; at: number }>): DemandWindow | null | undefined {
  let close: { event: RentalClosedEvent; at: number } | undefined;
  let revisedEnd: number | undefined;
  const bids: DemandBid[] = [];
  for (const item of evidence) {
    const event = item.event;
    if (!('contract' in event) || event.contract !== contract) continue;
    if (event.type === 'ContractCreated') return close ? undefined : null;
    if (event.type === 'ContractClosed') return undefined;
    if (!close) {
      if (event.type === 'RentalClosed') close = { event, at: item.at };
      continue;
    }
    if (event.type === 'ReservationPlaced') {
      bids.push({ at: item.at / 1_000, wallet: event.borrower, signature: event.signature });
    }
    if (event.type !== 'RentalCancelled' && event.type !== 'RentalAccepted') continue;
    if (event.rentalState !== close.event.rentalState || event.borrower !== close.event.borrower) continue;
    if (event.type === 'RentalCancelled') revisedEnd ??= Number(event.newEndTime);
    if (event.type === 'RentalAccepted') {
      const end = revisedEnd ?? Number(event.endTime);
      const start = Number(event.startTime);
      if (start >= close.at / 1_000 || (Number(event.endTime) > close.at / 1_000 && revisedEnd === undefined)) continue;
      if (!Number.isSafeInteger(end) || end <= start || end > close.at / 1_000) return undefined;
      const lowerBound = Math.max(start, end - FINAL_MINUTE_SECONDS);
      const included = bids.filter(bid => bid.at >= lowerBound && bid.at < end).reverse();
      return { start: lowerBound, end, closedAt: close.at / 1_000, closeSignature: close.event.signature,
        wallets: new Set(included.map(bid => bid.wallet)).size, bids: included };
    }
  }
  return undefined;
}

function getRpcFailureDetail(error: unknown): string {
  const { name, message } = error instanceof Error ? error : { name: '', message: '' };
  if (name === 'TimeoutError' || name === 'AbortError') return 'RPC history check timed out.';
  if (/\b429\b|rate limit/i.test(message)) return 'RPC provider rate-limited the history check.';
  return 'RPC request failed while reading transaction history.';
}

async function readLastReservationDemand(rpcUrl: string, context: BonusDemandContext): Promise<BonusDemandDiagnostic> {
  const rpc = createSolanaRpc(rpcUrl);
  const contract = address(context.contractAddress);
  const evidence: { event: AuditEvent; at: number }[] = [];
  let transactionsScanned = 0;
  const incomplete = (detail: string): BonusDemandDiagnostic => ({ status: 'incomplete-history', detail, transactionsScanned });
  let before: Parameters<typeof rpc.getTransaction>[0] | undefined;
  try {
    for (let page = 0; page < 6; page += 1) {
      const signatures = await rpc.getSignaturesForAddress(contract, { limit: 100, commitment: 'finalized', before }).send();
      for (const item of signatures) {
        if (item.err) continue;
        if (item.blockTime != null && Number(item.blockTime) < context.createdAt) {
          return incomplete('Reached older transactions before finding the required events for this contract.');
        }
        const tx = await rpc.getTransaction(item.signature, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 }).send();
        const blockTime = tx?.blockTime ?? item.blockTime;
        if (!tx?.meta || blockTime == null) return incomplete('RPC did not return a historical transaction, metadata, or timestamp.');
        if (tx.meta.err !== null) continue;
        transactionsScanned += 1;
        const logs = tx.meta.logMessages;
        if (!logs || logs.includes('Log truncated')) return incomplete('A historical transaction has missing or truncated logs.');
        const events = parseAnchorEvents(logs, NEXT_GEN_SRSLY_PROGRAM_ID, tx.slot, item.signature);
        evidence.push(...events.reverse().map(event => ({ event, at: Number(blockTime) * 1_000 })));
        const result = lastReservationDemand(context.contractAddress, evidence);
        if (result === null) {
          return { status: 'no-completed-period', detail: 'History reached contract creation without a rental close.', transactionsScanned };
        }
        if (result) return { status: 'verified', ...result, transactionsScanned };
        if (events.some(event => (event.type === 'ContractCreated' || event.type === 'ContractClosed') && event.contract === contract)) {
          return incomplete('Reached a contract lifecycle boundary before the previous rental period could be verified.');
        }
      }
      if (signatures.length < 100) {
        return incomplete(evidence.some(item => item.event.type === 'RentalClosed' && item.event.contract === context.contractAddress)
          ? 'RPC history ended before the rental start and deadline could be matched.'
          : 'RPC history ended before a rental close or contract creation was found.');
      }
      before = signatures.at(-1)?.signature;
    }
    return incomplete('The required rental events are beyond the 600-signature history limit.');
  } catch (error) {
    return { status: 'rpc-error', detail: getRpcFailureDetail(error), transactionsScanned };
  }
}

interface CachedDemand {
  revision: string;
  expiresAt: number;
  result: Promise<BonusDemandDiagnostic>;
}
const cachedDemand = new Map<string, CachedDemand>();

export function diagnoseBonusDemand(rpcUrl: string, context: BonusDemandContext): Promise<BonusDemandDiagnostic> {
  const key = `${rpcUrl}|${context.contractAddress}`;
  const cached = cachedDemand.get(key);
  if (cached?.revision === context.revision && cached.expiresAt > Date.now()) return cached.result;
  const item = {
    revision: context.revision, expiresAt: Infinity,
    result: readLastReservationDemand(rpcUrl, context).then(result => {
      item.expiresAt = Date.now() + (result.status === 'verified' ? 60 * 60_000 : 15_000);
      return result;
    }),
  };
  cachedDemand.set(key, item);
  return item.result;
}
