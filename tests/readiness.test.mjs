import test from 'node:test';
import assert from 'node:assert/strict';
import {assessRenderedPage} from '../page-readiness.mjs';
test('readiness identifies gates and placeholders without classifying legitimate login, media or documentation as gates',()=>{
 for(const title of ['Just a moment...','Attention Required! | Cloudflare','Verify you are human'])assert.equal(assessRenderedPage({title,text:'Wait'}),'verification-gate');
 for(const text of ['Loading…','Please wait...','加载中','正在加载…'])assert.equal(assessRenderedPage({text}),'loading-placeholder');
 assert.equal(assessRenderedPage({text:''}),'empty-rendered-body');assert.equal(assessRenderedPage({text:'undefined'}),'unknown');assert.equal(assessRenderedPage({text:'Error'}),'unknown');
 for(const input of [{url:'https://example.com/login',text:'Sign in'},{visibleMedia:1},{hasMainContent:true},{title:'Cloudflare integration guide',text:'Documentation about checking your browser and loading states.'},{text:'A normal page'}])assert.equal(assessRenderedPage(input),'content-observed');
});
