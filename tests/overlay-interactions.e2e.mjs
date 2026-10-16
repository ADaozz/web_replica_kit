import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright';
import {explorePage} from '../interaction-explorer.mjs';
import {collectOverlayDiagnostics} from '../overlay-diagnostics.mjs';
import {makeSnapshotHtml} from '../capture.mjs';

const fixture=await fs.readFile(new URL('./fixtures/interaction-lab.html',import.meta.url),'utf8');
async function serve(body,writes=[]) {
  const server=http.createServer((req,res)=>{if(req.method==='POST'){writes.push(req.url);res.writeHead(204);res.end();return;}res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(body(req,res));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {server,url:`http://127.0.0.1:${server.address().port}/lab`};
}

test('recursive source exploration preserves layout evidence and blocks writes',async()=>{
  const writes=[],server=await serve(()=>fixture,writes),browser=await chromium.launch();
  try {
    const page=await browser.newPage({viewport:{width:1440,height:900}});await page.goto(server.url);
    const states=[];
    const result=await explorePage(page,{maxObservations:512,budgets:{maxStates:24,maxDepth:2,maxActions:90},onState:state=>{states.push(state.id);return {collected:true};}});
    assert.deepEqual(writes,[]);
    assert.ok(result.failures.some(f=>/network operation blocked/.test(f.reason)),JSON.stringify(result.failures));
    assert.ok(result.transitions.some(t=>t.control.selector==='#nested' && t.confidence==='observed'));
    assert.ok(result.transitions.some(t=>t.control.selector==='#dynamic' && t.confidence==='observed'));
    assert.ok(result.transitions.some(t=>t.effects.some(e=>e.type==='attribute' && e.name==='aria-selected')));
    assert.equal(result.restoreFailed,false,JSON.stringify(result.failures));
    assert.equal(states.length,result.states.length);assert.ok(result.states.every(s=>s.evidence.collected));
    assert.equal('model' in result,false);
    const observed=new Map(result.observations.map(o=>[o.id,o]));
    assert.ok(result.transitions.every(t=>observed.has(t.beforeObservationId) && observed.has(t.afterObservationId)));
    for(const relation of result.relations.relations) {
      const actual=observed.get(relation.afterObservationId);
      for(const target of relation.targets) if(target.after)assert.ok(actual.snapshot.nodes.some(n=>n.elementId===target.after.elementId));
    }
    for(const width of [390,768,1440]) {
      await page.setViewportSize({width,height:900});await page.goto(server.url);await page.click('#transform-trigger');
      const diagnostics=await collectOverlayDiagnostics(page,{width});
      const popup=diagnostics.frames[0].overlays.find(o=>o.selector==='#transform-menu');
      assert.equal(popup.styles.position,'absolute');assert.ok(popup.positioningAncestor);assert.ok(popup.offsetParent);
      await page.locator('#transform-trigger').press('Escape');
    }
    const preview=await makeSnapshotHtml(page,{});assert.equal(preview.html.includes('wrk-offline-interactions'),false);
  } finally {await browser.close();server.server.close();}
});

test('capture exports static evidence without replay products',async()=>{
  const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
  const output=await fs.mkdtemp(path.join(os.tmpdir(),'replica-evidence-'));
  const css='#panel[data-state="closed"]{display:none}\n#panel[data-state="open"]{display:block;color:rgb(1,2,3)}';
  const html='<link rel="stylesheet" href="/rules.css"><link rel="stylesheet" href="/missing.css"><button id="toggle" aria-expanded="false" aria-controls="panel">More</button><div id="panel" data-state="closed">Menu</div><script>toggle.onclick=()=>{const open=toggle.getAttribute("aria-expanded")!=="true";toggle.setAttribute("aria-expanded",String(open));panel.dataset.state=open?"open":"closed";}</script>';
  const server=await serve((req,res)=>{if(req.url==='/missing.css'){res.statusCode=404;return '';}return req.url==='/rules.css'?css:html;});
  try {
    await promisify(execFile)(process.execPath,['capture.mjs','--url',server.url,'--out',output,'--headless','--explore-interactions','--explore-max-actions','4','--explore-max-depth','1','--wait','0'],{cwd:path.resolve('.'),timeout:60000});
    const preview=await fs.readFile(path.join(output,'index.html'),'utf8');
    assert.equal(preview.includes('wrk-offline-interactions'),false);assert.equal(preview.includes('replaceChildren'),false);
    for(const file of ['dom/tree.json','interactions/controls.json','interactions/states.json','interactions/transitions.json'])assert.ok((await fs.stat(path.join(output,file))).size>0);
    const read=async file=>JSON.parse(await fs.readFile(path.join(output,file),'utf8'));
    const states=await read('interactions/states.json'),matched=await read('css/matched-rules.json'),sheets=await read('css/stylesheets.json');
    assert.equal(matched.schemaVersion,2);assert.equal(sheets.schemaVersion,2);
    for(const reference of matched.snapshots){const snapshot=await read(reference.file);assert.equal(snapshot.id,reference.id);assert.ok(snapshot.elements.length);assert.equal('elements' in reference,false);}
    const variables=await read('css/variables.json');assert.equal(variables.schemaVersion,2);
    for(const state of variables.states){const data=await read(state.file);assert.equal(data.stateId,state.stateId);assert.ok(data.elements.every(e=>variables.resolvedSets.some(set=>set.id===e.resolvedSetId)));}
    for(const reference of sheets.cssomSnapshots){assert.equal((await read(reference.file)).documentId,reference.documentId);assert.equal('sheets' in reference,false);}
    assert.ok(states.length>1);assert.ok(states.every(state=>!('snapshot' in state) && state.domRef && state.cssRef));
    for(const state of states){assert.ok((await read(state.domRef)).nodes.length);assert.ok(matched.snapshots.some(s=>s.id===state.cssRef.snapshotId));}
    const elements=await read('dom/elements.json'),tree=await read('dom/tree.json');
    assert.ok(tree.nodes.every(node=>elements.some(e=>e.elementId===node.elementId)));
    assert.ok((await read('interactions/controls.json')).every(c=>c.elementRefs.length>0));
    assert.ok((await read('report.json')).missingResources.some(item=>item.url.endsWith('/missing.css') && item.reason));
    const raw=sheets.resourceFiles.find(file=>file.url.endsWith('/rules.css'));
    assert.equal(await fs.readFile(path.join(output,raw.originalPath),'utf8'),css);
    const relations=await read('relations/state-style.json');
    assert.ok(relations.relations.some(r=>r.targets.some(t=>t.status==='observed' && t.selectorDependencies.some(d=>d.attribute==='data-state'))));
    assert.ok(matched.rules.some(r=>r.selector==='#panel[data-state="open"]' && r.source.range));
    for(const file of ['interactions.js','state-000.html','interaction-states','styles.css'])await assert.rejects(fs.stat(path.join(output,file)),{code:'ENOENT'});
  } finally {server.server.close();await fs.rm(output,{recursive:true,force:true});}
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
