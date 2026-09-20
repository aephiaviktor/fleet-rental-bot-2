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
 assert.equal(readRentalHistory(file,'profile').length,1);assert.deepEqual(untils,[undefined,undefined,'sig']);assert.equal(fetches,2);
 }finally{await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
});
