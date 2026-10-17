import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {PNG} from 'pngjs';
import pixelmatch from 'pixelmatch';
import {capture} from '../capture.mjs';
import {parseArgs} from '../scripts/cli-options.mjs';

test('same-origin and tainted cross-origin videos freeze the observed frame, including segmented media, without playback',async()=>{
 const movie=await fs.readFile(new URL('./fixtures/video-colors.mp4',import.meta.url));
 let fullGets=0,rangeGets=0;
 const sendMovie=(req,res)=>{
   res.setHeader('Content-Type','video/mp4');res.setHeader('Accept-Ranges','bytes');
   if(req.headers.range){rangeGets++;const start=Number(/bytes=(\d+)/.exec(req.headers.range)[1]),end=Math.min(start+255,movie.length-1);res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${movie.length}`,'Content-Length':end-start+1});res.end(movie.subarray(start,end+1));}
   else{fullGets++;res.setHeader('Content-Length',movie.length);res.end(movie);}
 };
 const media=http.createServer(sendMovie);await new Promise(r=>media.listen(0,'127.0.0.1',r));
 const server=http.createServer((req,res)=>{
   if(req.url==='/movie.mp4'){sendMovie(req,res);return;}
   res.setHeader('Content-Type','text/html');res.end(`<!doctype html><style>body{margin:0}video{width:160px;height:100px;object-fit:contain;background:lime;border:3px solid white}</style><main><video src="/movie.mp4" muted preload="auto"></video><div id="host"></div></main><script>
   const root=document.querySelector('#host').attachShadow({mode:'open'});root.innerHTML='<video width="160" height="100" src="http://127.0.0.1:${media.address().port}/movie.mp4" muted preload="auto"></video>';
   const videos=[document.querySelector('video'),root.querySelector('video')];
   Promise.all(videos.map(v=>new Promise(resolve=>{v.onloadeddata=()=>{v.onseeked=()=>{v.pause();resolve()};v.currentTime=1.4};}))).then(()=>document.querySelector('main').setAttribute('data-ready','yes'));
   window.ORIGINAL_VIDEO_SCRIPT=true;</script>`);
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'replica-video-'));let browser;
 try{
   const result=await capture(parseArgs(['--url',`http://127.0.0.1:${server.address().port}/`,'--out',dir,'--wait','0','--ready-selector','[data-ready]']));
   assert.equal(result.status,'partial','same-origin raw media remains incomplete and is reported, even though its frame is preserved');
   const report=JSON.parse(await fs.readFile(path.join(dir,'report.json')));assert.equal(report.videoSnapshots.length,2);assert.ok(report.videoSnapshots.every(v=>v.status==='captured'&&v.time>=1.4));
   const assets=JSON.parse(await fs.readFile(path.join(dir,'assets.json')));assert.equal(assets.resources.filter(r=>r.source==='video-frame').length,2);assert.ok(assets.resources.filter(r=>r.type==='media').every(r=>r.bytes===movie.length),'partial ranges never masquerade as complete media');assert.ok(fullGets>0&&rangeGets>0);
   browser=await chromium.launch();const page=await browser.newPage({viewport:report.viewport});await page.route(/^https?:/,r=>r.abort());await page.goto(pathToFileURL(path.join(dir,'index.html')).href);await page.waitForTimeout(200);
   assert.ok((await page.locator('video').evaluateAll(els=>els.map(v=>!v.hasAttribute('src')&&!v.autoplay&&v.poster&&v.paused))).every(Boolean));assert.equal(await page.evaluate(()=>window.ORIGINAL_VIDEO_SCRIPT),undefined);
   const original=PNG.sync.read(await fs.readFile(path.join(dir,'screenshot.png'))),preview=PNG.sync.read(await page.screenshot());// Native video and poster image sampling can differ by one edge column.
   assert.ok(pixelmatch(original.data,preview.data,null,original.width,original.height,{threshold:0.1})<=2*(100+100));
   for(const image of [original,preview])for(const y of [50,160]){const offset=(y*image.width+80)*4;assert.ok(image.data[offset]<20&&image.data[offset+2]>230,'observed blue frame, not red first frame or an old poster');}
 }finally{await browser?.close();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>media.close(r))]);await fs.rm(dir,{recursive:true,force:true});}
});
