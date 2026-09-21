import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('each navigation entry owns its column picker',()=>{
 const html=readFileSync('ui/index.html','utf8');
 assert.ok(html.indexOf('id="column-options"')<html.indexOf('id="open-history"'));
 assert.match(html,/id="history-column-options"/);
});
test('history renderer uses independent persisted columns and hides borrower addresses',()=>{
 const js=readFileSync('ui/app.js','utf8');
 assert.match(js,/historyColumns/);assert.doesNotMatch(js,/row\.borrower\.slice/);
});
test('history display distinguishes full rows and computes ATLAS all-in without pricing point bids',async()=>{
 const {runInNewContext}=await import('node:vm');const context:any={};runInNewContext(readFileSync('ui/rules-display.js','utf8'),context);
 const display=context.RulesDisplay;
 assert.equal(display.historyClass('Active'),'history-active');assert.equal(display.historyClass('Completed'),'history-completed');
 assert.equal(display.historyAllIn({rate:100,bid:50,currency:'Atlas',start:0,end:172800000}),125);
 assert.equal(display.historyAllIn({rate:100,bid:5,currency:'Points',start:0,end:172800000}),100);
 assert.equal(display.historyAllIn({rate:100,bid:null,currency:null,start:0,end:172800000}),null);
 assert.equal(display.historyAllIn({rate:100,bid:0,currency:null,start:0,end:172800000}),100);
 const css=readFileSync('ui/styles.css','utf8');assert.match(css,/#history-body.*history-active/);assert.match(css,/#history-body.*history-completed/);
});
