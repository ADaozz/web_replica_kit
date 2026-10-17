import test from 'node:test';
import assert from 'node:assert/strict';
import {classify,groupNavigation} from '../scripts/discover.mjs';
test('navigation classification preserves queries and fragments',()=>{
  const base='https://example.com/a?q=1';
  for(const [raw,kind] of [['?q=1','current'],['#x','anchor'],['#','anchor'],['?q=2','internal'],['https://else.com/','external'],['javascript:x','unsupported'],['mailto:a@b','unsupported'],['http://[','unsupported']])assert.equal(classify(raw,base).kind,kind);
});
test('navigation groups equivalent URLs and retains every source',()=>{
  const entries=groupNavigation([{href:'/p',label:'P',region:'header'},{href:'https://example.com/p',label:'P',region:'footer'},{href:'/p?q=1'}],'https://example.com/');
  assert.equal(entries.length,2);assert.equal(entries[0].sources.length,2);
  const unsupported=groupNavigation([{href:'javascript:SECRET_SCRIPT()'},{href:'data:text/html,SECRET_DATA'}],'https://example.com/');
  assert.ok(!JSON.stringify(unsupported).includes('SECRET'));
});

test('deduplication retains visible and hidden sources without dropping hidden-only targets',()=>{
 const entries=groupNavigation([{href:'/shared',label:'Products',visible:true,region:'header'},{href:'/shared',label:'Hidden products',visible:false,region:'nav'},{href:'/hidden',label:'Hidden page',visible:false,region:'aside'}],'https://example.com/');
 assert.equal(entries.length,2);assert.equal(entries[0].sources.length,2);assert.equal(entries.filter(e=>e.sources.some(s=>s.visible)).length,1);assert.equal(entries.filter(e=>e.sources.every(s=>!s.visible)).length,1);
});
