import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {parseArgs} from '../scripts/cli-options.mjs';
test('CLI rejects invalid arguments with stable machine-readable failure',()=>{
 for(const args of [[],['--url','file:///tmp/a'],['--url','https://a','--explore-interactions'],['--url','https://a','--width','no'],['--url','https://a','--headed','--headless']]) {
  const result=spawnSync(process.execPath,['scripts/capture.mjs',...args],{encoding:'utf8'});
  assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).status,'failed');
 }
 assert.equal(parseArgs(['--url','https://a','--width','800']).width,800);
});
test('core module import has no CLI side effects',()=>{
 assert.equal(execFileSync(process.execPath,['--input-type=module','-e',"await import('./capture.mjs')"],{encoding:'utf8'}),'');
});
