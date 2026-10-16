import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { stabilize } from '../actionability.mjs';
import { explorePage } from '../interaction-explorer.mjs';
import { injectOfflineRuntime } from '../offline-runtime.mjs';
import { collectOverlayDiagnostics } from '../overlay-diagnostics.mjs';
import { verifyBrowserSequence } from '../scripts/verify-interactions.mjs';
import { captureStructuredState } from '../interaction-snapshot.mjs';
import { compareInteractionSnapshots, semanticDiff, semanticHash } from '../state-diff.mjs';

const fixture=await fs.readFile(new URL('./fixtures/interaction-lab.html',import.meta.url),'utf8');
const out=path.resolve('test-results/interaction-lab');
async function serve(body,writes=[]) {
  const server=http.createServer((req,res)=>{if(req.method==='POST'){writes.push(req.url);res.writeHead(204);res.end();return;}res.setHeader('Content-Type','text/html; charset=utf-8');res.end(body());});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {server,url:`http://127.0.0.1:${server.address().port}/lab`};
}
const step=(selector,kind='click',key)=>({control:{selector},action:{kind,...(key?{key}:{})}});

test('native overlay layout, recursive states, component combinations, routes and write protection',async()=>{
  const writes=[],sourceServer=await serve(()=>fixture,writes);
  const browser=await chromium.launch({headless:true});
  let replicaServer;
  try {
    const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
    const source=await context.newPage();
    await source.goto(sourceServer.url);
    const baseline=await source.content();
    const exploration=await explorePage(source,{evidenceDir:out,budgets:{maxStates:32,maxDepth:3,maxActions:120},allowSameOriginNavigation:true,preserveSettledDocument:true});
    await fs.mkdir(out,{recursive:true});
    await Promise.all([
      fs.writeFile(path.join(out,'actions.json'),JSON.stringify(exploration.transitions,null,2)),
      fs.writeFile(path.join(out,'interaction-failures.json'),JSON.stringify(exploration.failures,null,2)),
      fs.writeFile(path.join(out,'overlay-diagnostics.json'),JSON.stringify(exploration.overlayDiagnostics,null,2)),
      fs.writeFile(path.join(out,'states','graph.json'),JSON.stringify({states:exploration.states,transitions:exploration.transitions.map(({from,to,control,action})=>({from,to,controlId:control.id,action}))},null,2))
    ]);
    assert.deepEqual(writes,[],'all production writes must be blocked BEFORE server receipt');
    assert.ok(exploration.failures.some(f=>/network operation blocked/.test(f.reason)), 'an innocently named write is intercepted');
    assert.ok(exploration.transitions.some(t=>t.control.selector==='#nested' && t.confidence==='observed'),'second-level exploration');
    assert.ok(exploration.transitions.some(t=>t.control.selector==='#dynamic' && t.confidence==='observed'),'newly inserted controls explored');
    assert.equal(exploration.failures.filter(f=>f.stage==='restore').length,0,JSON.stringify(exploration.failures.filter(f=>f.stage==='restore')));
    const offline=injectOfflineRuntime(baseline.replace(/<script>[\s\S]*?<\/script>/g,''),exploration.model);
    await fs.writeFile(path.join(out,'index.html'),offline);
    replicaServer=await serve(()=>offline);
    const replica=await context.newPage();
    const reports=[];
    for (const width of [390,768,1440]) {
      await Promise.all([source.setViewportSize({width,height:900}),replica.setViewportSize({width,height:900})]);
      await Promise.all([source.goto(sourceServer.url),replica.goto(replicaServer.url)]);
      await Promise.all([source.fill('#note','typed and preserved'),replica.fill('#note','typed and preserved')]);
      const steps=[step('#top'),step('#nested'),step('#dynamic'),step('#tab-b'),step('#switch'),step('#tab-a'),step('#tab-b'),step('#top','press','Escape'),step('#scroll-trigger'),step('#scroll-trigger','press','Escape'),step('#transform-trigger'),step('#transform-trigger','press','Escape'),step('#portal-trigger'),step('#portal-trigger','press','Escape'),step('#side'),step('#dialog-trigger'),step('#dialog-trigger','press','Escape'),step('#popover-trigger'),step('#popover-trigger'),step('#tooltip-trigger','hover'),step('#route')];
      const report=await verifyBrowserSequence({source,replica,steps,outDir:path.join(out,String(width)),allowSameOriginNavigation:true});
      reports.push(report);
      assert.equal(await replica.locator('#note').inputValue(),'typed and preserved');
      assert.equal(report.replicaVerified,true,JSON.stringify(report.results.filter(r=>!r.verified)));
      await Promise.all([source.goBack(),replica.goBack()]);
      await Promise.all([stabilize(source),stabilize(replica)]);
      assert.equal(compareInteractionSnapshots(await captureStructuredState(source),await captureStructuredState(replica)).verified,true,'Back restores local content and real URL');
      await Promise.all([source.goForward(),replica.goForward()]);
      await Promise.all([stabilize(source),stabilize(replica)]);
      assert.equal(compareInteractionSnapshots(await captureStructuredState(source),await captureStructuredState(replica)).verified,true,'Forward restores local content and real URL');
      // Native anchoring responds to scroll and resize without rewriting position or transform.
      await Promise.all([source.goto(sourceServer.url),replica.goto(replicaServer.url)]);
      await Promise.all([source.click('#scroll-trigger'),replica.click('#scroll-trigger')]);
      await Promise.all([source.evaluate(()=>document.getElementById('scroll').scrollTop=45),replica.evaluate(()=>document.getElementById('scroll').scrollTop=45)]);
      await Promise.all([source.evaluate(()=>scrollTo(0,35)),replica.evaluate(()=>scrollTo(0,35))]);
      const [a,b]=await Promise.all([captureStructuredState(source),captureStructuredState(replica)]);
      assert.equal(compareInteractionSnapshots(a,b).verified,true,'native CSS survives internal and page scroll');
      const diag=await collectOverlayDiagnostics(replica,'scroll');
      const menu=diag.frames[0].overlays.find(o=>o.selector==='#scroll-menu');
      assert.notEqual(menu.parent,'body');
      assert.ok(menu.offsetParent);
      assert.equal(menu.styles.position,'absolute');
      await Promise.all([source.setViewportSize({width:width+30,height:850}),replica.setViewportSize({width:width+30,height:850})]);
      assert.equal(compareInteractionSnapshots(await captureStructuredState(source),await captureStructuredState(replica)).verified,true,'resize alignment');
    }
    const verifiedIds=[...new Set(reports.flatMap(r=>r.verifiedIds))];
    await fs.writeFile(path.join(out,'interaction-verification.json'),JSON.stringify({viewports:reports.map((report,index)=>({width:[390,768,1440][index],...report})),verified:verifiedIds.length,verifiedIds,passed:reports.reduce((n,r)=>n+r.passed,0),failed:reports.reduce((n,r)=>n+r.failed,0),skipped:reports.reduce((n,r)=>n+r.skipped,0)},null,2));
    await fs.writeFile(path.join(out,'interaction-coverage.json'),JSON.stringify({...exploration.coverage,verified:verifiedIds.length,verifiedIds},null,2));
    // A matching DOM must never hide an actual route or coordinate mismatch.
    const a={route:'/lab',nodes:[{key:'popup',selector:'#popup',visible:true,bbox:{x:1300,y:50,width:100,height:80}}]};
    assert.equal(compareInteractionSnapshots(a,{...a,route:'/wrong'}).verified,false);
    assert.equal(compareInteractionSnapshots(a,{...a,nodes:[{...a.nodes[0],bbox:{x:0,y:700,width:100,height:80}}]}).verified,false);
    assert.notEqual(semanticHash(a),semanticHash({...a,nodes:[...a.nodes,{key:'other',visible:true,bbox:{x:20,y:30,width:10,height:10}}]}));
    assert.ok(semanticDiff({nodes:[]},{nodes:[{key:'new',selector:'div:nth-of-type(1)',visible:true}]}).changed);
  } finally {await browser.close();sourceServer.server.close();replicaServer?.server.close();}
});

test('measured script-positioned portals update on scroll/resize without clearing transforms',async()=>{
  const {compileOverlayPositioning}=await import('../overlay-positioning.mjs');
  const html=`<!doctype html><html><body style="margin:0;height:1800px"><button id="anchor" style="position:relative;margin-left:65vw;margin-top:140px">Anchor</button><div id="popup" role="menu" style="position:fixed;width:120px;height:70px;transform:translateX(3px);background:#abc">Popup</div><script>const a=document.getElementById('anchor'),p=document.getElementById('popup');function place(){const b=a.getBoundingClientRect();p.style.left=(b.right-123)+'px';p.style.top=(b.bottom+5)+'px'}addEventListener('scroll',place);addEventListener('resize',place);place();a.setAttribute('aria-controls','popup');</script></body></html>`;
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:800,height:600}});
    await page.setContent(html);
    const baseline=await page.content(),a=await collectOverlayDiagnostics(page,'initial');
    await page.setViewportSize({width:850,height:600});await page.waitForTimeout(80);
    const b=await collectOverlayDiagnostics(page,'resize');
    const policies=compileOverlayPositioning([a,b]);
    assert.equal(policies.length,1);
    const replica=await browser.newPage({viewport:{width:800,height:600}});
    await replica.setContent(injectOfflineRuntime(baseline.replace(/<script>[\s\S]*?<\/script>/g,''),{machines:[],overlays:policies}));
    for (const width of [850,390,1440]) {
      await replica.setViewportSize({width,height:600});
      await replica.evaluate(()=>scrollTo(0,70));await replica.waitForTimeout(100);
      const result=await replica.evaluate(()=>{const a=document.getElementById('anchor').getBoundingClientRect(),p=document.getElementById('popup').getBoundingClientRect();return {dx:p.right-a.right,dy:p.top-a.bottom,transform:getComputedStyle(document.getElementById('popup')).transform,parent:document.getElementById('popup').parentElement.localName}});
      assert.ok(Math.abs(result.dx)<=1,JSON.stringify(result));assert.ok(Math.abs(result.dy-5)<=1,JSON.stringify(result));assert.equal(result.parent,'body');assert.notEqual(result.transform,'none');
    }
  } finally {await browser.close();}
});

test('native check/uncheck, fill and select replay observed effects without losing typed values',async()=>{
  const html=`<!doctype html><html><body><input id="text" aria-label="Local text" aria-controls="echo" value="start"><span id="echo">start</span><select id="select" aria-label="Local choice" aria-controls="choice"><option value="a">A</option><option value="b">B</option></select><span id="choice">a</span><input id="check" type="checkbox" aria-label="Local check" aria-controls="checked"><span id="checked" hidden>Checked content</span><script>document.getElementById('text').oninput=e=>document.getElementById('echo').textContent=e.target.value;document.getElementById('select').onchange=e=>document.getElementById('choice').textContent=e.target.value;document.getElementById('check').onchange=e=>document.getElementById('checked').hidden=!e.target.checked;</script></body></html>`;
  const sourceServer=await serve(()=>html);let replicaServer;const browser=await chromium.launch();
  try {
    const context=await browser.newContext({serviceWorkers:'block'}),source=await context.newPage();await source.goto(sourceServer.url);
    const exploration=await explorePage(source,{budgets:{maxActions:18,maxDepth:2,maxStates:8}});
    assert.equal(exploration.restoreFailed,false,JSON.stringify(exploration.failures));
    const offline=injectOfflineRuntime(html.replace(/<script>[\s\S]*?<\/script>/g,''),exploration.model);
    replicaServer=await serve(()=>offline);const replica=await context.newPage();await replica.goto(replicaServer.url);await source.goto(sourceServer.url);
    const steps=[{control:{selector:'#text'},action:{kind:'fill',value:'replica test'}},{control:{selector:'#select'},action:{kind:'select',value:'b'}},step('#check','check'),step('#check','uncheck')];
    const report=await verifyBrowserSequence({source,replica,steps});
    assert.equal(report.replicaVerified,true,JSON.stringify(report.results.filter(r=>!r.verified)));
    assert.equal(await replica.locator('#text').inputValue(),'replica test');
  } finally {await browser.close();sourceServer.server.close();replicaServer?.server.close();}
});

test('capture CLI merges icon recordings into the local runtime and writes reviewable artifacts',async()=>{
  const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
  const output=path.join(out,'combined-capture');
  const html=`<!doctype html><html><body><div style="position:relative;transform:translate(10px,5px)"><button id="toggle" aria-expanded="false" aria-controls="panel"><svg width="12" height="12"><circle cx="6" cy="6" r="5"/></svg>More</button><div role="menu" id="panel" hidden style="position:absolute;top:100%;left:0">Menu</div></div><input id="note" value="original"><script>document.getElementById('toggle').onclick=e=>{const b=e.currentTarget,on=b.getAttribute('aria-expanded')!=='true';b.setAttribute('aria-expanded',String(on));document.getElementById('panel').hidden=!on;}</script></body></html>`;
  const sourceServer=await serve(()=>html);let replicaServer;const browser=await chromium.launch();
  try {
    await promisify(execFile)(process.execPath,['capture.mjs','--url',sourceServer.url,'--out',output,'--headless','--explore-interactions','--record-icon-interactions','--explore-max-actions','4','--explore-max-depth','1','--explore-max-states','3','--wait','0'],{cwd:path.resolve('.'),timeout:60000});
    const offline=await fs.readFile(path.join(output,'index.html'),'utf8');
    assert.match(offline,/wrk-offline-interactions/);assert.equal(offline.includes('wrk-recorded-states'),false);
    for(const file of ['actions.json','states/graph.json','overlay-diagnostics.json','interaction-coverage.json','interaction-failures.json','interaction-verification.json'])assert.ok((await fs.stat(path.join(output,file))).size>0,file);
    const pending=JSON.parse(await fs.readFile(path.join(output,'interaction-verification.json')));assert.equal(pending.status,'not-run');assert.equal(pending.verified,0);
    const {createPreviewServer}=await import('../serve.mjs');
    const preview=await createPreviewServer(output);await new Promise(resolve=>preview.listen(0,'127.0.0.1',resolve));
    replicaServer={server:preview,url:`http://127.0.0.1:${preview.address().port}/lab`};
    const replica=await browser.newPage();await replica.goto(replicaServer.url);await replica.fill('#note','keep typed value');await replica.click('#toggle');assert.equal(await replica.locator('#panel').isVisible(),true);await replica.click('#toggle');assert.equal(await replica.locator('#panel').isVisible(),false);assert.equal(await replica.locator('#note').inputValue(),'keep typed value');assert.equal(await replica.locator('#panel').evaluate(el=>el.parentElement.localName),'div');
  } finally {await browser.close();sourceServer.server.close();replicaServer?.server.close();}
});

test('network guard blocks popup first navigation, writes and websocket connections before transmission',async()=>{
  const {protectExploration}=await import('../exploration-safety.mjs');let externalHits=0;
  const external=await serve(()=>{externalHits++;return 'external';});
  const writes=[],sourceServer=await serve(()=>`<button id="open" onclick="fetch('/write',{method:'POST'}).catch(()=>{});window.open('${external.url}');new WebSocket('ws://'+location.host+'/socket')">Open local UI</button>`,writes);
  let upgrades=0;sourceServer.server.on('upgrade',(_request,socket)=>{upgrades++;socket.destroy();});
  const browser=await chromium.launch();
  try {
    const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();await page.goto(sourceServer.url);
    const guard=await protectExploration(page);await page.click('#open');await page.waitForTimeout(250);
    assert.deepEqual(writes,[]);assert.equal(externalHits,0);assert.equal(upgrades,0);
    assert.ok(guard.blocked.some(r=>r.method==='POST'));assert.ok(guard.blocked.some(r=>r.method==='WEBSOCKET'));assert.ok(guard.blocked.some(r=>r.method==='GET'));
    await guard.dispose();
  } finally {await browser.close();external.server.close();sourceServer.server.close();}
});

test('network guard also blocks sends on sockets opened before exploration',async()=>{
  const {protectExploration}=await import('../exploration-safety.mjs');const {createHash}=await import('node:crypto');
  const fixture=await serve(()=>'<body>Socket fixture</body>');let frames=0;
  fixture.server.on('upgrade',(request,socket)=>{
    const accept=createHash('sha1').update(request.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');socket.on('data',()=>{frames++;});socket.on('error',()=>{});
  });
  const browser=await chromium.launch();
  try {
    const page=await browser.newPage();await page.goto(fixture.url);
    await page.evaluate(()=>new Promise(resolve=>{window.fixtureSocket=new WebSocket('ws://'+location.host+'/socket');window.fixtureSocket.onopen=resolve;}));
    const guard=await protectExploration(page);
    assert.equal(await page.evaluate(()=>{try{fixtureSocket.send('mutating payload');return false;}catch{return true;}}),true);
    await guard.checkBlockedSockets();assert.equal(frames,0);assert.ok(guard.blocked.some(r=>r.method==='WEBSOCKET'));
    await guard.dispose();await page.evaluate(()=>fixtureSocket.close());
  } finally {await browser.close();fixture.server.closeAllConnections();fixture.server.close();}
});

test('duplicate IDs and names use unique container scopes and replay the clicked instance',async()=>{
  const html=`<!doctype html><html><body><section id="first"><button id="duplicate" aria-expanded="false" aria-controls="first-panel">More</button><div id="first-panel" hidden>First</div></section><section id="second"><button id="duplicate" aria-expanded="false" aria-controls="second-panel">More</button><div id="second-panel" hidden>Second</div></section><script>for(const b of document.querySelectorAll('button'))b.onclick=()=>{const on=b.getAttribute('aria-expanded')!=='true';b.setAttribute('aria-expanded',String(on));document.getElementById(b.getAttribute('aria-controls')).hidden=!on;}</script></body></html>`;
  const sourceServer=await serve(()=>html);let replicaServer;const browser=await chromium.launch();
  try {
    const source=await browser.newPage();await source.goto(sourceServer.url);
    const exploration=await explorePage(source,{budgets:{maxStates:4,maxDepth:1,maxActions:14}});
    const more=exploration.controls.filter(c=>c.accessibleName==='More');
    assert.equal(more.length,2);assert.notEqual(more[0].id,more[1].id);assert.ok(more.every(c=>c.selectorStable && !c.locatorAmbiguous));
    const offline=injectOfflineRuntime(html.replace(/<script>[\s\S]*?<\/script>/g,''),exploration.model);
    replicaServer=await serve(()=>offline);const replica=await browser.newPage();await replica.goto(replicaServer.url);await replica.locator('#second button').click();
    assert.equal(await replica.locator('#second-panel').isVisible(),true);assert.equal(await replica.locator('#first-panel').isVisible(),false);
  } finally {await browser.close();sourceServer.server.close();replicaServer?.server.close();}
});
