import {assertSnapshotHtml} from './snapshot-validation.mjs';
import {waitForConfirmation} from './scripts/manual-confirmation.mjs';
import {cleanPage} from './page-cleanup.mjs';
import {staticSheetText} from './css-static-text.mjs';
import {auditSnapshot} from './scripts/audit-snapshot.mjs';
import {reserveOutput} from './scripts/output-directory.mjs';
import {writeJsonFile} from './json-writer.mjs';
import {captureDOM} from './dom-snapshot.mjs';
import {captureStylesheets} from './css-rule-capture.mjs';
import {chromium,request as apiRequest} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {discoverIcons,completeIcons,inlineSpriteSymbols} from './icon-capture.mjs';
import {injectSnapshotScrollRuntime} from './snapshot-scroll.mjs';
import {finalizeSnapshotResources,rewriteSnapshotAssets,rewriteSrcsetUrls} from './snapshot-resources.mjs';
const MB=1024*1024, MAX_PER_FILE=12*MB, MAX_TOTAL=120*MB;
const mimeExt = new Map([
  ['text/css', '.css'],
  ['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/gif', '.gif'],
  ['image/webp', '.webp'], ['image/avif', '.avif'], ['image/svg+xml', '.svg'],
  ['image/x-icon', '.ico'], ['image/vnd.microsoft.icon', '.ico'],
  ['font/woff', '.woff'], ['font/woff2', '.woff2'],
  ['font/ttf', '.ttf'], ['font/otf', '.otf'],
  ['application/font-woff', '.woff'],
  ['video/mp4', '.mp4'], ['audio/mpeg', '.mp3']
]);
const knownExt = new Set([...mimeExt.values()]);
function fileExt(url, contentType, resourceType) {
  const mime = (contentType || '').split(';')[0].trim().toLowerCase();
  if (resourceType === 'stylesheet') return '.css';
  const mimeMatch = mimeExt.get(mime);
  if (mimeMatch) return mimeMatch;
  let pathname = '';
  try { pathname = new URL(url).pathname; } catch {}
  const ext = path.posix.extname(pathname).toLowerCase();
  return knownExt.has(ext) ? ext : '.bin';
}
function shouldStore(resourceType, contentType) {
  if (resourceType === 'script' || /(?:javascript|ecmascript|text\/html|json)/i.test(contentType || '')) return false;
  const t = (contentType || '').toLowerCase();
  return ['image', 'font', 'stylesheet', 'media'].includes(resourceType) ||
    /^(?:image\/|font\/|text\/css|application\/(?:font|x-font))/.test(t);
}
function isHttpUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
}

export function rewriteCss(css, baseUrl, assetMap, outputCssDir = '') {
  function resolve(raw) {
    const value = raw.trim();
    if (!value || /^(?:data:|#|about:|javascript:)/i.test(value)) return value;
    try {
      const absolute = new URL(value, baseUrl).href;
      const parsed = new URL(absolute);
      const fragment = parsed.hash;
      parsed.hash = '';
      const local = assetMap[parsed.href];
      if (!local) return absolute; // 未保存的资源保留原地址，便于检查缺失原因。
      if (!outputCssDir) return local + fragment;
      const relative = path.posix.relative(outputCssDir, local);
      return (relative.startsWith('.') ? relative : './' + relative) + fragment;
    } catch { return value; }
  }
  return css
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_full, _q, raw) => {
      const ref = resolve(raw);
      return `url("${ref.replace(/"/g, '%22')}")`;
    })
    .replace(/(@import\s+)(['"])([^'"\n]+)\2/gi, (_full, prefix, quote, raw) =>
      `${prefix}${quote}${resolve(raw)}${quote}`);
}

async function waitForPending(pending) {
  // 写入响应正文时仍可能有新请求完成，因此分几轮等待保存队列。
  for (let i = 0; i < 5; i++) {
    if (!pending.size) return;
    await Promise.allSettled([...pending]);
  }
}

export async function makeSnapshotHtml(page, assetMap, stylesheetSources = {}, {storeCanvas} = {}) {
  // Preserve the rendered DOM and native CSS; only scroll initialization is authorized.
  const render = ({ mappings,stylesheetSources,maxCanvasFileBytes,maxCanvasTotalBytes }) => {
    const localMap = mappings;
    const base = document.baseURI;
    function mapURL(raw) {
      const val = (raw || '').trim();
      if (!val || /^(?:data:|#|about:|javascript:)/i.test(val)) return val;
      try {
        const absolute = new URL(val, base).href;
        const parsed = new URL(absolute);
        const fragment = parsed.hash;
        parsed.hash = '';
        return localMap[parsed.href] ? localMap[parsed.href] + fragment : absolute;
      } catch { return val; }
    }
    function rewriteCSS(cssText) {
      return cssText.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_all, _q, value) =>
        `url("${mapURL(value).replace(/"/g, '%22')}")`)
        .replace(/(@import\s+)(['"])([^'"\n]+)\2/gi, (_all, prefix, quote, value) =>
          `${prefix}${quote}${mapURL(value)}${quote}`);
    }
    function rewriteSrcset(srcset) {return rewriteSrcsetUrls(srcset,mapURL);}
    function appendAdoptedStyles(source, target) {
      for (const sheet of source.adoptedStyleSheets || []) {
        try {
          const style = document.createElement('style');
          style.textContent = [...sheet.cssRules].map(r => r.cssText).join('\n');
          target.append(style);
        } catch {}
      }
    }
    const scrollStates = [];
    const definedElements = [];
    const canvasFrames = [];
    let canvasBytes=0;
    function cloneRendered(source) {
      if(source.nodeType===Node.COMMENT_NODE || (source.nodeType===Node.ELEMENT_NODE && ['script','noscript'].includes(source.localName)))return document.createTextNode('');
      if(source.localName==='link' && source.relList.contains('stylesheet') && source.sheet) {
        try {
          const style=document.createElement('style');
          const base=source.sheet.href || source.baseURI;
          style.textContent=staticSheetText(source.sheet,stylesheetSources[source.sheet.href]).replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi,(_all,_q,raw)=>{
            if(/^(?:data:|#)/i.test(raw))return `url("${raw}")`;
            return `url("${new URL(raw,base).href}")`;
          }).replace(/(@import\s+)(['"])([^'"\n]+)\2/gi,(_all,p,q,raw)=>p+q+new URL(raw,base).href+q);
          if(source.media)style.media=source.media;
          if(source.sheet.disabled)style.media='not all';
          return style;
        }catch{}
      }
      if(source.localName==='meta' && /token|secret|csrf|authorization|api[_-]?key/i.test(source.getAttribute('name') || ''))return document.createTextNode('');
      const target = source.cloneNode(false);
      if (source.nodeType !== Node.ELEMENT_NODE) return target;
      if(source.localName==='canvas' && source.isConnected) {
        const frame={target,width:source.width,height:source.height};
        try {
          if(!source.width || !source.height)throw new Error('Canvas has zero intrinsic dimensions');
          if(source.width*source.height>16777216)throw new Error('Canvas exceeds 16 megapixel export budget');
          frame.data=source.toDataURL('image/png');
          if(!frame.data.startsWith('data:image/png;base64,'))throw new Error('Canvas PNG export unavailable');
          const bytes=Math.ceil((frame.data.length-22)*3/4);
          if(bytes>maxCanvasFileBytes || canvasBytes+bytes>maxCanvasTotalBytes)throw new Error('Canvas exceeds capture size budget');
          canvasBytes+=bytes;
          const style=getComputedStyle(source);
          frame.background=Object.fromEntries(['image','size','position','repeat','origin','clip','attachment','blend-mode'].map(name=>[name,style.getPropertyValue('background-'+name)]));
        }catch(error){delete frame.data;frame.error=String(error.message);}
        canvasFrames.push(frame);
      }
      if(source.localName==='input') {
        const sensitive=source.matches('input[type=password],input[type=file],input[type=hidden]') || /token|secret|password|csrf|api[_-]?key|session|credential|authorization/i.test(`${source.id} ${source.name}`);
        if(sensitive)target.removeAttribute('value');else target.setAttribute('value',source.value);
        target.toggleAttribute('checked',source.checked);
      }
      if(source.localName==='option')target.toggleAttribute('selected',source.selected);
      if (source.localName.includes('-') && source.matches(':defined')) definedElements.push(target);
      // Scroll offsets are live DOM properties, absent from cloneNode/outerHTML.
      // Zero matters too: CSS scroll snapping may otherwise select a different state.
      if (source === document.scrollingElement || source.scrollLeft || source.scrollTop ||
          source.scrollWidth > source.clientWidth || source.scrollHeight > source.clientHeight) {
        scrollStates.push({ target, left: source.scrollLeft, top: source.scrollTop });
      }
      if(source.localName==='textarea'){target.textContent=/token|secret|password|csrf|api[_-]?key|session|credential|authorization/i.test(`${source.id} ${source.name}`)?'':source.value;return target;}
      // 动态 insertRule() 添加的规则不在文本内容中，需要读取样式表。
      if (source.localName === 'style' && source.sheet) {
        if(source.sheet.disabled)target.setAttribute('media','not all');
        try { target.textContent = staticSheetText(source.sheet,source.textContent); return target; } catch {}
      }
      if (source.localName === 'template') {
        for(const child of source.content.childNodes)target.content.append(cloneRendered(child));
      } else {
        for (const child of source.childNodes) target.append(cloneRendered(child));
      }
      if (source.shadowRoot) {
        const template = document.createElement('template');
        template.setAttribute('shadowrootmode', 'open');
        if (source.shadowRoot.delegatesFocus) template.setAttribute('shadowrootdelegatesfocus', '');
        for (const child of source.shadowRoot.childNodes) template.content.append(cloneRendered(child));
        appendAdoptedStyles(source.shadowRoot, template.content);
        target.prepend(template);
      }
      return target;
    }
    const clone = cloneRendered(document.documentElement);
    appendAdoptedStyles(document, clone.querySelector('head') || clone);
    function elements(root) {
      const list = [...root.querySelectorAll('*')];
      if (root.nodeType === Node.ELEMENT_NODE) list.unshift(root);
      return list.flatMap(el => el.localName === 'template' ? [el, ...elements(el.content)] : [el]);
    }
    const all = elements(clone);
    all.filter(el => ['script', 'base'].includes(el.localName)).forEach(x => x.remove());
    all.filter(el => el.localName === 'meta' && el.hasAttribute('http-equiv')).forEach(x => {
      const value = (x.getAttribute('http-equiv') || '').toLowerCase();
      if (value === 'refresh' || value === 'content-security-policy' || value === 'content-type') x.remove();
    });
    all.filter(el => el.localName === 'meta' && el.hasAttribute('charset')).forEach(el => el.remove());
    all.filter(el => el.localName === 'iframe').forEach(el => {
      el.removeAttribute('srcdoc');
      el.setAttribute('src', 'about:blank');
    });
    all.forEach(el => {
      for (const attribute of [...el.attributes]) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith('on')) el.removeAttribute(attribute.name);
        if (name.startsWith('data-') && /^[\s]*[\[{]/.test(attribute.value))el.removeAttribute(attribute.name);
        if (/token|secret|password|csrf|api[_-]?key|session|credential|authorization|nonce|cookie/i.test(name) || /^data-(?:props|page|state-json|hydration|react-props|initial-state|server-data)$/.test(name)) el.removeAttribute(attribute.name);
        if (/^(?:href|src|action|xlink:href)$/.test(name) && /^javascript:/i.test(attribute.value))el.removeAttribute(attribute.name);
        if (name === 'ping') el.removeAttribute(attribute.name);
        if (name.startsWith('data-wrk-')) el.removeAttribute(attribute.name);
      }
      for (const attr of ['src', 'href', 'poster', 'data', 'background', 'xlink:href']) {
        if (el.hasAttribute(attr)) {
          const mapped = mapURL(el.getAttribute(attr));
          el.setAttribute(attr, mapped);
          // 样式表改写后，原来的完整性校验值已失效。
          if (mapped.startsWith('assets/')) el.removeAttribute('integrity');
        }
      }
      for (const attr of ['srcset', 'imagesrcset']) {
        if (el.hasAttribute(attr)) el.setAttribute(attr, rewriteSrcset(el.getAttribute(attr)));
      }
      if (el.hasAttribute('style')) el.setAttribute('style', rewriteCSS(el.getAttribute('style')));
      if (el.tagName.toLowerCase() === 'style') el.textContent = rewriteCSS(el.textContent);
      if (el.tagName.toLowerCase() === 'form') el.setAttribute('action', '#');
    });
    for (const { target, left, top } of scrollStates) {
      target.setAttribute('data-wrk-scroll-left', String(left));
      target.setAttribute('data-wrk-scroll-top', String(top));
    }
    for (const target of definedElements) target.setAttribute('data-wrk-defined', '');
    const head = clone.querySelector('head');
    if (head) {
      const meta = document.createElement('meta');
      meta.setAttribute('http-equiv', 'Content-Security-Policy');
      meta.setAttribute('content', "script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'");
      head.prepend(meta);
      // The source response may have supplied its encoding only through HTTP headers.
      // Snapshots are written as UTF-8 and must also decode correctly via file://.
      const charset = document.createElement('meta');
      charset.setAttribute('charset', 'utf-8');
      head.prepend(charset);
    }
    Object.defineProperty(clone,'__wrkCanvasFrames',{value:canvasFrames});
    return clone;
  };
  // Compose only our own helper functions; webpage data stays in structured arguments.
  const renderInBrowser = new Function('args',`const rewriteSrcsetUrls = ${rewriteSrcsetUrls.toString()}; const staticSheetText = ${staticSheetText.toString()}; return new Promise((resolve,reject)=>requestAnimationFrame(()=>{try{resolve((${render.toString()})(args));}catch(error){reject(error);}}));`);
  const snapshot = await page.evaluateHandle(renderInBrowser,{mappings:assetMap,stylesheetSources,maxCanvasFileBytes:MAX_PER_FILE,maxCanvasTotalBytes:MAX_TOTAL});
  try {
    const valid=await snapshot.evaluate(root=>!!root && root.nodeType===1 && root.localName==='html');
    if(!valid)throw new Error('Static preview did not produce an HTML document');
    const frames=await snapshot.evaluate(root=>root.__wrkCanvasFrames.map(({target,background,...frame})=>frame));
    const canvases=[];
    for(const [index,frame] of frames.entries()) {
      const result={index:index+1,width:frame.width,height:frame.height,status:'unavailable'};
      try {
        if(frame.error)throw new Error(frame.error);
        const body=Buffer.from(frame.data.split(',')[1],'base64');
        if(body.length>MAX_PER_FILE)throw new Error('Canvas exceeds file size budget');
        result.image=storeCanvas?await storeCanvas(body,result):frame.data;
        result.bytes=body.length;result.status='captured';
      }catch(error){result.reason=String(error.message);}
      canvases.push(result);
    }
    await snapshot.evaluate((root,frames)=>{
      for(const frame of frames) {
        if(frame.status!=='captured')continue;
        const {target,background}=root.__wrkCanvasFrames[frame.index-1];
        const first={image:`url("${frame.image}")`,size:'100% 100%',position:'0% 0%',repeat:'no-repeat',origin:'content-box',clip:'content-box',attachment:'scroll','blend-mode':'normal'};
        for(const [name,value] of Object.entries(first))target.style.setProperty('background-'+name,value+', '+background[name],'important');
      }
    },canvases);
    const html = await snapshot.evaluate(root => (document.doctype ? new XMLSerializer().serializeToString(document.doctype)+'\n' : '') + root.outerHTML);
    assertSnapshotHtml(html);
    return { html: injectSnapshotScrollRuntime(finalizeSnapshotResources(html)), canvases };
  } finally { await snapshot.dispose(); }
}

export async function capture(opts) {
  const release=await reserveOutput(opts.out);
  try{return await captureInto(opts);}finally{await release();}
}
async function captureInto(opts) {
  const started=performance.now(),cpuStarted=process.cpuUsage(),timings={};
  await fs.mkdir(path.join(opts.out, 'assets'), { recursive: true });
  const recorded = new Map();
  const redirectAliases = new Map();
  const pending = new Set();
  const errors = [];
  const resourceFailures=new Map();
  const missingResource=(url,type,reason,details={})=>resourceFailures.set(JSON.stringify([url,type,reason]),{url,type,reason,...details});
  const saving = new Map();
  let totalBytes = 0;
  const currentMappings = () => {
    const mappings = Object.fromEntries([...recorded.values()].map(r => [r.url, r.localPath]));
    for (const [alias, target] of redirectAliases) if (recorded.has(target)) mappings[alias] = recorded.get(target).localPath;
    return mappings;
  };

  async function storeResource(url, body, contentType, type) {
    if (recorded.has(url)) return recorded.get(url);
    if (saving.has(url)) return saving.get(url);
    const job = (async () => {
      if (body.length > MAX_PER_FILE || totalBytes + body.length > MAX_TOTAL) {
        throw new Error('Resource exceeds capture size budget');
      }
      const name = crypto.createHash('sha256').update(url).digest('hex').slice(0, 20) +
        fileExt(url, contentType, type);
      const localPath = `assets/${name}`;
      totalBytes += body.length;
      try { await fs.writeFile(path.join(opts.out, localPath), body); }
      catch (error) { totalBytes -= body.length; throw error; }
      const resource = { url, localPath, type, contentType, bytes: body.length };
      recorded.set(url, resource);
      return resource;
    })();
    saving.set(url, job);
    try { return await job; } finally { saving.delete(url); }
  }

  const launchOptions = { headless: !opts.headed, handleSIGINT: !opts.manual };
  if (opts.executablePath) launchOptions.executablePath = opts.executablePath;
  let browser = null;
  let context = null;
  let resourceClient = null;

  try {
    const contextOptions = {
      viewport: { width: opts.width, height: opts.height },
      deviceScaleFactor: 1,
      serviceWorkers: 'block'
    };
    browser = await chromium.launch(launchOptions);
    context = await browser.newContext(contextOptions);
    const proxy=process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    resourceClient=await apiRequest.newContext(proxy?{proxy:{server:proxy,bypass:'localhost,127.0.0.1,[::1]'}}:{});
    const page = context.pages()[0] || await context.newPage();
    page.on('requestfailed',request=>{
      const type=request.resourceType();
      if(request.method()!=='GET' || !isHttpUrl(request.url()) || !shouldStore(type,''))return;
      const job=(async()=>{const response=await request.response().catch(()=>null);missingResource(request.url(),type,request.failure()?.errorText || 'request failed',{status:response?.status() || null});})();
      pending.add(job);void job.finally(()=>pending.delete(job));
    });
    page.on('requestfinished', request => {
      const type = request.resourceType();
      if (request.method() !== 'GET' || !isHttpUrl(request.url())) return;
      const job = (async () => {
        const response = await request.response();
        if(!response){if(shouldStore(type,''))missingResource(request.url(),type,'response unavailable');return;}
        if(response.status()<200 || response.status()>=300){if(!request.redirectedTo() && shouldStore(type,response.headers()['content-type'] || ''))missingResource(request.url(),type,'unsuccessful HTTP response',{status:response.status()});return;}
        const contentType = response.headers()['content-type'] || '';
        if (!shouldStore(type, contentType)) return;
        for (let previous = request.redirectedFrom(); previous; previous = previous.redirectedFrom()) {
          redirectAliases.set(previous.url(), response.url());
        }
        if (recorded.has(response.url())) return;
        const contentLength = Number(response.headers()['content-length']);
        if(Number.isFinite(contentLength) && contentLength>MAX_PER_FILE){missingResource(response.url(),type,'resource-byte-budget',{bytes:contentLength,limit:MAX_PER_FILE});return;}
        const body = await response.body();
        await storeResource(response.url(), body, contentType, type);
      })().catch(e=>{const reason=String(e.message || e).split('\n')[0];errors.push(`${type}: ${reason}`);missingResource(request.url(),type,reason);});
      pending.add(job);
      void job.finally(() => pending.delete(job));
    });


    const response=await page.goto(opts.url,{waitUntil:opts.manual?'commit':'domcontentloaded',timeout:45000});
    if(response?.status()>=400&&!opts.manual)throw new Error(`HTTP ${response.status()}`);
    const confirmation=await waitForConfirmation(page,opts);
    if(opts.manual)await page.waitForLoadState('domcontentloaded',{timeout:opts.readyTimeout});
    if(opts.readySelector)await page.locator(opts.readySelector).filter({visible:true}).first().waitFor({timeout:opts.readyTimeout});
    await page.waitForTimeout(opts.wait);
    timings.load=performance.now()-started;
    let phase=performance.now();
    const cleanup=await cleanPage(page,opts);
    timings.cleanup=performance.now()-phase;phase=performance.now();
    const dom=await captureDOM(page,{maxNodes:opts.maxNodes});
    timings.dom=performance.now()-phase;phase=performance.now();
    const css=await captureStylesheets(page);
    timings.css=performance.now()-phase;phase=performance.now();
    await waitForPending(pending);
    const stylesheetSources={};
    for(const r of recorded.values())if(r.localPath.endsWith('.css')){const text=await fs.readFile(path.join(opts.out,r.localPath),'utf8');for(const url of [r.url,...[...redirectAliases].filter(([,target])=>target===r.url).map(([alias])=>alias)])stylesheetSources[url]=text;}
    const settledSnapshot=await makeSnapshotHtml(page,currentMappings(),stylesheetSources,{storeCanvas:async(body,frame)=>{
      const resource=await storeResource(`wrk:canvas-${frame.index}`,body,'image/png','image');
      resource.source='canvas-bitmap';resource.canvasIndex=frame.index;resource.width=frame.width;resource.height=frame.height;
      return resource.localPath;
    }});
    await page.screenshot({path:path.join(opts.out,'screenshot.png'),animations:'allow'});
    const inventory=await page.evaluate(discoverIcons,{limit:30000});
    await waitForPending(pending);
    const stylesheets=[];
    for(const resource of recorded.values())if(resource.localPath.endsWith('.css'))stylesheets.push({css:await fs.readFile(path.join(opts.out,resource.localPath),'utf8'),base:resource.url});
    const iconReport = await completeIcons({
      inventory, stylesheets,
      find: url => recorded.get(url) || recorded.get(redirectAliases.get(url)),
      read: resource => fs.readFile(path.join(opts.out, resource.localPath)),
      fetchResource: async url => {
        if (url.startsWith('blob:')) {
          const result = await page.evaluate(async ({ url, limit }) => {
            const response = await fetch(url);
            const blob = await response.blob();
            if (blob.size > limit) throw new Error('Blob exceeds file size budget');
            const data = await new Promise((resolve, reject) => {
              const reader = new FileReader(); reader.onload = () => resolve(reader.result);
              reader.onerror = reject; reader.readAsDataURL(blob);
            });
            return { contentType: blob.type, base64: data.slice(data.indexOf(',') + 1) };
          }, { url, limit: MAX_PER_FILE });
          return { status: 200, url, contentType: result.contentType, body: Buffer.from(result.base64, 'base64') };
        }
        if (!isHttpUrl(url)) throw new Error('Unsupported icon resource protocol');
        let response;
        try{response=await resourceClient.get(url,{timeout:12000});}
        catch(error){throw new Error(String(error.message).split('\n')[0]);}
        try {
          if(response.status()<200 || response.status()>=300)throw new Error(`HTTP ${response.status()}`);
          if (!shouldStore('',response.headers()['content-type'] || ''))throw new Error('Unsupported static resource content type');
          if (Number(response.headers()['content-length']) > MAX_PER_FILE) throw new Error('File exceeds size budget');
          return { status: response.status(), url: response.url(),
            contentType: response.headers()['content-type'] || '', body: await response.body() };
        } finally { await response.dispose(); }
      },
      save: async (url, response) => {
        const type = /font|woff|ttf|otf/i.test(response.contentType + ' ' + new URL(url).pathname) ? 'font' : 'image';
        const resource = await storeResource(response.url || url, response.body, response.contentType, type);
        if (resource.url !== url) redirectAliases.set(url, resource.url);
        return resource;
      }
    });
    await waitForPending(pending);


    timings.resources=performance.now()-phase;phase=performance.now();
    // SVG is an image resource but may contain executable markup. Sanitize it
    // before either local preview loading or sprite symbol inlining.
    for(const resource of recorded.values())if(resource.localPath.endsWith('.svg')) {
      const file=path.join(opts.out,resource.localPath),raw=await fs.readFile(file,'utf8');
      let cleaned;
      try{cleaned=await page.evaluate(text=>{
        const doc=new DOMParser().parseFromString(text,'image/svg+xml');
        if(doc.querySelector('parsererror'))throw new Error('Invalid SVG markup');
        const walker=doc.createTreeWalker(doc,NodeFilter.SHOW_COMMENT),comments=[];
        while(walker.nextNode())comments.push(walker.currentNode);for(const node of comments)node.remove();
        for(const el of doc.querySelectorAll('*')) {
          if(['script','iframe','object','embed','base'].includes(el.localName.toLowerCase())){el.remove();continue;}
          for(const attr of [...el.attributes])if(/^on|token|secret|password|csrf|nonce|cookie/i.test(attr.name)||(/^(?:href|xlink:href)$/i.test(attr.name)&&/^\s*javascript:/i.test(attr.value)))el.removeAttribute(attr.name);
        }
        return new XMLSerializer().serializeToString(doc);
      },raw);}catch(error){
        recorded.delete(resource.url);totalBytes-=resource.bytes;await fs.unlink(file);
        missingResource(resource.url,resource.type,'SVG sanitization failed: '+String(error.message).split('\n')[0]);continue;
      }
      await fs.writeFile(file,cleaned);totalBytes+=Buffer.byteLength(cleaned)-resource.bytes;resource.bytes=Buffer.byteLength(cleaned);resource.sanitized=true;
    }
    for(const [alias,target] of redirectAliases){const r=recorded.get(target);if(r)(r.aliases ||= []).push(alias);}
    const mappings=currentMappings();
    const network=[];
    await fs.mkdir(path.join(opts.out,'styles/original'),{recursive:true});
    for(const r of recorded.values()) {
      if(!r.localPath.endsWith('.css'))continue;
      const file=path.join(opts.out,r.localPath),raw=await fs.readFile(file);
      const originalPath='styles/original/'+path.basename(r.localPath);
      await fs.writeFile(path.join(opts.out,originalPath),raw);
      network.push({url:r.url,aliases:r.aliases || [],originalPath,previewPath:r.localPath,source:'network',sha256:crypto.createHash('sha256').update(raw).digest('hex')});
      await fs.writeFile(file,rewriteCss(raw.toString('utf8'),r.url,mappings,'assets'));
    }
    for(const sheet of css.stylesheets) {
      const source=network.find(r=>r.url===sheet.url||r.aliases.includes(sheet.url));
      sheet.originalPath=source?.originalPath || null;
    }
    let html=rewriteSnapshotAssets(settledSnapshot.html,mappings,page.url());
    const sprites=[];
    for(const r of recorded.values())if(r.localPath.endsWith('.svg'))sprites.push(await fs.readFile(path.join(opts.out,r.localPath),'utf8'));
    html=inlineSpriteSymbols(html,sprites);
    assertSnapshotHtml(html);
    await fs.writeFile(path.join(opts.out,'index.html'),html);
    const missing=[...[...resourceFailures.values()].filter(r=>!recorded.has(r.url)&&!recorded.has(redirectAliases.get(r.url))),...iconReport.missing.map(r=>({...r,type:r.kind,source:'icon-inventory'}))];
    const warnings=[...errors,...missing.map(r=>`${r.type || r.kind}: ${r.reason || r.reference || r.url || 'unresolved'}`)];
    for(const frame of settledSnapshot.canvases)if(frame.status!=='captured')warnings.push(`Canvas ${frame.index}: ${frame.reason}`);
    if(dom.truncated)warnings.push('DOM node budget exceeded');
    if(inventory.truncated)warnings.push('Resource inventory node budget exceeded');
    for(const sheet of css.stylesheets)if(sheet.readError&&!sheet.originalPath)warnings.push(`Stylesheet unavailable: ${sheet.url || sheet.scope}`);
    const limitations=['Original CSS and limited computed properties do not establish every winning cascade declaration.','Closed Shadow DOM is inaccessible. Iframe content is not captured; preview frames are blank. Readable canvas pixels are frozen as PNG backgrounds; tainted or unavailable canvases cannot be reconstructed. Animations and discarded WebGL buffers are not reconstructed.','Only the rendered initial page is observed. Lazy content outside this state is not explored.'];
    const write=(file,value)=>writeJsonFile(path.join(opts.out,file),{schemaVersion:3,...value});
    await write('components.json',{elements:dom.elements});
    await write('layout.json',{viewport:dom.viewport,pageSize:dom.pageSize,scroll:dom.scroll,elements:dom.layout});
    await write('styles/computed.json',{elements:dom.computed});
    await write('styles/stylesheets.json',{...css,network});
    await write('assets.json',{resources:[...recorded.values()],missing,icons:iconReport});
    const staticAudit=await auditSnapshot(opts.out);
    if(staticAudit.issueCount)warnings.push(`Static resource audit found ${staticAudit.issueCount} unresolved references; see report.staticAudit`);
    timings.output=performance.now()-phase;timings.total=performance.now()-started;
    const status=warnings.length?'partial':'ok';
    await write('report.json',{status,inputUrl:opts.url,finalUrl:page.url(),viewport:dom.viewport,confirmation,cleanup,dom:{total:dom.totalNodes,captured:dom.elements.length,truncated:dom.truncated},stylesheetCount:css.stylesheets.length,missingResources:missing,staticAudit,shadowRoots:dom.shadowRoots,iframes:dom.iframes,canvases:dom.canvases,canvasSnapshots:settledSnapshot.canvases,limitations,warnings,timingsMs:timings,previewGenerated:true,nodeCpuTimeMs:Object.fromEntries(Object.entries(process.cpuUsage(cpuStarted)).map(([key,value])=>[key,value/1000])),resourceBytes:totalBytes,nodeMemoryBytes:process.memoryUsage().rss});
    return {status,url:page.url(),output:opts.out,files:{html:'index.html',components:'components.json',layout:'layout.json',styles:'styles/stylesheets.json',report:'report.json'},warnings};
  }finally{await resourceClient?.dispose();await context?.close();await browser?.close();}
}
