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
