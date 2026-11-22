import { createRequire } from 'node:module';
import { address, createSolanaRpc, getBase64EncodedWireTransaction, type Instruction, type TransactionMessageBytesBase64 } from '@solana/kit';
import { lcfsFeeInstructions, lcfsSchedule, lcfsTipLamports, planLcfsReservation } from './lcfs.js';
import { NEXT_GEN_SRSLY_PROGRAM_ID, type FleetContractSnapshot, type FleetTableRow } from './model.js';
import { loadRawContractSnapshot, mapContractSnapshot } from './protocol-snapshot.js';
import { withRpcDeadline } from './rpc-fetch-limiter.js';
import type { AppSettings } from './settings-store.js';
import { compileUnsignedInstructions } from './transaction-simulation.js';
import { buildUnsignedAtlasReservation } from './unsigned-reservation.js';

const {
  SRSLY_ERROR__UNAUTHORIZED, SRSLY_ERROR__INVALID_AUTHORITY,
  SRSLY_ERROR__MISSING_REQUIRED_ACCOUNT, SRSLY_ERROR__MISSING_THREAD_ACCOUNTS,
  SRSLY_ERROR__EXPIRED_BORROWER_STATE_REQUIRED,
} = createRequire(import.meta.url)('@sly-rentals/core/codama') as typeof import('@sly-rentals/core/codama');

const CHECK_INTERVAL_MS = 10 * 60_000;
const RETRY_INTERVAL_MS = 2 * 60_000;
const BACKGROUND_BUDGET_MS = 15_000;
const QUIET_MARGIN_MS = 45_000;
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

export interface PreflightFinding {
  status: 'passed' | 'low-sol' | 'missing-account' | 'authority' | 'simulation-failed' | 'unavailable';
  detail: string;
}

type CachedCheck = PreflightFinding & { expiresAtMs: number };

function sol(lamports: bigint): string {
  return (Number(lamports) / 1_000_000_000).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
}

function solShortfall(available: bigint, fee: bigint, tip: bigint): PreflightFinding | null {
  const required = fee + tip;
  if (available >= required) return null;
  return { status: 'low-sol', detail: `Signing wallet has ${sol(available)} SOL. Fees and tip alone need ${sol(required)} SOL. Account creation can require more.` };
}

/** Match protocol errors only when the failing instruction invokes SRSLY. */
export function classifyReservationSimulation(error: unknown, logs: readonly string[], instructions: readonly Instruction[]): PreflightFinding {
  if (error == null) return { status: 'passed', detail: 'Early LCFS simulation passed for the state checked.' };
  const instructionError = typeof error === 'object' && 'InstructionError' in error && Array.isArray(error.InstructionError)
    ? error.InstructionError : [];
  const [index, reason] = instructionError;
  const code = reason && typeof reason === 'object' && 'Custom' in reason ? Number(reason.Custom) : null;
  const program = instructions[index]?.programAddress;
  if (error === 'InsufficientFundsForFee' || (typeof error === 'object' && 'InsufficientFundsForRent' in error)
    || (program === SYSTEM_PROGRAM && code === 1)
    || logs.some(line => /^Program log: (?:Transfer|Create Account): insufficient lamports\b/i.test(line))) {
    return { status: 'low-sol', detail: 'Early LCFS simulation found insufficient SOL for fees, tip, or required account rent.' };
  }
  if (error === 'BlockhashNotFound') return { status: 'unavailable', detail: 'Early LCFS simulation could not use the current blockhash.' };
  const missingAccount = program === NEXT_GEN_SRSLY_PROGRAM_ID && [SRSLY_ERROR__MISSING_REQUIRED_ACCOUNT, SRSLY_ERROR__MISSING_THREAD_ACCOUNTS, SRSLY_ERROR__EXPIRED_BORROWER_STATE_REQUIRED].some(value => value === code);
  const missingAuthority = program === NEXT_GEN_SRSLY_PROGRAM_ID && [SRSLY_ERROR__UNAUTHORIZED, SRSLY_ERROR__INVALID_AUTHORITY].some(value => value === code);
  if (missingAccount || ['AccountNotFound', 'ProgramAccountNotFound'].includes(String(error)) || ['MissingAccount', 'NotEnoughAccountKeys'].includes(String(reason))) {
    return { status: 'missing-account', detail: 'Early LCFS simulation could not find a required account.' };
  }
  if (missingAuthority || reason === 'MissingRequiredSignature' || error === 'MissingSignatureForFee') {
    return { status: 'authority', detail: 'Early LCFS simulation reported a missing signer or invalid authority. Check the wallet and player profile.' };
  }
  // Display bounded diagnostics only. Never pass raw RPC exceptions, URLs or logs to the renderer.
  const suffix = Number.isSafeInteger(code) ? ` Program error ${code}.` : '';
  return { status: 'simulation-failed', detail: `The early LCFS simulation rejected the transaction.${suffix}` };
}

function contractKey(snapshot: FleetContractSnapshot): string {
  return JSON.stringify([
    snapshot.activeRentalIdentity, snapshot.activeRentalEndsAtMs, snapshot.reservationDefender,
    snapshot.reservationCreatedAtMs, snapshot.reservationBidAtlas, snapshot.reservationBidPoints,
    snapshot.rentalRateAtlasPerDay, snapshot.reservationsAllowed, snapshot.minimumDurationSeconds, snapshot.maximumDurationSeconds,
  ]);
}

export async function checkReservationPreflight(
  row: FleetTableRow, settings: AppSettings, signal: AbortSignal,
  dependencies = { loadSnapshot: loadRawContractSnapshot, build: buildUnsignedAtlasReservation },
): Promise<PreflightFinding> {
  const { entry, position } = row;
  const raw = await dependencies.loadSnapshot(entry.contractAddress, settings.rpcUrl);
  signal.throwIfAborted();
  const snapshot = mapContractSnapshot(raw);
  if (contractKey(snapshot) !== contractKey(row.snapshot)) {
    return { status: 'unavailable', detail: 'The contract or current reservation changed. A fresh fleet refresh is needed.' };
  }
  const plan = planLcfsReservation(entry, snapshot, position);
  if (plan.kind !== 'ready' || plan.watchOnly) {
    return { status: 'unavailable', detail: 'The latest state has no eligible LCFS bid to simulate.' };
  }
  const wallet = address(settings.walletAddress);
  const rpc = createSolanaRpc(settings.rpcUrl);
  const built = await dependencies.build({ plan, walletAddress: wallet, challengerProfile: settings.playerProfile, rpcUrl: settings.rpcUrl, snapshot: raw });
  signal.throwIfAborted();
  if (!Array.isArray(built)) throw new Error('Reservation builder did not return instructions');
  const instructions = [...lcfsFeeInstructions(settings, wallet), ...(built as Instruction[])];
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send({ abortSignal: signal });
  const transaction = compileUnsignedInstructions(instructions, wallet, lifetime);
  const message = Buffer.from(transaction.messageBytes).toString('base64') as TransactionMessageBytesBase64;
  const [{ value: balance }, { value: fee }] = await Promise.all([
    rpc.getBalance(wallet, { commitment: 'confirmed' }).send({ abortSignal: signal }).catch(() => ({ value: null })),
    rpc.getFeeForMessage(message, { commitment: 'confirmed' }).send({ abortSignal: signal }).catch(() => ({ value: null })),
  ]);
  signal.throwIfAborted();
  if (balance !== null && fee !== null) {
    const shortfall = solShortfall(balance, fee, lcfsTipLamports(settings));
    if (shortfall) return shortfall;
  }
  const wire = getBase64EncodedWireTransaction(transaction);
  const { value: simulation } = await rpc.simulateTransaction(wire, {
    encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
  }).send({ abortSignal: signal });
  return classifyReservationSimulation(simulation.err, simulation.logs ?? [], instructions);
}

const cached = new Map<string, CachedCheck>();
let inFlight = false;

/** Collect fresh results and start at most one normal-priority simulation in the background. */
export function collectReservationPreflights(rows: FleetTableRow[], settings: AppSettings, nowMs = Date.now()): Map<string, CachedCheck> {
  const results = new Map<string, CachedCheck>();
  if (!settings.useHeliusSender || !settings.walletAddress || !settings.playerProfile) return results;
  const candidates = [];
  let quiet = true;
  for (const row of rows) {
    const { entry, snapshot, position } = row;
    if (!entry.enabled || !entry.lcfs) continue;
    const ends = snapshot.activeRentalEndsAtMs;
    if (ends != null && nowMs <= ends + QUIET_MARGIN_MS
      && lcfsSchedule(ends, settings.lcfsLeadTimeSeconds).prepareAtMs <= nowMs + QUIET_MARGIN_MS) quiet = false;
    const plan = planLcfsReservation(entry, snapshot, position, nowMs);
    if (plan.kind !== 'ready' || plan.watchOnly) continue;
    const key = JSON.stringify([settings.rpcUrl, settings.walletAddress, settings.playerProfile, settings.transactionPriorityFeeMicroLamports,
      settings.heliusSenderTipSol, entry.id, entry.contractAddress, entry.requestedDurationSeconds, entry.maximumRentalRateAtlasPerDay,
      entry.maximumReservationBidAtlas, contractKey(snapshot)]);
    candidates.push({ key, row });
    const result = cached.get(key);
    if (result && result.expiresAtMs > nowMs) results.set(entry.id, result);
  }
  const currentKeys = new Set(candidates.map(candidate => candidate.key));
  for (const key of cached.keys()) if (!currentKeys.has(key)) cached.delete(key);
  if (inFlight || !quiet) return results;
  const next = candidates.filter(({ row }) => !results.has(row.entry.id))
    .sort((a, b) => (cached.get(a.key)?.expiresAtMs ?? 0) - (cached.get(b.key)?.expiresAtMs ?? 0))[0];
  if (!next) return results;
  inFlight = true;
  const signal = AbortSignal.timeout(BACKGROUND_BUDGET_MS);
  void withRpcDeadline(signal, () => checkReservationPreflight(next.row, settings, signal))
    .catch((): PreflightFinding => ({ status: 'unavailable', detail: 'Early LCFS simulation could not complete. The RPC or account data may be unavailable.' }))
    .then(finding => cached.set(next.key, { ...finding, expiresAtMs: Date.now() + (finding.status === 'passed' ? CHECK_INTERVAL_MS : RETRY_INTERVAL_MS) }))
    .finally(() => { inFlight = false; });
  return results;
}
