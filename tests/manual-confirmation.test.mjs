import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {withManualConfirmation} from '../scripts/manual-confirmation.mjs';
import {parseArgs} from '../scripts/cli-options.mjs';
function fakePage(){const page=new EventEmitter();page.url=()=> 'https://example.test/';return page;}
test('manual confirmation waits for Enter and writes prompts only to its diagnostic stream',async()=>{
 const input=new PassThrough(),output=new PassThrough();input.isTTY=true;let prompt='';output.on('data',d=>prompt+=d);
 const opts=withManualConfirmation({manual:true},{input,output});let confirmed=false;const wait=opts.confirmReady(fakePage()).then(()=>confirmed=true);
 await new Promise(r=>setImmediate(r));assert.equal(confirmed,false);assert.match(prompt,/Press Enter/);
 input.write('\n');await wait;assert.equal(confirmed,true);
 assert.equal(parseArgs(['--url','https://example.test','--manual']).headed,true);
 assert.equal(parseArgs(['--url','https://example.test','--manual']).keepNoise,false);
 assert.equal(parseArgs(['--url','https://example.test','--keep-noise']).keepNoise,true);
 assert.throws(()=>parseArgs(['--url','https://example.test','--manual','--headless']),/conflict/);
});
test('manual mode fails explicitly on non-TTY input, EOF or closing browser',async()=>{
 assert.throws(()=>withManualConfirmation({manual:true},{input:new PassThrough()}),/interactive terminal/);
 for(const closeBrowser of [false,true]){
  const input=new PassThrough(),output=new PassThrough();input.isTTY=true;const page=fakePage();const opts=withManualConfirmation({manual:true},{input,output});
  const wait=opts.confirmReady(page);if(closeBrowser)page.emit('close');else input.end();await assert.rejects(wait,/closed|cancelled/);
 }
});
