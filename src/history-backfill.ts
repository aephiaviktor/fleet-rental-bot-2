import {createRequire} from 'node:module';
import {getBase58Encoder} from '@solana/kit';
import {DatabaseSync} from 'node:sqlite';
import {NEXT_GEN_SRSLY_PROGRAM_ID} from './model.js';
import {readRentalHistory, type RentalHistoryRow} from './rental-history.js';
const require=createRequire(import.meta.url);
const audit=require('@sly-rentals/core/audit') as typeof import('@sly-rentals/core/audit');
const core=require('@sly-rentals/core/codama') as typeof import('@sly-rentals/core/codama');
export function decodeAcceptedRentals(tx:any, signature:string, profile:string):RentalHistoryRow[]{
 if(!tx?.meta || tx.meta.err!==null || !Number.isSafeInteger(tx.blockTime) || tx.blockTime<=0)return [];
 const message=tx.transaction?.message;if(!message)return [];
 const keys=[...(message.accountKeys||[]),...(tx.meta.loadedAddresses?.writable||[]),...(tx.meta.loadedAddresses?.readonly||[])].map(x=>typeof x==='string'?x:x.pubkey);
 const instructions=[...(message.instructions||[]),...(tx.meta.innerInstructions||[]).flatMap((g:any)=>g.instructions||[])];
 const rows:RentalHistoryRow[]=[];
 for(const ix of instructions){
  if(keys[ix.programIdIndex]!==NEXT_GEN_SRSLY_PROGRAM_ID || !ix.data)continue;
  const bytes=getBase58Encoder().encode(ix.data);
  if(!core.ACCEPT_RENTAL_DISCRIMINATOR.every((b,i)=>bytes[i]===b))continue;
  // SDK 5.4.0: 26 fixed accounts, then borrower profile as first SAGE remaining account.
  if(ix.accounts?.length<31)throw new Error('Unsupported acceptRental account layout');
  const accounts=ix.accounts.map((i:number)=>keys[i]);if(accounts[26]!==profile)continue;
  const data=core.getAcceptRentalInstructionDataDecoder().decode(bytes);
  const start=tx.blockTime*1000,end=start+Number(data.duration)*1000;
  if(!Number.isSafeInteger(end)||end<=start)throw new Error('Invalid historical rental duration');
  rows.push({id:accounts[7],contract:accounts[6],borrower:accounts[0],fleet:accounts[4],signature,start,end,rate:null,rentTotal:null,bid:null,currency:null,observedAt:Date.now(),status:end>Date.now()?'Active':'Completed',startEstimated:true});
 }
 const events=audit.parseAnchorEvents(tx.meta.logMessages||[],NEXT_GEN_SRSLY_PROGRAM_ID,BigInt(tx.slot||0),signature);
 for(const row of rows){
  const accepted=events.find(e=>e.type==='RentalAccepted' && e.rentalState===row.id && e.contract===row.contract && e.borrower===row.borrower);
  if(accepted?.type==='RentalAccepted'){
   row.start=Number(accepted.startTime)*1000;row.end=Number(accepted.endTime)*1000;
   row.rate=Number(accepted.rate)/1e8;row.rentTotal=row.rate*(row.end-row.start)/86400000;
   row.startEstimated=false;row.status=row.end>Date.now()?'Active':'Completed';
  }
 }
 return rows;
}
/** RentalClosed awards are integer CTF points, not ATLAS/point-bid stardust. */
export function applyClosedRental(rows:RentalHistoryRow[],event:any,at:number,signature:string):boolean {
 if(event.type!=='RentalClosed' || typeof event.pointsAwarded!=='bigint' || event.pointsAwarded<0n || event.pointsAwarded>BigInt(Number.MAX_SAFE_INTEGER))return false;
 const candidates=rows.filter(r=>r.id===event.rentalState && r.contract===event.contract && r.borrower===event.borrower && r.start<=at).sort((a,b)=>b.start-a.start);
 const row=candidates[0];
 if(!row || row.end>at)return false; // Cannot safely assign early-cancellation rewards without the cancellation event.
 row.pointsEarned=Number(event.pointsAwarded);row.pointsSignature=signature;return true;
}
export async function backfillRentals(file:string,profile:string,wallets:string[],rpcUrl:string):Promise<void>{
 readRentalHistory(file,profile); // Initialize the per-instance database.
 const db=new DatabaseSync(file);
 db.exec('CREATE TABLE IF NOT EXISTS history_close_events(profile TEXT, signature TEXT, rental TEXT, at INTEGER, payload TEXT, PRIMARY KEY(profile,signature,rental))');
 db.exec('CREATE TABLE IF NOT EXISTS history_cursor(profile TEXT, wallet TEXT, signature TEXT, PRIMARY KEY(profile,wallet))');
 const sdk=require('@sly-rentals/core') as typeof import('@sly-rentals/core');
 async function rpc(method:string,params:unknown[]){
  const response=await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`History RPC HTTP ${response.status}`);
  const result=await response.json() as any;if(result.error)throw new Error(result.error.message);return result.result;
 }
 try{
 const targets=new Map<string,string>();
 for(const wallet of new Set(wallets))targets.set(wallet,await sdk.deriveBorrowerState(wallet,NEXT_GEN_SRSLY_PROGRAM_ID));
 // A rental may be accepted by a keeper/other signer. Its own account is a reliable read-only history index.
 for(const row of readRentalHistory(file,profile).filter(row=>!row.signature || row.pointsEarned===undefined))targets.set(`rental:${row.id}`,row.id);
 for(const [wallet,pda] of targets){
  const cursor=db.prepare('SELECT signature FROM history_cursor WHERE profile=? AND wallet=?').get(profile,wallet)?.signature;
  const signatures:any[]=[];let before:string|undefined;let complete=false;
  for(let page=0;page<10;page++){
   const batch=await rpc('getSignaturesForAddress',[pda,{limit:100,commitment:'confirmed',...(before?{before}:{}),...(cursor?{until:cursor}:{})}]);
   if(!Array.isArray(batch))throw new Error('Invalid history signature response');
   signatures.push(...batch);if(batch.length<100){complete=true;break;}before=batch.at(-1).signature;
  }
  if(!complete)throw new Error('History scan limit reached; cursor preserved');
  const rows:RentalHistoryRow[]=[];const closes:{event:any;at:number;signature:string}[]=[];
  for(const item of signatures){if(item.err)continue;const tx=await rpc('getTransaction',[item.signature,{encoding:'json',commitment:'confirmed',maxSupportedTransactionVersion:0}]);if(!tx)throw new Error('Historical transaction unavailable; cursor preserved');rows.push(...decodeAcceptedRentals(tx,item.signature,profile));if(tx.meta?.err===null && Number.isSafeInteger(tx.blockTime)){for(const event of audit.parseAnchorEvents(tx.meta.logMessages||[],NEXT_GEN_SRSLY_PROGRAM_ID,BigInt(tx.slot||0),item.signature)){if(event.type==='RentalClosed')closes.push({event,at:tx.blockTime*1000,signature:item.signature});}}}
  db.exec('BEGIN');try{
   for(const row of rows){
    // Block time is an estimate: merge with observed chain timestamps within 60s, never overwrite richer account data.
    const existing=db.prepare('SELECT start,payload FROM rental_history WHERE profile=? AND id=? AND ABS(start-?)<=60000').all(profile,row.id,row.start).find(r=>JSON.parse(String(r.payload)).borrower===row.borrower);
    const prior=existing?JSON.parse(String(existing.payload)):null;
    const merged=prior?{...row,...prior,signature:row.signature,fleet:row.fleet}:row;
    if(prior && row.rate!==null && prior.rate==null){merged.rate=row.rate;merged.rentTotal=row.rentTotal;}
    if(prior?.startEstimated && !row.startEstimated){
     db.prepare('DELETE FROM rental_history WHERE profile=? AND id=? AND start=?').run(profile,row.id,prior.start);
     merged.start=row.start;merged.end=row.end;merged.startEstimated=false;
    }
    db.prepare('INSERT INTO rental_history VALUES (?,?,?,?) ON CONFLICT(profile,id,start) DO UPDATE SET payload=excluded.payload').run(profile,row.id,merged.start,JSON.stringify(merged));
   }
   for(const close of closes)db.prepare('INSERT OR IGNORE INTO history_close_events VALUES (?,?,?,?,?)').run(profile,close.signature,close.event.rentalState,close.at,JSON.stringify(close.event,(_key,value)=>typeof value==='bigint'?value.toString():value));
   // Include newly inserted rows in this transaction, avoiding a separate connection's snapshot.
   const current=db.prepare('SELECT payload FROM rental_history WHERE profile=?').all(profile).map(r=>JSON.parse(String(r.payload))) as RentalHistoryRow[];
   for(const raw of db.prepare('SELECT * FROM history_close_events WHERE profile=? ORDER BY at').all(profile)){
    const event=JSON.parse(String(raw.payload));event.pointsAwarded=BigInt(event.pointsAwarded);
    applyClosedRental(current,event,Number(raw.at),String(raw.signature));
   }
   for(const row of current)db.prepare('UPDATE rental_history SET payload=? WHERE profile=? AND id=? AND start=?').run(JSON.stringify(row),profile,row.id,row.start);
   if(signatures.length)db.prepare('INSERT INTO history_cursor VALUES (?,?,?) ON CONFLICT(profile,wallet) DO UPDATE SET signature=excluded.signature').run(profile,wallet,signatures[0].signature);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
 }}finally{db.close();}
}
