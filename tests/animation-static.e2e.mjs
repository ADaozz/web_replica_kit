import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {makeSnapshotHtml} from '../capture.mjs';
import {rewriteSnapshotAssets} from '../snapshot-resources.mjs';

test('preview freezes observed WAAPI properties over stale inline styles and preserves SVG data URL backgrounds',async()=>{
 const browser=await chromium.launch();try{
 const page=await browser.newPage({viewport:{width:400,height:200}});
 await page.setContent('<!doctype html><style>body{margin:0;background:black}#logo{width:40px;height:40px}#notice{background:white;width:200px;height:80px;opacity:0;transform:translateY(100px)}</style><div id="logo"></div><div id="notice">Visible notice</div><div id="host"></div>');
 await page.evaluate(()=>{
  document.querySelector('#logo').style.backgroundImage='url("data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 10 10%22><rect width=%2210%22 height=%2210%22 fill=%22red%22/></svg>")';
  document.querySelector('#notice').animate([{opacity:1,transform:'translateY(0px)'},{opacity:1,transform:'translateY(0px)'}],{duration:100000,fill:'both'});
  const root=document.querySelector('#host').attachShadow({mode:'open'});root.innerHTML='<div style="opacity:0;color:white">Shadow notice</div>';
  root.firstElementChild.animate([{opacity:1},{opacity:1}],{duration:100000,fill:'both'});
 });
 const {html,animations}=await makeSnapshotHtml(page,{});assert.equal(animations.length,2);assert.ok(animations.some(a=>a.properties.includes('opacity')));
 const preview=await browser.newPage({viewport:{width:400,height:200}});await preview.setContent(rewriteSnapshotAssets(html,{},'https://example.test/'));
 assert.equal(await preview.locator('#notice').evaluate(e=>getComputedStyle(e).opacity),'1');assert.equal(await preview.evaluate(()=>document.getAnimations().length),0);
 assert.deepEqual(await preview.screenshot(),await page.screenshot());
 }finally{await browser.close();}
});
