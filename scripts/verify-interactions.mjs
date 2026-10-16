#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {PNG} from 'pngjs';
import pixelmatch from 'pixelmatch';
import {captureStructuredState} from '../interaction-snapshot.mjs';
import {createCssRuleCollector} from '../css-rule-capture.mjs';
import {discoverAllFrames,classifyActionSafety} from '../actionable-dom.mjs';
import {runPlaywrightAction,stabilize} from '../actionability.mjs';
import {protectExploration} from '../exploration-safety.mjs';

const routeOf=page=>{const url=new URL(page.url());return url.pathname+url.search+url.hash;};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export function compareScreenshots(source,target,{maxPixelRatio=0.01}={}) {
  const a=PNG.sync.read(source),b=PNG.sync.read(target);
  if(a.width!==b.width || a.height!==b.height)return {passed:false,reason:'screenshot-dimensions'};
  const diff=new PNG({width:a.width,height:a.height});
  const pixels=pixelmatch(a.data,b.data,diff.data,a.width,a.height,{threshold:0.1}),ratio=pixels/(a.width*a.height);
  return {passed:ratio<=maxPixelRatio,pixels,ratio,diff:PNG.sync.write(diff)};
}

async function mappedLocator(page,spec) {
  if(!spec)throw new Error('explicit source/target mapping required');
  let scope=page.mainFrame();
  if(spec.frame?.url) {
    const frames=page.frames().filter(f=>f.url()===spec.frame.url);
    if(frames.length!==1)throw new Error('frame missing or ambiguous');
    scope=frames[0];
  } else if(spec.frame?.index!==undefined)scope=page.frames()[spec.frame.index];
  if(!scope)throw new Error('frame missing');
  let locator;
  if(spec.selector)locator=scope.locator(spec.selector.replaceAll('>>>',' '));
  else if(spec.role && typeof spec.name==='string')locator=scope.getByRole(spec.role,{name:spec.name,exact:true});
  else if(spec.label)locator=scope.getByLabel(spec.label,{exact:true});
  else if(spec.testId)locator=scope.getByTestId(spec.testId);
  else throw new Error('mapping needs selector, role/name, label, or testId');
  const count=await locator.count();
  if(count!==1){const error=new Error(count?'locator ambiguous':'locator missing');error.code=count?'AMBIGUOUS':'MISSING';throw error;}
  return {scope,locator,frameIndex:page.frames().indexOf(scope)};
}

async function mappedControl(page,spec,allowSameOriginNavigation) {
  const mapped=await mappedLocator(page,spec);
  const found=await discoverAllFrames(page,{allowSameOriginNavigation,pageOrigin:page.url()});
  const candidates=found.controls.filter(c=>c.frameIndex===mapped.frameIndex);
  const selectors=await mapped.locator.evaluate((element,selectors)=>selectors.filter(selector=>{
    let root=document,el=null;
    try {for(const part of selector.split('>>>').map(s=>s.trim())){el=root?.querySelector(part);root=el?.shadowRoot;}return el===element;}catch{return false;}
  }),candidates.map(c=>c.selector));
  const controls=candidates.filter(c=>selectors.includes(c.selector));
  if(controls.length!==1)throw new Error('mapped element is not a uniquely discovered control');
  const control=controls[0],safety=classifyActionSafety(control,{allowSameOriginNavigation,pageOrigin:page.url()});
  if(safety.classification!=='allowed-safe')throw new Error('unsafe or unknown action: '+safety.reason);
  return control;
}

function hasCheck(assertion) {
  return assertion.exists===true || assertion.visible===true || assertion.text===true || assertion.bbox===true || assertion.attributes?.length || assertion.properties?.length || assertion.styles?.length || assertion.cssRules?.length;
}
async function observe(page,spec,assertion,{before=false}={}) {
  let mapped;
  try{mapped=await mappedLocator(page,spec);}catch(error){if(error.code==='MISSING' && (before || assertion.exists))return {exists:false,visible:assertion.visible?false:undefined};throw error;}
  const {locator,frameIndex}=mapped;
  const properties=assertion.properties || [];
  if(properties.some(p=>!['value','checked','selected','selectedIndex','open','disabled'].includes(p)))throw new Error('unsupported observed property');
  const facts=await locator.evaluate((el,{attributes,properties,styles,text})=>({
    attributes:Object.fromEntries(attributes.map(name=>[name,el.getAttribute(name)])),
    properties:Object.fromEntries(properties.map(name=>[name,el[name] ?? null])),
    styles:Object.fromEntries(styles.map(name=>[name,getComputedStyle(el).getPropertyValue(name)])),
    text:text ? el.textContent.replace(/\s+/g,' ').trim():null
  }),{attributes:assertion.attributes || [],properties,styles:assertion.styles || [],text:Boolean(assertion.text)});
  if(assertion.exists)facts.exists=true;
  if(assertion.visible)facts.visible=await locator.isVisible();
  if(assertion.bbox)facts.bbox=await locator.boundingBox();
  if(assertion.cssRules?.length) {
    const snapshot=await captureStructuredState(page);
    const elementId=await locator.evaluate(el=>globalThis[Symbol.for('web-replica-kit.identities')]?.nodes.get(el));
    facts.elementId=elementId;facts.frameIndex=frameIndex;
    facts.domSnapshot=snapshot;
  }
  return facts;
}

export function compareMappedFacts(source,target,assertion,{tolerance=8}={}) {
  const differences=[];
  for(const field of ['exists','attributes','properties','styles','text','visible'])if(!same(source[field],target[field]))differences.push({field,source:source[field],target:target[field]});
  if(assertion.bbox) {
    const a=source.bbox,b=target.bbox;
    if(!a || !b) {if(!same(a,b))differences.push({field:'bbox',source:a,target:b});}
    else for(const edge of ['left','top','right','bottom']) {
      const value=(box,key)=>key==='left'?box.x:key==='top'?box.y:key==='right'?box.x+box.width:box.y+box.height;
      const delta=Math.abs(value(a,edge)-value(b,edge));
      if(delta>tolerance)differences.push({field:'bbox.'+edge,source:value(a,edge),target:value(b,edge),delta});
    }
  }
  return {passed:differences.length===0,differences};
}

function ruleDeclarations(rule,properties) {
  return (rule.declarations || []).filter(p=>!p.disabled && !p.implicit && (!properties?.length || properties.includes(p.name))).map(p=>({name:p.name,value:p.value,important:Boolean(p.important)}));
}
async function checkRules(assertion,facts,collectors,index) {
  if(!assertion.cssRules?.length)return [];
  const data=[];
  for(const [side,collector] of collectors.entries()) {
    const fact=facts[side];
    if(!fact.domSnapshot){data.push({entry:null,rules:new Map()});continue;}
    const snapshot={...fact.domSnapshot,nodes:fact.domSnapshot.nodes.filter(n=>n.elementId===fact.elementId)};
    await collector.fingerprint(snapshot);
    const captured=await collector.capture(snapshot,`verify-${index}`),evidence=collector.export();
    const entry=evidence.snapshots.find(s=>s.id===captured.cssSnapshotId)?.elements.find(e=>e.elementId===fact.elementId);
    data.push({entry,rules:new Map(evidence.rules.map(r=>[r.id,r]))});
  }
  return assertion.cssRules.map(spec=>{
    const matches=data.map((d,i)=>(d.entry?.matchedRules || []).map(m=>d.rules.get(m.ruleId)).filter(rule=>rule && rule.selector===(i?spec.targetSelector:spec.sourceSelector) && (!(i?spec.targetUrl:spec.sourceUrl) || rule.source.url===(i?spec.targetUrl:spec.sourceUrl))));
    if(matches.some(m=>m.length!==1))return {passed:false,status:'unresolved',spec,reason:'matched rule absent or ambiguous; specify selector and optional URL'};
    const declarations=matches.map(m=>ruleDeclarations(m[0],spec.properties));
    if(declarations.some(d=>!d.length))return {passed:false,status:'unresolved',spec,reason:'requested declarations unavailable'};
    return {passed:same(...declarations),status:same(...declarations)?'preserved-declarations':'different-declarations',spec,source:{ruleId:matches[0][0].id,source:matches[0][0].source,declarations:declarations[0]},target:{ruleId:matches[1][0].id,source:matches[1][0].source,declarations:declarations[1]}};
  });
}
const publicFacts=({domSnapshot,elementId,frameIndex,...facts})=>facts;

// source and target have independent mappings; DOM equality is never assumed.
export async function verifyBrowserSequence({source,target,steps,outDir,allowSameOriginNavigation=false,tolerance=8}) {
  if(outDir)await fs.mkdir(outDir,{recursive:true});
  if(!Array.isArray(steps) || !steps.length)throw new Error('nonempty steps required');
  const guards=await Promise.all([protectExploration(source),protectExploration(target)]);
  const collectors=[];
  const results=[];
  let chainValid=true;
  try {
    collectors.push(...await Promise.all([createCssRuleCollector(source),createCssRuleCollector(target)]));
    for(const [index,step] of steps.entries()) {
      const base={index,id:step.id || `step-${index}`,controlId:step.controlId || JSON.stringify({source:step.source,target:step.target}),source:step.source,target:step.target,action:step.action};
      if(!chainValid){results.push({...base,status:'skipped',reason:'prior step did not pass; state unknown'});continue;}
      let actionStarted=false;
      try {
        if(!step.source || !step.target || !step.action)throw new Error('explicit action mappings required');
        if(!step.assertions?.length || step.assertions.some(a=>!a.source || !a.target || !hasCheck(a)))throw new Error('explicit state mappings and nonempty checks required');
        const [a,b]=await Promise.all([mappedControl(source,step.source,allowSameOriginNavigation),mappedControl(target,step.target,allowSameOriginNavigation)]);
        const beforeRoute=routeOf(source);
        const before=await Promise.all(step.assertions.map(assertion=>observe(source,assertion.source,assertion,{before:true})));
        for(const guard of guards)guard.blocked.length=0;
        actionStarted=true;
        const outcomes=await Promise.allSettled([runPlaywrightAction(source,a,step.action),runPlaywrightAction(target,b,step.action)]);
        await Promise.all(guards.map(g=>g.checkBlockedSockets()));
        const failure=outcomes.find(o=>o.status==='rejected' || !o.value.ok);
        if(failure || guards.some(g=>g.blocked.length))throw new Error(guards.some(g=>g.blocked.length)?'network operation blocked before transmission':failure.reason?.message || failure.value?.reason || 'action failed');
        await Promise.all([stabilize(source),stabilize(target)]);
        const assertions=[];
        let sourceChanged=beforeRoute!==routeOf(source);
        for(const [assertionIndex,assertion] of step.assertions.entries()) {
          const facts=await Promise.all([observe(source,assertion.source,assertion),observe(target,assertion.target,assertion)]);
          sourceChanged ||= !same(publicFacts(before[assertionIndex]),publicFacts(facts[0]));
          const compared=compareMappedFacts(...facts,assertion,{tolerance:assertion.tolerance ?? tolerance});
          const cssRules=await checkRules(assertion,facts,collectors,`${index}-${assertionIndex}`);
          assertions.push({id:assertion.id || `assertion-${assertionIndex}`,source:publicFacts(facts[0]),target:publicFacts(facts[1]),...compared,passed:compared.passed && cssRules.every(r=>r.passed),cssRules,styleEvidence:assertion.styles?.length?'computed-equivalence-observed':assertion.cssRules?.length?'matched-declarations-checked':'unresolved'});
        }
        const route={source:routeOf(source),target:routeOf(target)};
        route.passed=step.route ? route.source===step.route.source && route.target===step.route.target : route.source===route.target;
        let visual=null,artifacts=null;
        if(outDir || step.visual) {
          const images=await Promise.all([source.screenshot({animations:'disabled'}),target.screenshot({animations:'disabled'})]);
          let diff;
          if(step.visual)({diff,...visual}=compareScreenshots(...images,step.visual));
          if(outDir) {
            artifacts={source:`${index}-source.png`,target:`${index}-target.png`};
            await Promise.all(images.map((bytes,i)=>fs.writeFile(path.join(outDir,i?artifacts.target:artifacts.source),bytes)));
            if(diff){artifacts.diff=`${index}-diff.png`;await fs.writeFile(path.join(outDir,artifacts.diff),diff);}
          }
        }
        const passed=assertions.every(a=>a.passed) && route.passed && (!visual || visual.passed);
        results.push({...base,status:passed?'passed':'failed',sourceChanged,verified:passed && sourceChanged,assertions,route,visual,artifacts,reason:passed?null:'required state, layout, CSS, route, or visual assertion differs'});
        if(!passed)chainValid=false;
      } catch(error) {
        results.push({...base,status:actionStarted?'failed':'skipped',verified:false,reason:String(error.message || error)});chainValid=false;
      }
    }
  } finally {await Promise.all([...guards.map(g=>g.dispose()),...collectors.map(c=>c.dispose())]);}
  const verifiedIds=[...new Set(results.filter(r=>r.verified).map(r=>r.controlId))];
  const report={schemaVersion:1,purpose:'source-vs-implemented-frontend',results,total:results.length,passed:results.filter(r=>r.status==='passed').length,failed:results.filter(r=>r.status==='failed').length,skipped:results.filter(r=>r.status==='skipped').length,verified:verifiedIds.length,verifiedSteps:results.filter(r=>r.verified).length,verifiedIds,passedAll:results.every(r=>r.status==='passed')};
  if(outDir)await fs.writeFile(path.join(outDir,'interaction-verification.json'),JSON.stringify(report,null,2));
  return report;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [sourceUrl,targetUrl,scenarioPath,outDir='verification']=process.argv.slice(2);
  if(!sourceUrl || !targetUrl || !scenarioPath)throw new Error('Usage: node scripts/verify-interactions.mjs SOURCE_URL TARGET_URL SCENARIO.json [OUT_DIR]');
  const scenario=JSON.parse(await fs.readFile(scenarioPath,'utf8'));
  const browser=await chromium.launch({headless:true});
  try {
    // Separate contexts prevent source cookies/storage from contaminating the implementation.
    const contexts=await Promise.all([browser.newContext({viewport:scenario.viewport || {width:1440,height:900},serviceWorkers:'block'}),browser.newContext({viewport:scenario.viewport || {width:1440,height:900},serviceWorkers:'block'})]);
    const [source,target]=await Promise.all(contexts.map(c=>c.newPage()));
    const startup=await Promise.all([protectExploration(source,{origin:new URL(sourceUrl).origin}),protectExploration(target,{origin:new URL(targetUrl).origin})]);
    try {
      await Promise.all([source.goto(sourceUrl),target.goto(targetUrl)]);
      const report=await verifyBrowserSequence({source,target,steps:scenario.steps,outDir,allowSameOriginNavigation:Boolean(scenario.allowSameOriginNavigation),tolerance:scenario.tolerance ?? 8});
      console.log(JSON.stringify(report,null,2));if(!report.passedAll)process.exitCode=2;
    } finally {await Promise.all(startup.map(g=>g.dispose()));}
  } finally {await browser.close();}
}
