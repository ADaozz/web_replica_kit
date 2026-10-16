import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {chromium} from 'playwright';
import {createCssRuleCollector} from '../css-rule-capture.mjs';
import {captureStructuredState} from '../interaction-snapshot.mjs';
import {linkRuleStates} from '../rule-state-linker.mjs';
import {semanticDiff,semanticHash} from '../state-diff.mjs';

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
    assert.ok(result.variables.some(v=>v.elementId===node.elementId && v.references.some(r=>r.name==='--accent')));
    assert.ok(result.missing.some(m=>m.kind==='cssom-rules-inaccessible'),'cross-origin CSSOM restriction is explicit');
    assert.ok(result.stylesheets.some(s=>s.header?.sourceURL===foreign.url+'/foreign.css' && s.versions[0]?.text.includes('font-weight')),'CDP supplements cross-origin CSSOM gaps');
    assert.deepEqual(cssom.scopes[0].styleSheets.slice(0,2),cssom.sheets.filter(s=>s.href).slice(0,2).map(s=>s.id));
    await page.evaluate(()=>document.getElementById('dynamic-style').sheet.insertRule('#menu {word-spacing:2px}',2));
    const changed=await captureStructuredState(page);changed.cssFingerprint=await collector.fingerprint(changed);assert.notEqual(changed.cssFingerprint,after.cssFingerprint);
  } finally {await collector?.dispose();await browser.close();source.instance.close();foreign.instance.close();}
});

test('CSS budgets and absent CDP sessions produce explicit missing evidence',async()=>{
  const browser=await chromium.launch();
  try {
    const page=await browser.newPage();await page.setContent('<style>button{color:red}button:hover{color:blue}</style><button id="a">A</button><button id="b">B</button>');
    const collector=await createCssRuleCollector(page,{maxNodes:1,maxRules:1});
    const snapshot=await captureStructuredState(page);await collector.fingerprint(snapshot);await collector.capture(snapshot,'limited');
    const result=collector.export();assert.ok(result.snapshots[0].missing.some(m=>m.reason==='matched-node-budget'));assert.ok(result.missing.some(m=>m.kind==='cssom-rule-budget'));await collector.dispose();
    const unavailable=await createCssRuleCollector({context(){throw new Error('CDP not available');},frames:()=>[]});
    assert.ok(unavailable.export().missing.some(m=>m.kind==='cdp-unavailable'));await unavailable.dispose();
  }finally {await browser.close();}
});
