import assert from 'node:assert/strict';
import test from 'node:test';
import { address, blockhash, generateKeyPairSigner, createTransactionMessage, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners, getBase64EncodedWireTransaction, getAddressEncoder } from '@solana/kit';
import { ATLAS_MINT, estimateFunding, requiredAtlasFunding, loadAtlasBalance, recordPendingFunding, withFundingLock } from '../src/funding.js';
import type { FleetContractSnapshot, FleetWatchEntry } from '../src/model.js';
import { parseWatchlist } from '../src/watchlist-store.js';
import { appendLcfsDiagnostic } from '../src/lcfs-diagnostics.js';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const entry = { requestedDurationSeconds: 40 * 86400, lcfs: true } as FleetWatchEntry;
const snapshot = { rentalRateAtlasPerDay: 1000, minimumTakeoverBidAtlas: 1000, reservationBidAtlas: 1000, projectedExpiryTakeoverBidAtlas: 1100 } as FleetContractSnapshot;

test('funding includes the complete requested duration and planned bid, with exact equality allowed', () => {
  const ready = estimateFunding(entry, snapshot, 41100, 123);
  assert.equal(ready.status, 'ready'); assert.equal(ready.requiredAtlas, 41100); assert.equal(ready.bidAtlas, 1100); assert.equal(ready.escrowAtlas, 40000);
  const short = estimateFunding(entry, snapshot, 41000, 123);
  assert.equal(short.status, 'short'); assert.equal(short.shortfallAtlas, 100);
  assert.equal(estimateFunding(entry, snapshot, null).status, 'unknown');
});

test('fractional days use upward-rounded integer dust and never claim unknown inputs are funded', () => {
  assert.equal(requiredAtlasFunding(0.00000001, 3600, 0), 0.00000001);
  assert.equal(requiredAtlasFunding(240, 3600, 12), 22);
  assert.equal(estimateFunding(entry, { ...snapshot, rentalRateAtlasPerDay: NaN }, 1e6).status, 'unknown');
  assert.equal(estimateFunding(entry, { ...snapshot, minimumTakeoverBidAtlas: null }, 1e6).status, 'unknown');
  assert.equal(estimateFunding({ ...entry, requestedDurationSeconds: -1 }, snapshot, 1e6).status, 'unknown');
  assert.throws(() => requiredAtlasFunding(100, 0.5, 1));
});

test('first free reservation still checks its rent escrow; held escrow is not added to spendable funds', () => {
  const first = estimateFunding(entry, { ...snapshot, minimumTakeoverBidAtlas: 0, currentMinimumBidAtlas: 1000,
    projectedExpiryTakeoverBidAtlas: null, reservationBidAtlas: null, reservationRentEscrowAtlas: 1e6 }, 1000);
  assert.equal(first.bidAtlas, 0); assert.equal(first.shortfallAtlas, 39000);
});

test('Funding is enabled once on migration and can subsequently be hidden', () => {
  const doc = parseWatchlist(JSON.stringify({ version: 4, contractTermsColumnsAdded: true, entries: [], visibleColumns: ['comment'] }));
  assert.deepEqual(doc.visibleColumns, ['comment', 'funding']);
  doc.visibleColumns = ['comment'];
  assert.deepEqual(parseWatchlist(JSON.stringify(doc)).visibleColumns, ['comment']);
});

test('wallet funding locks serialize simultaneous attempts and recover after an exception', async () => {
  const calls: number[] = [];
  const a = withFundingLock('test-lock', async () => { await new Promise(resolve => setTimeout(resolve, 10)); calls.push(1); throw new Error('failed'); });
  const b = withFundingLock('test-lock', async () => { calls.push(2); return 2; });
  assert.deepEqual((await Promise.allSettled([a,b])).map(x => x.status), ['rejected','fulfilled']);
  assert.deepEqual(calls, [1,2]);
});

test('ATA balance excludes pending sends until confirmation, then reads at or beyond their slot', async () => {
  const signer = await generateKeyPairSigner();
  const message = setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 999n },
    setTransactionMessageFeePayerSigner(signer, createTransactionMessage({ version: 0 })));
  const wire = getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(message));
  const bytes = Buffer.alloc(165); const encoder = getAddressEncoder();
  bytes.set(encoder.encode(address(ATLAS_MINT)),0); bytes.set(encoder.encode(signer.address),32);bytes.writeBigUInt64LE(500n*100_000_000n,64);bytes[108]=1;
  const saved = globalThis.fetch; let confirmed = false; let valid = false; const reads: any[] = [];
  globalThis.fetch = (async (_url, init) => {
    const req = JSON.parse(String(init?.body)); let result: unknown;
    if (req.method === 'getSignatureStatuses') result = { context:{slot:200}, value:[confirmed?{slot:150,confirmations:1,err:null,confirmationStatus:'confirmed'}:null] };
    else if (req.method === 'isBlockhashValid') result = { context:{slot:200},value:valid };
    else { reads.push(req.params); result={context:{slot:200},value:{data:[bytes.toString('base64'),'base64'],owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',lamports:2039280,executable:false,rentEpoch:0,space:165}}; }
    return new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,result}),{headers:{'content-type':'application/json'}});
  }) as typeof fetch;
  try {
    assert.equal(await loadAtlasBalance(signer.address, 'https://rpc.invalid'),500);
    recordPendingFunding(signer.address, wire, 200);
    assert.equal(await loadAtlasBalance(signer.address, 'https://rpc.invalid'),300);
    // A not-yet-finalized blockhash must not release funds on a false result.
    valid=true;assert.equal(await loadAtlasBalance(signer.address, 'https://rpc.invalid'),300);
    valid=false;assert.equal(await loadAtlasBalance(signer.address, 'https://rpc.invalid'),500);
    assert.equal(reads.at(-1)[1].minContextSlot,200);
    recordPendingFunding(signer.address, wire, 200);
    confirmed=true;bytes.writeBigUInt64LE(300n*100_000_000n,64);
    assert.equal(await loadAtlasBalance(signer.address, 'https://rpc.invalid'),300);
    assert.equal(reads.at(-1)[1].minContextSlot,200);
    assert.equal(await loadAtlasBalance(signer.address, 'https://rpc.invalid'),300);
    assert.equal(reads.at(-1)[1].minContextSlot,200);
    bytes[108]=2;assert.equal(await loadAtlasBalance(signer.address, 'https://rpc.invalid'),null);
  } finally { globalThis.fetch=saved; }
});

test('durable LCFS diagnostics append events and redact provider URLs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'fleet-diagnostics-'));
  await appendLcfsDiagnostic(dir,{status:'failed',detail:'https://rpc.example/?api-key=private-token'});
  await appendLcfsDiagnostic(dir,{status:'submitted',signature:'public-signature'});
  const files=await readdir(path.join(dir,'lcfs-diagnostics'));
  const text=await readFile(path.join(dir,'lcfs-diagnostics',files[0]),'utf8');
  assert.equal(text.trim().split('\n').length,2); assert.doesNotMatch(text,/private-token/);
  assert.match(text,/public-signature/);text.trim().split('\n').forEach(line=>JSON.parse(line));
});

test('Large screenshot: LCFS off funds rent only, while enabling LCFS restores bid-limit checks', () => {
  const rule = { ...entry, lcfs: false, requestedDurationSeconds: 24 * 86400, maximumReservationBidAtlas: 8000, maximumRentalRateAtlasPerDay: 2900 };
  const large = { ...snapshot, rentalRateAtlasPerDay: 2900, minimumTakeoverBidAtlas: 1649700,
    projectedExpiryTakeoverBidAtlas: 1650000, reservationBidAtlas: 0 };
  const off = estimateFunding(rule, large, 201960.44283635);
  assert.equal(off.status, 'ready'); assert.equal(off.bidAtlas, 0);
  assert.equal(off.escrowAtlas, 69600); assert.equal(off.requiredAtlas, 69600);
  assert.equal(off.shortfallAtlas, 0); assert.equal(off.limitDetail, null);
  const on = estimateFunding({ ...rule, lcfs: true }, large, 201960.44283635);
  assert.equal(on.status, 'bid-limit'); assert.equal(on.bidAtlas, 1650000);
  assert.equal(on.requiredAtlas, 1719600); // Live requirements are never capped to Max bid.
  assert.match(on.limitDetail!, /8000/);
  assert.equal(estimateFunding(rule, large, 69600).status, 'ready');
  const short = estimateFunding(rule, large, 69000);
  assert.equal(short.status, 'short'); assert.equal(short.shortfallAtlas, 600);
});

test('LCFS off ignores unavailable takeover data but still needs valid rent and a known balance', () => {
  const rule = { ...entry, lcfs: false, maximumReservationBidAtlas: 0, maximumRentalRateAtlasPerDay: 1000 };
  for (const minimum of [null, NaN, Infinity, -1]) {
    const unknownBid = { ...snapshot, minimumTakeoverBidAtlas: minimum, projectedExpiryTakeoverBidAtlas: NaN };
    assert.equal(estimateFunding(rule, unknownBid, 40000).status, 'ready');
    assert.equal(estimateFunding({ ...rule, lcfs: true }, unknownBid, 40000).status, 'unknown');
  }
  assert.equal(estimateFunding(rule, snapshot, null).status, 'unknown');
  assert.equal(estimateFunding(rule, { ...snapshot, rentalRateAtlasPerDay: NaN }, 40000).status, 'unknown');
});

test('rate-limit blockers precede shortfalls and disappear when the rule permits the live rate', () => {
  const rule = { ...entry, lcfs: false, requestedDurationSeconds: 24 * 86400, maximumRentalRateAtlasPerDay: 10000, maximumReservationBidAtlas: 33000 };
  const mining = { ...snapshot, rentalRateAtlasPerDay: 10500, minimumTakeoverBidAtlas: 0 };
  const blocked = estimateFunding(rule, mining, 201960.44283635);
  assert.equal(blocked.status, 'rate-limit'); assert.equal(blocked.requiredAtlas, 252000);
  assert.match(blocked.limitDetail!, /10500.*10000/);
  assert.equal(estimateFunding({ ...rule, maximumRentalRateAtlasPerDay: 10500 }, mining, 201960.44283635).status, 'short');
  assert.equal(estimateFunding(rule, mining, null).status, 'rate-limit');
});

test('LCFS projected bid above Max bid is shown as a limit even with enough ATLAS', () => {
  const rule = { ...entry, maximumReservationBidAtlas: 1100, maximumRentalRateAtlasPerDay: 1000 };
  assert.equal(estimateFunding(rule, { ...snapshot, projectedExpiryTakeoverBidAtlas: 1101 }, 1e6).status, 'bid-limit');
  assert.equal(estimateFunding(rule, snapshot, 41100).status, 'ready');
});
