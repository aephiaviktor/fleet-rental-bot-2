import {
  address, createSolanaRpc, getSignatureFromTransaction, getTransactionDecoder, signature,
  type Base64EncodedWireTransaction, type Instruction,
} from '@solana/kit';
import type { ContractSnapshot } from '@sly-rentals/core';
import { createRequire } from 'node:module';
import { clearPendingBonusBid, readPendingBonusBid, savePendingBonusBid, type BonusRule } from './bonus-store.js';
import { loadAtlasBalance, recordPendingFunding, requiredAtlasFunding, withFundingLock } from './funding.js';
import { prepareSenderTransaction, submitPreparedToHelius } from './lcfs.js';
import { NEXT_GEN_SRSLY_PROGRAM_ID, type FleetContractSnapshot, type FleetWatchEntry } from './model.js';
import type { AtlasReservationPlan } from './reservation-plan.js';
import { loadRawContractSnapshot, mapContractSnapshot } from './protocol-snapshot.js';
import { rentalSdk } from './rental-sdk.js';
import { recordBidIntent } from './rental-history.js';
import { withRpcDeadline } from './rpc-fetch-limiter.js';
import type { AppSettings } from './settings-store.js';
import { buildUnsignedAtlasReservation } from './unsigned-reservation.js';

export const BONUS_OVERBID_MIN_REMAINING_MS = 24 * 60 * 60 * 1_000;
const NO_RENTAL = '11111111111111111111111111111111';
const { fetchAllMaybeContractState, fetchAllMaybeRentalState, RentalStatus } = createRequire(import.meta.url)(
  '@sly-rentals/core/codama',
) as typeof import('@sly-rentals/core/codama');
type ReadyPlan = Extract<AtlasReservationPlan, { kind: 'ready' }> & { requiredAtlas: number; overbid: boolean; sendDeadlineMs: number };
type BonusPlan = ReadyPlan | { kind: 'blocked'; detail: string };

export function planBonusReservation(
  entry: FleetWatchEntry, rule: BonusRule, snapshot: FleetContractSnapshot, ours: boolean, nowMs: number,
): BonusPlan {
  const blocked = (detail: string): BonusPlan => ({ kind: 'blocked', detail });
  if (!entry.enabled || !rule.fcfs) return blocked('FCFS paused');
  if (!entry.canSafelyOperate) return blocked('Fleet marked unsafe');
  if (!snapshot.reservationsAllowed) return blocked('Reservations closed');
  const endMs = snapshot.activeRentalEndsAtMs;
  if (endMs == null || endMs <= nowMs) return blocked('Waiting for the next rental cycle');
  if (ours) return blocked('Our bid is holding');
  const overbid = snapshot.reservationDefender !== null;
  const sendDeadlineMs = overbid ? endMs - BONUS_OVERBID_MIN_REMAINING_MS : endMs - 1;
  if (nowMs > sendDeadlineMs) return blocked('Overbidding closed · under 24h left');
  const durationSeconds = snapshot.minimumDurationSeconds;
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds <= 0 || durationSeconds > snapshot.maximumDurationSeconds) return blocked('Minimum rental duration unavailable');
  const rate = snapshot.rentalRateAtlasPerDay;
  const minimum = snapshot.currentMinimumBidAtlas ?? snapshot.minimumTakeoverBidAtlas;
  if (!Number.isFinite(rate) || rate <= 0 || minimum == null || !Number.isFinite(minimum) || minimum < 0) return blocked('Live bid quote unavailable');
  const bidAtlas = Math.max(rate, minimum);
  if (bidAtlas > rule.maximumBidAtlas) return blocked('Required premium exceeds Max bid');
  return {
    kind: 'ready',
    action: 'reserve',
    contractAddress: entry.contractAddress,
    bidAtlas,
    requestedDurationSeconds: durationSeconds,
    maximumBidAtlas: rule.maximumBidAtlas,
    maximumRentalRateAtlasPerDay: rule.maximumBidAtlas,
    activeRentalEndsAtMs: endMs,
    expiresAtMs: endMs,
    requiredAtlas: requiredAtlasFunding(rate, durationSeconds, bidAtlas),
    overbid,
    sendDeadlineMs,
  };
}

export async function readBonusFleet(contractAddress: string, rpcUrl: string) {
  const receivedAtMs = performance.now();
  const raw = await loadRawContractSnapshot(contractAddress, rpcUrl);
  if ((raw.activeRental && (raw.activeRental.data.contract !== contractAddress || raw.activeRental.data.status !== RentalStatus.Active))
    || (raw.queuedRental && (raw.queuedRental.data.contract !== contractAddress || raw.queuedRental.data.status !== RentalStatus.Queued))) {
    throw new Error('Rental accounts changed during the FCFS snapshot');
  }
  return { raw, snapshot: mapContractSnapshot(raw), receivedAtMs };
}

type BonusFleet = Awaited<ReturnType<typeof readBonusFleet>>;
type RuntimeSettings = AppSettings & { hotWalletSecret: string };

/** Poll armed fleets in batches. A bid still requires an individual fresh read. */
export async function pollBonusFleets(contracts: string[], rpcUrl: string): Promise<Map<string, BonusFleet>> {
  const rpc = createSolanaRpc(rpcUrl);
  const sdk = rentalSdk();
  const receivedAtMs = performance.now();
  const [config, nowSeconds] = await Promise.all([sdk.fetchConfig(rpcUrl), sdk.fetchChainNowSeconds(rpcUrl)]);
  const fleets = new Map<string, BonusFleet>();
  for (let offset = 0; offset < contracts.length; offset += 50) {
    const accounts = await fetchAllMaybeContractState(rpc, contracts.slice(offset, offset + 50).map(address), { commitment: 'finalized' });
    const valid = accounts.filter(account => account.exists).filter(account => account.programAddress === NEXT_GEN_SRSLY_PROGRAM_ID);
    const rentalAddresses = [...new Set(valid.flatMap(({ data }) => [data.activeRental, data.queuedRental]))]
      .filter(rental => rental !== NO_RENTAL);
    const rentals = rentalAddresses.length
      ? await fetchAllMaybeRentalState(rpc, rentalAddresses, { commitment: 'finalized' }) : [];
    const byAddress = new Map(rentals.filter(account => account.exists).filter(account => account.programAddress === NEXT_GEN_SRSLY_PROGRAM_ID)
      .map(account => [account.address, account]));
    for (const contract of valid) {
      const { activeRental: active, queuedRental: queued } = contract.data;
      const activeRental = byAddress.get(active) ?? null;
      const queuedRental = byAddress.get(queued) ?? null;
      if ((active !== NO_RENTAL && (activeRental?.data.contract !== contract.address || activeRental.data.status !== RentalStatus.Active))
        || (queued !== NO_RENTAL && (queuedRental?.data.contract !== contract.address || queuedRental.data.status !== RentalStatus.Queued))) continue;
      const state = { config, contract, activeRental, queuedRental, nowSeconds };
      const raw = {
        ...state, minimumBid: sdk.computeMinimumBidFromSnapshot(state),
        effectiveRate: sdk.rateAfterStaleDecay(contract.data, config.data, nowSeconds),
      };
      fleets.set(contract.address, { raw, snapshot: mapContractSnapshot(raw), receivedAtMs });
    }
  }
  return fleets;
}

export function ourBonusDefender(raw: ContractSnapshot, settings: Pick<AppSettings, 'playerProfile' | 'walletAddress'>): boolean {
  const queued = raw.queuedRental?.data;
  return queued != null && (queued.borrowerProfile === settings.playerProfile || queued.borrower === settings.walletAddress);
}

function chainNow(fleet: BonusFleet): number {
  return fleet.raw.nowSeconds * 1_000 + (performance.now() - fleet.receivedAtMs);
}

type BonusAttemptResult = { status: 'waiting' | 'warning' | 'pending' | 'submitted'; detail: string };

export async function executeBonusBid(
  entry: FleetWatchEntry, rule: BonusRule, fleet: BonusFleet, settings: RuntimeSettings,
  dataDirectory: string, historyFile: string, stillEnabled: () => Promise<boolean>,
): Promise<BonusAttemptResult> {
  const waiting = (detail: string): BonusAttemptResult => ({ status: 'waiting', detail });
  const warning = (detail: string): BonusAttemptResult => ({ status: 'warning', detail });
  const { walletAddress, playerProfile, rpcUrl } = settings;
  const contract = entry.contractAddress;
  const rpc = createSolanaRpc(rpcUrl);

  const pending = await readPendingBonusBid(dataDirectory, walletAddress, contract);
  if (pending) {
    const result = await rpc.getSignatureStatuses([signature(pending.signature)], { searchTransactionHistory: true }).send();
    const observed = result.value[0];
    if (observed?.confirmationStatus === 'finalized') {
      await clearPendingBonusBid(dataDirectory, walletAddress, contract);
      return observed.err ? warning('Previous FCFS bid failed on chain') : waiting('FCFS bid confirmed · checking the queue');
    }
    if (observed || await rpc.getBlockHeight({ commitment: 'finalized' }).send() <= BigInt(pending.lastValidBlockHeight)) {
      return { status: 'pending', detail: 'Waiting for FCFS bid confirmation' };
    }
    await clearPendingBonusBid(dataDirectory, walletAddress, contract);
    return waiting('Previous FCFS bid expired · checking the queue');
  }

  const initial = planBonusReservation(entry, rule, fleet.snapshot, ourBonusDefender(fleet.raw, settings), chainNow(fleet));
  if (initial.kind === 'blocked') return waiting(initial.detail);
  // The contest floor can rise while a transaction is signed and sent.
  const projected = initial.overbid
    ? Number(rentalSdk().computeMinimumBidFromSnapshot(fleet.raw, { nowSeconds: chainNow(fleet) / 1_000 + 5 }).atlas) / Number(fleet.raw.config.data.stardustToAtlas)
    : initial.bidAtlas;
  const bidAtlas = Number.isFinite(projected) && projected <= rule.maximumBidAtlas ? Math.max(initial.bidAtlas, projected) : initial.bidAtlas;
  const plan = { ...initial, bidAtlas };
  const built = await buildUnsignedAtlasReservation({ plan, walletAddress, challengerProfile: playerProfile, rpcUrl, snapshot: fleet.raw });
  if (!Array.isArray(built)) throw new Error('SDK did not return reservation instructions');
  const prepared = await prepareSenderTransaction(built as Instruction[], settings, settings.hotWalletSecret);
  const required = requiredAtlasFunding(fleet.snapshot.rentalRateAtlasPerDay, plan.requestedDurationSeconds, bidAtlas);
  const simulation = await rpc.simulateTransaction(prepared.wire as Base64EncodedWireTransaction, {
    commitment: 'confirmed', encoding: 'base64', sigVerify: true,
  }).send();
  const fresh = await readBonusFleet(contract, rpcUrl);
  const latest = planBonusReservation(entry, rule, fresh.snapshot, ourBonusDefender(fresh.raw, settings), chainNow(fresh));
  if (latest.kind === 'blocked') return waiting(latest.detail);
  if (fresh.snapshot.activeRentalIdentity !== fleet.snapshot.activeRentalIdentity
    || fresh.snapshot.reservationIdentity !== fleet.snapshot.reservationIdentity
    || fresh.raw.contract.data.rate !== fleet.raw.contract.data.rate
    || fresh.snapshot.rentalRateAtlasPerDay !== fleet.snapshot.rentalRateAtlasPerDay
    || latest.requestedDurationSeconds !== plan.requestedDurationSeconds
    || latest.bidAtlas > bidAtlas) return waiting('Rental or bid changed · refreshing quote');

  const checkedAtMs = performance.now();
  const stillValid = async () => await stillEnabled() && chainNow(fresh) <= latest.sendDeadlineMs
    && performance.now() - checkedAtMs <= 4_000;

  const submission = await withFundingLock(walletAddress, () => withRpcDeadline(AbortSignal.timeout(4_000), async () => {
    if (!await stillValid()) return waiting('FCFS rule, quote or bidding window changed');
    const available = await loadAtlasBalance(walletAddress, rpcUrl);
    if (available === null) return warning('ATLAS balance unavailable');
    if (available < required) return warning(`Insufficient ATLAS · need ${required.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
    if (simulation.value.err !== null) return warning(`Simulation failed · ${JSON.stringify(simulation.value.err)}`);
    if (!await stillValid()) return waiting('FCFS rule, quote or bidding window changed');

    const tx = getTransactionDecoder().decode(Buffer.from(prepared.wire, 'base64'));
    const bidSignature = getSignatureFromTransaction(tx);
    recordBidIntent(historyFile, playerProfile, { signature: bidSignature, contract, borrower: walletAddress, currency: 'Atlas', amount: bidAtlas });
    await savePendingBonusBid(dataDirectory, walletAddress, contract, {
      signature: bidSignature, lastValidBlockHeight: prepared.lastValidBlockHeight.toString(),
    });
    if (!await stillValid()) {
      await clearPendingBonusBid(dataDirectory, walletAddress, contract);
      return waiting('FCFS rule, quote or bidding window changed');
    }

    recordPendingFunding(walletAddress, prepared.wire, required);
    // Funding is reserved before sending, so the wallet lock can be released while Sender responds.
    return { acknowledged: submitPreparedToHelius(prepared.wire).then(() => true, () => false) };
  }));
  if (!('acknowledged' in submission)) return submission;
  if (!await submission.acknowledged) return { status: 'pending', detail: 'Submission uncertain · checking for confirmation' };
  return { status: 'submitted', detail: `FCFS bid submitted · ${bidAtlas.toLocaleString(undefined, { maximumFractionDigits: 2 })} ATLAS` };
}
