import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {verifyBrowserSequence} from '../scripts/verify-interactions.mjs';

function html(target,{shift=0,wrongStyle=false,staticPage=false,wrongRoute=false}={}) {
  const ids=target?['launch','items','second-tab','content','choice','memo','navigate','route-text']:['toggle','menu','tab-b','panel','switch','note','route','route-content'];
  const [toggle,menu,tab,panel,check,note,route,content]=ids;
  return `<!doctype html><html><head><style>
  body{margin:0;font:14px Arial}#anchor{position:relative;height:90px;width:400px;padding:10px;box-sizing:border-box}
  #${menu}[data-state="closed"]{display:none}#${menu}[data-state="open"]{display:block;position:absolute;left:${20+shift}px;top:40px;width:180px;height:40px;background:rgb(${wrongStyle?'255, 0, 0':'10, 20, 30'});color:white}
  </style></head><body><${target?'section':'header'} id="anchor"><button id="${toggle}" aria-expanded="false" aria-controls="${menu}">Menu</button><${target?'section':'div'} id="${menu}" data-state="closed">Items</${target?'section':'div'}></${target?'section':'header'}>
  <button id="${tab}" role="tab" aria-selected="false" aria-controls="${panel}">Second tab</button><section id="${panel}">First</section>
  <button id="${check}" role="switch" aria-checked="false" aria-controls="${check}-region">Choice</button><section id="${check}-region" hidden>Advanced</section><input type="text" id="${note}" aria-label="Note" aria-controls="${note}-preview" value="seed"><span id="${note}-preview">seed</span>
  <a id="${route}" href="${target?'/preferences':'/settings'}">Settings</a><div id="${content}">Home</div>
  ${staticPage?'':`<script>
  const trigger=document.getElementById('${toggle}'),menu=document.getElementById('${menu}');
  trigger.onclick=()=>{const on=trigger.getAttribute('aria-expanded')!=='true';trigger.setAttribute('aria-expanded',String(on));menu.dataset.state=on?'open':'closed';};
  document.getElementById('${tab}').onclick=e=>{e.currentTarget.setAttribute('aria-selected','true');document.getElementById('${panel}').textContent='Second';};
  document.getElementById('${check}').onclick=e=>{const on=e.currentTarget.getAttribute('aria-checked')!=='true';e.currentTarget.setAttribute('aria-checked',String(on));document.getElementById('${check}-region').hidden=!on;};
  document.getElementById('${note}').oninput=e=>document.getElementById('${note}-preview').textContent=e.currentTarget.value;
  document.getElementById('${route}').onclick=e=>{e.preventDefault();history.pushState({},'','${wrongRoute?'/incorrect':target?'/preferences':'/settings'}');document.getElementById('${content}').textContent='Settings';};
  </script>`}</body></html>`;
}
async function serve(body) {const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(body);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,url:`http://127.0.0.1:${server.address().port}/app`};}
const mapping=(a,b,checks)=>({source:{selector:a},target:{selector:b},...checks});
function scenario() {
  const assertions=[mapping('#toggle','#launch',{attributes:['aria-expanded']}),mapping('#menu','#items',{attributes:['data-state'],visible:true,bbox:true,styles:['display','background-color','position']}),mapping('#panel','#content',{text:true}),mapping('#switch','#choice',{attributes:['aria-checked']}),mapping('#switch-region','#choice-region',{visible:true}),mapping('#note','#memo',{properties:['value']}),mapping('#note-preview','#memo-preview',{text:true})];
  return [
    {id:'open',source:{selector:'#toggle'},target:{selector:'#launch'},action:{kind:'click'},assertions:assertions.map((a,index)=>index!==1?a:{...a,cssRules:[{sourceSelector:'#menu[data-state="open"]',targetSelector:'#items[data-state="open"]',properties:['display','position','top','width','height']}]})},
    {id:'tab',source:{selector:'#tab-b'},target:{selector:'#second-tab'},action:{kind:'click'},assertions},
    {id:'switch',source:{selector:'#switch'},target:{selector:'#choice'},action:{kind:'click'},assertions},
    {id:'input',source:{selector:'#note'},target:{selector:'#memo'},action:{kind:'fill',value:'kept across menu close'},assertions},
    {id:'close',source:{selector:'#toggle'},target:{selector:'#launch'},action:{kind:'click'},assertions},
    {id:'route',source:{selector:'#route'},target:{selector:'#navigate'},action:{kind:'click'},assertions:[mapping('#route-content','#route-text',{text:true})],route:{source:'/settings',target:'/preferences'}}
  ];
}

async function run(options={},mutateSteps=steps=>steps,outDir) {
  const servers=await Promise.all([serve(html(false)),serve(html(true,options))]);
  const browser=await chromium.launch();
  try {
    const contexts=await Promise.all([browser.newContext({viewport:{width:768,height:900},serviceWorkers:'block'}),browser.newContext({viewport:{width:768,height:900},serviceWorkers:'block'})]);
    const pages=await Promise.all(contexts.map(c=>c.newPage()));await Promise.all(pages.map((p,i)=>p.goto(servers[i].url)));
    return await verifyBrowserSequence({source:pages[0],target:pages[1],steps:mutateSteps(scenario()),allowSameOriginNavigation:true,outDir});
  } finally {await browser.close();servers.forEach(s=>s.server.close());}
}

test('explicit mappings verify independent DOMs, CSS, component combinations, input preservation and real route mappings',async()=>{
  const out=await fs.mkdtemp(path.join(os.tmpdir(),'frontend-verification-'));
  try {
    const result=await run({},undefined,out);
    assert.equal(result.passedAll,true,JSON.stringify(result.results));assert.equal(result.passed,6);assert.equal(result.verified,5);assert.equal(result.verifiedSteps,6);
    assert.equal(result.results[0].assertions[1].cssRules[0].status,'preserved-declarations');
    assert.equal(result.results.at(-1).route.source,'/settings');assert.equal(result.results.at(-1).route.target,'/preferences');
    assert.ok((await fs.stat(path.join(out,'interaction-verification.json'))).size);
  } finally {await fs.rm(out,{recursive:true,force:true});}
});

test('position, CSS, behavior and route errors fail without DOM normalization; later actions are skipped',async()=>{
  for(const options of [{shift:20},{wrongStyle:true},{staticPage:true},{wrongRoute:true}]) {
    const result=await run(options);
    assert.equal(result.passedAll,false,JSON.stringify(options));assert.ok(result.failed>0,JSON.stringify(result.results));
    if(!options.wrongRoute)assert.ok(result.skipped>0);
    if(options.shift)assert.ok(result.results[0].assertions[1].differences.some(d=>d.field==='bbox.left'));
    if(options.wrongRoute)assert.equal(result.results.at(-1).route.target,'/incorrect');
  }
});

test('missing or ambiguous mappings and empty checks never count as verified',async()=>{
  for(const change of [steps=>[{...steps[0],target:undefined}],steps=>[{...steps[0],target:{selector:'button'}}],steps=>[{...steps[0],assertions:[]}]]) {
    const result=await run({},change);assert.equal(result.skipped,1);assert.equal(result.verified,0);assert.equal(result.passedAll,false);
  }
});
