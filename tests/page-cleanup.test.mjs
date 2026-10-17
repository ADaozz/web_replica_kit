import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {cleanPage} from '../page-cleanup.mjs';
import {captureDOM} from '../dom-snapshot.mjs';
import {makeSnapshotHtml} from '../capture.mjs';
test('cleans ads, loaders and promotional overlays across open shadow roots without removing normal UI or clicking',async()=>{
 const browser=await chromium.launch();try{
 const page=await browser.newPage();await page.setContent(`<style>.loading-overlay{position:fixed;inset:0}</style><body class="modal-open" style="overflow:hidden"><main><h1>Real page</h1><div class="address">Address</div><button onclick="window.clicked=true">Loading…</button><progress value="50" max="100"></progress></main><div class="ad-banner">AD_CONTENT</div><div class="loading-overlay">Loading…</div><div role="dialog" style="position:fixed">Special offer<button onclick="window.clicked=true">Close</button></div><div class="modal-backdrop"></div><x-box></x-box><sl-dialog open style="display:contents">Migrate to New Product</sl-dialog>`);
 await page.evaluate(()=>document.querySelector('x-box').attachShadow({mode:'open'}).innerHTML='<div class="advertisement">SHADOW_AD</div><p>Shadow main</p>');
 await page.evaluate(()=>document.querySelector('sl-dialog').attachShadow({mode:'open'}).innerHTML='<div style="width:200px;height:100px"><slot></slot></div>');
 const result=await cleanPage(page,{cleanNoise:true});assert.equal(result.automatic,true);assert.equal(result.removedCount,6);assert.equal(await page.evaluate(()=>window.clicked),undefined);
 assert.equal(await page.locator('h1').textContent(),'Real page');assert.equal(await page.locator('progress').count(),1);assert.equal(await page.locator('.address').count(),1);assert.equal(await page.locator('button').count(),1);
 assert.equal(await page.locator('body').getAttribute('class'),'');assert.notEqual(await page.locator('body').evaluate(e=>getComputedStyle(e).overflow),'hidden');
 const dom=await captureDOM(page),{html}=await makeSnapshotHtml(page,{});assert.ok(!JSON.stringify(dom).includes('AD_CONTENT'));assert.ok(!html.includes('SHADOW_AD'));assert.ok(html.includes('Real page'));
 }finally{await browser.close();}
});
test('preserves substantive loading containers and ordinary dialogs; default preservation and explicit selectors are supported',async()=>{
 const browser=await chromium.launch();try{
 const page=await browser.newPage();await page.setContent('<div class="loading-screen"><main>Content loading guide</main></div><div role="dialog">Edit profile<label>Newsletter preference</label></div><div class="ad-banner">Ad</div><aside id="custom">Custom promotion</aside>');
 const preserved=await cleanPage(page);assert.equal(preserved.automatic,false);assert.equal(preserved.removedCount,0);
 const result=await cleanPage(page,{removeSelector:'#custom'});assert.equal(result.automatic,false);assert.equal(result.removedCount,1);assert.equal(await page.locator('.ad-banner').count(),1);assert.equal(await page.locator('.loading-screen').count(),1);assert.equal(await page.locator('[role=dialog]').count(),1);
 await assert.rejects(cleanPage(page,{removeSelector:'['}));assert.equal(await page.locator('main').count(),1);
 }finally{await browser.close();}
});
test('automatic is true only for explicit clean-noise and does not change which nodes are removed',async()=>{
 const browser=await chromium.launch();try{
 const page=await browser.newPage();
 const html='<main>Keep</main><div class="ad-banner">AD</div><div class="loading-overlay">Loading…</div><aside id="custom">Custom</aside>';
 await page.setContent(html);
 const defaults=await cleanPage(page);assert.equal(defaults.automatic,false);assert.equal(defaults.removedCount,0);assert.equal(await page.locator('#custom').count(),1);assert.equal(await page.locator('.ad-banner').count(),1);
 await page.setContent(html);
 const selected=await cleanPage(page,{removeSelector:'#custom'});assert.equal(selected.automatic,false);assert.equal(selected.removedCount,1);assert.equal(selected.removed[0].reason,'user-selector');assert.equal(await page.locator('.ad-banner').count(),1);assert.equal(await page.locator('.loading-overlay').count(),1);assert.equal(await page.locator('main').count(),1);
 await page.setContent(html);
 const noise=await cleanPage(page,{cleanNoise:true});assert.equal(noise.automatic,true);assert.equal(noise.removedCount,2);assert.deepEqual(noise.removed.map(item=>item.reason).sort(),['advertisement','loading-placeholder']);assert.equal(await page.locator('#custom').count(),1);assert.equal(await page.locator('main').count(),1);
 await page.setContent(html);
 const both=await cleanPage(page,{cleanNoise:true,removeSelector:'#custom'});assert.equal(both.automatic,true);assert.equal(both.removedCount,3);assert.equal(both.removed.filter(item=>item.reason==='user-selector').length,1);assert.equal(await page.locator('main').count(),1);assert.equal(await page.locator('#custom').count(),0);assert.equal(await page.locator('.ad-banner').count(),0);
 }finally{await browser.close();}
});
