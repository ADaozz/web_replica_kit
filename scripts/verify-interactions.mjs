#!/usr/bin/env node
import { collectOverlayDiagnostics } from '../overlay-diagnostics.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { compareInteractionSnapshots } from '../state-diff.mjs';
import { captureStructuredState } from '../interaction-snapshot.mjs';
import { discoverAllFrames, classifyActionSafety } from '../actionable-dom.mjs';
import { runPlaywrightAction, stabilize } from '../actionability.mjs';
import { protectExploration } from '../exploration-safety.mjs';

export function verifyInteractionReport(source,replica) {
  const results = Array.from({length:Math.max(source.steps?.length || 0,replica.steps?.length || 0)},(_,index) => {
    const a = source.steps?.[index],b = replica.steps?.[index];
    if (!a || !b) return {index,verified:false,reason:'missing-step'};
    return {index,action:a.action || null,...compareInteractionSnapshots(a.snapshot,b.snapshot)};
  });
  const verified = results.filter(r=>r.verified).length;
  return {verified,total:results.length,denominator:results.length,replicaVerified:results.length>0 && verified===results.length,results};
}

export function compareScreenshots(source,replica,{maxPixelRatio=0.01}={}) {
  const a=PNG.sync.read(source),b=PNG.sync.read(replica);
  if (a.width!==b.width || a.height!==b.height) return {verified:false,reason:'screenshot-dimensions'};
  const diff=new PNG({width:a.width,height:a.height});
  const pixels=pixelmatch(a.data,b.data,diff.data,a.width,a.height,{threshold:0.1});
  const ratio=pixels/(a.width*a.height);
  return {verified:ratio<=maxPixelRatio,pixels,ratio,diff:PNG.sync.write(diff)};
}

// A scenario is an ordered sequence, never an independently reset list of clicks.
export async function verifyBrowserSequence({source,replica,steps,outDir,allowSameOriginNavigation=false,maxPixelRatio=0.01}) {
  if (outDir) await fs.mkdir(outDir,{recursive:true});
  const guards=await Promise.all([protectExploration(source),protectExploration(replica)]);
  const results=[];
  const initial=compareInteractionSnapshots(await captureStructuredState(source),await captureStructuredState(replica));
  let chainValid=true;
  try {
    for (const [index,step] of steps.entries()) {
      const base={index,controlId:step.controlId || step.control?.id || null,action:step.action};
      if (!chainValid) {results.push({...base,status:'skipped',verified:false,reason:'prior step failed; state unknown'});continue;}
      const found=await discoverAllFrames(source,{allowSameOriginNavigation,pageOrigin:source.url()});
      const spec=step.control || {};
      const candidates=found.controls.filter(c=>step.controlId ? c.id===step.controlId : spec.selector ? c.selector===spec.selector : c.role===spec.role && c.accessibleName===(spec.name || spec.accessibleName));
      if (candidates.length!==1) {results.push({...base,status:'skipped',verified:false,reason:candidates.length ? 'locatorAmbiguous':'locatorMissing'});chainValid=false;continue;}
      const control=candidates[0];
      base.controlId=control.id;
      const safety=classifyActionSafety(control,{allowSameOriginNavigation,pageOrigin:source.url()});
      if (safety.classification!=='allowed-safe') {results.push({...base,status:'skipped',verified:false,reason:safety.reason});chainValid=false;continue;}
      for (const g of guards) g.blocked.length=0;
      const targetFound=await discoverAllFrames(replica,{allowSameOriginNavigation,pageOrigin:replica.url()});
      const targets=targetFound.controls.filter(c=>c.selector===control.selector && JSON.stringify(c.framePath)===JSON.stringify(control.framePath));
      if (targets.length!==1) {results.push({...base,status:'failed',verified:false,reason:'replica locatorMissing or ambiguous'});chainValid=false;continue;}
      const outcomes=await Promise.allSettled([runPlaywrightAction(source,control,step.action),runPlaywrightAction(replica,targets[0],step.action)]);
      await Promise.all(guards.map(g=>g.checkBlockedSockets()));
      const failure=outcomes.find(r=>r.status==='rejected' || !r.value.ok);
      if (failure || guards.some(g=>g.blocked.length)) {
        results.push({...base,status:'failed',verified:false,reason:guards.some(g=>g.blocked.length) ? 'unsafe network operation blocked' : failure.reason?.message || failure.value?.reason});chainValid=false;continue;
      }
      await Promise.all([stabilize(source),stabilize(replica)]);
      const [a,b,sa,sb]=await Promise.all([captureStructuredState(source),captureStructuredState(replica),source.screenshot({animations:'disabled'}),replica.screenshot({animations:'disabled'})]);
      const compared=compareInteractionSnapshots(a,b);
      const {diff,...screenshot}=compareScreenshots(sa,sb,{maxPixelRatio});
      const verified=compared.verified && screenshot.verified;
      const overlayDiagnostics={source:await collectOverlayDiagnostics(source,{index,phase:'after'}),replica:await collectOverlayDiagnostics(replica,{index,phase:'after'})};
      const artifacts=outDir ? {source:`${index}-source.png`,replica:`${index}-replica.png`,diff:`${index}-diff.png`,snapshots:`${index}-snapshots.json`,overlays:`${index}-overlays.json`} : null;
      if (outDir) await Promise.all([fs.writeFile(path.join(outDir,artifacts.source),sa),fs.writeFile(path.join(outDir,artifacts.replica),sb),diff ? fs.writeFile(path.join(outDir,artifacts.diff),diff):null,fs.writeFile(path.join(outDir,artifacts.snapshots),JSON.stringify({source:a,replica:b},null,2)),fs.writeFile(path.join(outDir,artifacts.overlays),JSON.stringify(overlayDiagnostics,null,2))]);
      results.push({...base,...compared,verified,replicaVerified:verified,status:verified?'passed':'failed',screenshot,artifacts,failureStage:verified?null:initial.verified?'runtime':'DOM-reconstruction',reason:verified?null:!compared.verified?'DOM, route, or layout mismatch':'screenshot mismatch'});
      if (!verified) chainValid=false;
    }
  } finally {await Promise.all(guards.map(g=>g.dispose()));}
  const verifiedIds=[...new Set(results.filter(r=>r.verified).map(r=>r.controlId))];
  const report={initial,results,total:results.length,passed:results.filter(r=>r.verified).length,failed:results.filter(r=>r.status==='failed').length,skipped:results.filter(r=>r.status==='skipped').length,verified:verifiedIds.length,verifiedIds,replicaVerified:results.length>0 && results.every(r=>r.verified)};
  if (outDir) await fs.writeFile(path.join(outDir,'interaction-verification.json'),JSON.stringify(report,null,2));
  return report;
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const args=process.argv.slice(2);
  if (args[0]==='--browser') {
    const [sourceUrl,offlineUrl,scenarioPath,outDir='verification']=args.slice(1);
    const scenario=JSON.parse(await fs.readFile(scenarioPath,'utf8'));
    const browser=await chromium.launch({headless:true});
    try {
      const context=await browser.newContext({viewport:scenario.viewport || {width:1440,height:900},serviceWorkers:'block'});
      const source=await context.newPage(),replica=await context.newPage();
      // Guards also cover initial navigations and loading handlers.
      const startup=await Promise.all([protectExploration(source,{origin:new URL(sourceUrl).origin}),protectExploration(replica,{origin:new URL(offlineUrl).origin})]);
      await Promise.all([source.goto(sourceUrl),replica.goto(offlineUrl)]);
      const report=await verifyBrowserSequence({source,replica,steps:scenario.steps,outDir,allowSameOriginNavigation:Boolean(scenario.allowSameOriginNavigation),maxPixelRatio:scenario.maxPixelRatio ?? 0.01});
      await Promise.all(startup.map(g=>g.dispose()));
      if (scenario.coveragePath) {
        const coverage=JSON.parse(await fs.readFile(scenario.coveragePath,'utf8'));
        coverage.verified=report.verified;coverage.verifiedIds=report.verifiedIds;
        await fs.writeFile(scenario.coveragePath,JSON.stringify(coverage,null,2));
      }
      console.log(JSON.stringify(report,null,2)); if (!report.replicaVerified) process.exitCode=2;
    } finally {await browser.close();}
  } else {
    const report=verifyInteractionReport(JSON.parse(await fs.readFile(args[0],'utf8')),JSON.parse(await fs.readFile(args[1],'utf8')));
    console.log(JSON.stringify(report,null,2));if (!report.replicaVerified) process.exitCode=2;
  }
}
