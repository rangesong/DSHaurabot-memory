import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {panelListHarness} from './helpers/panel-list-harness.js';
test('switching scope while a request is pending starts the new request and ignores stale replies',async()=>{const source=readFileSync(new URL('../adapters/aurabot/module/panel.js',import.meta.url),'utf8'),h=panelListHarness(source);try{
 h.render('a');assert.equal(h.requests.length,1);h.render('b');assert.equal(h.requests.length,2);assert.equal(h.requests[1].params.scope,'b');
 h.requests[0].resolve({items:[{id:'old',label:'旧范围私有内容'}]});await new Promise(setImmediate);assert.doesNotMatch(JSON.stringify(h.render('b')),/旧范围私有内容/);
 h.requests[1].resolve({items:[{id:'new',label:'新范围资料'}]});await new Promise(setImmediate);assert.match(JSON.stringify(h.render('b')),/新范围资料/);
 }finally{h.close();}});
