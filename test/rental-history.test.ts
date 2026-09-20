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
 assert.equal(rows.length,1);assert.equal(rows[0].status,'Active');assert.equal(rows[0].bid,5);assert.equal(rows[0].currency,'Points');
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
  assert.equal(request.params[1].filters[1].memcmp.offset,74);
  assert.equal(request.params[1].filters[1].memcmp.bytes,profile);
 } finally {await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));}
});
