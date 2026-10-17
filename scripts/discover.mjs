#!/usr/bin/env node
import {reserveOutput} from './output-directory.mjs';
import {chromium} from 'playwright';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {writeJsonFile} from '../json-writer.mjs';
import {parseArgs} from './cli-options.mjs';

export function classify(raw,base) {
  try {
    const url=new URL(raw,base), current=new URL(base);
    if(!['http:','https:'].includes(url.protocol))return {url:['javascript:','data:','vbscript:'].includes(url.protocol)?url.protocol:url.href,kind:'unsupported'};
    const hash=url.hash || (url.href.endsWith('#')?'#':'');url.hash='';current.hash='';
    return {url:url.href+hash,kind:url.href===current.href?(hash?'anchor':'current'):url.origin===current.origin?'internal':'external'};
  } catch {return {url:raw,kind:'unsupported'};}
}
export function groupNavigation(links,base) {
  const groups=new Map();
  for(const link of links) {
    const target=classify(link.href,base);
    const key=target.url;
    if(!groups.has(key))groups.set(key,{id:`page-${String(groups.size+1).padStart(3,'0')}`,label:link.label || target.url,...target,sources:[]});
    groups.get(key).sources.push({...link,href:/^(?:javascript|data|vbscript):/i.test(link.href)?target.url:link.href,sameOrigin:target.kind!=='external'&&target.kind!=='unsupported',anchor:target.kind==='anchor'});
  }
  return [...groups.values()];
}
export function scanNavigation() {
  const links=[];
  function walk(root,prefix='') {
    for(const el of root.children || []) {
      const selector=prefix+el.localName+`:nth-of-type(${[...el.parentNode.children].filter(n=>n.localName===el.localName).indexOf(el)+1})`;
      const raw=el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? el.getAttribute('data-href') ?? el.getAttribute('data-url');
      if(raw!==null && (['a','area'].includes(el.localName)||el.matches('[role=link],[role=menuitem],[data-href],[data-url],nav *,header *,aside *,footer *'))) {
        const rect=el.getBoundingClientRect(),style=getComputedStyle(el);
        let container=el,region='other';
        while(container){const nearest=container.closest('header,nav,aside,main,footer');if(nearest){region=nearest.localName;break;}container=container.getRootNode()?.host;}
        links.push({label:(el.innerText || el.textContent || '').trim().replace(/\s+/g,' ').slice(0,500)||el.getAttribute('aria-label')||el.getAttribute('title')||el.querySelector('img')?.alt||'',href:raw,region,selector,visible:!!(rect.width&&rect.height)&&style.visibility!=='hidden'&&style.display!=='none',baseUrl:el.baseURI});
      }
      if(el.shadowRoot)walk(el.shadowRoot,selector+' >>> ');
      walk(el,selector+' > ');
    }
  }
  walk(document);
  return links;
}
export async function discover(opts) {
  const release=await reserveOutput(opts.out);
  let browser;
  try {
  browser=await chromium.launch({headless:!opts.headed,executablePath:opts.executablePath});
    const page=await browser.newPage({viewport:{width:opts.width,height:opts.height},serviceWorkers:'block'});
    const response=await page.goto(opts.url,{waitUntil:'domcontentloaded',timeout:45000});
    if(response?.status()>=400)throw new Error(`HTTP ${response.status()}`);
    if(opts.readySelector)await page.locator(opts.readySelector).filter({visible:true}).first().waitFor({timeout:opts.readyTimeout});
    await page.waitForTimeout(opts.wait);
    const links=await page.evaluate(scanNavigation);
    // Resolve against each entry's actual base URI, including <base href>.
    const resolved=groupNavigation(links.map(link=>({...link,href:classify(link.href,link.baseUrl).url})),page.url());
    for(const entry of resolved)for(const source of entry.sources){const raw=links.find(l=>l.selector===source.selector)?.href;source.href=raw && !/^(?:javascript|data|vbscript):/i.test(raw)?raw:source.href;}
    const data={schemaVersion:3,sourceUrl:opts.url,finalUrl:page.url(),entries:resolved,limitations:['Only explicit URLs in the rendered DOM and open Shadow DOM are included. JS-only routes, closed Shadow DOM and iframe navigation are not inferred. Executable or encoded unsupported URL bodies are omitted. No discovered destination was visited.']};
    await writeJsonFile(path.join(opts.out,'navigation.json'),data);
    return {status:'ok',url:page.url(),output:opts.out,files:{navigation:'navigation.json'},warnings:[]};
  }finally{await browser?.close();await release();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try{console.log(JSON.stringify(await discover(parseArgs(process.argv.slice(2)))));}
  catch(error){console.error(error.message);console.log(JSON.stringify({status:'failed',error:error.message}));process.exitCode=1;}
}
