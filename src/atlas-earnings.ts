import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getBase58Encoder } from '@solana/kit';
import type { AuditEvent } from '@sly-rentals/core/audit';
import type { HistoryEvidence } from './history-backfill.js';
import { NEXT_GEN_SRSLY_PROGRAM_ID as PROGRAM } from './model.js';
import { MAINNET_SAGE_PROGRAM } from './rental-sdk.js';
import { bidPriceDay, readEarningsRates } from './earnings-prices.js';

const core = createRequire(import.meta.url)('@sly-rentals/core/codama') as typeof import('@sly-rentals/core/codama');
const YEAR_MS = 365n * 86_400_000n;
const ATLAS_SCALE = 100_000_000;
const LAMPORTS_PER_SOL = 1_000_000_000;
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
// Published Helius Sender and Jito block engine tip accounts. The network
// fee already contains the priority fee. A tip is a separate SOL transfer.
const TIP_ACCOUNTS = new Set([
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE', 'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta', '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD', '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF', '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey', '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49', '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
]);

export interface EarningsEvidence {
  reservationProfile?: string | null;
  bonusAtlasUnits?: string | null;
  bidCostLamports?: string | null;
}

function bidCost(tx: any, keys: string[], instructions: any[], borrower: string): string | null {
  const fee = tx.meta.fee;
  if (!Number.isSafeInteger(fee) || fee <= 0 || keys[0] !== borrower) return null;
  let cost = BigInt(fee);
  for (const ix of instructions) {
    if (keys[ix.programIdIndex] !== SYSTEM_PROGRAM || keys[ix.accounts?.[0]] !== borrower
      || !TIP_ACCOUNTS.has(keys[ix.accounts?.[1]])) continue;
    try {
      const bytes = Buffer.from(getBase58Encoder().encode(ix.data));
      if (bytes.length === 12 && bytes.readUInt32LE(0) === 2) cost += bytes.readBigUInt64LE(4);
    } catch { return null; }
  }
  return String(cost);
}

/** Identify ATLAS refund logs emitted by SRSLY itself. The refund includes principal. */
function atlasRefunds(logs: readonly string[]): Map<string, number> {
  const stack: string[] = [];
  const matches = new Map<string, number>();
  for (const log of logs) {
    const invoke = /^Program (\w+) invoke \[(\d+)\]$/.exec(log);
    if (invoke) {
      stack.length = Number(invoke[2]) - 1;
      stack.push(invoke[1]);
    } else if (/^Program \w+ (?:success|failed:)/.test(log)) {
      stack.pop();
    } else if (stack.at(-1) === PROGRAM) {
      const refund = /^Program log: Refunded (\d+) ATLAS to defender \(includes (\d+) bonus\)$/.exec(log);
      if (refund) {
        const key = `${refund[1]}:${refund[2]}`;
        matches.set(key, (matches.get(key) ?? 0) + 1);
      }
    }
  }
  return matches;
}

export function earningsEvidence(tx: any, keys: string[], events: AuditEvent[]): EarningsEvidence[] {
  if (!events.some(event => event.type === 'ReservationPlaced' || event.type === 'ReservationKnockedOff')) return events.map(() => ({}));
  const instructions = [
    ...(tx.transaction?.message?.instructions || []),
    ...(tx.meta.innerInstructions || []).flatMap((group: any) => group.instructions || []),
  ];
  const reserves = instructions.flatMap((ix: any) => {
    if (keys[ix.programIdIndex] !== PROGRAM || !ix.data || !Array.isArray(ix.accounts) || ix.accounts.length < 25) return [];
    const at = (index: number) => keys[ix.accounts[index]];
    // 21 fixed ReserveRental accounts in next-gen SRSLY, followed by the SAGE profile.
    if (at(14) !== MAINNET_SAGE_PROGRAM || at(20) !== SYSTEM_PROGRAM || !at(21)) return [];
    try {
      const bytes = getBase58Encoder().encode(ix.data);
      if (!core.RESERVE_RENTAL_DISCRIMINATOR.every((byte, index) => byte === bytes[index])) return [];
      const data = core.getReserveRentalInstructionDataDecoder().decode(bytes);
      return [{ contract: at(2), rentalState: at(11), borrower: at(0), profile: at(21), ...data }];
    } catch { return []; }
  });
  const refunds = atlasRefunds(tx.meta.logMessages || []);
  const knockoffs = events.filter(event => event.type === 'ReservationKnockedOff');
  const placementCount = events.filter(event => event.type === 'ReservationPlaced').length;
  return events.map(event => {
    if (event.type === 'ReservationPlaced') {
      const matches = reserves.filter(ix => ix.contract === event.contract && ix.rentalState === event.rentalState
        && ix.borrower === event.borrower && ix.bidAtlas === event.bidAtlas && ix.bidPoints === event.bidPoints);
      const profiles = new Set(matches.map(ix => ix.profile));
      return { reservationProfile: profiles.size === 1 ? matches[0].profile : null,
        bidCostLamports: placementCount === 1 ? bidCost(tx, keys, instructions, event.borrower) : null };
    }
    if (event.type === 'ReservationKnockedOff') {
      if (event.bonus === 0n) return { bonusAtlasUnits: '0' };
      const key = `${event.refund}:${event.bonus}`;
      const verified = event.refund >= event.bonus && refunds.get(key) === 1
        && knockoffs.filter(other => other.refund === event.refund && other.bonus === event.bonus).length === 1;
      return { bonusAtlasUnits: verified ? String(event.bonus) : null };
    }
    return {};
  });
}

interface EarningsBid {
  amount: number;
  currency: 'ATLAS' | 'Points' | null;
}

export interface AtlasEarningsRow {
  id: string;
  contract: string;
  borrower: string;
  signature: string;
  outbidAtMs: number;
  heldMs: number | null;
  atlasLocked: number | null;
  myBid: EarningsBid | null;
  challengerBid: EarningsBid | null;
  bonusAtlas: number | null;
  bidAtMs: number | null;
  bidCostSol: number | null;
  solFeesAtlas: number | null;
  netProfitAtlas: number | null;
  aprPct: number | null;
  walletOnly: boolean;
}

export interface AtlasEarningsReport {
  rows: AtlasEarningsRow[];
  totalBonusAtlas: number | null;
  aprPct: number | null;
  aprCount: number;
  verifiedCount: number;
}

function units(value: unknown): bigint | null {
  if (typeof value !== 'bigint' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const amount = BigInt(value);
  return amount >= 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER) ? amount : null;
}

function earningsBid(atlas: bigint | null, points: bigint | null): EarningsBid | null {
  const hasAtlas = atlas !== null && atlas > 0n;
  const hasPoints = points !== null && points > 0n;
  if (hasAtlas && !hasPoints) return { amount: Number(atlas) / ATLAS_SCALE, currency: 'ATLAS' };
  if (hasPoints && !hasAtlas) return { amount: Number(points) / ATLAS_SCALE, currency: 'Points' };
  // Both currency fields are zero for a zero bid, regardless of its selected currency.
  return atlas === 0n && points === 0n ? { amount: 0, currency: null } : null;
}

function annualized(profit: bigint, atlasUnitMs: bigint): number | null {
  return atlasUnitMs > 0n ? Number(profit * YEAR_MS * 100n) / Number(atlasUnitMs) : null;
}

/** Rebuild each contract's queue from saved confirmed evidence. State addresses can be reused. */
export function calculateAtlasEarnings(events: HistoryEvidence[], profile: string, wallets: readonly string[],
  atlasPerSol: ReadonlyMap<number, number> = new Map()): AtlasEarningsReport {
  const walletSet = new Set(wallets);
  const rows: AtlasEarningsRow[] = [];
  const pending = new Map<string, HistoryEvidence>();
  const bySlot = new Map<number, Map<string, HistoryEvidence[]>>();
  const seen = new Set<string>();
  let total = 0n, pooledProfit = 0n, pooledCapitalTime = 0n, aprCount = 0, verifiedCount = 0;
  for (const e of events) {
    const id = `${e.signature}:${e.index}`;
    if (!e.event?.contract || !e.signature || !Number.isSafeInteger(e.slot) || !Number.isSafeInteger(e.at) || e.at <= 0 || seen.has(id)) continue;
    seen.add(id);
    const byContract = bySlot.get(e.slot) ?? new Map();
    const group = byContract.get(e.event.contract) ?? [];
    group.push(e);
    byContract.set(e.event.contract, group);
    bySlot.set(e.slot, byContract);
  }

  const recordOutbid = (e: HistoryEvidence, prior: HistoryEvidence | undefined, possibleProfiles: Set<string>) => {
    const event = e.event;
    const borrower = event.displacedBorrower;
    if (!borrower || event.newBorrower === borrower) return;
    const placed = prior?.event;
    const match = prior && placed.rentalState === event.rentalState && placed.borrower === borrower && prior.at <= e.at ? prior : undefined;
    const knownProfile = match?.reservationProfile;
    const walletOnly = knownProfile !== profile;
    if (knownProfile && walletOnly) return;
    if (walletOnly && (!walletSet.has(borrower) || [...possibleProfiles].some(value => value !== profile))) return;
    // A replacement by another known wallet in this profile is not an external outbid.
    if (walletSet.has(event.newBorrower)) return;
    const bonus = event.bonus === '0' || event.bonus === 0n ? 0n : units(e.bonusAtlasUnits);
    const bid = units(match?.event.bidAtlas), escrow = units(match?.event.escrow);
    const locked = bid !== null && escrow !== null ? bid + escrow : null;
    const heldMs = match ? e.at - match.at : null;
    const exposure = locked !== null && heldMs !== null ? locked * BigInt(heldMs) : 0n;
    const bidAtMs = match?.at ?? null;
    const lamports = units(match?.bidCostLamports);
    const bidCostSol = lamports === null ? null : Number(lamports) / LAMPORTS_PER_SOL;
    const rate = bidAtMs === null ? undefined : atlasPerSol.get(bidPriceDay(bidAtMs));
    const feeAmount = bidCostSol === 0 ? 0 : bidCostSol !== null && rate && rate > 0 ? bidCostSol * rate : null;
    const feeDust = feeAmount === null ? null : Math.round(feeAmount * ATLAS_SCALE);
    const fees = feeDust !== null && Number.isSafeInteger(feeDust) ? BigInt(feeDust) : null;
    const profit = bonus !== null && fees !== null ? bonus - fees : null;
    const aprPct = profit === null ? null : annualized(profit, exposure);
    if (bonus !== null) {
      total += bonus;
      verifiedCount++;
    }
    if (profit !== null && aprPct !== null) {
      pooledProfit += profit;
      pooledCapitalTime += exposure;
      aprCount++;
    }
    rows.push({ id: `${e.signature}:${e.index}`, contract: event.contract, borrower, signature: e.signature,
      outbidAtMs: e.at, heldMs, atlasLocked: locked === null ? null : Number(locked) / ATLAS_SCALE,
      myBid: earningsBid(bid, units(match?.event.bidPoints)),
      challengerBid: earningsBid(units(event.newBidAtlas), units(event.newBidPoints)),
      bonusAtlas: bonus === null ? null : Number(bonus) / ATLAS_SCALE, bidAtMs, bidCostSol,
      solFeesAtlas: fees === null ? null : Number(fees) / ATLAS_SCALE,
      netProfitAtlas: profit === null ? null : Number(profit) / ATLAS_SCALE, aprPct, walletOnly });
  };

  const lifecycle = new Set(['ReservationPlaced', 'ReservationKnockedOff', 'ReservationForceClosed', 'RentalCancelled', 'RentalAccepted', 'ContractCreated', 'ContractClosed']);
  for (const [, contracts] of [...bySlot].sort(([a], [b]) => a - b)) {
    for (const [contract, all] of contracts) {
      const group = all.filter(e => lifecycle.has(e.event.type));
      const signatures = new Set(group.map(e => e.signature));
      // A slot alone cannot order two transactions. Process events in a transaction's exact order,
      // but discard reconstructed holding times across ambiguous transactions in the same slot.
      const ambiguous = signatures.size > 1;
      const before = pending.get(contract);
      for (const signature of signatures) {
        let prior = ambiguous ? undefined : before;
        const transaction = group.filter(e => e.signature === signature).sort((a, b) => a.index - b.index);
        for (const e of transaction) {
          if (e.event.type === 'ReservationPlaced') { prior = e; continue; }
          if (e.event.type === 'ReservationKnockedOff') {
            const borrower = e.event.displacedBorrower;
            const possibleProfiles = new Set((ambiguous ? [...group, before] : [prior]).flatMap(p =>
              p?.event.type === 'ReservationPlaced' && p.event.borrower === borrower && p.reservationProfile ? [p.reservationProfile] : []));
            const ownReplacement = transaction.some(p => p.event.type === 'ReservationPlaced' && p.event.borrower === e.event.newBorrower
              && p.event.rentalState === e.event.rentalState && p.reservationProfile === profile);
            if (!ownReplacement) recordOutbid(e, prior, possibleProfiles);
          }
          // An active-rental cancellation does not clear a different queued account.
          if (prior && e.event.type === 'RentalCancelled' && e.event.rentalState !== prior.event.rentalState) continue;
          prior = undefined;
        }
        if (!ambiguous && prior) pending.set(contract, prior);
        else pending.delete(contract);
      }
    }
  }
  rows.sort((a, b) => b.outbidAtMs - a.outbidAtMs || a.id.localeCompare(b.id));
  return { rows, totalBonusAtlas: verifiedCount === 0 ? null : Number(total) / ATLAS_SCALE,
    aprPct: annualized(pooledProfit, pooledCapitalTime), aprCount, verifiedCount };
}

export function recordEarningsWalletScope(file: string, profile: string, wallets: readonly string[]): void {
  if (!profile || !wallets.length) return;
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS history_earnings_wallets(profile TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    db.prepare('INSERT INTO history_earnings_wallets VALUES (?,?) ON CONFLICT(profile) DO UPDATE SET payload=excluded.payload')
      .run(profile, JSON.stringify(wallets));
  } finally { db.close(); }
}

export function readAtlasEarnings(file: string, profile: string, wallets?: readonly string[]): AtlasEarningsReport {
  if (!profile || !existsSync(file)) return calculateAtlasEarnings([], profile, wallets ?? []);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='history_evidence'").get();
    const events = table ? db.prepare('SELECT payload FROM history_evidence WHERE profile=?').all(profile)
      .map(row => JSON.parse(String(row.payload)) as HistoryEvidence) : [];
    const scopeTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='history_earnings_wallets'").get();
    const scope = scopeTable && wallets === undefined
      ? JSON.parse(String(db.prepare('SELECT payload FROM history_earnings_wallets WHERE profile=?').get(profile)?.payload || '[]')) as string[]
      : [];
    return calculateAtlasEarnings(events, profile, wallets ?? scope, readEarningsRates(db));
  } finally { db.close(); }
}
