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
