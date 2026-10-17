import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {pathToFileURL} from 'node:url';
import {discover} from '../scripts/discover.mjs';
import {parseArgs} from '../scripts/cli-options.mjs';

function command(args){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['scripts/capture.mjs',...args]);let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',reject);child.on('close',code=>resolve({code,result:JSON.parse(stdout),stderr}));});}
test('independent discovery and capture produce safe schema 3, one page and exact static preview',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'replica-static-'));const visited=[],resourceCookies=[];
 const server=http.createServer((req,res)=>{
 visited.push(req.url);
 if(req.url==='/extra.svg'){resourceCookies.push(req.headers.cookie);res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg"/>');return;}
 if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end('window.SOURCE_BUNDLE_SENTINEL=true; document.querySelector("#css").sheet.insertRule("main{border:3px solid blue}");');return;}
 if(req.url==='/sheet.css'){res.setHeader('Content-Type','text/css');res.end('/* ORIGINAL_CSS */ @layer base; main{display:grid;grid-template-columns:100px 1fr;width:600px;height:180px;background:#eee}');return;}
 if(req.url==='/missing.png'){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type','text/html');res.setHeader('Set-Cookie','session=PRIVATE_COOKIE; Path=/');res.end(`<!doctype html><link rel="apple-touch-icon" href="/extra.svg"><meta name="csrf-token" content="CSRF_SECRET"><input name="api_key" style="display:none" value="API_SECRET"><link id="css" rel="stylesheet" href="/sheet.css"><main data-mode="visible"><nav><a href="/never">Never</a><a href="?q=1">Query</a><a href="#x">Anchor</a><a href="/never"><img alt="Picture" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"></a></nav><section>Rendered</section></main><input type="hidden" value="HYDRATION_SECRET"><script type="application/json">HYDRATION_SECRET</script><!-- COMMENT_SECRET --><button onclick="alert('HANDLER_SECRET')">Button</button><script src="/bundle.js"></script>${req.url.includes('broken')?'<img src="/missing.png">':''}`);
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/`;
 let browser;try{
 const navOut=path.join(directory,'nav');await discover(parseArgs(['--url',url,'--out',navOut,'--wait','0']));
 const nav=JSON.parse(await fs.readFile(path.join(navOut,'navigation.json')));assert.equal(nav.entries.find(e=>e.url.endsWith('/never')).sources.length,2);assert.ok(!visited.includes('/never'));
 const out=path.join(directory,'capture');const result=await command(['--url',url,'--out',out,'--wait','0']);assert.equal(result.code,0,JSON.stringify(result.result));assert.equal(result.result.status,'ok');
 const read=async f=>JSON.parse(await fs.readFile(path.join(out,f)));
 const report=await read('report.json');assert.equal(report.schemaVersion,3);assert.equal(report.previewGenerated,true);
 const assets=await read('assets.json');assert.ok(!assets.resources.some(r=>r.type==='script'));assert.ok(!visited.includes('/never'));
 const css=await read('styles/stylesheets.json');assert.equal(css.network.length,1);assert.match(await fs.readFile(path.join(out,css.network[0].originalPath),'utf8'),/ORIGINAL_CSS/);
 const html=await fs.readFile(path.join(out,'index.html'),'utf8');for(const secret of ['SOURCE_BUNDLE_SENTINEL','HYDRATION_SECRET','COMMENT_SECRET','HANDLER_SECRET','CSRF_SECRET','API_SECRET','PRIVATE_COOKIE'])assert.ok(!html.includes(secret),secret);
 const components=JSON.stringify(await read('components.json'));for(const secret of ['HYDRATION_SECRET','CSRF_SECRET','API_SECRET'])assert.ok(!components.includes(secret));
 assert.ok(resourceCookies.length>0);assert.ok(resourceCookies.every(value=>value===undefined),'resource completion does not inherit source cookies');
 browser=await chromium.launch();const page=await browser.newPage({viewport:report.viewport});await page.route(/^https?:/,route=>route.abort());await page.goto(pathToFileURL(path.join(out,'index.html')).href);await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>window.SOURCE_BUNDLE_SENTINEL),undefined);assert.equal(await page.locator('main').evaluate(e=>getComputedStyle(e).borderTopWidth),'3px');
 assert.deepEqual(await page.screenshot(),await fs.readFile(path.join(out,'screenshot.png')));
 const reused=await command(['--url',url,'--out',out]);assert.equal(reused.code,1);
 const partial=await command(['--url',url+'?broken','--out',path.join(directory,'partial'),'--wait','0']);assert.equal(partial.code,2);assert.equal(partial.result.status,'partial');
 const capped=await command(['--url',url,'--out',path.join(directory,'capped'),'--wait','0','--max-nodes','2']);assert.equal(capped.code,2);
 }finally{await browser?.close();await new Promise(r=>server.close(r));await fs.rm(directory,{recursive:true,force:true});}
});
test('legacy document mode and HTML background resources survive capture',async()=>{
 const browser=await chromium.launch();try{
 const page=await browser.newPage();await page.setContent('<html><body background="https://example.com/stars.gif"><table><tr><td>Legacy</td></tr></table></body></html>');
 const {makeSnapshotHtml}=await import('../capture.mjs');const {html}=await makeSnapshotHtml(page,{'https://example.com/stars.gif':'assets/stars.gif'});
 assert.ok(!html.includes('<!DOCTYPE'));assert.match(html,/background="assets\/stars.gif"/);
 const preview=await browser.newPage();await preview.setContent(html);assert.equal(await preview.evaluate(()=>document.compatMode),'BackCompat');
 }finally{await browser.close();}
});
