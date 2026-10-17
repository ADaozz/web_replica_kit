import {assessRenderedPage} from '../page-readiness.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import pixelmatch from 'pixelmatch';
import {PNG} from 'pngjs';
import {createPreviewServer} from '../serve.mjs';
// Evidence classification for the fixed integration matrix, not route inference.
export function classifyFailure(error,stage) {
  let message=error.stderr || error.message || String(error);
  try{message=JSON.parse(error.stdout).error || message;}catch{}
  message=String(message).split('\n')[0].slice(0,1000);
  let classification='requires-investigation';
  if(stage==='preview')classification='preview-failure';
  else if(/HTTP (?:401|403|407|429|451)\b/.test(message))classification='external-access-restriction';
  else if(/HTTP 5\d\d\b|ERR_(?:NAME_NOT_RESOLVED|CONNECTION|TIMED_OUT|CERT|SSL|TUNNEL|HTTP_RESPONSE_CODE_FAILURE|PROXY)/.test(message))classification='external-network-or-server-failure';
  else if(/page.goto: Timeout|page.goto: net::/.test(message))classification='external-navigation-failure';
  else if(error.killed || error.signal)classification='process-budget-exceeded';
  else if(/locator.waitFor: Timeout/.test(message))classification='readiness-timeout';
  return {classification,error:message};
}
export function verifyStructure({components,layout,computed,assets,report}) {
  for(const doc of [components,layout,computed,assets,report])if(doc.schemaVersion!==3)throw new Error('Unexpected output schema');
  const ids=new Set(components.elements.map(e=>e.elementId));
  if(ids.size!==components.elements.length)throw new Error('Duplicate component elementId');
  for(const el of components.elements)if(el.parentElementId&&!ids.has(el.parentElementId))throw new Error('Missing DOM parent');
  for(const doc of [layout,computed]) {
    const own=new Set(doc.elements.map(e=>e.elementId));
    if(own.size!==ids.size||doc.elements.length!==ids.size||[...own].some(id=>!ids.has(id)))throw new Error('Layout/computed element IDs do not match DOM');
  }
  for(const el of layout.elements)if(!Object.values(el.rect).every(Number.isFinite))throw new Error('Nonfinite layout geometry');
  if(report.dom.captured!==ids.size)throw new Error('Report DOM count does not match evidence');
  if(assets.resources.some(r=>r.type==='script'||/\.(?:m?js|cjs|map)$/i.test(r.localPath)))throw new Error('Unexpected JavaScript or source map artifact');
  return {elements:ids.size,parentLinksValid:true,geometryFinite:true,elementIdsAligned:true,noScriptAssets:true};
}

export async function verifyPreviews({browser,directory,viewport,sourceUrl,waitMs=3000,outputDirectory=directory}) {
 await fs.mkdir(outputDirectory,{recursive:true});
 const previewServer=await createPreviewServer(directory);await new Promise(r=>previewServer.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${previewServer.address().port}`;
   const previews=[];
   try {
    for(const [protocol,url] of [['file',pathToFileURL(path.join(directory,'index.html')).href],['http',origin+'/']]) {
     const page=await browser.newPage({viewport:viewport}),failed=[],errors=[];
     try {
      page.on('requestfailed',r=>failed.push({url:r.url(),reason:r.failure()?.errorText}));page.on('pageerror',e=>errors.push(e.message.split('\n')[0]));
      await page.route(/^https?:/,route=>protocol==='http'&&route.request().url().startsWith(origin+'/')?route.continue():route.abort());
      const response=await page.goto(url,{waitUntil:'load',timeout:30000});await page.evaluate(async()=>{let timer;try{await Promise.race([document.fonts.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Font readiness timed out')),30000);})]);}finally{clearTimeout(timer);}});await page.waitForTimeout(waitMs);
      const bytes=await page.screenshot({timeout:30000});await fs.writeFile(path.join(outputDirectory,`preview-${protocol}.png`),bytes);
      const a=PNG.sync.read(await fs.readFile(path.join(directory,'screenshot.png'))),b=PNG.sync.read(bytes);
      const pixelDiffRatio=pixelmatch(a.data,b.data,null,a.width,a.height,{threshold:0.1})/(a.width*a.height);
      const text=await page.locator('body').innerText(),title=await page.title();
      const visibleMedia=await page.locator('img,svg,canvas,video').evaluateAll(els=>els.filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;}).length);
      previews.push({protocol,httpStatus:response?.status(),title,bodyTextLength:text.trim().length,visibleMedia,pageAssessment:assessRenderedPage({title,url:sourceUrl,text,visibleMedia}),pixelDiffRatio,failedRequests:failed,pageErrors:errors});
     }finally{await page.close();}
    }
   }finally{await new Promise(r=>previewServer.close(r));}

 return previews;
}
