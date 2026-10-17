import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {parseArgs} from '../scripts/cli-options.mjs';
test('CLI rejects invalid arguments with stable machine-readable failure',()=>{
 for(const args of [[],['--url','https://a','--manual'],['--url','file:///tmp/a'],['--url','https://a','--explore-interactions'],['--url','https://a','--width','no'],['--url','https://a','--headed','--headless']]) {
  const result=spawnSync(process.execPath,['scripts/capture.mjs',...args],{encoding:'utf8'});
  assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).status,'failed');
 }
 assert.equal(parseArgs(['--url','https://a','--width','800']).width,800);
});
test('core module import has no CLI side effects',()=>{
 assert.equal(execFileSync(process.execPath,['--input-type=module','-e',"await import('./capture.mjs')"],{encoding:'utf8'}),'');
});

test('empty output reservation excludes concurrent commands and releases on errors',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {reserveOutput}=await import('../scripts/output-directory.mjs');const directory=await fs.mkdtemp(path.join(os.tmpdir(),'replica-lock-'));
 try{const release=await reserveOutput(directory);await assert.rejects(reserveOutput(directory),/reserved/);await release();await fs.writeFile(path.join(directory,'existing'),'keep');await assert.rejects(reserveOutput(directory),/empty/);assert.equal(await fs.readFile(path.join(directory,'existing'),'utf8'),'keep');assert.ok(!(await fs.readdir(directory)).includes('.web-replica.lock'));}finally{await fs.rm(directory,{recursive:true,force:true});}
});
