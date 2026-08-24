import {
  address,
  blockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
} from '@solana/kit';
import { requireSolanaAddress } from './solana-address.js';

export interface SimulationConfig {
  encoding: 'base64';
  sigVerify: false;
  commitment: 'confirmed';
}

export interface RawSimulationResult {
  err: unknown;
  logs: string[] | null;
  unitsConsumed?: number;
}

export interface UnsignedSimulationInput {
  instructions: Instruction[];
  walletAddress: string;
  getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  simulateWire: (wire: string, config: SimulationConfig) => Promise<RawSimulationResult>;
}

export interface UnsignedSimulationResult {
  ok: boolean;
  error: string | null;
  logs: string[];
  unitsConsumed: number | null;
  lastValidBlockHeight: bigint;
}

function errorText(error: unknown): string | null {
  if (error == null) return null;
  try { return JSON.stringify(error); } catch { return String(error); }
}

export async function simulateUnsignedInstructions(input: UnsignedSimulationInput): Promise<UnsignedSimulationResult> {
  const wallet = address(requireSolanaAddress(input.walletAddress, 'walletAddress'));
  const lifetime = await input.getLatestBlockhash();
  const emptyMessage = createTransactionMessage({ version: 0 });
  const feePayerMessage = setTransactionMessageFeePayer(wallet, emptyMessage);
  const lifetimeMessage = setTransactionMessageLifetimeUsingBlockhash({
    blockhash: blockhash(lifetime.blockhash),
    lastValidBlockHeight: lifetime.lastValidBlockHeight,
  }, feePayerMessage);
  const instructionMessage = appendTransactionMessageInstructions(input.instructions, lifetimeMessage);
  const wire = getBase64EncodedWireTransaction(compileTransaction(instructionMessage));
  const response = await input.simulateWire(wire, {
    encoding: 'base64', sigVerify: false, commitment: 'confirmed',
  });
  const error = errorText(response.err);
  return {
    ok: error === null,
    error,
    logs: response.logs ?? [],
    unitsConsumed: response.unitsConsumed ?? null,
    lastValidBlockHeight: lifetime.lastValidBlockHeight,
  };
}
