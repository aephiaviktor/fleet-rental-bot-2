import { createSolanaRpc, type Base64EncodedWireTransaction, type Instruction } from '@solana/kit';
import type { ContractSnapshot } from '@sly-rentals/core';
import type { FleetContractSnapshot, FleetWatchEntry } from './model.js';
import type { AppSettings } from './settings-store.js';
import { deriveWalletPosition, loadRawContractSnapshot, mapContractSnapshot } from './protocol-snapshot.js';
import { planAtlasReservation, type AtlasReservationPlan } from './reservation-plan.js';
import { buildUnsignedAtlasReservation } from './unsigned-reservation.js';
import { simulateUnsignedInstructions, type UnsignedSimulationResult } from './transaction-simulation.js';

interface Dependencies {
  fetchBundle?: (contractAddress: string, rpcUrl: string) => Promise<{ raw: ContractSnapshot; mapped: FleetContractSnapshot }>;
  build?: typeof buildUnsignedAtlasReservation;
  simulate?: (instructions: Instruction[], walletAddress: string, rpcUrl: string) => Promise<UnsignedSimulationResult>;
}

type SerializableSimulation = Omit<UnsignedSimulationResult, 'lastValidBlockHeight'> & { lastValidBlockHeight: string };

export type ReservationSimulation =
  | { kind: 'blocked'; plan: Extract<AtlasReservationPlan, { kind: 'blocked' }> }
  | { kind: 'simulated'; plan: Extract<AtlasReservationPlan, { kind: 'ready' }>; simulation: SerializableSimulation };

async function simulateLive(instructions: Instruction[], walletAddress: string, rpcUrl: string): Promise<UnsignedSimulationResult> {
  const rpc = createSolanaRpc(rpcUrl);
  return simulateUnsignedInstructions({
    instructions,
    walletAddress,
    getLatestBlockhash: async () => {
      const response = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      return response.value;
    },
    simulateWire: async (wire, config) => {
      const response = await rpc.simulateTransaction(wire as Base64EncodedWireTransaction, config).send();
      return {
        err: response.value.err,
        logs: response.value.logs ?? null,
        unitsConsumed: response.value.unitsConsumed == null ? undefined : Number(response.value.unitsConsumed),
      };
    },
  });
}

export async function simulateReservation(
  entry: FleetWatchEntry,
  settings: AppSettings,
  nowMs = Date.now(),
  dependencies: Dependencies = {},
): Promise<ReservationSimulation> {
  if (!settings.walletAddress) throw new Error('Wallet address is required to simulate a reservation');
  if (!settings.challengerProfileAddress) throw new Error('SAGE profile address is required to simulate a reservation');
  const fetchBundle = dependencies.fetchBundle ?? (async (contractAddress: string, rpcUrl: string) => {
    const raw = await loadRawContractSnapshot(contractAddress, rpcUrl);
    return { raw, mapped: mapContractSnapshot(raw) };
  });
  const { raw, mapped } = await fetchBundle(entry.contractAddress, settings.rpcUrl);
  const plan = planAtlasReservation(entry, mapped, deriveWalletPosition(mapped, settings.walletAddress), nowMs);
  if (plan.kind === 'blocked') return { kind: 'blocked', plan };
  const built = await (dependencies.build ?? buildUnsignedAtlasReservation)({
    plan, walletAddress: settings.walletAddress, challengerProfile: settings.challengerProfileAddress,
    rpcUrl: settings.rpcUrl, snapshot: raw,
  });
  if (!Array.isArray(built)) throw new Error('SDK did not return an instruction array');
  const simulation = await (dependencies.simulate ?? simulateLive)(built as Instruction[], settings.walletAddress, settings.rpcUrl);
  return {
    kind: 'simulated',
    plan,
    simulation: { ...simulation, lastValidBlockHeight: simulation.lastValidBlockHeight.toString() },
  };
}
