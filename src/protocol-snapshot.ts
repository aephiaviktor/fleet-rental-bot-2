import { createRequire } from 'node:module';
import { createSolanaRpc } from '@solana/kit';
import type { ContractSnapshot } from '@sly-rentals/core';
import { NEXT_GEN_SRSLY_PROGRAM_ID, type FleetContractSnapshot, type FleetWatchEntry, type WalletOwnership, type WalletPosition } from './model.js';
import { rentalSdk } from './rental-sdk.js';

const DEFAULT_DECIMAL_FACTOR = 100_000_000;
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const { fetchAllMaybeRentalState, RentalStatus } = createRequire(import.meta.url)('@sly-rentals/core/codama') as typeof import('@sly-rentals/core/codama');

function queuedIdentity(queued: NonNullable<ContractSnapshot['queuedRental']>['data']): string {
  return `${queued.borrower}:${queued.createdAt}:${queued.bidAtlas}:${queued.bidPoints}:${queued.escrow}`;
}

function decimalAmount(value: bigint, factor: bigint): number {
  if (factor <= 0n) throw new Error('Decimal factor must be positive');
  return Number(value) / Number(factor);
}

function unixSecondsToMs(value: bigint): number | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : null;
}

export function mapContractSnapshot(snapshot: ContractSnapshot, fleetName = ''): FleetContractSnapshot {
  const config = snapshot.config.data;
  const contract = snapshot.contract.data;
  const queued = snapshot.queuedRental?.data ?? null;
  const active = snapshot.activeRental?.data ?? null;
  const atlasFactor = BigInt(config.stardustToAtlas || BigInt(DEFAULT_DECIMAL_FACTOR));
  const pointsFactor = BigInt(DEFAULT_DECIMAL_FACTOR);
  const bidAtlas = queued ? decimalAmount(BigInt(queued.bidAtlas), atlasFactor) : null;
  const bidPoints = queued ? decimalAmount(BigInt(queued.bidPoints), pointsFactor) : null;
  const core = rentalSdk();
  // Use the on-chain comparison ratio (currently 100 ATLAS per point).
  const minimumBid = core.computeMinimumBidFromSnapshot(snapshot);
  const reservationCurrency = queued
    ? (BigInt(queued.bidAtlas) > 0n ? 'ATLAS' : 'POINTS')
    : null;
  const basePointsPerDay = decimalAmount(BigInt(config.pointsPerDay), pointsFactor);
  const fleetWeight = Number(contract.weight);
  const defenderBidAtlasEquivalent = queued
    ? BigInt(queued.bidAtlas) + BigInt(queued.bidPoints) * BigInt(config.atlasPerPoint) * atlasFactor / pointsFactor
    : 0n;
  const expiryBase = snapshot.effectiveRate > defenderBidAtlasEquivalent
    ? snapshot.effectiveRate
    : defenderBidAtlasEquivalent;
  const expiryRampBps = BigInt(Math.max(
    Number(config.captureRateBps),
    10_000 + Math.max(0, Number(config.contestedMultiplierMaxBps) - 100) * 100,
  ));

  return {
    fleetName,
    reservationsAllowed: config.reservationsEnabled && !contract.reservationsDisabled && !contract.toClose,
    minimumDurationSeconds: Number(contract.durationMinSeconds),
    maximumDurationSeconds: Number(contract.durationMaxSeconds),
    cancelDelaySeconds: contract.cancelDelayMin == null ? null : Number(contract.cancelDelayMin),
    rentalRateAtlasPerDay: decimalAmount(BigInt(snapshot.effectiveRate), atlasFactor),
    activeRentalIdentity: active ? `${snapshot.activeRental?.address}:${active.borrower}:${active.startTime}:${active.endTime}` : undefined,
    activeRentalEndsAtMs: active ? unixSecondsToMs(BigInt(active.endTime)) : null,
    reservationCurrency,
    reservationDefender: queued ? queued.borrower.toString() : null,
    reservationIdentity: queued ? queuedIdentity(queued) : null,
    reservationBidAtlas: bidAtlas,
    reservationRentEscrowAtlas: queued ? decimalAmount(BigInt(queued.escrow), atlasFactor) : null,
    reservationBidPoints: bidPoints,
    minimumTakeoverBidAtlas: queued
      ? decimalAmount(BigInt(minimumBid.atlas), atlasFactor)
      : 0,
    minimumTakeoverBidPoints: queued
      ? decimalAmount(BigInt(minimumBid.points), pointsFactor)
      : 0,
    currentMinimumBidAtlas: decimalAmount(BigInt(minimumBid.atlas), atlasFactor),
    projectedExpiryTakeoverBidAtlas: queued
      ? decimalAmount(expiryBase * expiryRampBps / 10_000n, atlasFactor)
      : null,
    reservationCreatedAtMs: queued ? unixSecondsToMs(BigInt(queued.createdAt)) : null,
    fleetWeight,
    basePointsPerDay,
    effectivePointsPerDay: basePointsPerDay * fleetWeight,
  };
}

export function deriveWalletPosition(
  snapshot: FleetContractSnapshot,
  ownership: ReadonlyArray<string> | string | WalletOwnership,
): WalletPosition {
  const structured = typeof ownership === 'object' && !Array.isArray(ownership)
    ? ownership as WalletOwnership
    : null;
  const owned = structured?.addresses ?? (typeof ownership === 'string' ? [ownership] : ownership as ReadonlyArray<string>);
  const resolution = structured?.status ?? 'resolved';
  const defending = snapshot.reservationDefender != null && owned.includes(snapshot.reservationDefender);
  // Old cached snapshots do not carry escrow; show unknown rather than bid-only.
  const lockedAtlas = snapshot.reservationRentEscrowAtlas == null
    ? null
    : snapshot.reservationRentEscrowAtlas + (snapshot.reservationBidAtlas ?? 0);
  return {
    status: defending ? 'defending' : resolution === 'unknown' ? 'unknown' : 'none',
    atlasLocked: defending ? lockedAtlas : 0,
    reservedAtMs: defending ? snapshot.reservationCreatedAtMs : null,
  };
}

export async function loadContractSnapshot(contractAddress: string, rpcUrl: string): Promise<FleetContractSnapshot> {
  const snapshot = await loadRawContractSnapshot(contractAddress, rpcUrl);
  const core = rentalSdk();
  const fleet = await core.fetchFleet(snapshot.contract.data.fleet.toString(), rpcUrl);
  const fleetName = Buffer.from(fleet.fleetLabel).toString('utf8').replace(/\0/g, '').trim();
  return mapContractSnapshot(snapshot, fleetName || snapshot.contract.data.fleet.toString());
}

export async function loadRawContractSnapshot(contractAddress: string, rpcUrl: string): Promise<ContractSnapshot> {
  if (!contractAddress.trim()) throw new Error('Contract address is required');
  if (!rpcUrl.trim()) throw new Error('RPC URL is required');
  const core = rentalSdk();
  const snapshot = await core.getContractSnapshot({ contractAddress, rpcUrl });
  const { activeRental, queuedRental } = snapshot.contract.data;
  // The SDK returns null after a rental read fails, even when the contract still points to it.
  if ((activeRental !== SYSTEM_PROGRAM && snapshot.activeRental?.address !== activeRental)
    || (queuedRental !== SYSTEM_PROGRAM && snapshot.queuedRental?.address !== queuedRental)) {
    throw new Error('The contract points to a rental account that could not be loaded.');
  }
  return snapshot;
}

/** Compare queued rental accounts in batches and let the full refresh resolve changes. */
export async function findChangedReservations(rows: readonly {
  entry: Pick<FleetWatchEntry, 'id' | 'contractAddress'>;
  snapshot: Pick<FleetContractSnapshot, 'reservationIdentity' | 'reservationDefender'>;
}[], rpcUrl: string): Promise<Set<string>> {
  const changed = new Set<string>();
  if (!rows.length) return changed;
  const rpc = createSolanaRpc(rpcUrl);
  const sdk = rentalSdk();
  for (let offset = 0; offset < rows.length; offset += 100) {
    const batch = rows.slice(offset, offset + 100);
    const addresses = await Promise.all(batch.map(({ entry }) => sdk.deriveQueuedRental(entry.contractAddress, NEXT_GEN_SRSLY_PROGRAM_ID)));
    const queued = await fetchAllMaybeRentalState(rpc, addresses, { commitment: 'finalized' });
    for (const [index, row] of batch.entries()) {
      const account = queued[index];
      if (account.exists && (account.programAddress !== NEXT_GEN_SRSLY_PROGRAM_ID || account.data.contract !== row.entry.contractAddress)) {
        throw new Error('Unexpected queued rental account.');
      }
      const identity = account.exists && account.data.status === RentalStatus.Queued ? queuedIdentity(account.data) : null;
      const previous = row.snapshot.reservationIdentity ?? (row.snapshot.reservationDefender ? undefined : null);
      if (identity !== previous) changed.add(row.entry.id);
    }
  }
  return changed;
}
