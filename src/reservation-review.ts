import type { ContractSnapshot } from '@sly-rentals/core';
import type { FleetContractSnapshot, FleetWatchEntry } from './model.js';
import type { AtlasReservationPlan } from './reservation-plan.js';
import type { AppSettings } from './settings-store.js';
import { resolveWalletOwnership } from './player-profile.js';
import { deriveWalletPosition, loadRawContractSnapshot, mapContractSnapshot } from './protocol-snapshot.js';
import { planAtlasReservation } from './reservation-plan.js';
import { buildUnsignedAtlasReservation } from './unsigned-reservation.js';

interface InstructionAccountSummary { address: string; role: number }
interface InstructionSummary {
  index: number;
  programAddress: string;
  dataBytes: number;
  accounts: InstructionAccountSummary[];
}

export type ReservationReview =
  | { kind: 'blocked'; plan: Extract<AtlasReservationPlan, { kind: 'blocked' }> }
  | {
      kind: 'ready';
      plan: Extract<AtlasReservationPlan, { kind: 'ready' }>;
      instructionCount: number;
      instructions: InstructionSummary[];
    };

interface RawInstruction {
  programAddress: unknown;
  accounts?: Array<{ address: unknown; role: number }>;
  data?: { byteLength?: number; length?: number };
}

export interface ReservationReviewDependencies {
  fetchBundle?: (contractAddress: string, rpcUrl: string) => Promise<{ raw: ContractSnapshot; mapped: FleetContractSnapshot }>;
  build?: typeof buildUnsignedAtlasReservation;
}

function summarizeInstructions(value: unknown): InstructionSummary[] {
  if (!Array.isArray(value)) throw new Error('SDK did not return an instruction array');
  return (value as RawInstruction[]).map((instruction, index) => ({
    index,
    programAddress: String(instruction.programAddress),
    dataBytes: Number(instruction.data?.byteLength ?? instruction.data?.length ?? 0),
    accounts: (instruction.accounts ?? []).map((account) => ({
      address: String(account.address),
      role: account.role,
    })),
  }));
}

export async function prepareReservationReview(
  entry: FleetWatchEntry,
  settings: AppSettings,
  nowMs = Date.now(),
  dependencies: ReservationReviewDependencies = {},
): Promise<ReservationReview> {
  if (!settings.walletAddress) throw new Error('Wallet address is required to prepare a reservation');
  if (!settings.challengerProfileAddress) throw new Error('SAGE profile address is required to prepare a reservation');
  const fetchBundle = dependencies.fetchBundle ?? (async (contractAddress: string, rpcUrl: string) => {
    const raw = await loadRawContractSnapshot(contractAddress, rpcUrl);
    return { raw, mapped: mapContractSnapshot(raw) };
  });
  const { raw, mapped } = await fetchBundle(entry.contractAddress, settings.rpcUrl);
  const position = deriveWalletPosition(mapped, await resolveWalletOwnership(settings, settings.rpcUrl));
  const plan = planAtlasReservation(entry, mapped, position, nowMs);
  if (plan.kind === 'blocked') return { kind: 'blocked', plan };
  const instructions = summarizeInstructions(await (dependencies.build ?? buildUnsignedAtlasReservation)({
    plan,
    walletAddress: settings.walletAddress,
    challengerProfile: settings.challengerProfileAddress,
    rpcUrl: settings.rpcUrl,
    snapshot: raw,
  }));
  return { kind: 'ready', plan, instructionCount: instructions.length, instructions };
}
