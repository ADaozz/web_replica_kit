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

test('discovery JSON retains all hidden explicit links without hovering, clicking or visiting destinations',async()=>{
 const http=await import('node:http'),fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {discover}=await import('../scripts/discover.mjs'),{parseArgs}=await import('../scripts/cli-options.mjs');
 const requested=[],directory=await fs.mkdtemp(path.join(os.tmpdir(),'replica-hidden-nav-'));
 const server=http.createServer((req,res)=>{requested.push(req.url);res.setHeader('Content-Type','text/html');res.end(`<!doctype html><header><a href="/shared">Products</a></header><nav onmouseenter="document.body.dataset.hovered='yes'"><div style="display:none"><a href="/display">Display hidden</a><a href="/shared">Hidden products</a></div><a href="/visibility" style="visibility:hidden">Visibility hidden</a><div style="opacity:0"><a href="/opacity">Opacity hidden</a></div><x-nav></x-nav><a href="http://[">Invalid</a><button onclick="location.href='/js-only'">JS menu</button></nav><script>document.querySelector('x-nav').attachShadow({mode:'open'}).innerHTML='<a style="display:none" href="/shadow">Shadow hidden</a>';if(document.body.dataset.hovered)document.body.innerHTML='UNEXPECTED HOVER';</script>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
 const url=`http://127.0.0.1:${server.address().port}/`;await discover(parseArgs(['--url',url,'--out',directory,'--wait','0']));
 const data=JSON.parse(await fs.readFile(path.join(directory,'navigation.json')));const entries=data.entries;
 for(const pathname of ['/display','/visibility','/opacity','/shadow']){const entry=entries.find(e=>e.url===new URL(pathname,url).href);assert.ok(entry,pathname);assert.ok(entry.sources.every(s=>s.visible===false));}
 const shared=entries.find(e=>e.url===new URL('/shared',url).href);assert.equal(shared.sources.length,2);assert.ok(shared.sources.some(s=>s.visible));assert.ok(shared.sources.some(s=>!s.visible));assert.equal(entries.find(e=>e.label==='Invalid').kind,'unsupported');
 assert.ok(!entries.some(e=>e.url.endsWith('/js-only')));assert.deepEqual(requested,['/']);
 }finally{await new Promise(r=>server.close(r));await fs.rm(directory,{recursive:true,force:true});}
});
