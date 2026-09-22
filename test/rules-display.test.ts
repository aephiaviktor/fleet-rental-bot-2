import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const context: any = {};
runInNewContext(readFileSync('ui/rules-display.js', 'utf8'), context);
test('sorts all rules by numeric end time, stable unknowns last without mutation', () => {
  const entries = [{id:'unknown'}, {id:'late'}, {id:'early',enabled:false}, {id:'missing'}];
  const live = new Map([['late',{ok:true,row:{snapshot:{activeRentalEndsAtMs:200}}}],['early',{ok:true,row:{snapshot:{activeRentalEndsAtMs:100}}}]]);
  assert.equal(context.RulesDisplay.sorted(entries,live).map((x:any)=>x.id).join(','),'early,late,unknown,missing');
  assert.equal(entries[0].id,'unknown');
});
test('UTC tooltip is exact and missing dates are explicit', () => {
  assert.equal(context.RulesDisplay.utc(Date.UTC(2026,8,20,18,42,15)), '2026-09-20 18:42:15 UTC');
  assert.equal(context.RulesDisplay.utc(null),'Unknown end time');
});
test('next bid rounds upward to whole ATLAS and preserves unavailable values', () => {
  assert.equal(context.RulesDisplay.nextBid(114.34),115);
  assert.equal(context.RulesDisplay.nextBid(115),115);
  assert.equal(context.RulesDisplay.nextBid(0),0);
  assert.equal(context.RulesDisplay.nextBid(null),null);
});
test('confirmed zero reservations show assumed Points without mutating evidence', () => {
 const row={bid:0,currency:'Unknown',bidSource:'reservation'};
 assert.equal(context.RulesDisplay.historyCurrency(row),'Points*');
 assert.equal(row.currency,'Unknown');
 assert.equal(context.RulesDisplay.historyCurrency({...row,bid:null}),'Unknown');
 assert.equal(context.RulesDisplay.historyCurrency({...row,bidSource:'direct-accept'}),'Unknown');
 assert.equal(context.RulesDisplay.historyCurrency({...row,bid:500,currency:'Atlas'}),'Atlas');
 assert.equal(context.RulesDisplay.historyCurrency({...row,currency:'Atlas',bidSource:'local-intent'}),'Atlas');
});
test('queued zero bids show assumed Points, missing reservations do not', () => {
 assert.equal(context.RulesDisplay.reservationCurrency({reservationCurrency:'POINTS',reservationBidAtlas:0,reservationBidPoints:0}),'Points*');
 assert.equal(context.RulesDisplay.reservationCurrency({reservationCurrency:'POINTS',reservationBidAtlas:0,reservationBidPoints:26}),'Points');
 assert.equal(context.RulesDisplay.reservationCurrency({reservationCurrency:'ATLAS',reservationBidAtlas:500,reservationBidPoints:0}),'Atlas');
 assert.equal(context.RulesDisplay.reservationCurrency({reservationCurrency:null,reservationBidAtlas:null,reservationBidPoints:null}),'—');
});
