import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {jsonChunks,writeJsonFile} from '../json-writer.mjs';

test('bounded JSON output preserves Unicode, escaping, omissions, arrays and source text',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'json-evidence-'));
  try {
    const data={text:'😀\n\t"\\\u0000\ud800'.repeat(20000),keep:'/* source comment */ data:image/svg+xml;base64,AAAA',missing:undefined,items:[NaN,Infinity,-0,undefined,,new Date('2026-01-01T00:00:00Z')]};
    const expected=JSON.stringify(data),chunks=[...jsonChunks(data,{stringChunkSize:127})];
    assert.equal(chunks.join(''),expected);assert.ok(chunks.every(chunk=>chunk.length<=127*6+12));
    const file=path.join(directory,'nested','evidence.json'),written=await writeJsonFile(file,data,{batchBytes:4096,stringChunkSize:127});
    assert.equal(await fs.readFile(file,'utf8'),expected);assert.equal(written.bytes,Buffer.byteLength(expected));assert.equal(written.batches,Math.ceil(written.bytes/4096));
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('serialization failure preserves existing evidence and removes partial output',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'json-failure-')),file=path.join(directory,'evidence.json');
  try {
    await fs.writeFile(file,'{"original":true}');
    const circular={first:'x'.repeat(10000)};circular.self=circular;
    await assert.rejects(writeJsonFile(file,circular,{batchBytes:32}),/circular/);
    await assert.rejects(writeJsonFile(file,{value:1n}),/BigInt/);
    assert.equal(await fs.readFile(file,'utf8'),'{"original":true}');assert.deepEqual(await fs.readdir(directory),['evidence.json']);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('large aggregate evidence exceeds the V8 string limit without building an aggregate string',async()=>{
  const {constants}=await import('node:buffer');
  const value='x'.repeat(1024*1024),rows=Array(Math.floor(constants.MAX_STRING_LENGTH/value.length)+1).fill({value});
  let length=0,maxChunk=0;
  for(const chunk of jsonChunks(rows)){length+=chunk.length;maxChunk=Math.max(maxChunk,chunk.length);}
  assert.ok(length>constants.MAX_STRING_LENGTH);assert.ok(maxChunk<=8192);
});
