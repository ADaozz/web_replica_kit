import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {captureDOM} from '../dom-snapshot.mjs';
test('DOM retains hierarchy, semantic candidates, geometry and shadow content without state evidence',async()=>{
 const browser=await chromium.launch();try{
 const page=await browser.newPage({viewport:{width:800,height:600}});
 await page.setContent('<main style="display:flex;width:600px"><section>A<button>B</button></section><x-box></x-box><input type="password" value="PRIVATE"><script>secret()</script></main>');
 await page.evaluate(()=>document.querySelector('x-box').attachShadow({mode:'open'}).innerHTML='<aside>Shadow</aside>');
 const data=await captureDOM(page);const main=data.elements.find(e=>e.tag==='main'),section=data.elements.find(e=>e.tag==='section');
 assert.equal(section.parentElementId,main.elementId);assert.equal(main.componentType,'Main');assert.equal(data.layout.find(e=>e.elementId===main.elementId).rect.width,600);
 assert.equal(data.computed.find(e=>e.elementId===main.elementId).properties.display,'flex');assert.equal(data.shadowRoots,1);assert.ok(data.elements.some(e=>e.text==='Shadow'));assert.ok(!JSON.stringify(data).includes('PRIVATE'));assert.ok(!data.elements.some(e=>e.tag==='script'));
 const limited=await captureDOM(page,{maxNodes:2});assert.equal(limited.elements.length,2);assert.equal(limited.truncated,true);
 }finally{await browser.close();}
});
