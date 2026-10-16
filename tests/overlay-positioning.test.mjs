import test from 'node:test';
import assert from 'node:assert/strict';
import {compileOverlayPositioning} from '../overlay-positioning.mjs';

test('position fallback requires measured tracking and leaves ordinary CSS alone',()=>{
  const sample=(x,style)=>({frames:[{index:0,overlays:[{selector:'#popup',trigger:'#trigger',triggerRect:{x,y:20,left:x,right:x+40,top:20,bottom:40},popupRect:{x:x-60,y:45,left:x-60,right:x+40,top:45,bottom:95,width:100,height:50},styles:{position:'fixed'},attributes:{style}}]}]});
  assert.deepEqual(compileOverlayPositioning([sample(100,'left:40px')]),[]);
  assert.deepEqual(compileOverlayPositioning([sample(100,''),sample(120,'')]),[]);
  const policies=compileOverlayPositioning([sample(100,'left:40px;top:45px'),sample(120,'left:60px;top:45px')]);
  assert.equal(policies.length,1);assert.equal(policies[0].align,'right');assert.equal(policies[0].dy,5);
});
