import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {capture} from '../capture.mjs';
import {parseArgs} from '../scripts/cli-options.mjs';
import {inspectPageReadiness} from '../page-readiness.mjs';
import {chromium} from 'playwright';
const exec=promisify(execFile);
const pages={normal:'<main>Real content</main>',loading:'<main>Loading…</main>',gate:'<title>Just a moment...</title><main>Checking your browser</main>',empty:'<body></body>',login:'<main><form><label>Email<input name="email"></label><button>Sign in</button></form></main>',canvas:'<canvas width="100" height="50"></canvas><script>const ctx=document.querySelector("canvas").getContext("2d");ctx.fillStyle="orange";ctx.fillRect(0,0,100,50)</script>',image:'<img width="100" height="50" src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'100\' height=\'50\'%3E%3C/svg%3E">',delayed:'<main id="ready" hidden>Loaded real content</main><script>setTimeout(()=>document.querySelector("#ready").hidden=false,100)</script>'};
test('capture diagnoses local readiness fixtures, preserves manual confirmation and enforces explicit selector waits',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'replica-ready-')),visited=[];
 const server=http.createServer((req,res)=>{visited.push(req.url);res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html>'+pages[req.url.slice(1)]);});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/`;
 async function run(name,extra=[],suffix=name){const out=path.join(directory,suffix);let code=0,stdout;try{({stdout}=await exec(process.execPath,['scripts/capture.mjs','--url',base+name,'--out',out,'--wait','0',...extra],{timeout:30000}));}catch(error){code=error.code;stdout=error.stdout;}return {code,result:JSON.parse(stdout),out};}
 try{
 for(const [name,status] of [['normal','content-observed'],['loading','loading-placeholder'],['gate','verification-gate'],['empty','empty-rendered-body'],['login','content-observed'],['canvas','content-observed'],['image','content-observed']])await t.test(name,async()=>{
 const result=await run(name);const partial=['loading','gate','empty'].includes(name);assert.equal(result.code,partial?2:0,JSON.stringify(result));const report=JSON.parse(await fs.readFile(path.join(result.out,'report.json')));assert.equal(report.readiness.status,status);assert.equal(report.readiness.readySelectorMatched,null);assert.equal(report.cleanup.removedCount,0);assert.equal(report.previewGenerated,true);if(partial)assert.ok(report.warnings.some(w=>w.includes('Page readiness')));
 });
 await t.test('ready selector success',async()=>{const result=await run('delayed',['--ready-selector','#ready','--ready-timeout','3000']);assert.equal(result.code,0);const report=JSON.parse(await fs.readFile(path.join(result.out,'report.json')));assert.equal(report.readiness.readySelectorMatched,true);assert.equal(report.readiness.status,'content-observed');});
 await t.test('ready selector timeout',async()=>{const result=await run('normal',['--ready-selector','#missing','--ready-timeout','50'],'timeout');assert.equal(result.code,1);assert.equal(result.result.status,'failed');assert.match(result.result.error,/Timeout/);assert.ok(!(await fs.readdir(result.out)).includes('report.json'));});
 await t.test('manual preparation and manual gate diagnosis remain independent',async()=>{
 for(const prepare of [true,false]){
 const out=path.join(directory,prepare?'manual-content':'manual-gate');const opts=parseArgs(['--url',base+'gate','--out',out,'--wait','0']);
 const result=await capture({...opts,manual:true,confirmReady:async page=>{assert.ok(!(await fs.readdir(out)).includes('components.json'));if(prepare)await page.setContent('<!doctype html><main>After confirmation</main>');}});
 const report=JSON.parse(await fs.readFile(path.join(out,'report.json')));assert.equal(report.confirmation.confirmed,true);assert.equal(report.readiness.status,prepare?'content-observed':'verification-gate');assert.equal(result.status,prepare?'ok':'partial');
 }
 });
 assert.equal(visited.length,11,'one navigation per case; no automatic retry or refresh');
 }finally{await new Promise(r=>server.close(r));await fs.rm(directory,{recursive:true,force:true});}
});

test('hidden media does not establish readiness; rendered open shadow text and controls are considered',async()=>{
 const browser=await chromium.launch();try{
 const page=await browser.newPage();await page.setContent('<img hidden src="data:image/svg+xml,%3Csvg/%3E"><x-page></x-page>');assert.equal((await inspectPageReadiness(page)).status,'empty-rendered-body');
 await page.evaluate(()=>document.querySelector('x-page').attachShadow({mode:'open'}).innerHTML='<main>Shadow only content</main>');assert.equal((await inspectPageReadiness(page)).status,'content-observed');
 await page.setContent('<form><input placeholder="Email"><input type="password" placeholder="Password"></form>');assert.equal((await inspectPageReadiness(page)).status,'content-observed');
 }finally{await browser.close();}
});
