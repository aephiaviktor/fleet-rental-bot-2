import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';
import type { ContractSnapshot } from '@sly-rentals/core';
import type { FleetContractSnapshot, FleetWatchEntry, WalletPosition } from './model.js';
import { deriveWalletPosition, loadRawContractSnapshot, mapContractSnapshot } from './protocol-snapshot.js';
import { planAtlasReservation, type AtlasReservationPlan } from './reservation-plan.js';
import type { AppSettings } from './settings-store.js';
import { ownedWalletAddresses } from './settings-store.js';
import { buildUnsignedAtlasReservation, type UnsignedReservationInput } from './unsigned-reservation.js';

const HELIUS_SENDER_ENDPOINT = 'https://sender.helius-rpc.com/fast';
const HELIUS_TIP_ACCOUNT = '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const LAMPORTS_PER_SOL = 1_000_000_000;
const PREPARE_MARGIN_SECONDS = 25;
const REFRESH_MARGIN_SECONDS = 5;
const FINAL_CHECK_MARGIN_SECONDS = 2;

export interface LcfsSchedule {
  prepareAtMs: number;
  refreshAtMs: number;
  finalCheckAtMs: number;
  sendAtMs: number;
}

export type LcfsEligibility =
  | ({ kind: 'ready'; executeAtMs: number; plan: Extract<AtlasReservationPlan, { kind: 'ready' }> } & LcfsSchedule)
  | { kind: 'blocked'; reason: string };

export type LcfsAttemptResult =
  | { kind: 'submitted'; signature: string; attemptKey: string }
  | { kind: 'blocked'; reason: string };

interface PreparedLcfsCandidate {
  fingerprint: string;
  wireTransaction: string;
}

export interface LcfsDependencies {
  fetchBundle?: (contractAddress: string, rpcUrl: string) => Promise<{ raw: ContractSnapshot; mapped: FleetContractSnapshot }>;
  build?: (input: UnsignedReservationInput) => Promise<unknown>;
  prepareTransaction?: (instructions: Instruction[], settings: AppSettings, hotWalletSecret: string) => Promise<string>;
  submitPrepared?: (wireTransaction: string) => Promise<string>;
  now?: () => number;
  waitUntil?: (targetMs: number) => Promise<void>;
  validateAccess?: (force?: boolean) => Promise<unknown>;
}

export function lcfsAttemptKey(entryId: string, activeRentalEndsAtMs: number): string {
  return `${entryId}:${activeRentalEndsAtMs}`;
}

export function lcfsSchedule(activeRentalEndsAtMs: number, configuredLeadTimeSeconds: number): LcfsSchedule {
  const sendLeadSeconds = Math.max(5, configuredLeadTimeSeconds);
  return {
    prepareAtMs: activeRentalEndsAtMs - Math.max(30, sendLeadSeconds + PREPARE_MARGIN_SECONDS) * 1_000,
    refreshAtMs: activeRentalEndsAtMs - Math.max(10, sendLeadSeconds + REFRESH_MARGIN_SECONDS) * 1_000,
    finalCheckAtMs: activeRentalEndsAtMs - (sendLeadSeconds + FINAL_CHECK_MARGIN_SECONDS) * 1_000,
    sendAtMs: activeRentalEndsAtMs - sendLeadSeconds * 1_000,
  };
}

function roundedAtlas(value: number): number {
  return Number(value.toFixed(8));
}

function roundedUpToHundredAtlas(value: number): number {
  return Math.ceil(roundedAtlas(value) / 100) * 100;
}

export function planLcfsReservation(
  entry: FleetWatchEntry,
  snapshot: FleetContractSnapshot,
  position: WalletPosition,
  nowMs = Date.now(),
): AtlasReservationPlan {
  const base = planAtlasReservation(entry, snapshot, position, nowMs);
  if (base.kind === 'blocked' || snapshot.reservationBidAtlas == null) return base;

  // Self-defender guard: if the on-chain reservation defender is our own wallet,
  // we already hold the reservation. Do not overbid against our own manual bid;
  // stay idle while defending and only bid again once a real challenger takes
  // the top spot (which flips reservationDefender away from our wallet).
  if (position.status === 'defending') {
    return {
      kind: 'blocked',
      reason: 'self-defender',
      detail: 'Already the reservation defender; no overbid needed while we hold the reservation',
    };
  }

  const currentBid = snapshot.reservationBidAtlas;
  const bidAtlas = roundedUpToHundredAtlas(Math.max(base.bidAtlas, roundedAtlas(currentBid * 1.1)));
  if (bidAtlas > entry.maximumReservationBidAtlas) {
    return {
      kind: 'blocked',
      reason: 'bid-limit',
      detail: `Rounded 110% ATLAS bid ${bidAtlas} exceeds maximum ${entry.maximumReservationBidAtlas}`,
    };
  }
  return { ...base, bidAtlas };
}

export function evaluateLcfsEligibility(
  entry: FleetWatchEntry,
  snapshot: FleetContractSnapshot,
  position: WalletPosition,
  leadTimeSeconds: number,
  nowMs = Date.now(),
): LcfsEligibility {
  if (!entry.lcfs) return { kind: 'blocked', reason: 'LCFS is not enabled for this fleet' };
  const plan = planLcfsReservation(entry, snapshot, position, nowMs);
  if (plan.kind === 'blocked') return { kind: 'blocked', reason: plan.detail };
  const schedule = lcfsSchedule(plan.activeRentalEndsAtMs, leadTimeSeconds);
  return { kind: 'ready', executeAtMs: schedule.sendAtMs, plan, ...schedule };
}

function candidateFingerprint(snapshot: FleetContractSnapshot, plan: Extract<AtlasReservationPlan, { kind: 'ready' }>): string {
  return JSON.stringify([
    snapshot.activeRentalEndsAtMs,
    snapshot.reservationsAllowed,
    snapshot.rentalRateAtlasPerDay,
    snapshot.reservationDefender,
    snapshot.reservationBidAtlas,
    snapshot.minimumTakeoverBidAtlas,
    plan.action,
    plan.bidAtlas,
    plan.requestedDurationSeconds,
  ]);
}

function loadBundle(contractAddress: string, rpcUrl: string): Promise<{ raw: ContractSnapshot; mapped: FleetContractSnapshot }> {
  return loadRawContractSnapshot(contractAddress, rpcUrl).then((raw) => ({ raw, mapped: mapContractSnapshot(raw) }));
}

async function inspectFreshState(
  entry: FleetWatchEntry,
  settings: AppSettings,
  expectedActiveRentalEndsAtMs: number,
  nowMs: number,
  fetchBundle: NonNullable<LcfsDependencies['fetchBundle']>,
): Promise<{ raw: ContractSnapshot; mapped: FleetContractSnapshot; plan: Extract<AtlasReservationPlan, { kind: 'ready' }> } | LcfsAttemptResult> {
  const { raw, mapped } = await fetchBundle(entry.contractAddress, settings.rpcUrl);
  if (mapped.activeRentalEndsAtMs !== expectedActiveRentalEndsAtMs) {
    return { kind: 'blocked', reason: 'Active rental changed after this LCFS attempt was scheduled' };
  }
  const plan = planLcfsReservation(entry, mapped, deriveWalletPosition(mapped, ownedWalletAddresses(settings)), nowMs);
  if (plan.kind === 'blocked') return { kind: 'blocked', reason: plan.detail };
  return { raw, mapped, plan };
}

async function buildCandidate(
  inspected: { raw: ContractSnapshot; mapped: FleetContractSnapshot; plan: Extract<AtlasReservationPlan, { kind: 'ready' }> },
  settings: AppSettings,
  hotWalletSecret: string,
  dependencies: LcfsDependencies,
): Promise<PreparedLcfsCandidate> {
  const built = await (dependencies.build ?? buildUnsignedAtlasReservation)({
    plan: inspected.plan,
    walletAddress: settings.walletAddress,
    challengerProfile: settings.playerProfile,
    rpcUrl: settings.rpcUrl,
    snapshot: inspected.raw,
  });
  if (!Array.isArray(built)) throw new Error('SDK did not return an instruction array');
  const wireTransaction = await (dependencies.prepareTransaction ?? prepareLcfsTransaction)(
    built as Instruction[], settings, hotWalletSecret,
  );
  return { fingerprint: candidateFingerprint(inspected.mapped, inspected.plan), wireTransaction };
}

async function prepareOrRefreshCandidate(
  previous: PreparedLcfsCandidate | null,
  entry: FleetWatchEntry,
  settings: AppSettings,
  hotWalletSecret: string,
  expectedActiveRentalEndsAtMs: number,
  dependencies: LcfsDependencies,
  nowMs: number,
): Promise<PreparedLcfsCandidate | LcfsAttemptResult> {
  const fetchBundle = dependencies.fetchBundle ?? loadBundle;
  const inspected = await inspectFreshState(entry, settings, expectedActiveRentalEndsAtMs, nowMs, fetchBundle);
  if ('kind' in inspected) return inspected;
  const fingerprint = candidateFingerprint(inspected.mapped, inspected.plan);
  if (previous?.fingerprint === fingerprint) return previous;
  return buildCandidate(inspected, settings, hotWalletSecret, dependencies);
}

export async function executeLcfsAttempt(
  entry: FleetWatchEntry,
  settings: AppSettings,
  hotWalletSecret: string,
  nowMs?: number,
  dependencies: LcfsDependencies = {},
  expectedActiveRentalEndsAtMs?: number,
): Promise<LcfsAttemptResult> {
  if (!entry.lcfs) return { kind: 'blocked', reason: 'LCFS is not enabled for this fleet' };
  if (!settings.useHeliusSender) return { kind: 'blocked', reason: 'Helius Sender is disabled' };
  if (!hotWalletSecret.trim()) return { kind: 'blocked', reason: 'No signing wallet is stored' };
  if (!settings.playerProfile) return { kind: 'blocked', reason: 'Player Profile is required' };
  if (expectedActiveRentalEndsAtMs === undefined) return { kind: 'blocked', reason: 'Expected active rental end is required' };

  const now = dependencies.now ?? (nowMs === undefined ? Date.now : () => nowMs);
  const waitUntil = dependencies.waitUntil ?? (async (targetMs: number) => {
    const delayMs = targetMs - Date.now();
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  });
  const waitForPhase = async (targetMs: number) => {
    if (now() < targetMs) await waitUntil(targetMs);
  };
  const schedule = lcfsSchedule(expectedActiveRentalEndsAtMs, settings.lcfsLeadTimeSeconds);
  const validateAccess = dependencies.validateAccess ?? (async () => undefined);

  await waitForPhase(schedule.prepareAtMs);
  await validateAccess(false);
  let candidate = await prepareOrRefreshCandidate(
    null, entry, settings, hotWalletSecret, expectedActiveRentalEndsAtMs, dependencies, now(),
  );
  if ('kind' in candidate) return candidate;

  await waitForPhase(schedule.refreshAtMs);
  await validateAccess(true);
  candidate = await prepareOrRefreshCandidate(
    candidate, entry, settings, hotWalletSecret, expectedActiveRentalEndsAtMs, dependencies, now(),
  );
  if ('kind' in candidate) return candidate;

  await waitForPhase(schedule.finalCheckAtMs);
  await validateAccess(false);
  candidate = await prepareOrRefreshCandidate(
    candidate, entry, settings, hotWalletSecret, expectedActiveRentalEndsAtMs, dependencies, now(),
  );
  if ('kind' in candidate) return candidate;

  await waitForPhase(schedule.sendAtMs);
  if (now() >= expectedActiveRentalEndsAtMs) {
    return { kind: 'blocked', reason: 'Active rental ended while the LCFS transaction was being prepared' };
  }
  const signature = await (dependencies.submitPrepared ?? submitPreparedToHelius)(candidate.wireTransaction);
  return { kind: 'submitted', signature, attemptKey: lcfsAttemptKey(entry.id, expectedActiveRentalEndsAtMs) };
}

function decodeBase58(value: string): Uint8Array {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error('Hot wallet secret is not valid base58');
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) { bytes.push(Number(number % 256n)); number /= 256n; }
  bytes.reverse();
  let zeroes = 0;
  while (zeroes < value.length && value[zeroes] === '1') zeroes += 1;
  return Uint8Array.from([...new Array(zeroes).fill(0), ...bytes]);
}

function decodeSecret(secret: string): Uint8Array {
  const trimmed = secret.trim();
  if (!trimmed) throw new Error('Hot wallet secret is empty');
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new Error('Hot wallet secret JSON value must be an array of bytes');
    }
    return Uint8Array.from(parsed);
  }
  const hex = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
  if (/^[0-9a-fA-F]+$/.test(hex)) {
    if (hex.length % 2 !== 0) throw new Error('Hot wallet secret hex value must have an even length');
    return Uint8Array.from(Buffer.from(hex, 'hex'));
  }
  return decodeBase58(trimmed);
}

function u64InstructionData(discriminator: number, value: bigint, discriminatorBytes: 1 | 4): Uint8Array {
  const data = Buffer.alloc(discriminatorBytes + 8);
  discriminatorBytes === 1 ? data.writeUInt8(discriminator) : data.writeUInt32LE(discriminator);
  data.writeBigUInt64LE(value, discriminatorBytes);
  return data;
}

export function normalizeInstructionSigners(instructions: Instruction[], signer: TransactionSigner): Instruction[] {
  return instructions.map((instruction) => ({
    ...instruction,
    accounts: instruction.accounts?.map((account) => account.address === signer.address && 'signer' in account
      ? { ...account, signer }
      : account),
  }));
}

async function prepareLcfsTransaction(
  instructions: Instruction[],
  settings: AppSettings,
  hotWalletSecret: string,
): Promise<string> {
  const secret = decodeSecret(hotWalletSecret);
  try {
    if (secret.length !== 64) throw new Error('Hot wallet secret must contain exactly 64 bytes');
    const signer = await createKeyPairSignerFromBytes(secret);
    if (settings.walletAddress && signer.address !== settings.walletAddress) throw new Error('Signing wallet does not match configured wallet');
    const rpc = createSolanaRpc(settings.rpcUrl);
    const lifetime = (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value;
    const computeBudget: Instruction = {
      programAddress: address(COMPUTE_BUDGET_PROGRAM),
      data: u64InstructionData(3, BigInt(settings.transactionPriorityFeeMicroLamports), 1),
    };
    const tipLamports = BigInt(Math.max(1, Math.round(settings.heliusSenderTipSol * LAMPORTS_PER_SOL)));
    const tip: Instruction = {
      programAddress: address(SYSTEM_PROGRAM),
      accounts: [
        { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
        { address: address(HELIUS_TIP_ACCOUNT), role: AccountRole.WRITABLE },
      ],
      data: u64InstructionData(2, tipLamports, 4),
    };
    const emptyMessage = createTransactionMessage({ version: 0 });
    const feePayerMessage = setTransactionMessageFeePayerSigner(signer, emptyMessage);
    const lifetimeMessage = setTransactionMessageLifetimeUsingBlockhash({
      blockhash: blockhash(lifetime.blockhash), lastValidBlockHeight: lifetime.lastValidBlockHeight,
    }, feePayerMessage);
    const normalizedInstructions = normalizeInstructionSigners(instructions, signer);
    const withInstructions = appendTransactionMessageInstructions([computeBudget, tip, ...normalizedInstructions], lifetimeMessage);
    return getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(withInstructions));
  } finally {
    secret.fill(0);
  }
}

async function submitPreparedToHelius(wireTransaction: string): Promise<string> {
  const response = await fetch(HELIUS_SENDER_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: Date.now().toString(), method: 'sendTransaction',
      params: [wireTransaction, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }],
    }),
  });
  const payload = await response.json() as { result?: string; error?: { code?: number; message?: string } };
  if (!response.ok || payload.error || !payload.result) {
    throw new Error(`Helius Sender failed${payload.error?.code ? ` (${payload.error.code})` : ''}: ${payload.error?.message ?? response.statusText}`);
  }
  return payload.result;
}
