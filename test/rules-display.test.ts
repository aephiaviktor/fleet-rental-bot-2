import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const context: any = {};
runInNewContext(readFileSync('ui/rules-display.js', 'utf8'), context);
test('allowed days preserves whole-day and fractional-day contract limits', () => {
  const range = (min: number, max: number) => context.RulesDisplay.allowedDays({minimumDurationSeconds:min,maximumDurationSeconds:max});
  assert.equal(range(5*86400,40*86400), '5–40');
  assert.equal(range(12*3600,40*86400), '0.5–40');
  assert.equal(range(5*86400,5*86400), '5–5');
  assert.equal(range(40*86400,5*86400), '—');
  assert.equal(context.RulesDisplay.allowedDays({}), '—');
  assert.equal(context.RulesDisplay.allowedDays(null), '—');
});
test('cancel delay preserves sub-day precision and distinguishes zero from unavailable', () => {
  const format = context.RulesDisplay.cancelDelay;
  for (const [seconds, expected] of [[0,'Instant'],[5*86400,'5d'],[12*3600,'12h'],[2*86400+12*3600,'2d 12h'],[3661,'1h 1m 1s'],[30,'30s']]) {
    assert.equal(format(seconds), expected);
  }
  for (const missing of [undefined,null,NaN,Infinity,-1,'0',0.5]) assert.equal(format(missing), '—');
});
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

test('LCFS report only includes reservations that ended in the last 48 hours', () => {
 const now=Date.UTC(2026,8,27,8);
 const entries=[
  {id:'recent',label:'',contractAddress:'recent-contract',lcfs:true},
  {id:'future',label:'Future',contractAddress:'future-contract',lcfs:true},
  {id:'old',label:'Old',contractAddress:'old-contract',lcfs:true},
  {id:'none',label:'No attempt',contractAddress:'none-contract',lcfs:true},
 ];
 const live=new Map([
  ['recent',{ok:true,row:{snapshot:{fleetName:'Miner IMP-Krew -U-'}}}],
 ]);
 const attempts=[
  {key:'blocked:recent:'+Math.floor((now-60_000)/1000)+':1',status:'blocked',detail:'Minimum ATLAS bid 16498.5 exceeds maximum 12000',updatedAt:'2026-09-27T07:59:00.000Z'},
  {key:'future:'+(now+60_000),status:'submitted',detail:'future-signature',updatedAt:'2026-09-27T08:00:00.000Z'},
  {key:'blocked:old:'+Math.floor((now-49*3600_000)/1000)+':1',status:'blocked',detail:'too old',updatedAt:'2026-09-25T07:00:00.000Z'},
 ];
 assert.equal(
  context.RulesDisplay.lcfsOutcomeLines(entries,attempts,live,now).join('\n'),
  'Miner IMP-Krew -U-: no LCFS bid sent — Minimum ATLAS bid 16498.5 exceeded maximum 12000',
 );
});

test('LCFS report uses latest outcome for an ended reservation and accurate send wording', () => {
 const now=Date.UTC(2026,8,27,8),end=now-1000;
 const entries=[{id:'fleet',label:'Fallback label',contractAddress:'contract',lcfs:false}];
 const live=new Map([['fleet',{ok:true,row:{snapshot:{fleetName:'Sunpaa'}}}]]);
 const attempts=[
  {key:'fleet:'+end,status:'started',detail:'preparing',updatedAt:'2026-09-27T07:59:40.000Z'},
  {key:'fleet:'+end,status:'submitted',detail:'123456789ABCDEFG',updatedAt:'2026-09-27T07:59:55.000Z'},
 ];
 assert.equal(
  context.RulesDisplay.lcfsOutcomeLines(entries,attempts,live,now).join('\n'),
  'Sunpaa: LCFS bid sent — transaction 123456789A…',
 );
});

test('funding distinguishes limit blockers from genuine balance shortfalls', () => {
  const format = context.RulesDisplay.fundingLabel;
  assert.equal(format({ status: 'bid-limit', shortfallAtlas: 1517339.557 }), 'Bid limit');
  assert.equal(format({ status: 'rate-limit', shortfallAtlas: 50039.557 }), 'Rate limit');
  assert.equal(format({ status: 'short', shortfallAtlas: 0.001 }), 'Short 0.01 ATLAS');
  assert.equal(format({ status: 'ready' }), 'Ready');
  assert.equal(format(null), 'Unknown');
});

test('Check flags Days outside the contract range and accepts both exact boundaries', () => {
  const warning = context.RulesDisplay.durationWarning;
  const terms = { minimumDurationSeconds: 7 * 86400 + 3600, maximumDurationSeconds: 14 * 86400 };
  assert.match(warning(7 * 86400, terms), /Requested 7 days/);
  assert.match(warning(14 * 86400 + 1, terms), /Allowed Days/);
  assert.equal(warning(terms.minimumDurationSeconds, terms), null);
  assert.equal(warning(terms.maximumDurationSeconds, terms), null);
  assert.equal(warning(86400, { ...terms, maximumDurationSeconds: 0 }), null);
  assert.equal(warning(86400, null), null);
});
