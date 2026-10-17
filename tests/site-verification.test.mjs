import {assessRenderedPage} from '../page-readiness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyFailure,verifyStructure} from '../scripts/site-verification.mjs';
test('site evidence distinguishes access restrictions, capture budgets, preview failures and gates',()=>{
 assert.equal(classifyFailure({stdout:JSON.stringify({error:'HTTP 403'})},'capture').classification,'external-access-restriction');
 assert.equal(classifyFailure({message:'Timed out',killed:true},'capture').classification,'process-budget-exceeded');
 assert.equal(classifyFailure({message:'Timeout'},'preview').classification,'preview-failure');
 assert.equal(classifyFailure({message:'Bad serialized JSON'},'capture').classification,'requires-investigation');
 assert.equal(assessRenderedPage({title:'Just a moment...',text:'Checking your browser'}),'verification-gate');
 assert.equal(assessRenderedPage({url:'https://example.com/login',text:'Sign in'}),'content-observed');
 assert.equal(assessRenderedPage({text:'Loading…'}),'loading-placeholder');
 assert.equal(assessRenderedPage({text:'undefined'}),'unknown');
 assert.equal(assessRenderedPage({visibleMedia:1}),'content-observed');
 assert.equal(assessRenderedPage({text:'API documentation mentions captcha and undefined.'}),'content-observed');
});
test('site structure validation rejects mismatched evidence and script artifacts',()=>{
 const elements=[{elementId:'e1',parentElementId:null}];
 const data={components:{schemaVersion:3,elements},layout:{schemaVersion:3,elements:[{elementId:'e1',rect:{x:0,y:0,width:100,height:50}}]},computed:{schemaVersion:3,elements:[{elementId:'e1'}]},assets:{schemaVersion:3,resources:[]},report:{schemaVersion:3,dom:{captured:1}}};
 assert.equal(verifyStructure(data).elements,1);
 assert.throws(()=>verifyStructure({...data,computed:{schemaVersion:3,elements:[]}}),/IDs/);
 assert.throws(()=>verifyStructure({...data,assets:{schemaVersion:3,resources:[{type:'script',localPath:'assets/code.js'}]}}),/JavaScript/);
});
