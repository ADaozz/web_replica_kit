#!/usr/bin/env node
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
import { discoverIcons, completeIcons } from './icon-capture.mjs';
import { annotateBasicInteractions, interactionScript } from './basic-interactions.mjs';
import { analyzeIconInteractions } from './icon-interactions.mjs';
import { recordIconInteractions, buildRecordedPreview, rewriteRecordedAssets, recordedInteractionScript } from './recorded-interactions.mjs';

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
  if (!args.url) {
    console.error('Usage: node capture.mjs --url https://example.com [--out site] [--width 1440] [--height 900] [--wait 1500] [--max-nodes 5000] [--headed] [--manual] [--record-icon-interactions] [--manual-icon-interactions] [--profile ./session] [--ready-selector SELECTOR] [--ready-text TEXT] [--executable /path/to/chromium]');
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
    headed: Boolean(args.headed || args.manual || args['manual-icon-interactions']),
    manual: Boolean(args.manual),
    recordIconInteractions: Boolean(args['record-icon-interactions'] || args['manual-icon-interactions']),
    manualIconInteractions: Boolean(args['manual-icon-interactions']),
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
  return page.evaluate((limit) => {
    const properties = [
      'display', 'position', 'box-sizing', 'width', 'height', 'min-width',
      'max-width', 'min-height', 'max-height', 'top', 'left', 'right', 'bottom',
      'margin', 'padding', 'gap', 'row-gap', 'column-gap', 'flex', 'flex-direction',
      'flex-wrap', 'justify-content', 'align-items', 'align-self',
      'grid-template-columns', 'grid-template-rows', 'grid-area',
      'background', 'background-color', 'background-image', 'color',
      'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
      'letter-spacing', 'text-align', 'text-decoration', 'text-transform',
      'border', 'border-radius', 'box-shadow', 'opacity', 'overflow',
      'overflow-x', 'overflow-y', 'z-index', 'transform', 'object-fit',
      'aspect-ratio', 'visibility'
    ];
    const nodes = [];
    const idOf = new Map();
    const tokens = { colors: {}, fonts: {}, fontSizes: {}, radii: {}, gaps: {} };
    const countToken = (group, value) => {
      if (!value || value === 'normal' || value === 'none' ||
          value === 'transparent' || value === 'rgba(0, 0, 0, 0)') return;
      group[value] = (group[value] || 0) + 1;
    };
    function selector(el) {
      const parts = [];
      let cur = el;
      for (let depth = 0; cur && depth < 8 && cur.nodeType === 1; depth++) {
        const tag = cur.tagName.toLowerCase();
        if (cur.id) {
          parts.unshift(`#${CSS.escape(cur.id)}`);
          break;
        }
        const parent = cur.parentElement;
        let nth = 1;
        if (parent) {
          let sibling = cur.previousElementSibling;
          while (sibling) {
            if (sibling.tagName === cur.tagName) nth++;
            sibling = sibling.previousElementSibling;
          }
        }
        parts.unshift(`${tag}:nth-of-type(${nth})`);
        cur = parent;
      }
      return parts.join(' > ');
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let el = document.body;
    while (el && nodes.length < limit) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const styles = {};
      for (const prop of properties) styles[prop] = style.getPropertyValue(prop).trim();
      const visible = rect.width > 0 && rect.height > 0 &&
        style.display !== 'none' && style.visibility !== 'hidden';
      const id = nodes.length + 1;
      const childrenText = [...el.childNodes]
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent.trim())
        .filter(Boolean).join(' ').slice(0, 160);
      nodes.push({
        id,
        parentId: idOf.get(el.parentElement) ?? null,
        tag: el.tagName.toLowerCase(),
        selector: selector(el),
        className: el.getAttribute('class') || '',
        role: el.getAttribute('role') || null,
        ariaLabel: el.getAttribute('aria-label') || null,
        text: childrenText,
        visible,
        rect: {
          x: Math.round((rect.x + scrollX) * 100) / 100,
          y: Math.round((rect.y + scrollY) * 100) / 100,
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100
        },
        styles
      });
      idOf.set(el, id);
      if (visible) {
        countToken(tokens.colors, styles['background-color']);
        countToken(tokens.colors, styles.color);
        countToken(tokens.fonts, styles['font-family']);
        countToken(tokens.fontSizes, styles['font-size']);
        countToken(tokens.radii, styles['border-radius']);
        countToken(tokens.gaps, styles.gap);
      }
      el = walker.nextNode();
    }
    function top(group) {
      return Object.entries(group).sort((a,b) => b[1]-a[1]).slice(0, 30)
        .map(([value, count]) => ({ value, count }));
    }
    const semanticTags = new Set(['header', 'nav', 'main', 'footer', 'article',
      'section', 'aside', 'form', 'dialog', 'button', 'table']);
    const components = nodes.filter(n => n.visible && n.rect.width >= 24 &&
      n.rect.height >= 15 && (semanticTags.has(n.tag) ||
      /(?:header|footer|nav|sidebar|card|modal|hero|menu|toolbar|tabs|dialog|button|widget)/i
        .test(n.className))).slice(0, 300)
      .map(({ id, parentId, tag, selector, className, rect }) =>
        ({ id, parentId, tag, selector, className, rect }));
    const lookup = new Map(nodes.map(n => [n.id, { id: n.id, tag: n.tag,
      className: n.className, text: n.text, children: [] }]));
    const roots = [];
    for (const n of nodes) {
      const node = lookup.get(n.id);
      if (n.parentId && lookup.has(n.parentId)) lookup.get(n.parentId).children.push(node);
      else roots.push(node);
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      pageSize: { width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight },
      capturedNodes: nodes.length,
      capped: Boolean(el),
      nodes, components, tree: roots,
      tokens: Object.fromEntries(Object.entries(tokens).map(([k,v]) => [k,top(v)]))
    };
  }, maxNodes);
}

export async function makeSnapshotHtml(page, assetMap, { enableBasicInteractions = false } = {}) {
  // 用浏览器句柄保留克隆节点，便于标记交互关系，不修改源页面，也不执行拼接代码。
  const scriptHash = crypto.createHash('sha256').update(interactionScript).digest('base64');
  const snapshot = await page.evaluateHandle(({ mappings, runtime, scriptHash, enabled }) => {
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
    function cloneRendered(source) {
      const target = source.cloneNode(false);
      if (source.nodeType !== Node.ELEMENT_NODE) return target;
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
      if (value === 'refresh' || value === 'content-security-policy') x.remove();
    });
    all.filter(el => el.localName === 'iframe').forEach(el => {
      el.removeAttribute('srcdoc');
      el.setAttribute('src', 'about:blank');
    });
    all.filter(el => el.localName === 'input').forEach(el => {
      el.removeAttribute('value');
      el.removeAttribute('checked');
    });
    all.filter(el => el.localName === 'textarea').forEach(el => el.textContent = '');
    all.filter(el => el.localName === 'option').forEach(el => el.removeAttribute('selected'));
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
    const head = clone.querySelector('head');
    if (head) {
      const meta = document.createElement('meta');
      meta.setAttribute('http-equiv', 'Content-Security-Policy');
      meta.setAttribute('content', `script-src ${enabled ? "'sha256-" + scriptHash + "'" : "'none'"}; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'`);
      head.prepend(meta);
    }
    if (enabled) {
      const script = document.createElement('script');
      script.textContent = runtime;
      (clone.querySelector('body') || clone).append(script);
    }
    return clone;
  }, { mappings: assetMap, runtime: interactionScript, scriptHash, enabled: enableBasicInteractions });
  try {
    const interactions = await snapshot.evaluate(annotateBasicInteractions, { applyBindings: enableBasicInteractions });
    interactions.runtimeEnabled = enableBasicInteractions;
    const html = await snapshot.evaluate(root => '<!DOCTYPE html>\n' + root.outerHTML);
    return { html, interactions };
  } finally { await snapshot.dispose(); }
}

async function waitUntilReady(page, opts) {
  if (opts.manual) {
    if (!process.stdin.isTTY) {
      throw new Error('--manual needs an interactive terminal. Use --ready-selector for unattended runs.');
    }
    console.log('\nThe browser is open. Log in normally if needed.');
    console.log('Wait until the ACTUAL target UI (not the loading screen) is visible.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await rl.question('Press ENTER here only after the target page is fully visible... ');
    } finally {
      rl.close();
    }
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
  await page.waitForTimeout(opts.manual || opts.readySelector || opts.readyText ? 450 : opts.wait);
}

async function getCaptureDiagnostics(page) {
  return page.evaluate(() => {
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
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.manualIconInteractions && !process.stdin.isTTY) throw new Error('--manual-icon-interactions 需要交互式终端。');
  await fs.mkdir(path.join(opts.out, 'assets'), { recursive: true });
  const recorded = new Map();
  const redirectAliases = new Map();
  const pending = new Set();
  const errors = [];
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
    page.on('requestfinished', request => {
      const type = request.resourceType();
      if (request.method() !== 'GET' || !isHttpUrl(request.url())) return;
      const job = (async () => {
        const response = await request.response();
        if (!response || response.status() < 200 || response.status() >= 300) return;
        const contentType = response.headers()['content-type'] || '';
        if (!shouldStore(type, contentType)) return;
        for (let previous = request.redirectedFrom(); previous; previous = previous.redirectedFrom()) {
          redirectAliases.set(previous.url(), response.url());
        }
        if (recorded.has(response.url())) return;
        const contentLength = Number(response.headers()['content-length']);
        if (Number.isFinite(contentLength) && contentLength > MAX_PER_FILE) return;
        const body = await response.body();
        await storeResource(response.url(), body, contentType, type);
      })().catch(e => errors.push(`${type}: ${String(e.message || e)}`));
      pending.add(job);
      void job.finally(() => pending.delete(job));
    });

    console.log(`Opening ${opts.url}`);
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
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
    const observedInventories = [];
    const observedControls = [];
    const baselineLayout = opts.recordIconInteractions ? await inspectDOM(page, opts.maxNodes) : null;
    const baselineOriginal = opts.recordIconInteractions ? await page.content() : null;
    const recording = opts.recordIconInteractions ? await recordIconInteractions({ page, out: opts.out, manual: opts.manualIconInteractions,
      snapshot: async () => {
        await waitForPending(pending);
        observedInventories.push(await page.evaluate(discoverIcons, { limit: 30000 }));
        observedControls.push(await page.evaluate(analyzeIconInteractions));
        return (await makeSnapshotHtml(page, currentMappings())).html;
      }
    }) : null;
    if (recording) {
      const candidates = new Map(iconInteractions.icons.map(row => [row.selector + '|' + row.iconName, row]));
      for (const inventory of observedControls) for (const row of inventory.icons) {
        const key = row.selector + '|' + row.iconName;
        if (!candidates.has(key)) candidates.set(key, row);
      }
      iconInteractions.icons = [...candidates.values()].map((row, index) => ({ ...row, id: index + 1,
        status: recording.observations.some(event => event.selector === row.host?.selector) ? 'observed-on-original-page' : row.status }));
      iconInteractions.totalIcons = iconInteractions.icons.length;
      iconInteractions.interactiveHosts = new Set(iconInteractions.icons.filter(row => row.host).map(row => row.host.selector)).size;
      iconInteractions.recordedHosts = new Set(recording.observations.map(event => event.selector)).size;
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
    try {
      if (recording?.states.length) await fs.copyFile(path.join(opts.out, recording.states[0].screenshot), path.join(opts.out, 'screenshot.png'));
      else await page.screenshot({ path: path.join(opts.out, 'screenshot.png'), fullPage: true,
        animations: 'disabled', timeout: 30000 });
    } catch (error) {
      errors.push('Full-page screenshot failed: ' + String(error.message || error));
      await page.screenshot({ path: path.join(opts.out, 'screenshot.png'),
        animations: 'disabled', timeout: 15000 }).catch(() => {});
    }
    await waitForPending(pending);

    const layout = baselineLayout || await inspectDOM(page, opts.maxNodes);
    const originalHtml = baselineOriginal || await page.content();
    for (const [alias, target] of redirectAliases) {
      const resource = recorded.get(target);
      if (resource) (resource.aliases ||= []).push(alias);
    }
    const mappings = Object.fromEntries([...recorded.values()].flatMap(r =>
      [r.url, ...(r.aliases || [])].map(url => [url, r.localPath])));

    // 按资源目录改写相对路径，使下载后的样式表可以在本地使用。
    const stylesheetSource = [];
    for (const resource of recorded.values()) {
      if (!resource.localPath.endsWith('.css')) continue;
      const fullPath = path.join(opts.out, resource.localPath);
      const raw = await fs.readFile(fullPath, 'utf8');
      await fs.writeFile(fullPath, rewriteCss(raw, resource.url, mappings, 'assets'));
      stylesheetSource.push(`/* 来源：${resource.url.replace(/\*\//g, '')} */\n` +
        rewriteCss(raw.replace(/@charset\s+[^;]+;/gi, ''), resource.url, mappings));
    }

    const snapshot = await makeSnapshotHtml(page, mappings);
    if (recording?.states.length) {
      for (const state of recording.states) {
        state.html = rewriteRecordedAssets(state.html, mappings, opts.url);
        await fs.writeFile(path.join(opts.out, `${state.id}.html`), state.html);
      }
      snapshot.html = buildRecordedPreview(recording);
    }
    const interactionReport = { ...snapshot.interactions, mode: recording ? 'recorded-original-states' : 'native-css-only',
      guessedHandlersEnabled: false, iconCandidates: iconInteractions.totalIcons,
      iconHosts: iconInteractions.interactiveHosts,
      recording: recording ? { ...recording, states: recording.states.map(({ html, ...state }) => state), inventory: undefined } : null };
    const writeJson = async (file, data) => fs.writeFile(path.join(opts.out, file), JSON.stringify(data, null, 2));
    await Promise.all([
      fs.writeFile(path.join(opts.out, 'index.html'), snapshot.html),
      fs.writeFile(path.join(opts.out, 'interactions.js'), recording ? recordedInteractionScript :
        '// 未录制原网页操作；保留原生 HTML/CSS 行为，不执行猜测的交互逻辑。\n'),
      writeJson('interactions.json', interactionReport),
      writeJson('icon-interactions.json', iconInteractions),
      fs.writeFile(path.join(opts.out, 'original.html'), originalHtml),
      fs.writeFile(path.join(opts.out, 'styles.css'), stylesheetSource.join('\n\n')),
      writeJson('layout.json', { viewport: layout.viewport, pageSize: layout.pageSize,
        capped: layout.capped, nodes: layout.nodes }),
      writeJson('dom-tree.json', layout.tree),
      writeJson('components.json', layout.components),
      writeJson('design-tokens.json', layout.tokens),
      writeJson('assets.json', [...recorded.values()]),
      writeJson('icons.json', iconReport),
      writeJson('report.json', {
        capturedAt: new Date().toISOString(), sourceUrl: opts.url,
        finalUrl: page.url(), captureDiagnostics,
        iconPolicy: iconReport.policy, iconsComplete: iconReport.complete,
        missingIcons: iconReport.missing.length,
        basicInteractions: recording?.transitions.length || 0,
        interactionMode: interactionReport.mode,
        unresolvedInteractions: snapshot.interactions.unresolved.length,
        interactionStatus: recording ? (recording.errors.length || recording.dropped || recording.ambiguousTransitions.length || recording.probe?.truncated || recording.probe?.attempts.some(a => a.errors.length) ? 'recording-needs-review' : 'recorded-states-unverified') : 'source-recording-required',
        readinessMode: opts.manual ? 'manual' :
          opts.readySelector ? 'selector' : opts.readyText ? 'text' : 'fixed-delay',
        viewport: layout.viewport, pageSize: layout.pageSize,
        capturedNodes: layout.capturedNodes, capped: layout.capped,
        componentCandidates: layout.components.length, assetCount: recorded.size,
        assetBytes: totalBytes, errors: errors.slice(0, 100),
        limitations: [
          'Original scripts are removed. Only observed state transitions are replayed; unrecorded custom handlers are not restored.',
          'Missing resources may still load from their original URLs.',
          'Cross-origin iframe contents, closed shadow roots, canvas pixels and application state are not fully exported.',
          'Only the captured viewport and rendered state are represented.',
          'Do not publish captured files unless you have the required rights.'
        ]
      })
    ]);
    console.log(`Saved ${layout.capturedNodes} nodes, ${recorded.size} assets to ${opts.out}`);
    console.log('Local preview: node serve.mjs ' + opts.out);
    if (snapshot.interactions.unresolved.length) {
      console.warn(`发现 ${snapshot.interactions.unresolved.length} 个尚未恢复的交互控件，请查看 interactions.json；图标完整不代表交互完整。`);
    }
    if (!iconReport.complete) {
      console.error(`Required icons incomplete (${iconReport.missing.length}); see icons.json. Output retained for review.`);
      process.exitCode = 2;
    }
  } finally {
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
