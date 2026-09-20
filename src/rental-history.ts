import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { createSolanaRpc, address, type Base58EncodedBytes, type Base64EncodedBytes } from '@solana/kit';
import { NEXT_GEN_SRSLY_PROGRAM_ID } from './model.js';

interface ObservedRental {
  address: string;
  data: { status: number; borrowerProfile: string; borrower: string; contract: string;
    startTime: bigint; endTime: bigint; rate: bigint; bidAtlas: bigint; bidPoints: bigint };
}
export interface RentalHistoryRow {
  id: string; contract: string; borrower: string; start: number; end: number;
  rate: number | null; rentTotal: number | null; bid: number | null; currency: string | null;
  fleet?: string; signature?: string; startEstimated?: boolean; observedAt: number; status: 'Active' | 'Completed';
}
function open(file: string) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS rental_history (
    profile TEXT NOT NULL, id TEXT NOT NULL, start INTEGER NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(profile,id,start))`);
  return db;
}
export function recordRentals(file: string, profile: string, rentals: ObservedRental[], now = Date.now()): void {
  if (!profile) return;
  const db = open(file);
  try {
    const put = db.prepare('INSERT INTO rental_history VALUES (?,?,?,?) ON CONFLICT(profile,id,start) DO UPDATE SET payload=excluded.payload');
    for (const {address: id,data: r} of rentals) {
      // Queued/available/cancelled accounts do not prove a successful rental.
      if (r.borrowerProfile !== profile || r.status !== 2) continue;
      const start=Number(r.startTime)*1000,end=Number(r.endTime)*1000;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<=0 || start>now || end<=start) continue;
      const rate=Number(r.rate)/1e8,atlas=Number(r.bidAtlas)/1e8,points=Number(r.bidPoints)/1e8;
      const row = {id,contract:r.contract,borrower:r.borrower,start,end,rate,
        rentTotal:rate*(end-start)/86400000,bid:atlas>0?atlas:points>0?points:null,
        currency:atlas>0?'Atlas':points>0?'Points':null,observedAt:now};
      const prior=db.prepare('SELECT start,payload FROM rental_history WHERE profile=? AND id=? AND ABS(start-?)<=60000').all(profile,id,start).find(x=>{const p=JSON.parse(String(x.payload));return p.borrower===r.borrower && p.startEstimated;});
      const previous=prior?JSON.parse(String(prior.payload)):JSON.parse(String(db.prepare('SELECT payload FROM rental_history WHERE profile=? AND id=? AND start=?').get(profile,id,start)?.payload||'{}'));
      if(prior && prior.start!==start)db.prepare('DELETE FROM rental_history WHERE profile=? AND id=? AND start=?').run(profile,id,Number(prior.start));
      put.run(profile,id,start,JSON.stringify({...previous,...row,startEstimated:false}));
    }
  } finally { db.close(); }
}
export function readRentalHistory(file: string, profile: string, now = Date.now()): RentalHistoryRow[] {
  const db=open(file);
  try {
    return db.prepare('SELECT payload FROM rental_history WHERE profile=? ORDER BY start DESC,id').all(profile)
      .map(raw=>{const row=JSON.parse(String(raw.payload));return {...row,status:row.end>now?'Active':'Completed'};});
  } finally {db.close();}
}
/** Confirmed account scan filtered by profile, including manual rentals outside the watchlist.
 * Closed accounts cannot be backfilled from current state; never claim complete history.
 * Layout comes from SDK 5.4.0 generated RentalState: discriminator/u32/u8/borrower/borrowerState/profile.
 */
export async function discoverRentals(profile: string, rpcUrl: string): Promise<ObservedRental[]> {
  const core=createRequire(import.meta.url)('@sly-rentals/core/codama') as typeof import('@sly-rentals/core/codama');
  const rpc=createSolanaRpc(rpcUrl);
  const accounts=await rpc.getProgramAccounts(address(NEXT_GEN_SRSLY_PROGRAM_ID), {
    encoding:'base64',commitment:'confirmed',filters:[
      {memcmp:{offset:0n,encoding:'base64',bytes:Buffer.from(core.RENTAL_STATE_DISCRIMINATOR).toString('base64') as Base64EncodedBytes}},
      {memcmp:{offset:77n,encoding:'base58',bytes:address(profile) as unknown as Base58EncodedBytes}},
    ],
  }).send();
  const decoder=core.getRentalStateDecoder();
  return accounts.map(account=>({address:account.pubkey,data:decoder.decode(Buffer.from(account.account.data[0],'base64'))}));
}
