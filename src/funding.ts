import { address, blockhash, signature, createSolanaRpc, getAddressDecoder, getTransactionDecoder, getCompiledTransactionMessageDecoder, getSignatureFromTransaction } from '@solana/kit';
import { rentalSdk } from './rental-sdk.js';
import type { FleetContractSnapshot, FleetWatchEntry } from './model.js';

export const ATLAS_MINT = 'ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const FACTOR = 100_000_000;
const pending = new Map<string, Map<string, { amount: number; blockhash: string; seenFinalizedValid?: boolean }>>();
const balanceSlotFloors = new Map<string, bigint>();
const walletLocks = new Map<string, Promise<unknown>>();
export async function withFundingLock<T>(wallet: string, operation: () => Promise<T>): Promise<T> {
  const previous = walletLocks.get(wallet) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  walletLocks.set(wallet, current);
  try { return await current; }
  finally { if (walletLocks.get(wallet) === current) walletLocks.delete(wallet); }
}
/** Reserve before sending, including uncertain network failures. Never log the signed wire. */
export function recordPendingFunding(wallet: string, wire: string, amount: number): void {
  const tx = getTransactionDecoder().decode(Buffer.from(wire, 'base64'));
  const sig = getSignatureFromTransaction(tx);
  const lifetime = getCompiledTransactionMessageDecoder().decode(tx.messageBytes).lifetimeToken;
  const entries = pending.get(wallet) ?? new Map();
  entries.set(sig, { amount, blockhash: String(lifetime) });
  pending.set(wallet, entries);
}

export interface FundingEstimate {
  status: 'ready' | 'short' | 'unknown' | 'bid-limit' | 'rate-limit';
  limitDetail: string | null;
  availableAtlas: number | null;
  requiredAtlas: number | null;
  bidAtlas: number | null;
  escrowAtlas: number | null;
  shortfallAtlas: number | null;
  checkedAtMs: number;
}

/** Conservative integer-dust arithmetic: round required escrow up, never down. */
export function requiredAtlasFunding(ratePerDay: number, durationSeconds: number, bidAtlas: number): number {
  for (const value of [ratePerDay, bidAtlas]) {
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.ceil(value * FACTOR))) throw new Error('Invalid funding amount');
  }
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds <= 0) throw new Error('Invalid funding duration');
  const escrow = (BigInt(Math.ceil(ratePerDay * FACTOR)) * BigInt(durationSeconds) + 86_399n) / 86_400n;
  const total = escrow + BigInt(Math.ceil(bidAtlas * FACTOR));
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Funding amount exceeds supported precision');
  return Number(total) / FACTOR;
}

export function estimateFunding(entry: FleetWatchEntry, snapshot: FleetContractSnapshot, availableAtlas: number | null, nowMs = Date.now()): FundingEstimate {
  let bid: number | null = null, required: number | null = null, escrow: number | null = null;
  try {
    // Monitoring without LCFS estimates rent only. A missing or expensive
    // takeover bid must not affect that estimate.
    bid = 0;
    if (entry.lcfs) {
      const minimum = snapshot.minimumTakeoverBidAtlas;
      if (minimum == null || !Number.isFinite(minimum) || minimum < 0) throw new Error('Unknown bid');
      bid = Math.ceil(Number(Math.max(minimum, snapshot.projectedExpiryTakeoverBidAtlas ?? 0, (snapshot.reservationBidAtlas ?? 0) * 1.1).toFixed(8)));
    }
    required = requiredAtlasFunding(snapshot.rentalRateAtlasPerDay, entry.requestedDurationSeconds, bid);
    escrow = requiredAtlasFunding(snapshot.rentalRateAtlasPerDay, entry.requestedDurationSeconds, 0);
  } catch { /* Do not display Ready when a required input is unavailable. */ }
  const available = availableAtlas != null && Number.isFinite(availableAtlas) && availableAtlas >= 0 ? availableAtlas : null;
  const shortfall = required == null || available == null ? null : Math.max(0, Math.round((required - available) * FACTOR) / FACTOR);
  // A top-up cannot make a bid within the user's limits. Show that blocker
  // before funding status, without capping the actual on-chain requirement.
  const rateLimited = Number.isFinite(snapshot.rentalRateAtlasPerDay) && snapshot.rentalRateAtlasPerDay > entry.maximumRentalRateAtlasPerDay;
  const bidLimited = entry.lcfs && bid != null && Number.isFinite(bid) && bid > entry.maximumReservationBidAtlas;
  const limitDetail = rateLimited
    ? `Rental rate ${snapshot.rentalRateAtlasPerDay} ATLAS/day exceeds your maximum ${entry.maximumRentalRateAtlasPerDay}.`
    : bidLimited ? `Required bid ${bid} ATLAS exceeds your maximum ${entry.maximumReservationBidAtlas}.` : null;
  return { status: rateLimited ? 'rate-limit' : bidLimited ? 'bid-limit' : shortfall == null ? 'unknown' : shortfall > 0 ? 'short' : 'ready', limitDetail, availableAtlas: available, requiredAtlas: required, bidAtlas: bid, escrowAtlas: escrow, shortfallAtlas: shortfall, checkedAtMs: nowMs };
}

/** Read the exact ATA used by reserveRental, not other profile wallets or locked escrow. */
export async function loadAtlasBalance(wallet: string, rpcUrl: string): Promise<number | null> {
  if (!wallet || !rpcUrl) return null;
  try {
    const ata = await rentalSdk().deriveAssociatedTokenAccount(address(wallet), address(ATLAS_MINT));
    const rpc = createSolanaRpc(rpcUrl);
    const entries = pending.get(wallet);
    let minContextSlot = balanceSlotFloors.get(wallet) ?? 0n;
    if (entries?.size) {
      const signatures = [...entries.keys()];
      const statuses = await rpc.getSignatureStatuses(signatures.map(signature), { searchTransactionHistory: true }).send();
      for (let index = 0; index < signatures.length; index++) {
        const sig = signatures[index], status = statuses.value[index], held = entries.get(sig);
        if (!held) continue;
        if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
          minContextSlot = status.slot > minContextSlot ? status.slot : minContextSlot;
          balanceSlotFloors.set(wallet, minContextSlot);
          entries.delete(sig);
        } else if (!status) {
          const valid = await rpc.isBlockhashValid(blockhash(held.blockhash), { commitment: 'finalized' }).send();
          // A fresh confirmed blockhash may not exist at finalized yet.
          // Only infer expiry after this node has observed it valid at finalized.
          if (valid.value) held.seenFinalizedValid = true;
          else if (held.seenFinalizedValid) {
            minContextSlot = valid.context.slot > minContextSlot ? valid.context.slot : minContextSlot;
            balanceSlotFloors.set(wallet, minContextSlot);
            entries.delete(sig);
          }
        }
      }
    }
    const floor = balanceSlotFloors.get(wallet) ?? 0n;
    minContextSlot = minContextSlot > floor ? minContextSlot : floor;
    balanceSlotFloors.set(wallet, minContextSlot);
    const { value } = await rpc.getAccountInfo(ata, { encoding: 'base64', commitment: 'processed', minContextSlot }).send();
    if (!value) return 0;
    const bytes = Buffer.from(value.data[0], 'base64');
    if (value.owner !== TOKEN_PROGRAM || bytes.length < 165 || bytes[108] !== 1) return null;
    const decoder = getAddressDecoder();
    if (decoder.decode(bytes.subarray(0, 32)) !== ATLAS_MINT || decoder.decode(bytes.subarray(32, 64)) !== wallet) return null;
    const amount = bytes.readBigUInt64LE(64);
    return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Math.max(0, Number(amount) / FACTOR - [...(entries?.values() ?? [])].reduce((sum, held) => sum + held.amount, 0)) : null;
  } catch { return null; }
}
