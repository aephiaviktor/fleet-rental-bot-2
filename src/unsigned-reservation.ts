import { createRequire } from 'node:module';
import { address, createNoopSigner } from '@solana/kit';
import type { ContractSnapshot, ReserveRentalParams } from '@sly-rentals/core';
import type { AtlasReservationPlan } from './reservation-plan.js';
import { requireSolanaAddress } from './solana-address.js';

const require = createRequire(import.meta.url);

export type ReserveRentalBuilder = (
  params: ReserveRentalParams,
  config?: { rpcUrl?: string },
) => Promise<unknown>;

export interface UnsignedReservationInput {
  plan: AtlasReservationPlan;
  walletAddress: string;
  challengerProfile: string;
  rpcUrl: string;
  snapshot: ContractSnapshot;
  reserve?: ReserveRentalBuilder;
}

export async function buildUnsignedAtlasReservation(input: UnsignedReservationInput): Promise<unknown> {
  if (input.plan.kind !== 'ready') throw new Error('A ready reservation plan is required');
  const walletAddress = requireSolanaAddress(input.walletAddress, 'walletAddress');
  const challengerProfile = requireSolanaAddress(input.challengerProfile, 'challengerProfile');
  const rawRate = BigInt(input.snapshot.contract.data.rate);
  const reserve = input.reserve ?? (
    require('@sly-rentals/core') as { reserveRental: ReserveRentalBuilder }
  ).reserveRental;

  return reserve({
    challenger: createNoopSigner(address(walletAddress)),
    challengerProfile,
    contract: input.plan.contractAddress,
    bidAtlas: { atlas: input.plan.bidAtlas },
    bidPoints: { points: 0 },
    duration: { seconds: input.plan.requestedDurationSeconds },
    rate: { stardust: rawRate },
    autoMinBid: false,
    computeUnits: 300_000,
    snapshot: input.snapshot,
  }, { rpcUrl: input.rpcUrl });
}
