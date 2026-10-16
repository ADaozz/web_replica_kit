import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
import {createCssRuleCollector} from '../css-rule-capture.mjs';
import {captureStructuredState} from '../interaction-snapshot.mjs';
import {linkRuleStates} from '../rule-state-linker.mjs';
import {semanticDiff,semanticHash} from '../state-diff.mjs';
import {jsonChunks} from '../json-writer.mjs';

const external=`@layer base,theme;
@layer base { :root { --accent: rgb(20, 40, 60) } #menu { color:var(--accent) } }
@media (min-width:200px) { #menu { padding:7px } }
@supports (display:grid) { #container { display:grid } }
@container card (min-width:100px) { #menu { border:2px solid } }
#menu[data-state="closed"]{display:none}
#menu[data-state="open"]{display:block}
#toggle:hover{background:rgb(1,2,3)}#toggle:focus{outline:2px solid}#toggle:active{opacity:.5}`;
async function server(handler) {const instance=http.createServer(handler);await new Promise(resolve=>instance.listen(0,'127.0.0.1',resolve));return {instance,url:`http://127.0.0.1:${instance.address().port}`};}

test('CDP captures source boundaries, matched rules, CSSOM changes, conditions, variables, shadow and frames',async()=>{
  const foreign=await server((_req,res)=>{res.setHeader('Content-Type','text/css');res.end('#menu {font-weight:600}');});
  const source=await server((req,res)=>{
    if(req.url==='/base.css'){res.setHeader('Content-Type','text/css');res.end(external);return;}
    res.setHeader('Content-Type','text/html');
    if(req.url==='/frame'){res.end('<style>#framed {color:rgb(1, 99, 2)}</style><button id="framed">Frame</button>');return;}
    res.end(`<!doctype html><html><head><link rel="stylesheet" href="/base.css"><link rel="stylesheet" href="${foreign.url}/foreign.css"><style id="dynamic-style">#menu {min-height:20px}</style></head><body><div id="container" style="container-type:inline-size;container-name:card;width:400px"><button id="toggle" aria-expanded="false" aria-controls="menu">Models</button><div id="menu" data-state="closed">Menu</div></div><x-box id="host"></x-box><iframe src="/frame"></iframe><script>
      document.getElementById('dynamic-style').sheet.insertRule('#menu {letter-spacing:1px}',1);
      customElements.define('x-box',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open'}).innerHTML='<style>button{border-radius:5px}</style><button id="inside">Shadow</button>';const sheet=new CSSStyleSheet();sheet.replaceSync(':host{display:block}button{color:rgb(9, 8, 7)}');this.shadowRoot.adoptedStyleSheets=[sheet];}});
      toggle.onclick=()=>{const open=toggle.getAttribute('aria-expanded')!=='true';toggle.setAttribute('aria-expanded',String(open));menu.dataset.state=open?'open':'closed';};
    </script></body></html>`);
  });
  const browser=await chromium.launch();let collector;
  try {
    const page=await browser.newPage({viewport:{width:768,height:900}});await page.goto(source.url);
    collector=await createCssRuleCollector(page,{maxNodes:100});
    const before=await captureStructuredState(page);before.cssFingerprint=await collector.fingerprint(before);await collector.capture(before,'closed');
    const same=await captureStructuredState(page);same.cssFingerprint=await collector.fingerprint(same);assert.equal(semanticHash(before),semanticHash(same),'CDP inspection must not invent a state');
    await page.click('#toggle');
    const after=await captureStructuredState(page);after.cssFingerprint=await collector.fingerprint(after);await collector.capture(after,'open');
    const result=collector.export();
    const linked=linkRuleStates({states:[{id:'closed',snapshot:before,evidence:{cssSnapshotId:'css:closed'}},{id:'open',snapshot:after,evidence:{cssSnapshotId:'css:open'}}],transitions:[{from:'closed',to:'open',control:{id:'toggle',selector:'#toggle'},action:{kind:'click'},effects:semanticDiff(before,after).effects}],css:result});
    const target=linked.relations[0].targets.find(t=>t.after?.elementId===after.nodes.find(n=>n.selector==='#menu').elementId);
    assert.equal(target.status,'observed');assert.equal(target.physicalIdentity,true);
    assert.ok(target.selectorDependencies.some(d=>d.attribute==='data-state'));
    assert.ok(target.matchedRules.added.some(r=>result.rules.find(rule=>rule.id===r.ruleId)?.selector==='#menu[data-state="open"]'));
    assert.ok(target.matchedRules.removed.some(r=>r.source.url===source.url+'/base.css' && r.source.range));
    const author=result.stylesheets.find(s=>s.header?.sourceURL.endsWith('/base.css'));
    assert.ok(author);assert.ok(author.versions[0].text.includes('@layer base,theme'));
    const node=after.nodes.find(n=>n.selector==='#menu');
    const closed=result.snapshots[0].elements.find(n=>n.selector==='#menu'),opened=result.snapshots[1].elements.find(n=>n.selector==='#menu');
    const selectors=entry=>entry.matchedRules.map(m=>result.rules.find(r=>r.id===m.ruleId).selector);
    assert.ok(selectors(closed).includes('#menu[data-state="closed"]'));
    assert.ok(selectors(opened).includes('#menu[data-state="open"]'));
    const rule=result.rules.find(r=>r.selector==='#menu[data-state="open"]');
    assert.ok(rule.source.range);assert.equal(rule.source.url,source.url+'/base.css');assert.ok(rule.source.versionId);
    assert.ok(result.rules.some(r=>r.selector==='#menu' && r.protocol.media?.length));
    const cssom=result.cssomSnapshots[0];
    const sheet=cssom.sheets.find(s=>s.href===source.url+'/base.css');
    const kinds=sheet.rules.map(r=>r.kind);
    for(const kind of ['CSSLayerStatementRule','CSSLayerBlockRule','CSSMediaRule','CSSSupportsRule','CSSContainerRule']) assert.ok(kinds.includes(kind),kind);
    assert.ok(sheet.rules.some(r=>r.selector==='#toggle:hover'));assert.ok(sheet.rules.some(r=>r.selector==='#toggle:focus'));assert.ok(sheet.rules.some(r=>r.selector==='#toggle:active'));
    assert.ok(cssom.sheets.some(s=>s.rules.some(r=>r.cssText.includes('letter-spacing'))));
    assert.ok(cssom.scopes.some(s=>s.kind==='open-shadow' && s.adoptedStyleSheets.length===1 && s.styleSheets.length===1));
    const shadow=result.snapshots[1].elements.find(n=>n.selector==='#host >>> #inside');assert.ok(shadow?.matchedRules.length);assert.equal(shadow.computedStyle.color,'rgb(9, 8, 7)');
    assert.ok(result.snapshots[1].elements.some(n=>n.frameIndex===1 && n.selector==='#framed' && !n.missing),'in-process iframe CDP mapping');
    const variable=result.variables.elements.find(v=>v.elementId===node.elementId && v.stateId==='open');
    assert.ok(variable.sourceRuleIds.some(id=>result.rules.find(r=>r.id===id).variableReferences.some(r=>r.name==='--accent')));
    assert.equal(result.variables.resolvedSets.find(set=>set.id===variable.resolvedSetId).values['--accent'],'rgb(20, 40, 60)');
    assert.ok(result.missing.some(m=>m.kind==='cssom-rules-inaccessible'),'cross-origin CSSOM restriction is explicit');
    assert.ok(result.stylesheets.some(s=>s.header?.sourceURL===foreign.url+'/foreign.css' && s.versions[0]?.text.includes('font-weight')),'CDP supplements cross-origin CSSOM gaps');
    assert.deepEqual(cssom.scopes[0].styleSheets.slice(0,2),cssom.sheets.filter(s=>s.href).slice(0,2).map(s=>s.id));
    await page.evaluate(()=>document.getElementById('dynamic-style').sheet.insertRule('#menu {word-spacing:2px}',2));
    const changed=await captureStructuredState(page);changed.cssFingerprint=await collector.fingerprint(changed);assert.notEqual(changed.cssFingerprint,after.cssFingerprint);
    await page.goto(source.url);const reloaded=await captureStructuredState(page);reloaded.cssFingerprint=await collector.fingerprint(reloaded);assert.equal(reloaded.cssFingerprint,before.cssFingerprint,'new browser instance IDs must not prevent semantic restoration');
  } finally {await collector?.dispose();await browser.close();source.instance.close();foreign.instance.close();}
});

test('CSS budgets and absent CDP sessions produce explicit missing evidence',async()=>{
  const browser=await chromium.launch();
  try {
    const page=await browser.newPage();await page.setContent('<style>html{color:red}html{font-weight:bold}button{color:red}button:hover{color:blue}</style><button id="a">A</button><button id="b">B</button>');
    const collector=await createCssRuleCollector(page,{maxNodes:1,maxRules:1});
    const snapshot=await captureStructuredState(page);await collector.fingerprint(snapshot);await collector.capture(snapshot,'limited');
    const result=collector.export();assert.ok(result.snapshots[0].missing.some(m=>m.reason==='matched-node-budget'));assert.ok(result.missing.some(m=>m.kind==='cssom-rule-budget'));assert.ok(result.snapshots[0].missing.some(m=>m.reason==='matched-rule-budget'));await collector.dispose();
    const unavailable=await createCssRuleCollector({context(){throw new Error('CDP not available');},frames:()=>[]});
    assert.ok(unavailable.export().missing.some(m=>m.kind==='cdp-unavailable'));await unavailable.dispose();
  }finally {await browser.close();}
});


test('inherited variables share resolved sets and inline/presentation styles never create fake stylesheets',async()=>{
  const browser=await chromium.launch();let collector;
  try {
    const page=await browser.newPage();
    await page.setContent('<style>:root{--accent:rgb(1, 2, 3)!important}.item{color:var(--accent)}</style><main id="parent" style="--local:7px"><button class="item" id="a" style="padding:var(--local)">A</button><button class="item" id="b" style="">B</button><svg><path id="path" fill="red"/></svg></main>');
    await page.evaluate(()=>{const host=document.createElement('x-variable');host.id='variable-host';document.body.append(host);host.attachShadow({mode:'open'}).innerHTML='<style>:host{--local:7px;--accent:rgb(1, 2, 3)}button{color:var(--accent)}</style><button id="inside">Shadow</button>';});
    collector=await createCssRuleCollector(page);const snapshot=await captureStructuredState(page);
    await collector.fingerprint(snapshot);await collector.capture(snapshot,'first');await collector.fingerprint(snapshot);await collector.capture(snapshot,'second');
    const data=collector.export(),byId=new Map(data.rules.map(r=>[r.id,r]));
    assert.equal(data.schemaVersion,2);assert.equal(data.stylesheets.length,2);assert.ok(data.stylesheets.every(s=>s.header));
    assert.equal(data.missing.some(m=>m.kind==='stylesheet-header-unavailable'),false);
    const a=snapshot.nodes.find(n=>n.selector==='#a'),b=snapshot.nodes.find(n=>n.selector==='#b');
    const entries=data.variables.elements.filter(e=>e.elementId===a.elementId || e.elementId===b.elementId);
    assert.ok(entries.every(e=>e.resolvedSetId===entries[0].resolvedSetId));
    assert.equal(data.variables.resolvedSets.find(set=>set.id===entries[0].resolvedSetId).values['--local'],'7px');
    assert.ok(entries.every(e=>!('declarations' in e) && !('computed' in e) && !('references' in e)));
    for(const entry of entries)assert.ok(entry.sourceRuleIds.every(id=>byId.has(id)));
    assert.ok(entries[0].sourceRuleIds.some(id=>byId.get(id).declarations.some(p=>p.name==='--accent' && p.important===true)));
    const matches=data.snapshots[0].elements.find(e=>e.elementId===a.elementId);
    assert.equal(matches.resolvedVariableSetId,entries[0].resolvedSetId);assert.equal('--accent' in matches.computedStyle,false);
    assert.equal(byId.get(matches.inlineRuleId).source.elementId,a.elementId);
    assert.equal(byId.get(matches.inlineRuleId).source.stylesheetId,null);
    assert.equal(data.snapshots[0].elements.find(e=>e.elementId===b.elementId).inlineRuleId,null);
    const inherited=matches.inherited.find(e=>e.inlineRuleId);
    assert.equal(byId.get(inherited.inlineRuleId).source.elementId,snapshot.nodes.find(n=>n.selector==='#parent').elementId);
    const shadow=snapshot.nodes.find(n=>n.selector==='#variable-host >>> #inside');
    const shadowVars=data.variables.elements.find(e=>e.elementId===shadow.elementId);
    assert.equal(shadowVars.resolvedSetId,entries[0].resolvedSetId);assert.notEqual(shadowVars.scopeId,entries[0].scopeId);
    assert.notDeepEqual(shadowVars.sourceRuleIds,entries[0].sourceRuleIds);
    assert.ok(data.rules.every(r=>!('style' in r.protocol)));
    assert.ok(data.rules.some(r=>r.source.kind==='attributes' && r.source.elementId===snapshot.nodes.find(n=>n.selector==='#path').elementId));
  }finally{await collector?.dispose();await browser.close();}
});

test('supplied ISSUE-001 and ISSUE-008 fixtures retain sources without per-element declaration copies',async()=>{
  const browser=await chromium.launch();
  const bytes=value=>{let size=0;for(const chunk of jsonChunks(value))size+=Buffer.byteLength(chunk);return size;};
  try {
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    for(const name of ['ISSUE-001/page-50.html','ISSUE-001/page-200.html','ISSUE-001/page-800.html','ISSUE-008/page.html']) {
      await page.setContent(await fs.readFile(new URL(`./fixtures/css-repros/${name}`,import.meta.url),'utf8'));
      const collector=await createCssRuleCollector(page,{maxNodes:1000});
      try {
        const snapshot=await captureStructuredState(page);await collector.fingerprint(snapshot);await collector.capture(snapshot,'fixture');
        const evidence=collector.export();
        assert.equal(evidence.stylesheets.length,1,name);
        assert.ok(evidence.stylesheets.every(s=>s.header),name);
        assert.ok(!evidence.missing.some(m=>m.kind==='stylesheet-header-unavailable'),name);
        if(name.startsWith('ISSUE-001')) {
          const declared=evidence.rules.flatMap(rule=>rule.variableNames.map(name=>`${rule.id}|${name}`));
          assert.equal(new Set(declared).size,201,name);
          assert.equal(declared.length,201,name);
          assert.equal(evidence.variables.resolvedSets.length,2,name);
          assert.ok(evidence.variables.elements.every(e=>!('declarations' in e)),name);
          const rules=new Map(evidence.rules.map(r=>[r.id,r]));
          const paragraph=snapshot.nodes.find(n=>n.tagName==='p');
          const resolved=evidence.variables.elements.find(e=>e.elementId===paragraph?.elementId);
          assert.ok(resolved,name);
          assert.ok(resolved.sourceRuleIds.some(id=>rules.get(id).variableNames.includes('--local')),name);
          assert.equal(evidence.variables.resolvedSets.find(s=>s.id===resolved.resolvedSetId).values['--v199'],'199px',name);
          // Only references grow with the element count; declaration/value bodies are shared.
          const shared=bytes(evidence.variables.resolvedSets);
          assert.ok(bytes(evidence.variables)<shared+evidence.variables.elements.length*500,name);
        }
      }finally{await collector.dispose();}
    }
  }finally{await browser.close();}
});
