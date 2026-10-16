#!/usr/bin/env node
// Synthetic reproduction of repeated inherited custom properties and inline-style IDs.
// Each invocation is a fresh process. maxRSS measures Node only, not Chromium.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {chromium} from 'playwright';
import {captureStructuredState} from '../interaction-snapshot.mjs';
const [collectorPath,outputPath,fixturePath]=process.argv.slice(2);
if(!collectorPath || !outputPath)throw new Error('Usage: node scripts/benchmark-css-evidence.mjs COLLECTOR.mjs METRICS.json [FIXTURE.html]');
const {createCssRuleCollector}=await import(pathToFileURL(path.resolve(collectorPath)).href);
const browser=await chromium.launch();let collector;
try {
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const vars=Array.from({length:223},(_,i)=>`--v${i}:${i}px`).join(';');
  const items=Array.from({length:370},(_,i)=>`<button class="item" id="item-${i}" style="margin:0">Item ${i}</button>`).join('');
  await page.setContent(fixturePath?await fs.readFile(fixturePath,'utf8'):`<style>:root{${vars}}.item{padding:var(--v1)}</style><main style="display:block">${items}</main>`);
  const started=performance.now();
  const maxNodes=fixturePath?1000:500;
  collector=await createCssRuleCollector(page,{maxNodes});
  const snapshotStart=performance.now(),state=await captureStructuredState(page),snapshotEnd=performance.now();
  await collector.fingerprint(state);const fingerprintEnd=performance.now();await collector.capture(state,'fixture');const matchingEnd=performance.now();
  const data=collector.export(),variables=data.variables;
  // Baseline intentionally uses the original serialization, in an isolated process.
  let variableBytes,totalBytes;
  if(data.schemaVersion===1){variableBytes=Buffer.byteLength(JSON.stringify(variables));totalBytes=Buffer.byteLength(JSON.stringify(data));}
  else {
    const {jsonChunks}=await import('../json-writer.mjs');
    const size=value=>{let bytes=0;for(const chunk of jsonChunks(value))bytes+=Buffer.byteLength(chunk);return bytes;};
    variableBytes=size(variables);totalBytes=size(data);
  }
  const serializationEnd=performance.now(),durationMs=Math.round(serializationEnd-started),nodePeakRssKiB=process.resourceUsage().maxRSS;
  const declarationCopies=Array.isArray(variables)?variables.reduce((sum,e)=>sum+e.declarations.length,0):0;
  const declaredPairs=Array.isArray(variables)?new Set(variables.flatMap(e=>e.declarations.map(d=>`${d.ruleId}|${d.name}`))).size:data.rules.reduce((sum,r)=>sum+(r.variableNames?.length || 0),0);
  const metrics={kind:'synthetic-css-reproduction',fixture:fixturePath?{file:fixturePath,viewport:{width:1440,height:900},maxCssNodes:maxNodes}:{elements:370,customProperties:223,viewport:{width:1440,height:900},maxCssNodes:maxNodes},node:process.version,browser:browser.version(),schemaVersion:data.schemaVersion,
    capturedNodes:data.snapshots[0].elements.length,stylesheetRecords:data.stylesheets.length,headerlessStylesheetRecords:data.stylesheets.filter(s=>!s.header).length,
    copiedVariableDeclarations:declarationCopies,uniqueRuleVariablePairs:declaredPairs,resolvedSets:variables.resolvedSets?.length ?? null,variableBytes,totalCssBytes:totalBytes,
    durationMs,timings:{structuredSnapshotMs:Math.round(snapshotEnd-snapshotStart),fingerprintMs:Math.round(fingerprintEnd-snapshotEnd),matchedStylesMs:Math.round(matchingEnd-fingerprintEnd),serializationMs:Math.round(serializationEnd-matchingEnd)},nodePeakRssKiB,memoryScope:'Node collector and serialization only; excludes Chromium and metric-analysis allocations',sizeScope:'Compact serialization of collector exports, not the complete capture directory or source-site measurements',samples:1};
  await fs.mkdir(path.dirname(path.resolve(outputPath)),{recursive:true});await fs.writeFile(outputPath,JSON.stringify(metrics,null,2));console.log(JSON.stringify(metrics));
}finally{await collector?.dispose();await browser.close();}
