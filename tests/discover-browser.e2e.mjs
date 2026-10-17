import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {scanNavigation,groupNavigation} from '../scripts/discover.mjs';
test('navigation observes image, SVG, area, explicit URL and shadow links without control actions',async()=>{
 const browser=await chromium.launch();try{
 const page=await browser.newPage();await page.setContent(`<base href="https://example.com/base/"><header><a href="../pricing">Pricing</a><x-nav></x-nav></header><main><svg><a xlink:href="/svg"><text>Vector</text></a></svg><a href="image"><img alt="Picture"></a><map><area href="/area" title="Area"></map><div data-href="/explicit">Explicit</div><a hidden href="/hidden">Hidden</a><button onclick="location.href='/must-not-visit'">Action</button></main><footer><a href="https://example.com/pricing">Plans</a></footer>`);
 await page.evaluate(()=>document.querySelector('x-nav').attachShadow({mode:'open'}).innerHTML='<a href="/shadow" aria-label="Shadow entry"></a>');
 const links=await page.evaluate(scanNavigation);const entries=groupNavigation(links.map(l=>({...l,href:new URL(l.href,l.baseUrl).href})),'https://example.com/base/');
 assert.equal(entries.find(e=>e.url==='https://example.com/pricing').sources.length,2);
 for(const label of ['Vector','Picture','Area','Explicit','Shadow entry'])assert.ok(entries.some(e=>e.label===label),label);
 assert.equal(links.find(l=>l.label==='Shadow entry').region,'header');assert.equal(links.find(l=>l.href==='/hidden').visible,false);
 assert.equal(page.url(),'about:blank');assert.ok(!entries.some(e=>e.url.includes('must-not-visit')));
 }finally{await browser.close();}
});
