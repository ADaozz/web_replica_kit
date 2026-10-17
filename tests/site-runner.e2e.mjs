import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
test('site runner attempts capture after failed discovery and verifies file/HTTP without following links',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'replica-matrix-'));let documents=0;const visited=[];
 const server=http.createServer((req,res)=>{visited.push(req.url);if(req.url!=='/'){res.writeHead(404);res.end();return;}documents++;res.setHeader('Content-Type','text/html');res.statusCode=documents===1?503:200;res.end('<!doctype html><main>Real test page<a href="/never">Never visit</a></main>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
 const matrix=path.join(directory,'matrix.json'),out=path.join(directory,'out');await fs.writeFile(matrix,JSON.stringify([{id:'independent',url:`http://127.0.0.1:${server.address().port}/`}]));
 await exec(process.execPath,['scripts/test-sites.mjs','--matrix',matrix,'--out',out,'--wait','0','--max-nodes','100'],{timeout:30000});
 const result=JSON.parse(await fs.readFile(path.join(out,'summary.json'))).cases[0];assert.equal(result.discovery.status,'failed');assert.equal(result.discovery.classification,'external-network-or-server-failure');assert.equal(result.capture.status,'ok');assert.equal(result.status,'measured');assert.equal(result.previews.length,2);assert.ok(result.previews.every(p=>p.pageAssessment==='content-observed'&&p.pageErrors.length===0&&p.pixelDiffRatio===0));assert.equal(documents,2);assert.ok(!visited.includes('/never'));
 }finally{await new Promise(r=>server.close(r));await fs.rm(directory,{recursive:true,force:true});}
});
