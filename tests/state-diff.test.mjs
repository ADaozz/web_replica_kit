import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticDiff } from '../state-diff.mjs';
import { classifyNavigation, routeKey } from '../route-capture.mjs';
import { compareMappedFacts } from '../scripts/verify-interactions.mjs';

test('semantic diff keeps visibility, aria, and route changes while ignoring noise and scroll', () => {
  const before = {
    origin: 'http://fixture.test', route: '/app',
    nodes: [
      { key: 'clock', noise: true, visible: true, value: '10:00' },
      { key: 'panel', selector: '#panel', visible: false, expanded: null, bbox: { x: 0, y: 10, width: 100, height: 40 } },
      { key: 'more', selector: '#more', visible: true, expanded: 'false', bbox: { x: 0, y: 10, width: 40, height: 20 } }
    ]
  };
  const after = {
    origin: 'http://fixture.test', route: '/app/settings',
    nodes: [
      { key: 'clock', noise: true, visible: true, value: '10:05' },
      { key: 'panel', selector: '#panel', visible: true, expanded: null, bbox: { x: 0, y: 30, width: 100, height: 40 } },
      { key: 'more', selector: '#more', visible: true, expanded: 'true', bbox: { x: 0, y: 30, width: 40, height: 20 } }
    ]
  };
  const diff = semanticDiff(before, after);
  assert.ok(diff.effects.some(effect => effect.type === 'route' && effect.to === '/app/settings'));
  assert.ok(diff.effects.some(effect => effect.type === 'visibility' && effect.selector === '#panel' && effect.to === true));
  assert.ok(diff.effects.some(effect => effect.type === 'aria' && effect.name === 'aria-expanded' && effect.to === 'true'));
  assert.equal(diff.effects.some(effect => effect.key === 'clock'), false);
  assert.deepEqual(diff.ignored, ['uniform-scroll']);
  assert.equal(!semanticDiff(before,after,{strictGeometry:true}).changed, false);
  assert.equal(!semanticDiff(after,after,{strictGeometry:true}).changed, true);
});

test('route policy blocks other origins unless same-origin exploration is permitted', () => {
  assert.equal(routeKey('http://fixture.test/app?tab=1#top'), '/app?tab=1#top');
  assert.equal(classifyNavigation('http://fixture.test/app', 'https://other.test/app').classification, 'blocked');
  assert.equal(classifyNavigation('http://fixture.test/app', 'http://fixture.test/settings').classification, 'review-required');
  assert.equal(classifyNavigation('http://fixture.test/app', 'http://fixture.test/settings', { allowSameOriginNavigation: true }).classification, 'allowed-safe');
});

test('mapped verification compares required facts and actual popup edges',()=>{
  const a={attributes:{'aria-expanded':'true'},bbox:{x:100,y:20,width:120,height:50}};
  assert.equal(compareMappedFacts(a,a,{bbox:true}).passed,true);
  assert.equal(compareMappedFacts(a,{...a,bbox:{...a.bbox,x:109}},{bbox:true}).passed,false);
  assert.equal(compareMappedFacts(a,{...a,attributes:{'aria-expanded':'false'}},{bbox:true}).passed,false);
});

test('structural snapshots retain positional selectors, shadow selectors, text and classes',async()=>{
  const {semanticHash}=await import('../state-diff.mjs');
  const before={route:'/lab',nodes:[{key:'anchor',selector:'#anchor',visible:true,bbox:{x:100,y:20,width:40,height:20}},{key:'popup',selector:'#host >>> div:nth-of-type(1)',visible:true,text:'First',attributes:{class:'old','aria-expanded':'true'},bbox:{x:100,y:40,width:100,height:80}}]};
  const after={...before,nodes:[before.nodes[0],{...before.nodes[1],text:'Second',attributes:{class:'active'},bbox:{x:150,y:40,width:100,height:80}}]};
  const diff=semanticDiff(before,after);
  assert.ok(diff.effects.some(e=>e.type==='attribute' && e.name==='class'));
  assert.ok(diff.effects.some(e=>e.type==='attribute' && e.name==='aria-expanded' && e.to===null));
  assert.ok(diff.effects.some(e=>e.type==='text'));
  assert.ok(diff.effects.some(e=>e.type==='geometry'));
  assert.notEqual(semanticHash(before),semanticHash(after));
  assert.equal(!semanticDiff(before,after,{strictGeometry:true}).changed,false);
});

test('verification rejects uniform position errors and hashes ignore compensated scroll',async()=>{
  const {semanticHash}=await import('../state-diff.mjs');
  const a={route:'/lab',nodes:[{key:'a',visible:true,bbox:{x:100,y:100,width:50,height:20},documentBox:{x:100,y:100,width:50,height:20}}]};
  const scrolled={...a,nodes:[{...a.nodes[0],bbox:{x:100,y:50,width:50,height:20}}]};
  assert.equal(semanticHash(a),semanticHash(scrolled));
  assert.equal(!semanticDiff(a,scrolled,{strictGeometry:true}).changed,false);
});

test('attribute removal and reinsertion order does not create a false state or restore failure',async()=>{
  const {semanticHash}=await import('../state-diff.mjs');
  const a={route:'/lab',nodes:[{key:'popup',visible:false,attributes:{hidden:'',style:'position:absolute'}}]};
  const b={route:'/lab',nodes:[{key:'popup',visible:false,attributes:{style:'position:absolute',hidden:''}}]};
  assert.equal(semanticHash(a),semanticHash(b));assert.equal(semanticDiff(a,b).changed,false);
});

test('running animation appearance and transform do not create new semantic states',async()=>{
  const {semanticHash}=await import('../state-diff.mjs');
  const a={route:'/lab',nodes:[{key:'spinner',animating:true,visible:true,appearance:{display:'block',visibility:'visible',opacity:'0.3',transform:'rotate(10deg)'},layout:{position:'relative',transform:'rotate(10deg)'}}]};
  const b={...a,nodes:[{...a.nodes[0],appearance:{...a.nodes[0].appearance,opacity:'0.7',transform:'rotate(80deg)'},layout:{position:'relative',transform:'rotate(80deg)'}}]};
  assert.equal(semanticHash(a),semanticHash(b));assert.equal(semanticDiff(a,b).changed,false);
  const hidden={...b,nodes:[{...b.nodes[0],visible:false,appearance:{...b.nodes[0].appearance,display:'none'}}]};
  assert.notEqual(semanticHash(a),semanticHash(hidden));
});
