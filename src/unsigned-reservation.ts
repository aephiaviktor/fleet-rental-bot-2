import { createRequire } from 'node:module';
import { address, createNoopSigner, createSolanaRpc, type Instruction, type TransactionSigner } from '@solana/kit';
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
  initializeBorrower?: (signer: TransactionSigner, rpcUrl: string) => Promise<unknown>;
}

function unwrapInstructions(value: unknown): Instruction[] {
  if (Array.isArray(value)) return value as Instruction[];
  if (value && typeof value === 'object' && Symbol.iterator in value) {
    return [...value as Iterable<Instruction>];
  }
  throw new Error('SDK did not return instructions');
}

async function buildBorrowerInitialization(signer: TransactionSigner, rpcUrl: string): Promise<Instruction[]> {
  const sdk = require('@sly-rentals/core') as {
    deriveBorrowerState: (borrower: TransactionSigner) => Promise<string>;
    createBorrower: (params: { borrower: TransactionSigner }, config?: { rpcUrl?: string }) => Promise<unknown>;
  };
  const borrowerState = await sdk.deriveBorrowerState(signer);
  const account = await createSolanaRpc(rpcUrl).getAccountInfo(address(borrowerState), { encoding: 'base64' }).send();
  if (account.value !== null) return [];
  return unwrapInstructions(await sdk.createBorrower({ borrower: signer }, { rpcUrl }));
}

export async function buildUnsignedAtlasReservation(input: UnsignedReservationInput): Promise<unknown> {
  if (input.plan.kind !== 'ready') throw new Error('A ready reservation plan is required');
  const walletAddress = requireSolanaAddress(input.walletAddress, 'walletAddress');
  const challengerProfile = requireSolanaAddress(input.challengerProfile, 'challengerProfile');
  const rawRate = BigInt(input.snapshot.contract.data.rate);
  const signer = createNoopSigner(address(walletAddress));
  const initializeBorrower = input.initializeBorrower ?? buildBorrowerInitialization;
  const reserve = input.reserve ?? (require('@sly-rentals/core') as { reserveRental: ReserveRentalBuilder }).reserveRental;

  const borrowerInstructions = unwrapInstructions(await initializeBorrower(signer, input.rpcUrl));
  const result = await reserve({
    challenger: signer,
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
  return [...borrowerInstructions, ...unwrapInstructions(result)];
}
