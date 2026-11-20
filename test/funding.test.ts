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
