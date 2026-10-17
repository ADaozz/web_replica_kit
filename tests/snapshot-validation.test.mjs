import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertSnapshotHtml} from '../snapshot-validation.mjs';
import {auditSnapshot} from '../scripts/audit-snapshot.mjs';
import {createPreviewServer} from '../serve.mjs';

test('rejects broken serialized output and preserves legitimate undefined UI text and legacy documents',()=>{
 for(const input of [undefined,'','undefined','<!DOCTYPE html>\nundefined','<html><head></head></html>'])assert.throws(()=>assertSnapshotHtml(input),/Invalid static preview/);
 for(const html of ['<!DOCTYPE html><html><head></head><body><code>undefined</code></body></html>','<html><head></head><body background="stars.gif"></body></html>'])assert.doesNotThrow(()=>assertSnapshotHtml(html));
});
test('audit and HTTP preview reject the historical undefined artifact instead of reporting success',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'replica-invalid-'));let server;
 try{
 await fs.writeFile(path.join(directory,'index.html'),'<!DOCTYPE html>\nundefined');await fs.writeFile(path.join(directory,'assets.json'),JSON.stringify({schemaVersion:3,resources:[]}));
 const audit=await auditSnapshot(directory);assert.equal(audit.validPreview,false);
 const cli=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/audit-snapshot.mjs',import.meta.url)),directory],{cwd:directory,encoding:'utf8'});assert.equal(cli.status,1);assert.equal(audit.issues[0].kind,'invalid-preview-document');
 server=await createPreviewServer(directory);await new Promise(r=>server.listen(0,'127.0.0.1',r));const response=await fetch(`http://127.0.0.1:${server.address().port}/`);assert.equal(response.status,500);assert.match(await response.text(),/capture again/);
 }finally{if(server?.listening)await new Promise(r=>server.close(r));await fs.rm(directory,{recursive:true,force:true});}
});
