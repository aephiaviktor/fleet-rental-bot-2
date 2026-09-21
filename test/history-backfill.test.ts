import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {getBase58Decoder} from '@solana/kit';
import {decodeAcceptedRentals} from '../src/history-backfill.js';
import {NEXT_GEN_SRSLY_PROGRAM_ID as program} from '../src/model.js';
const core=createRequire(import.meta.url)('@sly-rentals/core/codama');
function fixture(){const keys=Array.from({length:31},(_,i)=>`account${i}`);keys[26]='profile';keys.push(program);return {blockTime:100,meta:{err:null},transaction:{message:{accountKeys:keys,instructions:[{programIdIndex:31,accounts:Array.from({length:31},(_,i)=>i),data:getBase58Decoder().decode(core.getAcceptRentalInstructionDataEncoder().encode({duration:60n,discountSignature:null,discountMemberNonce:null,discountBps:null,discountExpiresAt:null}))}]}}};}
test('backfill includes successful manual rentals for the exact profile',()=>{const rows=decodeAcceptedRentals(fixture(),'sig','profile');assert.equal(rows.length,1);assert.equal(rows[0].start,100000);assert.equal(rows[0].end,160000);assert.equal(rows[0].rate,null);assert.equal(rows[0].signature,'sig');assert.deepEqual(decodeAcceptedRentals(fixture(),'sig','other'),[]);});
test('failed transactions and missing timestamps do not create rentals',()=>{const tx=fixture();tx.meta.err={} as never;assert.deepEqual(decodeAcceptedRentals(tx,'sig','profile'),[]);tx.meta.err=null;tx.blockTime=0;assert.deepEqual(decodeAcceptedRentals(tx,'sig','profile'),[]);});
test('inner instructions and lookup-table account keys are decoded',()=>{const tx:any=fixture();tx.meta.innerInstructions=[{index:0,instructions:tx.transaction.message.instructions}];tx.transaction.message.instructions=[];tx.meta.loadedAddresses={writable:[],readonly:tx.transaction.message.accountKeys.splice(20)};assert.equal(decodeAcceptedRentals(tx,'sig','profile').length,1);});
test('reservation instructions never count as a successful rental',()=>{const tx=fixture();tx.transaction.message.instructions[0].data=getBase58Decoder().decode(new Uint8Array([5,180,4,150,64,120,189,128]));assert.deepEqual(decodeAcceptedRentals(tx,'sig','profile'),[]);});
test('backfill persists cursors only after successful decoding and reruns without duplicates',async()=>{
 const {backfillRentals}=await import('../src/history-backfill.js');const {readRentalHistory}=await import('../src/rental-history.js');
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createServer}=await import('node:http');
 const dir=mkdtempSync(join(tmpdir(),'backfill-')),file=join(dir,'history.sqlite');let available=false,fetches=0;const untils:any[]=[];
 const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const q=JSON.parse(text);let result:any;
 if(q.method==='getSignaturesForAddress'){untils.push(q.params[1].until);result=q.params[1].until?[]:[{signature:'sig',err:null}];}
 else{fetches++;result=available?fixture():null;}
 res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}`;
 try{await assert.rejects(backfillRentals(file,'profile',['11111111111111111111111111111111'],url),/unavailable/);available=true;
 await backfillRentals(file,'profile',['11111111111111111111111111111111'],url);await backfillRentals(file,'profile',['11111111111111111111111111111111'],url);
 assert.equal(readRentalHistory(file,'profile').length,1);assert.deepEqual(untils,[undefined,undefined,'sig',undefined]);assert.equal(fetches,3);
 }finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});
test('acceptance events recover exact timestamps and rate only for matching confirmed rental',()=>{
 const tx:any=fixture();const zero='11111111111111111111111111111111';
 tx.transaction.message.accountKeys[0]=zero;tx.transaction.message.accountKeys[6]=zero;tx.transaction.message.accountKeys[7]=zero;
 const idl=createRequire(import.meta.url)('@sly-rentals/core/idl');
 const disc=idl.events.find((e:any)=>e.name==='RentalAccepted').discriminator;
 const data=Buffer.concat([Buffer.from(disc),Buffer.from(core.getRentalAcceptedEncoder().encode({rentalState:zero,contract:zero,borrower:zero,escrow:200000000n,rate:100000000n,serviceFee:0n,feeBps:0,startTime:1789900000n,endTime:1790072800n}))]);
 tx.blockTime=1789900000;tx.meta.logMessages=[`Program ${program} invoke [1]`,`Program data: ${data.toString('base64')}`,`Program ${program} success`];
 const row=decodeAcceptedRentals(tx,'sig','profile')[0];assert.equal(row.rate,1);assert.equal(row.rentTotal,2);assert.equal(row.startEstimated,false);assert.equal(row.bid,null);
 tx.meta.logMessages[0]='Program other invoke [1]';assert.equal(decodeAcceptedRentals(tx,'sig','profile')[0].rate,null);
});
test('backfill also scans observed rental accounts to recover accept signatures missed by borrower PDA',async()=>{
 const {backfillRentals}=await import('../src/history-backfill.js');const {readRentalHistory}=await import('../src/rental-history.js');
 const {DatabaseSync}=await import('node:sqlite');const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createServer}=await import('node:http');
 const dir=mkdtempSync(join(tmpdir(),'history-address-')),file=join(dir,'history.sqlite');readRentalHistory(file,'profile');const db=new DatabaseSync(file);
 db.prepare('INSERT INTO rental_history VALUES (?,?,?,?)').run('profile','account7',100000,JSON.stringify({id:'account7',contract:'account6',borrower:'account0',start:100000,end:160000,rate:2,rentTotal:2/1440,bid:0,currency:'None',observedAt:150000}));db.close();
 const server=createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;const q=JSON.parse(text);const result=q.method==='getSignaturesForAddress'?(q.params[0]==='account7'&&!q.params[1].until?[{signature:'sig',err:null}]:[]):fixture();res.end(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{await backfillRentals(file,'profile',[],`http://127.0.0.1:${(server.address() as any).port}`);const rows=readRentalHistory(file,'profile');assert.equal(rows.length,1);assert.equal(rows[0].signature,'sig');assert.equal(rows[0].bid,0);}finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});
test('verified close event attaches earned points only to the matching completed cycle',async()=>{
 const {applyClosedRental}=await import('../src/history-backfill.js') as any;
 const rows=[{id:'r',contract:'c',borrower:'b',start:1000,end:2000},{id:'r',contract:'c',borrower:'b',start:4000,end:5000}];
 const event={type:'RentalClosed',rentalState:'r',contract:'c',borrower:'b',pointsAwarded:50n};
 assert.equal(applyClosedRental(rows,event,3000,'close'),true);assert.equal((rows[0] as any).pointsEarned,50);assert.equal((rows[1] as any).pointsEarned,undefined);
 assert.equal(applyClosedRental(rows,{...event,borrower:'other'},6000,'bad'),false);
});
test('closed-rental rewards persist through backfill and subsequent account reads',async()=>{
 const {backfillRentals}=await import('../src/history-backfill.js');const {readRentalHistory}=await import('../src/rental-history.js');const {DatabaseSync}=await import('node:sqlite');const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createServer}=await import('node:http');
 const dir=mkdtempSync(join(tmpdir(),'history-points-')),file=join(dir,'h.sqlite'),zero='11111111111111111111111111111111';readRentalHistory(file,'profile');const db=new DatabaseSync(file);db.prepare('INSERT INTO rental_history VALUES (?,?,?,?)').run('profile',zero,100000,JSON.stringify({id:zero,contract:zero,borrower:zero,start:100000,end:200000,signature:'accept',rate:1,bid:0}));db.close();
 const idl=createRequire(import.meta.url)('@sly-rentals/core/idl');const data=Buffer.concat([Buffer.from(idl.events.find((e:any)=>e.name==='RentalClosed').discriminator),Buffer.from(core.getRentalClosedEncoder().encode({rentalState:zero,contract:zero,borrower:zero,ownerEarned:0n,feeCollected:0n,pointsAwarded:50n}))]);
 const tx={blockTime:300,meta:{err:null,logMessages:[`Program ${program} invoke [1]`,`Program data: ${data.toString('base64')}`,`Program ${program} success`]},transaction:{message:{accountKeys:[],instructions:[]}}};
 const server=createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;const q=JSON.parse(text);res.end(JSON.stringify({jsonrpc:'2.0',id:q.id,result:q.method==='getSignaturesForAddress'?[{signature:'close',err:null}]:tx}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{await backfillRentals(file,'profile',[],`http://127.0.0.1:${(server.address() as any).port}`);const row=readRentalHistory(file,'profile')[0];assert.equal(row.pointsEarned,50);assert.equal(row.pointsSignature,'close');assert.equal(row.signature,'accept');}finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});
