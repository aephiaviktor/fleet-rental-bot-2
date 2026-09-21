import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {decodeAcceptedRentals,applyClosedRental} from '../src/history-backfill.js';
const tx=(name:string)=>JSON.parse(readFileSync(`test/fixtures/history/${name}.json`,'utf8'));
const wallet='3MKddH2YyuMgQL27f8id89RhfMyni8Bv5nhoGX4u2u2D';
test('real automatic MUD acceptance is reconstructed only for authorized borrower',()=>{
 const decode=decodeAcceptedRentals;
 assert.equal(decode(tx('3aWU'),'sig','other-profile',[wallet]).length,0);
 assert.equal(decode(tx('3aWU'),'sig','ArUBNzxRcyseGSLbp2jjo4HLooEsEpdCTnFitutk82Cr',[wallet]).length,1);
 assert.equal(decode(tx('3aWU'),'sig','ArUBNzxRcyseGSLbp2jjo4HLooEsEpdCTnFitutk82Cr',['other']).length,0);
});
test('same-second close awards 1200 points to previous cycle, not replacement',()=>{
 const rows:any[]=[{id:'r',contract:'c',borrower:'b',start:1000,end:2000},{id:'r',contract:'c',borrower:'b',start:2000,end:3000}];
 assert.equal(applyClosedRental(rows,{type:'RentalClosed',rentalState:'r',contract:'c',borrower:'b',pointsAwarded:120000000000n},2000,'close'),true);
 assert.equal(rows[0].pointsEarned,1200);assert.equal(rows[1].pointsEarned,undefined);
});
test('real reservation replay recovers historical bid and keeps zero currency unknown',async()=>{
 const mod:any=await import('../src/history-backfill.js');
 const rows=decodeAcceptedRentals(tx('3xJP'),'start','ArUBNzxRcyseGSLbp2jjo4HLooEsEpdCTnFitutk82Cr',[wallet]);
 const current=decodeAcceptedRentals(tx('3aWU'),'next','ArUBNzxRcyseGSLbp2jjo4HLooEsEpdCTnFitutk82Cr',[wallet]);
 const events=['264x','3xJP','3tAh','3aWU'].flatMap(k=>mod.historyEvidence(tx(k),k));
 mod.applyBidEvidence([...rows,...current],events,[]);
 assert.equal(rows[0].bid,710);assert.equal(rows[0].currency,'Atlas');assert.equal(current[0].bid,0);assert.equal(current[0].currency,'Unknown');
 mod.applyBidEvidence(current,events,[{signature:'3tAh',currency:'Points',amount:0,borrower:wallet,contract:current[0].contract}]);
 assert.equal(current[0].currency,'Points');
});
test('zero-points currency intent survives database reopen and rejects conflicting overwrite',async()=>{
 const {recordBidIntent}=await import('../src/rental-history.js');const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {DatabaseSync}=await import('node:sqlite');
 const dir=mkdtempSync(join(tmpdir(),'bid-intent-')),file=join(dir,'h.sqlite');
 try{const intent={signature:'sig',contract:'c',borrower:'b',currency:'Points' as const,amount:0};recordBidIntent(file,'p',intent);const db=new DatabaseSync(file);assert.deepEqual(JSON.parse(String(db.prepare('select payload from history_intents').get()?.payload)),intent);db.close();assert.throws(()=>recordBidIntent(file,'p',{...intent,currency:'Atlas'}),/Conflicting/);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('early close of newer cycle never awards points to an older completed cycle',()=>{
 const rows:any[]=[{id:'r',contract:'c',borrower:'b',start:1000,end:2000},{id:'r',contract:'c',borrower:'b',start:3000,end:5000}];
 assert.equal(applyClosedRental(rows,{type:'RentalClosed',rentalState:'r',contract:'c',borrower:'b',pointsAwarded:120000000000n},4000,'early'),false);assert.equal(rows[0].pointsEarned,undefined);
});
test('displaced reservation and absent queue account cannot supply historical bid',async()=>{
 const {historyEvidence,applyBidEvidence}=await import('../src/history-backfill.js');const rows=decodeAcceptedRentals(tx('3xJP'),'s','ArUBNzxRcyseGSLbp2jjo4HLooEsEpdCTnFitutk82Cr',[wallet]);
 const events=['264x','3xJP'].flatMap(k=>historyEvidence(tx(k),k));const accepted=events.find(e=>e.event.type==='RentalAccepted')!;accepted.keys=[];applyBidEvidence(rows,events,[]);assert.equal(rows[0].bid,null);
});
test('real ONI prior F2 cycle and its 1200-point reward survive reconstruction',async()=>{
 const {historyEvidence,applyBidEvidence}=await import('../src/history-backfill.js');const oni='Erdr7J9phrxwiBJQVSxUVq9Zkre6Jn9LcanpcV4ZZMrv';
 const rows=decodeAcceptedRentals(tx('5rfH'),'start','51er38DkAZZszouBMhYNj7LiSQd4yziZ8WnAqBCSFcGJ',[oni]);assert.equal(rows.length,1);assert.equal(new Date(rows[0].start).toISOString(),'2026-08-20T17:47:17.000Z');
 const close=historyEvidence(tx('3ZT6'),'reward').find(e=>e.event.type==='RentalClosed')!;assert.equal(applyClosedRental(rows,close.event,close.at,close.signature),true);assert.equal(rows[0].pointsEarned,1200);assert.equal(rows[0].pointsSignature,'reward');
 applyBidEvidence(rows,['4nEu','5rfH'].flatMap(k=>historyEvidence(tx(k),k)),[]);assert.equal(rows[0].bid,1000);assert.equal(rows[0].currency,'Atlas');
});
