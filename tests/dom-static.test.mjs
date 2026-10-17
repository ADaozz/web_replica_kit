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

test('body-rooted UI evidence excludes metadata and inactive templates while preserving global layout and aligned IDs',async()=>{
 const browser=await chromium.launch();try{
 const page=await browser.newPage({viewport:{width:800,height:600}});
 await page.setContent('<!doctype html><html style="padding:7px;background:rgb(1, 2, 3)"><head><title>Metadata only</title><meta name="description" content="META_ONLY"><style>/* CSS_ONLY_SENTINEL */ body{margin:9px}#dropdown{display:none}</style></head><body><main><div id="dropdown">Hidden menu</div><x-card></x-card><template><aside>Inactive template</aside></template></main><style>.body-style{color:red}</style><script type="application/json">HYDRATION</script></body></html>');
 await page.evaluate(()=>document.querySelector('x-card').attachShadow({mode:'open'}).innerHTML='<style>:host{display:block}</style><section>Shadow UI</section><template><b>Inactive shadow</b></template>');
 const data=await captureDOM(page);
 assert.equal(data.elements[0].tag,'body');assert.equal(data.elements[0].parentElementId,null);assert.equal(data.totalNodes,5);assert.equal(data.truncated,false);
 for(const tag of ['html','head','style','link','meta','title','script','template'])assert.ok(!data.elements.some(e=>e.tag===tag),tag);
 const text=JSON.stringify(data.elements);for(const omitted of ['CSS_ONLY_SENTINEL','META_ONLY','Inactive template','Inactive shadow','HYDRATION'])assert.ok(!text.includes(omitted));assert.ok(text.includes('Shadow UI'));
 const hidden=data.elements.find(e=>e.attributes.id==='dropdown');assert.ok(hidden);assert.equal(data.layout.find(e=>e.elementId===hidden.elementId).visible,false);
 const ids=new Set(data.elements.map(e=>e.elementId));assert.deepEqual(new Set(data.layout.map(e=>e.elementId)),ids);assert.deepEqual(new Set(data.computed.map(e=>e.elementId)),ids);for(const e of data.elements)assert.ok(e.parentElementId===null || ids.has(e.parentElementId));
 assert.equal(data.documentElement.tag,'html');assert.equal(data.documentElement.properties.padding,'7px');assert.match(data.documentElement.properties.background,/rgb\(1, 2, 3\)/);assert.equal(data.computed[0].properties.margin,'9px');assert.equal(data.viewport.width,800);
 const limited=await captureDOM(page,{maxNodes:3});assert.equal(limited.totalNodes,5);assert.equal(limited.elements.length,3);assert.equal(limited.truncated,true);assert.ok(limited.elements.every(e=>e.parentElementId===null || limited.elements.some(p=>p.elementId===e.parentElementId)));
 }finally{await browser.close();}
});
