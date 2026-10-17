import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {capture,makeSnapshotHtml} from '../capture.mjs';
import {parseArgs} from '../scripts/cli-options.mjs';

test('canvas gradients, transparency, CSS backgrounds and open shadow pixels survive offline without drawing scripts',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'replica-canvas-'));
 const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><style>body{margin:0}canvas{width:200px;height:100px;background:lime;border:3px solid black;padding:5px;transform:translateX(8px)}</style><canvas width="400" height="200"></canvas><div id="host"></div><script>
 const paint=canvas=>{const ctx=canvas.getContext('2d');const g=ctx.createLinearGradient(0,0,canvas.width,0);g.addColorStop(0,'blue');g.addColorStop(1,'red');ctx.fillStyle=g;ctx.fillRect(0,0,canvas.width/2,canvas.height)};
 paint(document.querySelector('canvas'));const root=document.querySelector('#host').attachShadow({mode:'open'});root.innerHTML='<canvas width="100" height="50"></canvas>';paint(root.querySelector('canvas'));
 window.DRAWING_SCRIPT_SENTINEL=true;</script>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
 const result=await capture(parseArgs(['--url',`http://127.0.0.1:${server.address().port}/`,'--out',dir,'--wait','0']));assert.equal(result.status,'ok',JSON.stringify(result));
 const report=JSON.parse(await fs.readFile(path.join(dir,'report.json')));assert.equal(report.canvasSnapshots.length,2);assert.ok(report.canvasSnapshots.every(f=>f.status==='captured'&&f.bytes>0));
 const assets=JSON.parse(await fs.readFile(path.join(dir,'assets.json')));assert.equal(assets.resources.filter(r=>r.source==='canvas-bitmap').length,2);
 const html=await fs.readFile(path.join(dir,'index.html'),'utf8');assert.ok(!html.includes('DRAWING_SCRIPT_SENTINEL'));assert.ok(!html.includes('data:image/png;base64,'));
 browser=await chromium.launch();const page=await browser.newPage({viewport:report.viewport});await page.route(/^https?:/,r=>r.abort());await page.goto(pathToFileURL(path.join(dir,'index.html')).href);await page.waitForLoadState('networkidle');
 assert.equal(await page.locator('canvas').count(),2);assert.equal(await page.evaluate(()=>window.DRAWING_SCRIPT_SENTINEL),undefined);
 assert.deepEqual(await page.screenshot(),await fs.readFile(path.join(dir,'screenshot.png')));
 }finally{await browser?.close();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
});

test('canvas readback errors and storage budget failures are explicit without a broken image reference',async()=>{
 const browser=await chromium.launch();try{
 const page=await browser.newPage();await page.setContent('<canvas id="tainted"></canvas><canvas id="budget"></canvas><canvas width="0"></canvas>');
 await page.evaluate(()=>{document.querySelector('#tainted').toDataURL=()=>{throw new DOMException('Tainted canvas','SecurityError');};});
 const {html,canvases}=await makeSnapshotHtml(page,{}, {}, {storeCanvas:async()=>{throw new Error('Resource exceeds capture size budget');}});
 assert.equal(canvases.length,3);assert.ok(canvases.every(f=>f.status==='unavailable'));assert.match(canvases[0].reason,/Tainted/);assert.match(canvases[1].reason,/budget/);assert.match(canvases[2].reason,/zero/);assert.ok(!html.includes('background-image:'));
 }finally{await browser.close();}
});
