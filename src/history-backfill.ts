import {createRequire} from 'node:module';
import {getBase58Encoder} from '@solana/kit';
import {DatabaseSync} from 'node:sqlite';
import {NEXT_GEN_SRSLY_PROGRAM_ID} from './model.js';
import {readRentalHistory, type RentalHistoryRow} from './rental-history.js';
const require=createRequire(import.meta.url);
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
 return rows;
}
export async function backfillRentals(file:string,profile:string,wallets:string[],rpcUrl:string):Promise<void>{
 readRentalHistory(file,profile); // Initialize the per-instance database.
 const db=new DatabaseSync(file);
 db.exec('CREATE TABLE IF NOT EXISTS history_cursor(profile TEXT, wallet TEXT, signature TEXT, PRIMARY KEY(profile,wallet))');
 const sdk=require('@sly-rentals/core') as typeof import('@sly-rentals/core');
 async function rpc(method:string,params:unknown[]){
  const response=await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`History RPC HTTP ${response.status}`);
  const result=await response.json() as any;if(result.error)throw new Error(result.error.message);return result.result;
 }
 try{for(const wallet of new Set(wallets)){
  const cursor=db.prepare('SELECT signature FROM history_cursor WHERE profile=? AND wallet=?').get(profile,wallet)?.signature;
  const pda=await sdk.deriveBorrowerState(wallet,NEXT_GEN_SRSLY_PROGRAM_ID);
  const signatures:any[]=[];let before:string|undefined;let complete=false;
  for(let page=0;page<10;page++){
   const batch=await rpc('getSignaturesForAddress',[pda,{limit:100,commitment:'confirmed',...(before?{before}:{}),...(cursor?{until:cursor}:{})}]);
   if(!Array.isArray(batch))throw new Error('Invalid history signature response');
   signatures.push(...batch);if(batch.length<100){complete=true;break;}before=batch.at(-1).signature;
  }
  if(!complete)throw new Error('History scan limit reached; cursor preserved');
  const rows:RentalHistoryRow[]=[];
  for(const item of signatures){if(item.err)continue;const tx=await rpc('getTransaction',[item.signature,{encoding:'json',commitment:'confirmed',maxSupportedTransactionVersion:0}]);if(!tx)throw new Error('Historical transaction unavailable; cursor preserved');rows.push(...decodeAcceptedRentals(tx,item.signature,profile));}
  db.exec('BEGIN');try{
   for(const row of rows){
    // Block time is an estimate: merge with observed chain timestamps within 60s, never overwrite richer account data.
    const existing=db.prepare('SELECT start,payload FROM rental_history WHERE profile=? AND id=? AND ABS(start-?)<=60000').all(profile,row.id,row.start).find(r=>JSON.parse(String(r.payload)).borrower===row.borrower);
    const merged=existing?{...row,...JSON.parse(String(existing.payload)),signature:row.signature,fleet:row.fleet}:row;
    db.prepare('INSERT INTO rental_history VALUES (?,?,?,?) ON CONFLICT(profile,id,start) DO UPDATE SET payload=excluded.payload').run(profile,row.id,merged.start,JSON.stringify(merged));
   }
   if(signatures.length)db.prepare('INSERT INTO history_cursor VALUES (?,?,?) ON CONFLICT(profile,wallet) DO UPDATE SET signature=excluded.signature').run(profile,wallet,signatures[0].signature);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
 }}finally{db.close();}
}
