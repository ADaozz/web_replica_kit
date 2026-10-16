import test from 'node:test';
import assert from 'node:assert/strict';
import {correspondElements,semanticDiff} from '../state-diff.mjs';
import {linkRuleStates} from '../rule-state-linker.mjs';
const node=(elementId,id,extra={})=>({elementId,key:`0:#${id}`,selector:`#${id}`,scopeId:'document-1:document',frameIndex:0,attributes:{id},...extra});

test('instance continuity survives positional selector changes; author ID only proves a logical counterpart',()=>{
  const a=node('instance-a','item',{parentElementId:'p1',selector:'div:nth-of-type(1)'});
  const moved={...a,key:'0:div:nth-of-type(2)',selector:'div:nth-of-type(2)',parentElementId:'p2'};
  const pair=correspondElements({nodes:[a]},{nodes:[moved]})[0];
  assert.equal(pair.physicalIdentity,true);assert.equal(pair.basis,'same-browser-node');
  const effects=semanticDiff({nodes:[a]},{nodes:[moved]}).effects;
  assert.ok(effects.some(e=>e.type==='move' && e.elementId==='instance-a'));assert.equal(effects.some(e=>e.type==='insert'),false);
  const replaced=correspondElements({nodes:[a]},{nodes:[{...moved,elementId:'new-instance'}]})[0];
  assert.equal(replaced.physicalIdentity,false);assert.equal(replaced.basis,'unique-author-id-in-same-root');
  const otherRoot=correspondElements({nodes:[a]},{nodes:[{...moved,elementId:'different',scopeId:'other-root'}]});
  assert.equal(otherRoot.length,2);assert.equal(otherRoot[0].after,null);
});

test('ambiguous replacements and positional matches never prove identity',()=>{
  const a=node('old','duplicate');
  assert.equal(correspondElements({nodes:[a]},{nodes:[node('new1','duplicate'),node('new2','duplicate')]})[0].after,null);
  const positional=node('old','',{attributes:{},selector:'div:nth-of-type(1)'});
  assert.equal(correspondElements({nodes:[positional]},{nodes:[{...positional,elementId:'new'}]})[0].after,null);
});

test('unrelated layout changes and missing CSS remain unresolved',()=>{
  const trigger=node('button','toggle',{attributes:{id:'toggle','aria-controls':'menu'}}),menu=node('panel','menu'),other=node('other','unrelated');
  const before={nodes:[trigger,menu,other]},after={nodes:[trigger,{...menu,attributes:{id:'menu','data-state':'open'}},{...other,text:'Changed'}]};
  const result=linkRuleStates({states:[{id:'a',snapshot:before},{id:'b',snapshot:after}],transitions:[{from:'a',to:'b',control:{id:'toggle',selector:'#toggle'},action:{kind:'click'},effects:semanticDiff(before,after).effects}]});
  assert.equal(result.relations[0].declaredTargets[0].status,'declared');
  assert.ok(result.relations[0].targets.every(t=>t.status==='unresolved'));
  assert.ok(result.relations[0].targets.some(t=>t.reason==='matched CSS evidence unavailable'));
  const limited=linkRuleStates({states:[{id:'a',snapshot:before}],transitions:[{from:'a',to:null,control:{id:'toggle'},action:{kind:'click'}}]});
  assert.equal(limited.relations[0].status,'unresolved');
});
