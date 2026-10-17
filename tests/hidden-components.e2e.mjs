// Directed verification on local fixtures only. Production collectors never hover.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {captureDOM} from '../dom-snapshot.mjs';
import {scanNavigation} from '../scripts/discover.mjs';
import {makeSnapshotHtml} from '../capture.mjs';
const find=(snapshot,id)=>snapshot.elements.find(e=>e.attributes.id===id);
const layout=(snapshot,id)=>snapshot.layout.find(e=>e.elementId===find(snapshot,id)?.elementId);
test('mounted CSS hover menus and nested opacity-hidden contents are discoverable before hover',async()=>{
 const browser=await chromium.launch();try{
 const page=await browser.newPage();await page.setContent(`<style>#trigger{width:200px;height:100px}.display-menu{display:none}.fade-menu{position:absolute;opacity:0;width:200px;height:80px}#trigger:hover .display-menu{display:block}#trigger:hover .fade-menu{opacity:1}</style><nav id="trigger">Products<div id="display-menu" class="display-menu" role="menu"><a href="/product">Product</a></div><div id="fade-menu" class="fade-menu" role="menu"><a id="nested" href="/fade">Nested content</a></div></nav><svg id="decorative" aria-hidden="true" width="20" height="20"></svg>`);
 const navigation=await page.evaluate(scanNavigation);assert.equal(navigation.find(e=>e.href==='/fade').visible,false);assert.equal(navigation.find(e=>e.href==='/product').visible,false);
 const before=await captureDOM(page);for(const id of ['display-menu','fade-menu','nested']){assert.ok(find(before,id));assert.equal(layout(before,id).visible,false,id);}
 assert.equal(layout(before,'decorative').visible,true,'aria-hidden is not visual invisibility');
 assert.ok(before.elements.some(e=>e.attributes.href==='/product'));const preview=await makeSnapshotHtml(page,{});assert.match(preview.html,/role="menu"/);assert.match(preview.html,/#trigger:hover/);
 await page.locator('#trigger').hover();assert.equal((await page.evaluate(scanNavigation)).find(e=>e.href==='/fade').visible,true);const after=await captureDOM(page);for(const id of ['display-menu','fade-menu','nested'])assert.equal(layout(after,id).visible,true,id);
 }finally{await browser.close();}
});
test('open Shadow DOM hidden menu is retained, while JS-only unmounted menu cannot be inferred',async()=>{
 const browser=await chromium.launch();try{
 const page=await browser.newPage();await page.setContent('<x-menu style="display:block;width:150px;height:100px"></x-menu><button id="js-trigger">JS menu</button>');
 await page.evaluate(()=>{
 document.querySelector('x-menu').attachShadow({mode:'open'}).innerHTML='<style>#shadow-menu{display:none}:host(:hover) #shadow-menu{display:block}</style><div id="shadow-menu" role="menu">Shadow item</div>';
 document.querySelector('#js-trigger').addEventListener('mouseenter',()=>{const menu=document.createElement('div');menu.id='dynamic-menu';menu.role='menu';menu.textContent='Mounted only after hover';document.body.append(menu);},{once:true});
 });
 const before=await captureDOM(page);assert.ok(find(before,'shadow-menu'));assert.equal(layout(before,'shadow-menu').visible,false);assert.equal(find(before,'dynamic-menu'),undefined);
 await page.locator('x-menu').hover();assert.equal(layout(await captureDOM(page),'shadow-menu').visible,true);
 await page.locator('#js-trigger').hover();const after=await captureDOM(page);assert.ok(find(after,'dynamic-menu'));assert.equal(layout(after,'dynamic-menu').visible,true);assert.match((await makeSnapshotHtml(page,{})).html,/Mounted only after hover/);
 }finally{await browser.close();}
});
