import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordRentals, readRentalHistory } from '../src/rental-history.js';
const rental = (status=2, profile='profile') => ({address:'rental',data:{status,borrowerProfile:profile,borrower:'wallet',contract:'contract',startTime:100n,endTime:200n,rate:100000000n,bidAtlas:0n,bidPoints:500000000n}});
test('history records only started owned rentals, persists and deduplicates by rental cycle', () => {
 const dir=mkdtempSync(join(tmpdir(),'rental-history-')); const file=join(dir,'history.sqlite');
 try {
 recordRentals(file,'profile',[rental(1),rental(2,'other')],150000);
 assert.equal(readRentalHistory(file,'profile',150000).length,0);
 recordRentals(file,'profile',[rental(),rental()],150000);
 let rows=readRentalHistory(file,'profile',150000);
 assert.equal(rows.length,1);assert.equal(rows[0].status,'Active');assert.equal(rows[0].bid,null);assert.equal(rows[0].currency,null);
 assert.equal(readRentalHistory(file,'profile',200000)[0].status,'Completed');
 assert.equal(readRentalHistory(file,'other',200000).length,0);
 recordRentals(file,'profile',[rental(1)],210000);
 assert.equal(readRentalHistory(file,'profile',210000).length,1);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('future starts, invalid timestamps and cancelled queues never become successful history', () => {
 const dir=mkdtempSync(join(tmpdir(),'rental-history-'));const file=join(dir,'history.sqlite');
 try {
  recordRentals(file,'profile',[rental(0),rental(3),{...rental(),data:{...rental().data,startTime:999n}}],150000);
  assert.deepEqual(readRentalHistory(file,'profile',150000),[]);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('discovery uses confirmed profile-filtered account reads, never transaction submission', async () => {
 const { createServer }=await import('node:http');
 const { discoverRentals }=await import('../src/rental-history.js');
 const profile='11111111111111111111111111111111';
 let request:any;
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;request=JSON.parse(body);res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:request.id,result:[]}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const port=(server.address() as {port:number}).port;
  assert.deepEqual(await discoverRentals(profile,`http://127.0.0.1:${port}`),[]);
  assert.equal(request.method,'getProgramAccounts');
  assert.equal(request.params[1].commitment,'confirmed');
  assert.equal(request.params[1].filters[1].memcmp.offset,77);
  assert.equal(request.params[1].filters[1].memcmp.bytes,profile);
 } finally {await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));}
});
test('SDK-encoded RentalState stores the borrower profile at offset 77 (u32 version)',async()=>{
 const {createRequire}=await import('node:module');const core=createRequire(import.meta.url)('@sly-rentals/core/codama');const {getAddressEncoder,address}=await import('@solana/kit');
 const zero=address('11111111111111111111111111111111'),profile=address('E3Lh2ScF9c9ZZjoTAeNNApFZiQV1Q6GBmvgsKLh8xkL3');
 const encoded=core.getRentalStateEncoder().encode({version:1,bump:0,borrower:zero,borrowerState:zero,borrowerProfile:profile,contract:zero,rate:1n,lastPayment:0n,escrow:0n,startTime:1n,endTime:2n,serviceFee:0n,feeBps:0,referrer:null,discountBps:0,bidPoints:0n,bidAtlas:0n,cancelDelayMin:0n,status:2,updatedAt:0n,createdAt:0n});
 assert.deepEqual(encoded.slice(77,109),getAddressEncoder().encode(profile));
});
test('account refresh merges approximate backfill without losing signature or duplicating cycle',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const dir=mkdtempSync(join(tmpdir(),'history-merge-')),file=join(dir,'history.sqlite');
 try{readRentalHistory(file,'profile');const db=new DatabaseSync(file);db.prepare('INSERT INTO rental_history VALUES (?,?,?,?)').run('profile','rental',101000,JSON.stringify({id:'rental',contract:'contract',borrower:'wallet',start:101000,end:201000,rate:null,rentTotal:null,signature:'sig',startEstimated:true}));db.close();recordRentals(file,'profile',[rental()],150000);const rows=readRentalHistory(file,'profile',150000);assert.equal(rows.length,1);assert.equal(rows[0].start,100000);assert.equal(rows[0].signature,'sig');assert.equal(rows[0].rate,1);assert.equal(rows[0].startEstimated,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('current cleared bid fields do not prove the historical winning premium',()=>{
 const dir=mkdtempSync(join(tmpdir(),'history-zero-')),file=join(dir,'history.sqlite');
 try{const r=rental();r.data.bidPoints=0n;recordRentals(file,'profile',[r],150000);const row=readRentalHistory(file,'profile',150000)[0];assert.equal(row.bid,null);assert.equal(row.currency,null);}finally{rmSync(dir,{recursive:true,force:true});}
});
