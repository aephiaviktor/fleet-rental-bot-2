import { createRequire } from 'node:module';
import type { ContractSnapshot } from '@sly-rentals/core';
import type { FleetContractSnapshot, WalletOwnership, WalletPosition } from './model.js';

const require = createRequire(import.meta.url);

const DEFAULT_DECIMAL_FACTOR = 100_000_000;

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
  const reservationCurrency = queued
    ? (BigInt(queued.bidAtlas) > 0n ? 'ATLAS' : 'POINTS')
    : null;
  const basePointsPerDay = decimalAmount(BigInt(config.pointsPerDay), pointsFactor);
  const fleetWeight = Number(contract.weight);
  const defenderBid = queued ? BigInt(queued.bidAtlas) : 0n;
  const expiryBase = snapshot.effectiveRate > defenderBid ? snapshot.effectiveRate : defenderBid;
  const expiryRampBps = BigInt(Math.max(
    Number(config.captureRateBps),
    10_000 + Math.max(0, Number(config.contestedMultiplierMaxBps) - 100) * 100,
  ));

  return {
    fleetName,
    reservationsAllowed: config.reservationsEnabled && !contract.reservationsDisabled,
    minimumDurationSeconds: Number(contract.durationMinSeconds),
    maximumDurationSeconds: Number(contract.durationMaxSeconds),
    rentalRateAtlasPerDay: decimalAmount(BigInt(snapshot.effectiveRate), atlasFactor),
    activeRentalEndsAtMs: active ? unixSecondsToMs(BigInt(active.endTime)) : null,
    reservationCurrency,
    reservationDefender: queued ? queued.borrower.toString() : null,
    reservationBidAtlas: bidAtlas,
    reservationBidPoints: bidPoints,
    minimumTakeoverBidAtlas: queued
      ? decimalAmount(BigInt(snapshot.minimumBid.atlas), atlasFactor)
      : 0,
    minimumTakeoverBidPoints: queued
      ? decimalAmount(BigInt(snapshot.minimumBid.points), pointsFactor)
      : 0,
    currentMinimumBidAtlas: decimalAmount(BigInt(snapshot.minimumBid.atlas), atlasFactor),
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
  return {
    status: defending ? 'defending' : resolution === 'unknown' ? 'unknown' : 'none',
    atlasLocked: defending && snapshot.reservationCurrency === 'ATLAS'
      ? snapshot.reservationBidAtlas ?? 0
      : 0,
    reservedAtMs: defending ? snapshot.reservationCreatedAtMs : null,
  };
}

export async function loadContractSnapshot(contractAddress: string, rpcUrl: string): Promise<FleetContractSnapshot> {
  const snapshot = await loadRawContractSnapshot(contractAddress, rpcUrl);
  const core = require('@sly-rentals/core') as typeof import('@sly-rentals/core');
  const fleet = await core.fetchFleet(snapshot.contract.data.fleet.toString(), rpcUrl);
  const fleetName = Buffer.from(fleet.fleetLabel).toString('utf8').replace(/\0/g, '').trim();
  return mapContractSnapshot(snapshot, fleetName || snapshot.contract.data.fleet.toString());
}

export async function loadRawContractSnapshot(contractAddress: string, rpcUrl: string): Promise<ContractSnapshot> {
  if (!contractAddress.trim()) throw new Error('Contract address is required');
  if (!rpcUrl.trim()) throw new Error('RPC URL is required');
  // @sly-rentals/core 5.4.0 publishes a working CommonJS build, while its ESM
  // root contains extensionless directory imports that Node 24 rejects.
  const core = require('@sly-rentals/core') as typeof import('@sly-rentals/core');
  return core.getContractSnapshot({ contractAddress, rpcUrl });
}
