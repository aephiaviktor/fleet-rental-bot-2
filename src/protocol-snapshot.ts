import type { ContractSnapshot } from '@sly-rentals/core';
import type { FleetContractSnapshot, WalletPosition } from './model.js';

const DEFAULT_DECIMAL_FACTOR = 100_000_000;

function decimalAmount(value: bigint, factor: bigint): number {
  if (factor <= 0n) throw new Error('Decimal factor must be positive');
  return Number(value) / Number(factor);
}

function unixSecondsToMs(value: bigint): number | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : null;
}

export function mapContractSnapshot(snapshot: ContractSnapshot): FleetContractSnapshot {
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

  return {
    rentalRateAtlasPerDay: decimalAmount(BigInt(snapshot.effectiveRate), atlasFactor),
    activeRentalEndsAtMs: active ? unixSecondsToMs(BigInt(active.endTime)) : null,
    reservationCurrency,
    reservationDefender: queued ? queued.borrower.toString() : null,
    reservationBidAtlas: bidAtlas,
    reservationBidPoints: bidPoints,
    minimumTakeoverBidAtlas: decimalAmount(BigInt(snapshot.minimumBid.atlas), atlasFactor),
    minimumTakeoverBidPoints: decimalAmount(BigInt(snapshot.minimumBid.points), pointsFactor),
    reservationCreatedAtMs: queued ? unixSecondsToMs(BigInt(queued.createdAt)) : null,
    fleetWeight,
    basePointsPerDay,
    effectivePointsPerDay: basePointsPerDay * fleetWeight,
  };
}

export function deriveWalletPosition(snapshot: FleetContractSnapshot, walletAddress: string): WalletPosition {
  const defending = snapshot.reservationDefender === walletAddress;
  return {
    status: defending ? 'defending' : 'none',
    atlasLocked: defending && snapshot.reservationCurrency === 'ATLAS'
      ? snapshot.reservationBidAtlas ?? 0
      : 0,
    reservedAtMs: defending ? snapshot.reservationCreatedAtMs : null,
  };
}

export async function loadContractSnapshot(contractAddress: string, rpcUrl: string): Promise<FleetContractSnapshot> {
  if (!contractAddress.trim()) throw new Error('Contract address is required');
  if (!rpcUrl.trim()) throw new Error('RPC URL is required');
  // Keep the SDK import out of the pure mapping path. @sly-rentals/core 5.4.0's
  // ESM root currently contains extensionless directory imports that Node rejects;
  // Electron's bundler can resolve them, while unit tests remain independent.
  const { getContractSnapshot } = await import('@sly-rentals/core');
  return mapContractSnapshot(await getContractSnapshot({ contractAddress, rpcUrl }));
}
