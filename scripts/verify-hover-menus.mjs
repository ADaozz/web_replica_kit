// User-requested directed verification only. This never runs from capture or
// discover and never clicks, follows menu links, or recursively explores UI.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {captureDOM} from '../dom-snapshot.mjs';
const out=path.resolve(process.argv[2]||'test-results/hover-menus-'+Date.now());await fs.mkdir(out,{recursive:true});if((await fs.readdir(out)).length)throw new Error('Output directory must be empty');
const offlineAt=process.argv.indexOf('--offline'),offline=offlineAt>=0,captures=new Map();
if(offline){const files=process.argv.slice(offlineAt+1);if(!files.length)throw new Error('--offline requires saved summary.json paths');for(const file of files)for(const item of JSON.parse(await fs.readFile(file)).cases)if(item.capture?.output)captures.set(item.id,item.capture.output);}
const cases=[{id:'cursor',url:'https://cursor.com/',trigger:'[aria-label="Expand Menu"]'}, {id:'anthropic',url:'https://www.anthropic.com/',trigger:'[aria-controls^="w-dropdown-list-"]'}, {id:'vercel',url:'https://vercel.com/',trigger:'[aria-controls="nav-panel-products"]',panel:'nav-panel-products'}];
const report={mode:offline?'captured-static-preview':'live-website',date:new Date().toISOString(),notes:['One explicitly configured hover per target, authorized for testing hidden menus. No clicks, no links followed. Production collectors still never hover.','DOM element IDs are local to each snapshot; link counts and explicit panel IDs compare evidence without asserting identity across states.'],cases:[]};
const browser=await chromium.launch();
try{for(const c of cases){const result={...c};report.cases.push(result);const page=await browser.newPage({viewport:{width:1440,height:900}});try{
 if(offline)await page.route(/^https?:/,route=>route.abort());
 if(offline&&!captures.has(c.id))throw new Error('No saved capture for '+c.id);
 const response=await page.goto(offline?pathToFileURL(path.resolve(captures.get(c.id),'index.html')).href:c.url,{waitUntil:'domcontentloaded',timeout:45000});result.httpStatus=response?.status();if(result.httpStatus>=400)throw new Error(`HTTP ${result.httpStatus}`);await page.waitForTimeout(3000);
 const trigger=page.locator(c.trigger).filter({visible:true}).first();await trigger.waitFor({timeout:5000});
 const controlled=await trigger.getAttribute('aria-controls');result.panel=c.panel||controlled||null;
 const sample=async()=>{
  const dom=await captureDOM(page,{maxNodes:10000});const layouts=new Map(dom.layout.map(n=>[n.elementId,n]));const panel=result.panel?dom.elements.find(e=>e.attributes.id===result.panel):null;
  const rootId=panel?.elementId;const descendants=new Set(rootId?[rootId]:[]);if(rootId)for(const e of dom.elements)if(descendants.has(e.parentElementId))descendants.add(e.elementId);
  const links=dom.elements.filter(e=>e.tag==='a'&&e.attributes.href&&(!rootId||descendants.has(e.elementId)));
  return {totalElements:dom.elements.length,panelInDOM:!!panel,panelVisible:panel?layouts.get(panel.elementId)?.visible:null,linksInDOM:links.length,visibleLinks:links.filter(e=>layouts.get(e.elementId)?.visible).length,hiddenLinks:links.filter(e=>!layouts.get(e.elementId)?.visible).length};
 };
 result.before=await sample();result.urlBefore=page.url();await trigger.hover();await page.waitForTimeout(500);result.after=await sample();result.urlAfter=page.url();
 result.status='observed';result.hoverExpandedPanel=result.panel?result.before.panelVisible===false&&result.after.panelVisible===true:null;result.navigationOccurred=result.urlBefore!==result.urlAfter;result.interpretation=result.panel?(result.before.panelInDOM?'panel-present-before-hover':'panel-not-present-before-hover'):'no-explicit-panel-id; aggregate-link-counts-only';
 await page.screenshot({path:path.join(out,c.id+'-hover.png')});
 }catch(error){result.status='failed';result.error=String(error.message).split('\n')[0];}finally{await page.close();}await fs.writeFile(path.join(out,'summary.json'),JSON.stringify(report,null,2));console.error(c.id,result.status,result.interpretation||result.error);}}finally{await browser.close();}
console.log(JSON.stringify({output:out,cases:report.cases}));
