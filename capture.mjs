#!/usr/bin/env node
import { buildEvidenceManifest } from './evidence-output.mjs';
import { linkRuleStates } from './rule-state-linker.mjs';
import { createCssRuleCollector } from './css-rule-capture.mjs';
import { captureStructuredState } from './interaction-snapshot.mjs';
import { discoverAllFrames } from './actionable-dom.mjs';
import { semanticHash } from './state-diff.mjs';
/**
 * 网页静态快照与设计结构采集工具。
 * 用法：node capture.mjs --url https://example.com --out output --width 1440
 * 仅用于有权访问和复刻的页面。
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { discoverIcons, completeIcons, inlineSpriteSymbols } from './icon-capture.mjs';
import { analyzeIconInteractions } from './icon-interactions.mjs';
import { explorePage, summarizeCoverage } from './interaction-explorer.mjs';
import { injectSnapshotScrollRuntime } from './snapshot-scroll.mjs';
import { finalizeSnapshotResources, rewriteSnapshotAssets } from './snapshot-resources.mjs';

const MB = 1024 * 1024;
const MAX_PER_FILE = 12 * MB;
const MAX_TOTAL = 120 * MB;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = value;
        i++;
      }
    }
  }
  const supported = new Set(['url','out','width','height','wait','max-nodes','max-css-nodes','headed','headless','manual','explore-interactions','allow-same-origin-navigation','explore-max-states','explore-max-depth','explore-max-actions','profile','ready-selector','ready-text','ready-timeout','executable']);
  for (const key of Object.keys(args)) if (!supported.has(key)) throw new Error('Unknown option: --' + key);
  if (!args.url) {
    console.error('Usage: node capture.mjs --url https://example.com [--out site] [--width 1440] [--height 900] [--wait 1500] [--max-nodes 5000] [--headed] [--manual] [--explore-interactions] [--allow-same-origin-navigation] [--profile ./session] [--ready-selector SELECTOR] [--ready-text TEXT] [--executable /path/to/chromium]');
    process.exit(1);
  }
  const parsed = new URL(args.url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) URLs are supported.');
  return {
    url: parsed.href,
    out: path.resolve(args.out || 'output'),
    width: clamp(args.width, 1440, 320, 3840),
    height: clamp(args.height, 900, 320, 2160),
    wait: clamp(args.wait, 1500, 0, 30000),
    maxNodes: clamp(args['max-nodes'], 5000, 1, 20000),
    maxCssNodes:clamp(args['max-css-nodes'],1000,1,20000),
    headed: !args.headless && Boolean(args.headed || args.manual || args['explore-interactions']),
    manual: Boolean(args.manual),
    exploreInteractions: Boolean(args['explore-interactions']),
    allowSameOriginNavigation: Boolean(args['allow-same-origin-navigation']),
    exploreMaxStates: clamp(args['explore-max-states'], 24, 1, 80),
    exploreMaxDepth: clamp(args['explore-max-depth'], 4, 1, 8),
    exploreMaxActions: clamp(args['explore-max-actions'], 40, 1, 200),
    profile: typeof args.profile === 'string' ? path.resolve(args.profile) : null,
    readySelector: typeof args['ready-selector'] === 'string' ? args['ready-selector'] : null,
    readyText: typeof args['ready-text'] === 'string' ? args['ready-text'] : null,
    readyTimeout: clamp(args['ready-timeout'], 120000, 1000, 300000),
    executablePath: typeof args.executable === 'string' ? args.executable : undefined
  };
}
function clamp(input, fallback, min, max) {
  if (input === undefined) return fallback;
  const val = Number(input);
  return Number.isFinite(val) ? Math.max(min, Math.min(max, Math.round(val))) : fallback;
}

const mimeExt = new Map([
  ['text/css', '.css'], ['text/javascript', '.js'], ['application/javascript', '.js'],
  ['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/gif', '.gif'],
  ['image/webp', '.webp'], ['image/avif', '.avif'], ['image/svg+xml', '.svg'],
  ['image/x-icon', '.ico'], ['image/vnd.microsoft.icon', '.ico'],
  ['font/woff', '.woff'], ['font/woff2', '.woff2'],
  ['font/ttf', '.ttf'], ['font/otf', '.otf'],
  ['application/font-woff', '.woff'], ['application/pdf', '.pdf'],
  ['video/mp4', '.mp4'], ['audio/mpeg', '.mp3'], ['application/wasm', '.wasm']
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
  const t = (contentType || '').toLowerCase();
  return ['image', 'font', 'stylesheet', 'media', 'script'].includes(resourceType) ||
    /^(?:image\/|font\/|text\/css|application\/javascript)/.test(t);
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

export async function scrollToLoadLazyAssets(page) {
  await page.evaluate(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const step = Math.max(250, Math.round(window.innerHeight * 0.85));
    let y = 0;
    for (let i = 0; i < 50; i++) {
      window.scrollTo(0, y);
      await sleep(110);
      const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
      if (y >= max) break;
      y = Math.min(y + step, max);
    }
    window.scrollTo(0, 0);
    await sleep(250);
  });
}

async function inspectDOM(page, maxNodes) {
  const snapshot=await captureStructuredState(page,{limit:maxNodes,includeLayoutStyles:true});
  return {viewport:snapshot.frames[0]?.viewport,pageSize:snapshot.frames[0]?.pageSize,
    capturedNodes:snapshot.nodes.length,capped:snapshot.frames.some(f=>f.truncated),frames:snapshot.frames,
    nodes:snapshot.nodes.map(n=>({elementId:n.elementId,parentElementId:n.parentElementId,frameIndex:n.frameIndex,selector:n.selector,tag:n.tagName,visible:n.visible,rect:{...n.bbox,x:n.bbox.x+(snapshot.frames[n.frameIndex]?.scroll?.x || 0),y:n.bbox.y+(snapshot.frames[n.frameIndex]?.scroll?.y || 0)},styles:n.layoutStyles}))};
}

export async function makeSnapshotHtml(page, assetMap) {
  // Preserve the rendered DOM and native CSS; only scroll initialization is authorized.
  const snapshot = await page.evaluateHandle(({ mappings }) => {
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
    function rewriteSrcset(srcset) {
      // 处理常规的逗号分隔候选列表；含数据 URL 的复杂列表仍需人工检查。
      return srcset.split(',').map(item => {
        const match = item.trim().match(/^(\S+)(\s+.*)?$/);
        return match ? mapURL(match[1]) + (match[2] || '') : item;
      }).join(', ');
    }
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
    function cloneRendered(source) {
      const target = source.cloneNode(false);
      if (source.nodeType !== Node.ELEMENT_NODE) return target;
      if(source.localName==='input') {
        const sensitive=source.matches('input[type=password],input[type=file],input[type=hidden]') || /token|secret|password/i.test(`${source.id} ${source.name}`);
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
      if(source.localName==='textarea'){target.textContent=/token|secret|password/i.test(`${source.id} ${source.name}`)?'':source.value;return target;}
      // 动态 insertRule() 添加的规则不在文本内容中，需要读取样式表。
      if (source.localName === 'style' && source.sheet) {
        try { target.textContent = [...source.sheet.cssRules].map(r => r.cssText).join('\n'); return target; } catch {}
      }
      if (source.localName === 'template') {
        target.content.append(source.content.cloneNode(true));
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
        if (name === 'ping') el.removeAttribute(attribute.name);
        if (name.startsWith('data-wrk-')) el.removeAttribute(attribute.name);
      }
      for (const attr of ['src', 'href', 'poster', 'data', 'xlink:href']) {
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
    return clone;
  }, { mappings: assetMap });
  try {
    const html = await snapshot.evaluate(root => '<!DOCTYPE html>\n' + root.outerHTML);
    return { html: injectSnapshotScrollRuntime(finalizeSnapshotResources(html)) };
  } finally { await snapshot.dispose(); }
}

async function waitForOperator(message) {
  if (!process.stdin.isTTY) {
    throw new Error('--manual needs an interactive terminal. Use --ready-selector for unattended runs.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { await rl.question(message); }
  finally { rl.close(); }
}

function navigationInterrupted(error) {
  return /Execution context was destroyed|ERR_ABORTED|interrupted by another navigation|frame was detached/i.test(String(error?.message || error));
}

async function waitUntilReady(page, opts) {
  if (opts.manual && !opts.exploreInteractions) {
    console.log('\n浏览器已打开。如需登录，请在窗口里完成。');
    console.log('等目标界面真正出现后再继续，不要停在加载或验证页。');
    await waitForOperator('目标页面完全可见后，回到这里按 Enter... ');
  }
  if (opts.readySelector) {
    console.log('Waiting for visible selector:', opts.readySelector);
    await page.locator(opts.readySelector).filter({ visible: true }).first().waitFor({
      state: 'visible', timeout: opts.readyTimeout
    });
  }
  if (opts.readyText) {
    console.log('Waiting for text:', opts.readyText);
    await page.waitForFunction(
      expected => document.body?.innerText?.includes(expected),
      opts.readyText, { timeout: opts.readyTimeout }
    );
  }
  // 固定延迟无法判断应用是否就绪；人工或元素就绪信号之后只追加少量缓冲。
  await page.waitForTimeout(opts.manual || opts.exploreInteractions || opts.readySelector || opts.readyText ? 450 : opts.wait);
}

async function getCaptureDiagnostics(page) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      return await page.evaluate(() => {
        const text = document.body?.innerText?.trim() || '';
        const title = document.title || '';
        const loadingScreen = text.length < 900 &&
          /(just a moment|checking your browser|verify you are human|chatgpt is loading|正在加载|加载中|loading chatgpt)/i.test(title + '\n' + text.slice(0, 500));
        return {
          title,
          bodyTextLength: text.length,
          hasContentEditable: Boolean(document.querySelector('[contenteditable="true"]')),
          loadingScreenPossible: loadingScreen
        };
      });
    } catch (error) {
      lastError = error;
      if (!navigationInterrupted(error) || attempt === 3) throw error;
      await page.waitForTimeout(400);
    }
  }
  throw lastError;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const existing=await fs.readdir(opts.out).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  if(existing.length)throw new Error('Output directory must be empty; choose a fresh --out directory to avoid mixing evidence from different captures.');
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

  const launchOptions = { headless: !opts.headed };
  if (opts.executablePath) launchOptions.executablePath = opts.executablePath;
  let browser = null;
  let context = null;
  let cssCollector = null;
  try {
    const contextOptions = {
      viewport: { width: opts.width, height: opts.height },
      deviceScaleFactor: 1,
      serviceWorkers: 'block'
    };
    if (opts.profile) {
      // 使用隔离的持久目录保存登录状态；目录包含私密会话，不要提交或共享。
      context = await chromium.launchPersistentContext(opts.profile, {
        ...launchOptions, ...contextOptions
      });
    } else {
      browser = await chromium.launch(launchOptions);
      context = await browser.newContext(contextOptions);
    }
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
      })().catch(e=>{const reason=String(e.message || e);errors.push(`${type}: ${reason}`);missingResource(request.url(),type,reason);});
      pending.add(job);
      void job.finally(() => pending.delete(job));
    });

    console.log(opts.headed ? `正在打开可见浏览器：${opts.url}` : `Opening ${opts.url}`);
    const opened = page.goto(opts.url, { waitUntil: 'commit', timeout: 45000 }).catch(error => {
      if (navigationInterrupted(error) || /Timeout/i.test(String(error?.message || error))) return;
      throw error;
    });
    if (opts.exploreInteractions && opts.headed && process.stdin.isTTY) {
      console.log('\n浏览器已打开。请先在窗口里完成验证并登录。');
      console.log('按 Enter 时，窗口里已经显示的仓库、模型和侧栏会被原样保存，然后再尝试记录可展开的控件。');
      await waitForOperator('登录完成、目标页面可见后，按 Enter 开始采集：');
    }
    await opened;
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(error => {
      if (!navigationInterrupted(error) && !/Timeout/i.test(String(error?.message || error))) throw error;
    });
    await waitUntilReady(page, opts);
    const captureDiagnostics = await getCaptureDiagnostics(page);
    if (captureDiagnostics.loadingScreenPossible) {
      console.warn('WARNING: A loading/verification screen may still be visible.');
      console.warn('Re-run with --manual and press Enter only after full page renders.');
    }
    console.log('Capturing page:', page.url(), '| title:', captureDiagnostics.title);
    await scrollToLoadLazyAssets(page);
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await page.waitForTimeout(400);
    await waitForPending(pending);
    const iconInteractions = await page.evaluate(analyzeIconInteractions);
    cssCollector=await createCssRuleCollector(page,{maxNodes:opts.maxCssNodes});
    const baselineLayout = await inspectDOM(page, opts.maxNodes);
    const baselineOriginal = await page.content();
    const settledSnapshot = await makeSnapshotHtml(page, currentMappings());
    const observedInventories = [await page.evaluate(discoverIcons, {limit:30000})];
    await page.screenshot({path:path.join(opts.out,'screenshot.png'),fullPage:true,animations:'disabled'}).catch(error=>errors.push(String(error.message)));
    const baselineSnapshot=await captureStructuredState(page,{limit:opts.maxNodes});
    baselineSnapshot.cssFingerprint=await cssCollector.fingerprint(baselineSnapshot);
    const initialEvidence=await cssCollector.capture(baselineSnapshot,'initial');
    const initialControls=await discoverAllFrames(page,{allowSameOriginNavigation:opts.allowSameOriginNavigation,pageOrigin:page.url()});
    let exploration={states:[{id:'state-000',hash:semanticHash(baselineSnapshot),snapshot:baselineSnapshot,evidence:initialEvidence,depth:0,path:[]}],controls:initialControls.controls,transitions:[],failures:[],restorations:[],routes:[],overlayDiagnostics:[],coverage:summarizeCoverage({controls:initialControls.controls}),truncated:false,limitations:initialControls.limitations};
    if (opts.exploreInteractions) {
      try {
        exploration = await explorePage(page, {
          cssCollector,snapshotLimit:opts.maxNodes,
          allowSameOriginNavigation: opts.allowSameOriginNavigation,
          evidenceDir: opts.out,
          onState: async () => { observedInventories.push(await page.evaluate(discoverIcons,{limit:30000})); },
          budgets: {maxStates:opts.exploreMaxStates,maxDepth:opts.exploreMaxDepth,maxActions:opts.exploreMaxActions}
        });
        console.log(`Interaction evidence: ${exploration.coverage.discovered} controls discovered, ${exploration.coverage.observed} observed.`);
      } catch(error) {const reason='Interaction collection failed: '+String(error.message);errors.push(reason);exploration.failures.push({stage:'exploration',reason});exploration.restoreFailed=true;}
    }
    console.log('Checking required icon dependencies...');
    const inventory = await page.evaluate(discoverIcons, { limit: 30000 });
    for (const observed of observedInventories) {
      inventory.resources.push(...observed.resources); inventory.fonts.push(...observed.fonts);
      inventory.sheets.push(...observed.sheets); inventory.missing.push(...observed.missing);
    }
    const stylesheets = [];
    for (const resource of recorded.values()) {
      if (resource.localPath.endsWith('.css')) stylesheets.push({
        css: await fs.readFile(path.join(opts.out, resource.localPath), 'utf8'), base: resource.url
      });
    }
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
        const response = await context.request.get(url, { timeout: 12000,
          headers: { referer: page.url() } });
        try {
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

    const layout = baselineLayout || await inspectDOM(page, opts.maxNodes);
    const originalHtml = baselineOriginal || await page.content();
    for (const [alias, target] of redirectAliases) {
      const resource = recorded.get(target);
      if (resource) (resource.aliases ||= []).push(alias);
    }
    const mappings = Object.fromEntries([...recorded.values()].flatMap(r =>
      [r.url, ...(r.aliases || [])].map(url => [url, r.localPath])));

    // Keep the network response separately; preview URL rewriting must not erase source CSS.
    const cssResourceFiles=[];
    await fs.mkdir(path.join(opts.out,'css/original'),{recursive:true});
    // 按资源目录改写相对路径，使下载后的样式表可以在本地使用。
    for (const resource of recorded.values()) {
      if (!resource.localPath.endsWith('.css')) continue;
      const fullPath = path.join(opts.out, resource.localPath);
      const originalBytes=await fs.readFile(fullPath);
      const raw=originalBytes.toString('utf8');
      const originalPath='css/original/'+path.basename(resource.localPath);
      await fs.writeFile(path.join(opts.out,originalPath),originalBytes);
      cssResourceFiles.push({url:resource.url,aliases:resource.aliases || [],originalPath,previewPath:resource.localPath,channel:'network-response',sha256:crypto.createHash('sha256').update(originalBytes).digest('hex')});
      await fs.writeFile(fullPath, rewriteCss(raw, resource.url, mappings, 'assets'));

    }

    const cssEvidence=cssCollector.export();
    for(const sheet of cssEvidence.stylesheets) sheet.resourceRef=cssResourceFiles.find(file=>file.url===sheet.header?.sourceURL || file.aliases.includes(sheet.header?.sourceURL))?.originalPath || null;
    const snapshot = {...settledSnapshot,html:rewriteSnapshotAssets(settledSnapshot.html,mappings,opts.url)};
    const assetDir = path.join(opts.out, 'assets');
    const spriteSources = [];
    if (await fs.stat(assetDir).then(stat => stat.isDirectory()).catch(() => false)) {
      for (const name of await fs.readdir(assetDir)) {
        if (name.endsWith('.svg')) spriteSources.push(await fs.readFile(path.join(assetDir, name), 'utf8'));
      }
    }
    snapshot.html = inlineSpriteSymbols(snapshot.html, spriteSources);
    const writeJson = async (file, data) => {
      const full = path.join(opts.out, file);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, JSON.stringify(data, null, 2));
    };
    const resourceFailureEvidence=[...resourceFailures.values()].map(item=>({...item,resolved:Boolean(recorded.has(item.url) || recorded.has(redirectAliases.get(item.url)))}));
    const manifest=buildEvidenceManifest(exploration);
    await Promise.all(manifest.documents.map(item=>writeJson(item.file,item.snapshot)));
    await fs.mkdir(path.join(opts.out,'dom'),{recursive:true});
    await Promise.all([
      fs.writeFile(path.join(opts.out, 'index.html'), snapshot.html),
      writeJson('dom/icon-hosts.json',iconInteractions),
      fs.writeFile(path.join(opts.out,'dom/original.html'),originalHtml),
      writeJson('layout.json', { schemaVersion:1,viewport: layout.viewport, pageSize: layout.pageSize,frames:layout.frames,
        capped: layout.capped, nodes: layout.nodes }),
      writeJson('dom/tree.json', manifest.tree),
      writeJson('dom/elements.json',exploration.states[0].snapshot.nodes),
      writeJson('assets.json', [...recorded.values()]),
      writeJson('icons.json', iconReport),
      writeJson('css/stylesheets.json',{schemaVersion:1,stylesheets:cssEvidence.stylesheets,resourceFiles:cssResourceFiles,cssomSnapshots:cssEvidence.cssomSnapshots,missing:cssEvidence.missing,budgets:cssEvidence.budgets}),
      writeJson('css/matched-rules.json',{schemaVersion:1,rules:cssEvidence.rules,snapshots:cssEvidence.snapshots}),
      writeJson('css/variables.json',{schemaVersion:1,elements:cssEvidence.variables}),
      writeJson('relations/state-style.json',exploration.relations || linkRuleStates({...exploration,css:cssEvidence})),
      writeJson('interactions/controls.json',manifest.controls),
      writeJson('interactions/states.json',manifest.states),
      writeJson('interactions/observations.json',manifest.observations),
      writeJson('interactions/transitions.json',exploration?.transitions || []),
      writeJson('interactions/failures.json',exploration?.failures || []),
      writeJson('interactions/restorations.json',exploration?.restorations || []),
      writeJson('interactions/overlay-diagnostics.json',exploration?.overlayDiagnostics || []),
      writeJson('routes.json',{initialRoute:baselineSnapshot.route,routes:exploration?.routes || []}),
      writeJson('report.json', {
        schemaVersion:1,capturedAt: new Date().toISOString(), sourceUrl: opts.url,
        finalUrl: page.url(),settledRoute:baselineSnapshot.route, captureDiagnostics,
        iconPolicy: iconReport.policy, iconsComplete: iconReport.complete,
        missingIcons: iconReport.missing.length,resourceFailures:resourceFailureEvidence,missingResources:resourceFailureEvidence.filter(item=>!item.resolved),
        purpose:'structure-style-behavior-evidence',
        preview:'static',
        css:{stylesheets:cssEvidence.stylesheets.length,rules:cssEvidence.rules.length,missing:cssEvidence.missing,snapshots:cssEvidence.snapshots.map(s=>({id:s.id,capturedNodes:s.elements.length,missing:s.missing,nodeFailures:s.elements.filter(e=>e.missing).map(e=>({elementId:e.elementId,reason:e.missing}))}))},
        exploration: exploration ? {coverage:exploration.coverage,truncated:exploration.truncated,restoreFailed:exploration.restoreFailed,budgetUsage:exploration.budgetUsage,observationBudget:exploration.observationBudget,limitations:exploration.limitations} : null,
        readinessMode: opts.manual ? 'manual' :
          opts.readySelector ? 'selector' : opts.readyText ? 'text' : 'fixed-delay',
        viewport: layout.viewport, pageSize: layout.pageSize,
        capturedNodes: layout.capturedNodes, capped: layout.capped,
        assetCount: recorded.size,
        assetBytes: totalBytes, errors: errors.slice(0, 100),
        limitations: [
          'index.html is a static structure/style preview. Collected actions do not generate component behavior.',
          'Missing resources may still load from their original URLs.',
          'Cross-origin iframe contents, closed shadow roots, canvas pixels and application state are not fully exported.',
          'Only visited states and CSS within the recorded budgets are represented; resources in unvisited states or inactive conditions may remain unresolved.',
          'Do not publish captured files unless you have the required rights.'
        ]
      })
    ]);
    console.log(`Saved ${layout.capturedNodes} nodes, ${recorded.size} assets to ${opts.out}`);
    console.log('Local preview: node serve.mjs ' + opts.out);
    if (!iconReport.complete) {
      console.error(`Required icons incomplete (${iconReport.missing.length}); see icons.json. Output retained for review.`);
      process.exitCode = 2;
    }
  } finally {
    if (cssCollector) await cssCollector.dispose();
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
