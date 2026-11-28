import test from 'node:test';
import assert from 'node:assert/strict';
import * as output from '../extensions/aurabot/fish-world/tool-output.mjs';
const W='mcp__fish-world__world_';
const failed=(result,extra={})=>({id:'synthetic-call',tool:W+'do',args:'{"id":"inspect-fixture"}',status:'failed',isError:true,result,...extra});
const absent='Error: [E_UNKNOWN] 这里没有「inspect-fixture」。这里能做：看看合成招牌 fixture-sign、喝合成热水 fixture-water\n—— 现在 14:10 · 在合成地点';
test('known rules and the exact unavailable-action-with-current-menu protocol are proved business rejections',()=>{
 assert.equal(output.knownWorldRejection(failed('Error: [E_RULE] 合成岗位当前已满')),true);
 assert.equal(output.knownWorldRejection(failed('[E_RULE] 合成材料不可用')),true);
 assert.equal(output.knownWorldRejection(failed(absent)),true);
});
test('transport failures, ambiguous unknowns, missing menus and mismatched actual calls remain unproved',()=>{
 for(const row of [failed('Error: [E_UNKNOWN] 操作未知'),failed(absent,{status:'uncertain'}),failed(absent,{status:'confirmed'}),failed(absent,{isError:false}),failed(absent,{tool:W+'now'}),failed(absent,{args:'{"id":"another"}'}),failed(absent,{args:'broken'}),failed('Error: [E_UNKNOWN] 这里没有「inspect-fixture」。'),failed('Error: [E_UNKNOWN] 这里没有「inspect-fixture」。这里能做：'),failed('> '+absent),failed('资料如下：\n'+absent),...['timeout','aborted','not connected','ECONNRESET'].map(value=>failed(absent+'\n'+value))])assert.equal(output.knownWorldRejection(row),false,JSON.stringify(row));
});
test('purchase evidence is the unchanged successful world-do response rather than an action name',()=>{
 for(const line of ['你买了 1 盒合成药，花了 5 贝，还剩 20 贝。','好的，你买下了 1 把合成伞，花费 8 贝。','购买成功：1 本合成书，支付了 6 贝。']){
  const row=failed(line+'\n—— 现在 14:15 · 在合成商店',{status:'confirmed',isError:false,args:'{"id":"a-menu-id-without-buy"}'});assert.equal(output.purchaseReceipt(row),line);
 }
});
test('shelves, intentions, quotations, someone else, malformed success and failed purchases never prove a purchase',()=>{
 for(const row of [failed('你买了 1 盒合成药，花了 5 贝。'),failed('你买了 1 盒合成药，花了 5 贝。',{status:'uncertain'}),failed('你买了 1 盒合成药，花了 5 贝。',{status:'confirmed',isError:true}),...['合成货架：合成药 5 贝','你想购买 1 盒合成药，花了 5 贝。','别人买了 1 盒合成药，花了 5 贝。','> 你买了 1 盒合成药，花了 5 贝。','说明：\n你买了 1 盒合成药，花了 5 贝。','你买了 1 盒合成药，花了 5 贝吗？','你买了 1 盒合成药，花了 5 贝，但购买失败。'].map(result=>failed(result,{status:'confirmed',isError:false,args:'{"id":"buy-fixture"}'})),failed('你买了 1 盒合成药，花了 5 贝。',{status:'confirmed',isError:false,tool:W+'history'})])assert.equal(output.purchaseReceipt(row),null,JSON.stringify(row));
});
