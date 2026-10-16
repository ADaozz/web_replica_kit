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
  const server=http.createServer((req,res)=>{if(req.method==='POST'){writes.push(req.url);res.writeHead(204);res.end();return;}res.setHeader('Content-Type','text/html; charset=utf-8');res.end(body());});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {server,url:`http://127.0.0.1:${server.address().port}/lab`};
}

test('recursive source exploration preserves layout evidence and blocks writes',async()=>{
  const writes=[],server=await serve(()=>fixture,writes),browser=await chromium.launch();
  try {
    const page=await browser.newPage({viewport:{width:1440,height:900}});await page.goto(server.url);
    const states=[];
    const result=await explorePage(page,{budgets:{maxStates:24,maxDepth:2,maxActions:90},onState:state=>{states.push(state.id);return {collected:true};}});
    assert.deepEqual(writes,[]);
    assert.ok(result.failures.some(f=>/network operation blocked/.test(f.reason)),JSON.stringify(result.failures));
    assert.ok(result.transitions.some(t=>t.control.selector==='#nested' && t.confidence==='observed'));
    assert.ok(result.transitions.some(t=>t.control.selector==='#dynamic' && t.confidence==='observed'));
    assert.ok(result.transitions.some(t=>t.effects.some(e=>e.type==='attribute' && e.name==='aria-selected')));
    assert.equal(result.restoreFailed,false,JSON.stringify(result.failures));
    assert.equal(states.length,result.states.length);assert.ok(result.states.every(s=>s.evidence.collected));
    assert.equal('model' in result,false);
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
  const html='<button id="toggle" aria-expanded="false" aria-controls="panel">More</button><div id="panel" hidden>Menu</div><script>toggle.onclick=()=>{const open=toggle.getAttribute("aria-expanded")!=="true";toggle.setAttribute("aria-expanded",String(open));panel.hidden=!open;}</script>';
  const server=await serve(()=>html);
  try {
    await promisify(execFile)(process.execPath,['capture.mjs','--url',server.url,'--out',output,'--headless','--explore-interactions','--explore-max-actions','4','--explore-max-depth','1','--wait','0'],{cwd:path.resolve('.'),timeout:60000});
    const preview=await fs.readFile(path.join(output,'index.html'),'utf8');
    assert.equal(preview.includes('wrk-offline-interactions'),false);assert.equal(preview.includes('replaceChildren'),false);
    for(const file of ['dom/tree.json','interactions/controls.json','interactions/states.json','interactions/transitions.json'])assert.ok((await fs.stat(path.join(output,file))).size>0);
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
