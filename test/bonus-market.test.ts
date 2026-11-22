import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { address, type Address } from '@solana/kit';
import test from 'node:test';
import { discoverBonusMarket } from '../src/bonus-strategy.js';
import { NEXT_GEN_SRSLY_PROGRAM_ID } from '../src/model.js';
import { MAINNET_SAGE_PROGRAM, rentalSdk } from '../src/rental-sdk.js';

const {
  getConfigStateEncoder, getContractStateEncoder, getFleetDecoder, getFleetEncoder, getRentalStateEncoder, RentalStatus,
} = createRequire(import.meta.url)('@sly-rentals/core/codama') as typeof import('@sly-rentals/core/codama');

test('market scan enumerates reservable contracts, including idle fleets, and batches account reads', async () => {
  const empty = address('11111111111111111111111111111111');
  const fleet = address('So11111111111111111111111111111111111111112');
  const clock = address('SysvarC1ock11111111111111111111111111111111');
  const activeContract = address('FiELMQBWWxRtv78dQQcpD2McCsrRZMhgbXETrH1EyMk7');
  const idleContract = address('85BbUrMbPGDekp8mfSznWaSujHKaHrSgsTmiRfVr62Bo');
  const closedContract = address('gQxJAPtmHYAfhLZFxipsESMxKiLkbARNcSpG63dKm8x');
  const disabledContract = address('ComputeBudget111111111111111111111111111111');
  const active = await rentalSdk().deriveActiveRental(activeContract);
  const configAddress = await rentalSdk().deriveConfig();
  const now = 1_800_000_000;
  const end = now + 2 * 86_400;
  const clockBytes = Buffer.alloc(40);
  clockBytes.writeBigInt64LE(BigInt(now), 32);
  const configBytes = getConfigStateEncoder().encode({
    version: 2, bump: 255, admin: empty, stardustToAtlas: 100_000_000, serviceFeeBps: 1000, baseBps: 10_000,
    rentalDurationMinSeconds: 3600, rentalDurationMaxSeconds: 2_073_600, atlasMint: empty, slyvault: empty,
    reservationsEnabled: true, pointsPerDay: 0, cancellationPenalty: 0, minCaptureThreshold: 0, weightBase: 10,
    weightMultiplier: 1.5, maxWeight: 5, captureRateBps: 10_500, atlasPerPoint: 100, contestedMultiplierMaxBps: 465,
    rentalsCompleted: 0, lookupTable: empty, createdAt: 0, updatedAt: 0, staleDiscountPerDayBps: 0, bonusMultiplierBps: 100,
  });
  const rentalBytes = getRentalStateEncoder().encode({
    version: 2, bump: 255, borrower: idleContract, borrowerState: idleContract, borrowerProfile: idleContract, contract: activeContract,
    rate: 400_000_000_000, lastPayment: 0, escrow: 0, startTime: now - 86_400, endTime: end, serviceFee: 0, feeBps: 0,
    referrer: null, discountBps: 0, bidPoints: 0, bidAtlas: 0, cancelDelayMin: 0, status: RentalStatus.Active, updatedAt: 0, createdAt: 0,
  });
  const fleetDecoder = getFleetDecoder();
  assert.ok('fixedSize' in fleetDecoder);
  const blankFleet = fleetDecoder.decode(Buffer.alloc(fleetDecoder.fixedSize));
  const fleetBody = getFleetEncoder().encode({ ...blankFleet, fleetLabel: Buffer.from('Market Scout') });
  const fleetBytes = Buffer.concat([createHash('sha256').update('account:Fleet').digest().subarray(0, 8), Buffer.from(fleetBody)]);
  const account = (bytes: ArrayLike<number>, owner = NEXT_GEN_SRSLY_PROGRAM_ID) => ({
    data: [Buffer.from(bytes).toString('base64'), 'base64'], owner, executable: false, lamports: 1,
  });
  const listed = (pubkey: Address, activeRental: Address, toClose = false, reservationsDisabled = false) => ({
    pubkey, account: account(getContractStateEncoder().encode({
      version: 2, bump: 255, toClose, rate: 400_000_000_000, durationMinSeconds: 3600, durationMaxSeconds: 2_073_600,
      cancelDelayMin: 3600, weight: 1, reservationsDisabled, owner: empty, fleet, gameId: empty, ownerProfile: empty,
      activeRental, queuedRental: empty, delegate: null, thread: empty, trigger: { __kind: 'Immediate', jitter: 0 },
      managedTokenAccount: empty, totalEarned: 0, ownerClaimable: 0, feeClaimable: 0,
      contestedThreshold: 0, contestedCount: 0, createdAt: 0, updatedAt: 0, staleDiscountMaxBps: 0, staleSince: 0,
    })),
  });
  const accounts = new Map([
    [configAddress, account(configBytes)], [clock, account(clockBytes, empty)], [active, account(rentalBytes)],
    [fleet, account(fleetBytes, MAINNET_SAGE_PROGRAM)],
  ]);
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const { id, method, params } = JSON.parse(String(init?.body));
    calls.push(method);
    if (method === 'getProgramAccounts') {
      assert.equal(params[0], NEXT_GEN_SRSLY_PROGRAM_ID);
      assert.equal(params[1].filters.length, 1);
      return Response.json({ jsonrpc: '2.0', id, result: [
        listed(activeContract, active), listed(idleContract, empty), listed(closedContract, empty, true), listed(disabledContract, empty, false, true),
      ] });
    }
    assert.ok(method === 'getAccountInfo' || method === 'getMultipleAccounts');
    const value = method === 'getAccountInfo' ? accounts.get(params[0]) : params[0].map((key: Address) => accounts.get(key));
    return Response.json({ jsonrpc: '2.0', id, result: { context: { slot: 1 }, value } });
  };
  try {
    const rows = await discoverBonusMarket('https://rpc.example.test');
    assert.deepEqual(rows.map(row => row.contractAddress), [activeContract, idleContract]);
    assert.deepEqual(rows.map(row => row.fleetName), ['Market Scout', 'Market Scout']);
    assert.deepEqual(rows.map(row => row.bidAtlas), [4000, null]);
    assert.deepEqual(rows.map(row => row.endsAtMs), [end * 1000, null]);
    assert.ok(rows.every(row => row.minimumSeconds === 3600 && row.stateKnown));
    assert.deepEqual(calls.sort(), ['getAccountInfo', 'getAccountInfo', 'getMultipleAccounts', 'getMultipleAccounts', 'getProgramAccounts']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
