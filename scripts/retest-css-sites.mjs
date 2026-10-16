#!/usr/bin/env node
// Sequential real-site PR-01 retest. Captures/logs stay under ignored test-results.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
const [baseline,nodeExecutable,browserExecutable,output='test-results/fix-pr01',ids='S01,S05,S06,S09,S11',versions='after,baseline']=process.argv.slice(2);
if(!baseline || !nodeExecutable || !browserExecutable)throw new Error('Usage: retest-css-sites.mjs BASELINE_DIR NODE_EXEC BROWSER_EXEC OUTPUT_DIR [SITE_IDS] [VERSIONS=after,baseline]');
const selectedVersions=versions.split(',');
if(selectedVersions.some(v=>!['after','baseline'].includes(v)))throw new Error('VERSIONS must contain after and/or baseline');
const root=path.resolve('.'),out=path.resolve(output),sites=JSON.parse(await fs.readFile('fix-verification/sites.json','utf8')).filter(s=>ids.split(',').includes(s.id));
await fs.mkdir(out,{recursive:true});
const parse=async file=>{const stat=await fs.stat(file);if(stat.size>64*1024*1024)throw new Error('analysis-read-budget');return JSON.parse(await fs.readFile(file,'utf8'));};
async function bytes(directory){let size=0;for(const item of await fs.readdir(directory,{withFileTypes:true}).catch(()=>[])){const file=path.join(directory,item.name);size+=item.isDirectory()?await bytes(file):(await fs.stat(file)).size;}return size;}
const results=[];
for(const site of sites)for(const version of selectedVersions) {
  const cwd=version==='after'?root:path.resolve(baseline);
  const directory=path.join(out,site.id,version),capture=path.join(directory,'capture');await fs.mkdir(directory,{recursive:true});
  const args=['capture.mjs','--url',site.url,'--out',capture,'--width','1440','--height','900','--headless','--max-nodes','5000','--max-css-nodes','1000','--executable',browserExecutable];
  const log=await fs.open(path.join(directory,'capture.log'),'wx'),start=performance.now();
  const child=spawn(nodeExecutable,args,{cwd,detached:true,stdio:['ignore',log.fd,log.fd],env:process.env});
  let peak=0,samples=0,timedOut=false,sampling=false;
  const sample=async()=>{if(sampling)return;sampling=true;try{const status=await fs.readFile(`/proc/${child.pid}/status`,'utf8');const value=/VmHWM:\s+(\d+)/.exec(status);if(value){peak=Math.max(peak,Number(value[1]));samples++;}}catch{}finally{sampling=false;}};
  const poll=setInterval(sample,250);await sample();
  const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGTERM');}catch{}},900000);
  const hardStop=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},905000);
  const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}));});
  clearInterval(poll);clearTimeout(timer);clearTimeout(hardStop);await log.close();
  try{process.kill(-child.pid,'SIGTERM');}catch{}
  const text=await fs.readFile(path.join(directory,'capture.log'),'utf8');
  const result={siteId:site.id,url:site.url,version,command:{cwd,nodeExecutable,args},...exit,timedOut,durationMs:Math.round(performance.now()-start),sampledNodePeakRssKiB:peak || null,memorySamples:samples,memoryScope:'Node VmHWM sampled every 250ms; excludes Chromium; terminated-process samples are a lower bound.',captureDirectory:path.relative(root,capture),errorKind:/Invalid string length/.test(text)?'Invalid string length':/heap out of memory|Reached heap limit/i.test(text)?'V8 OOM':/net::ERR_/.test(text)?'browser-network-error':null};
  try {
    const report=await parse(path.join(capture,'report.json')),sheets=await parse(path.join(capture,'css/stylesheets.json'));
    const blocked=report.captureDiagnostics?.loadingScreenPossible || /just a moment|access denied|verify.*human|security checkpoint|forbidden/i.test(report.captureDiagnostics?.title || '');
    result.title=report.captureDiagnostics?.title;result.blocked=Boolean(blocked);result.schemaVersion=report.schemaVersion;result.capturedDomNodes=report.capturedNodes;
    result.css=report.css;result.stylesheetRecords=sheets.stylesheets.length;result.headerlessStylesheets=sheets.stylesheets.filter(s=>!s.header).length;
    result.resourceFailures=report.missingResources?.length || 0;result.reportErrors=report.errors;
    result.cssBytes=await bytes(path.join(capture,'css'));
    result.variableBytes=(await fs.stat(path.join(capture,'css/variables.json'))).size+await bytes(path.join(capture,'css/variables'));
    const matched=await parse(path.join(capture,'css/matched-rules.json'));
    let valid=0;
    for(const reference of matched.snapshots){const snapshot=reference.file?await parse(path.join(capture,reference.file)):reference;valid+=(snapshot.elements || []).filter(e=>!e.missing).length;}
    result.matchedElements=valid;
    result.cssCaptureCompleted=!blocked && [0,2].includes(exit.code) && !result.errorKind && valid>0;
    result.status=result.cssCaptureCompleted?'CAPTURED':blocked?'BLOCKED':'FAILED';
  }catch(error){result.status='FAILED';result.cssCaptureCompleted=false;result.analysisError=String(error.message);}
  if(timedOut){result.status='TIMED_OUT';result.cssCaptureCompleted=false;}
  await fs.writeFile(path.join(directory,'metrics.json'),JSON.stringify(result,null,2));results.push(result);
  await fs.writeFile(path.join(out,'results.json'),JSON.stringify({kind:'PR-01 real-site paired retest',results},null,2));
  console.log(JSON.stringify({siteId:result.siteId,version,status:result.status,exit:result.code,error:result.errorKind,durationMs:result.durationMs,matchedElements:result.matchedElements,cssBytes:result.cssBytes}));
}
