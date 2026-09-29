import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createKeyPairSignerFromBytes,
  createNoopSigner,
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
import type { FleetContractSnapshot, FleetWatchEntry, WalletOwnership, WalletPosition } from './model.js';
import { deriveWalletPosition, loadRawContractSnapshot, mapContractSnapshot } from './protocol-snapshot.js';
import { planAtlasReservation, type AtlasReservationPlan } from './reservation-plan.js';
import type { AppSettings } from './settings-store.js';
import { resolveWalletOwnership } from './player-profile.js';
import { buildUnsignedAtlasReservation, type UnsignedReservationInput } from './unsigned-reservation.js';
import { rentalSdk } from './rental-sdk.js';

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
  | ({ kind: 'ready'; executeAtMs: number; plan: Extract<LcfsReservationPlan, { kind: 'ready' }> } & LcfsSchedule)
  | { kind: 'blocked'; reason: string };

export type LcfsAttemptResult =
  | { kind: 'submitted'; signature: string; attemptKey: string }
  | { kind: 'blocked'; reason: string };

type ReadyAtlasReservationPlan = Extract<AtlasReservationPlan, { kind: 'ready' }>;
export type LcfsReservationPlan =
  | Extract<AtlasReservationPlan, { kind: 'blocked' }>
  | (ReadyAtlasReservationPlan & { watchOnly?: boolean });

interface PreparedLcfsCandidate {
  fingerprint: string;
  wireTransaction: string;
  bidAtlas: number;
  defender: string | null;
}

export interface WarmTransactionInput {
  warmUpAddress: string;
  bidAtlas: number;
  inspected: { raw: ContractSnapshot; mapped: FleetContractSnapshot; plan: Extract<LcfsReservationPlan, { kind: 'ready' }> };
  settings: AppSettings;
  hotWalletSecret: string;
}

export interface LcfsDependencies {
  fetchBundle?: (contractAddress: string, rpcUrl: string) => Promise<{ raw: ContractSnapshot; mapped: FleetContractSnapshot }>;
  resolveOwnedWallets?: (settings: AppSettings, rpcUrl: string) => Promise<WalletOwnership | string[]>;
  build?: (input: UnsignedReservationInput) => Promise<unknown>;
  prepareTransaction?: (instructions: Instruction[], settings: AppSettings, hotWalletSecret: string) => Promise<string>;
  recordIntent?: (wireTransaction:string, amount:number) => Promise<void>;
  submitPrepared?: (wireTransaction: string) => Promise<string>;
  now?: () => number;
  waitUntil?: (targetMs: number) => Promise<void>;
  validateAccess?: (force?: boolean) => Promise<unknown>;
  getSolanaUnixTime?: (rpcUrl: string) => Promise<number>;
  prepareWarmTransaction?: (input: WarmTransactionInput) => Promise<string>;
  monitorAfterPrimary?: boolean;
  monitorIntervalMs?: number;
  onTiming?: (event: { phase: string; localMs: number; solanaUnixSeconds?: number; offsetMs: number; targetMs?: number }) => Promise<void> | void;
  onSubmission?: (event: { lane: 'primary' | 'reactive' | 'warm'; status: 'submitted' | 'failed'; signature?: string; defender: string | null; bidAtlas: number; detail?: string }) => Promise<void> | void;
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

export function calculateSolanaClockOffsetMs(localNowMs: number, solanaUnixSeconds: number): number {
  return solanaUnixSeconds * 1_000 - Math.floor(localNowMs / 1_000) * 1_000;
}

export function calculateWarmUpBid(primaryBidAtlas: number, maximumBidAtlas: number):
  | { kind: 'ready'; bidAtlas: number }
  | { kind: 'blocked'; reason: string } {
  const bidAtlas = Math.ceil(Number((primaryBidAtlas * 1.35).toFixed(8)));
  return bidAtlas <= maximumBidAtlas
    ? { kind: 'ready', bidAtlas }
    : { kind: 'blocked', reason: `Warm-up bid ${bidAtlas} exceeds maximum ${maximumBidAtlas}` };
}

function roundedUpToWholeAtlas(value: number): number {
  return Math.ceil(roundedAtlas(value));
}

export function planLcfsReservation(
  entry: FleetWatchEntry,
  snapshot: FleetContractSnapshot,
  position: WalletPosition,
  nowMs = Date.now(),
): LcfsReservationPlan {
  const base = planAtlasReservation(entry, snapshot, position, nowMs);
  if (base.kind === 'blocked' || snapshot.reservationBidAtlas == null) return base;

  // Self-defender watch: while the on-chain reservation defender is our own
  // wallet we already hold the top spot, so we never overbid our own manual
  // bid. We still arm the last-second window and mark the plan watchOnly:
  // each inspection re-fetches fresh state, so a real challenger replacing us
  // rebuilds as a 110% counter-bid, while standing down at send time without
  // a transaction when we are still the defender. This closes the gap where
  // a snipe in the final seconds could otherwise never be answered.
  if (position.status === 'defending') {
    return { ...base, watchOnly: true };
  }

  const currentBid = snapshot.reservationBidAtlas;
  const bidAtlas = roundedUpToWholeAtlas(Math.max(base.bidAtlas, roundedAtlas(currentBid * 1.1)));
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
  resolveOwnedWallets: NonNullable<LcfsDependencies['resolveOwnedWallets']>,
): Promise<{ raw: ContractSnapshot; mapped: FleetContractSnapshot; plan: Extract<LcfsReservationPlan, { kind: 'ready' }> } | Extract<LcfsAttemptResult, { kind: 'blocked' }>> {
  const { raw, mapped } = await fetchBundle(entry.contractAddress, settings.rpcUrl);
  if (mapped.activeRentalEndsAtMs !== expectedActiveRentalEndsAtMs) {
    return { kind: 'blocked', reason: 'Active rental changed after this LCFS attempt was scheduled' };
  }
  const plan = planLcfsReservation(entry, mapped, deriveWalletPosition(mapped, await resolveOwnedWallets(settings, settings.rpcUrl)), nowMs);
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
  return { fingerprint: candidateFingerprint(inspected.mapped, inspected.plan), wireTransaction, bidAtlas: inspected.plan.bidAtlas, defender: inspected.mapped.reservationDefender };
}

type CandidateRefreshResult =
  | { kind: 'candidate'; candidate: PreparedLcfsCandidate | null }
  | Extract<LcfsAttemptResult, { kind: 'blocked' }>;

async function prepareOrRefreshCandidate(
  previous: PreparedLcfsCandidate | null,
  entry: FleetWatchEntry,
  settings: AppSettings,
  hotWalletSecret: string,
  expectedActiveRentalEndsAtMs: number,
  dependencies: LcfsDependencies,
  nowMs: number,
): Promise<CandidateRefreshResult> {
  const fetchBundle = dependencies.fetchBundle ?? loadBundle;
  const resolveOwnedWallets = dependencies.resolveOwnedWallets ?? resolveWalletOwnership;
  const inspected = await inspectFreshState(entry, settings, expectedActiveRentalEndsAtMs, nowMs, fetchBundle, resolveOwnedWallets);
  if ('kind' in inspected) return inspected;
  // While we are the defender there is nothing to sign: stand by until either
  // a challenger flips the top spot (fresh plan is no longer watchOnly) or the
  // send deadline passes without one. Returning null also discards any stale
  // challenger candidate if our wallet regained the top spot.
  if (inspected.plan.watchOnly) return { kind: 'candidate', candidate: null };
  const fingerprint = candidateFingerprint(inspected.mapped, inspected.plan);
  if (previous?.fingerprint === fingerprint) return { kind: 'candidate', candidate: previous };
  return { kind: 'candidate', candidate: await buildCandidate(inspected, settings, hotWalletSecret, dependencies) };
}

const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';

async function readSolanaUnixTime(rpcUrl: string): Promise<number> {
  const response = await createSolanaRpc(rpcUrl).getAccountInfo(address(CLOCK_SYSVAR), { encoding: 'base64', commitment: 'processed' }).send();
  if (!response.value) throw new Error('Solana Clock sysvar is unavailable');
  const bytes = Buffer.from(response.value.data[0], 'base64');
  if (bytes.length < 40) throw new Error('Solana Clock sysvar is malformed');
  return Number(bytes.readBigInt64LE(32));
}

async function loadMonitoredBundle(
  base: ContractSnapshot,
  rpcUrl: string,
  nowMs: number,
): Promise<{ raw: ContractSnapshot; mapped: FleetContractSnapshot }> {
  const sdk = rentalSdk() as typeof import('@sly-rentals/core') & {
    fetchRental: (rentalAddress: string, rpcUrl: string) => Promise<ContractSnapshot['queuedRental']>;
    deriveQueuedRental: (contractAddress: string) => Promise<string>;
  };
  const queuedAddress = await sdk.deriveQueuedRental(base.contract.address);
  const queuedRental = await sdk.fetchRental(queuedAddress, rpcUrl);
  const partial = { ...base, queuedRental, nowSeconds: Math.floor(nowMs / 1_000) };
  const minimumBid = sdk.computeMinimumBidFromSnapshot(partial);
  const raw = { ...partial, minimumBid } as ContractSnapshot;
  return { raw, mapped: mapContractSnapshot(raw) };
}

async function prepareWarmCandidate(
  warmUpAddress: string,
  bidAtlas: number,
  inspected: WarmTransactionInput['inspected'],
  settings: AppSettings,
  hotWalletSecret: string,
  dependencies: LcfsDependencies,
): Promise<PreparedLcfsCandidate> {
  if (dependencies.prepareWarmTransaction) {
    return {
      fingerprint: `warm:${warmUpAddress}:${bidAtlas}`,
      wireTransaction: await dependencies.prepareWarmTransaction({ warmUpAddress, bidAtlas, inspected, settings, hotWalletSecret }),
      bidAtlas,
      defender: warmUpAddress,
    };
  }
  if (!inspected.raw.queuedRental) throw new Error('Warm-up preparation requires a queued rental');
  const signer = createNoopSigner(address(warmUpAddress));
  const borrowerState = await (rentalSdk() as { deriveBorrowerState: (borrower: TransactionSigner) => Promise<string> }).deriveBorrowerState(signer);
  const assumedSnapshot = {
    ...inspected.raw,
    queuedRental: {
      ...inspected.raw.queuedRental,
      data: { ...inspected.raw.queuedRental.data, borrower: signer.address, borrowerState: address(borrowerState) },
    },
  } as ContractSnapshot;
  const plan = { ...inspected.plan, bidAtlas };
  const built = await (dependencies.build ?? buildUnsignedAtlasReservation)({
    plan, walletAddress: settings.walletAddress, challengerProfile: settings.playerProfile, rpcUrl: settings.rpcUrl, snapshot: assumedSnapshot,
  });
  if (!Array.isArray(built)) throw new Error('SDK did not return an instruction array');
  const wireTransaction = await (dependencies.prepareTransaction ?? prepareLcfsTransaction)(built as Instruction[], settings, hotWalletSecret);
  return { fingerprint: `warm:${warmUpAddress}:${bidAtlas}`, wireTransaction, bidAtlas, defender: warmUpAddress };
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
  const schedule = lcfsSchedule(expectedActiveRentalEndsAtMs, settings.lcfsLeadTimeSeconds);
  const validateAccess = dependencies.validateAccess ?? (async () => undefined);
  const fetchBundle = dependencies.fetchBundle ?? loadBundle;
  const resolveOwnedWallets = dependencies.resolveOwnedWallets ?? resolveWalletOwnership;
  const shouldMeasureClock = Boolean(dependencies.getSolanaUnixTime) || dependencies.now === undefined;
  const getSolanaUnixTime = dependencies.getSolanaUnixTime ?? readSolanaUnixTime;
  let clockOffsetMs = 0;
  const alignClock = async (phase: string, targetMs?: number) => {
    const requestStartedAtMs = now();
    let localMs = requestStartedAtMs;
    if (shouldMeasureClock) {
      try {
        const solanaUnixSeconds = await getSolanaUnixTime(settings.rpcUrl);
        localMs = (requestStartedAtMs + now()) / 2;
        clockOffsetMs = calculateSolanaClockOffsetMs(localMs, solanaUnixSeconds);
        await dependencies.onTiming?.({ phase, localMs, solanaUnixSeconds, offsetMs: clockOffsetMs, targetMs });
        return;
      } catch {
        clockOffsetMs = 0;
      }
    }
    await dependencies.onTiming?.({ phase, localMs, offsetMs: clockOffsetMs, targetMs });
  };
  const chainNow = () => now() + clockOffsetMs;
  const waitForPhase = async (phase: string, targetMs: number) => {
    await alignClock(phase, targetMs);
    const localTargetMs = targetMs - clockOffsetMs;
    if (now() < localTargetMs) await waitUntil(localTargetMs);
  };

  const candidateState: { value: PreparedLcfsCandidate | null } = { value: null };
  const refreshCandidate = async (forceAccessCheck: boolean): Promise<Extract<LcfsAttemptResult, { kind: 'blocked' }> | null> => {
    await validateAccess(forceAccessCheck);
    const refreshed = await prepareOrRefreshCandidate(
      candidateState.value, entry, settings, hotWalletSecret, expectedActiveRentalEndsAtMs, dependencies, chainNow(),
    );
    if (refreshed.kind === 'blocked') return refreshed;
    candidateState.value = refreshed.candidate;
    return null;
  };

  await waitForPhase('prepare', schedule.prepareAtMs);
  let blocked = await refreshCandidate(false);
  if (blocked) return blocked;
  await waitForPhase('refresh', schedule.refreshAtMs);
  blocked = await refreshCandidate(true);
  if (blocked) return blocked;
  await waitForPhase('final-check', schedule.finalCheckAtMs);
  blocked = await refreshCandidate(false);
  if (blocked) return blocked;
  await waitForPhase('send', schedule.sendAtMs);
  if (chainNow() >= expectedActiveRentalEndsAtMs) return { kind: 'blocked', reason: 'Active rental ended while the LCFS transaction was being prepared' };

  await validateAccess(false);
  const sendInspection = await inspectFreshState(entry, settings, expectedActiveRentalEndsAtMs, chainNow(), fetchBundle, resolveOwnedWallets);
  if ('kind' in sendInspection) return sendInspection;
  if (sendInspection.plan.watchOnly) {
    candidateState.value = null;
  } else {
    const sendFingerprint = candidateFingerprint(sendInspection.mapped, sendInspection.plan);
    candidateState.value = candidateState.value?.fingerprint === sendFingerprint
      ? candidateState.value
      : await buildCandidate(sendInspection, settings, hotWalletSecret, dependencies);
  }
  if (chainNow() >= expectedActiveRentalEndsAtMs) return { kind: 'blocked', reason: 'Active rental ended during the final LCFS state check' };

  const submissions: Array<{ lane: 'primary' | 'reactive' | 'warm'; signature: string; defender: string | null; bidAtlas: number }> = [];
  const submitCandidate = async (candidate: PreparedLcfsCandidate, lane: 'primary' | 'reactive' | 'warm', tolerateFailure: boolean) => {
    try {
      await dependencies.recordIntent?.(candidate.wireTransaction, candidate.bidAtlas);
      const signature = await (dependencies.submitPrepared ?? submitPreparedToHelius)(candidate.wireTransaction);
      submissions.push({ lane, signature, defender: candidate.defender, bidAtlas: candidate.bidAtlas });
      await dependencies.onSubmission?.({ lane, status: 'submitted', signature, defender: candidate.defender, bidAtlas: candidate.bidAtlas });
      return signature;
    } catch (error) {
      await dependencies.onSubmission?.({ lane, status: 'failed', defender: candidate.defender, bidAtlas: candidate.bidAtlas, detail: error instanceof Error ? error.message : String(error) });
      if (!tolerateFailure) throw error;
      return null;
    }
  };

  let primarySignature: string | null = null;
  if (candidateState.value) primarySignature = await submitCandidate(candidateState.value, 'primary', false);
  const monitorClosingWindow = dependencies.monitorAfterPrimary ?? dependencies.now === undefined;
  if (!monitorClosingWindow) {
    if (!primarySignature) return { kind: 'blocked', reason: 'self-defender at send time: no challenger appeared' };
    return { kind: 'submitted', signature: primarySignature, attemptKey: lcfsAttemptKey(entry.id, expectedActiveRentalEndsAtMs) };
  }

  const warmAtMs = expectedActiveRentalEndsAtMs - 2_000;
  const warmBaseSource = candidateState.value?.bidAtlas ?? sendInspection.mapped.reservationBidAtlas;
  const warmBase = warmBaseSource == null ? null : calculateWarmUpBid(warmBaseSource, entry.maximumReservationBidAtlas);
  const warmCandidates = new Map<string, Promise<PreparedLcfsCandidate | null>>();
  const prepareWarm = (warmUpAddress: string, bidAtlas: number, inspected = sendInspection) => {
    const promise = prepareWarmCandidate(warmUpAddress, bidAtlas, inspected, settings, hotWalletSecret, dependencies)
      .catch(() => null);
    warmCandidates.set(warmUpAddress, promise);
  };
  if (warmBase?.kind === 'ready') for (const warmUpAddress of settings.warmUpAddresses) prepareWarm(warmUpAddress, warmBase.bidAtlas);

  const owned = await resolveOwnedWallets(settings, settings.rpcUrl);
  const ownedAddresses = new Set(Array.isArray(owned) ? owned : owned.addresses);
  const warmSet = new Set(settings.warmUpAddresses);
  const fetchMonitoredBundle = dependencies.fetchBundle
    ? () => fetchBundle(entry.contractAddress, settings.rpcUrl)
    : () => loadMonitoredBundle(sendInspection.raw, settings.rpcUrl, chainNow());
  const handledFingerprints = new Set<string>();
  let warmSent = false;
  const pollMs = Math.max(100, dependencies.monitorIntervalMs ?? 250);
  while (chainNow() < expectedActiveRentalEndsAtMs) {
    const nextChainMs = Math.min(expectedActiveRentalEndsAtMs, warmSent ? chainNow() + pollMs : Math.min(warmAtMs, chainNow() + pollMs));
    if (nextChainMs > chainNow()) await waitUntil(nextChainMs - clockOffsetMs);
    if (!warmSent && chainNow() >= warmAtMs) {
      await alignClock('warm-send', warmAtMs);
      if (chainNow() < warmAtMs) await waitUntil(warmAtMs - clockOffsetMs);
      const prepared = await Promise.all([...warmCandidates.values()]);
      await Promise.all(prepared.filter((candidate): candidate is PreparedLcfsCandidate => candidate !== null)
        .map((candidate) => submitCandidate(candidate, 'warm', true)));
      warmSent = true;
    }
    if (chainNow() >= expectedActiveRentalEndsAtMs) break;
    const observed = await fetchMonitoredBundle();
    if (observed.mapped.activeRentalEndsAtMs !== expectedActiveRentalEndsAtMs) break;
    const observedPlan = planLcfsReservation(
      entry,
      observed.mapped,
      deriveWalletPosition(observed.mapped, owned),
      chainNow(),
    );
    if (observedPlan.kind === 'blocked') continue;
    const inspected = { ...observed, plan: observedPlan };
    const defender = inspected.mapped.reservationDefender;
    if (!defender || ownedAddresses.has(defender) || inspected.plan.watchOnly) continue;
    const fingerprint = candidateFingerprint(inspected.mapped, inspected.plan);
    if (handledFingerprints.has(fingerprint)) continue;
    handledFingerprints.add(fingerprint);
    if (!warmSent && warmSet.has(defender)) {
      if (warmBase?.kind === 'ready') {
        const liveBid = roundedUpToWholeAtlas(Math.max(warmBase.bidAtlas, (inspected.mapped.reservationBidAtlas ?? 0) * 1.1));
        if (liveBid <= entry.maximumReservationBidAtlas) prepareWarm(defender, liveBid, inspected);
      }
      continue;
    }
    const reactive = await buildCandidate(inspected, settings, hotWalletSecret, dependencies);
    await submitCandidate(reactive, 'reactive', true);
  }

  const firstSignature = primarySignature ?? submissions[0]?.signature;
  if (!firstSignature) return { kind: 'blocked', reason: 'No LCFS transaction was submitted before the rental ended' };
  return { kind: 'submitted', signature: firstSignature, attemptKey: lcfsAttemptKey(entry.id, expectedActiveRentalEndsAtMs) };
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
