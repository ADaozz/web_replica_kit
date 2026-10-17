import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { makeSnapshotHtml } from '../capture.mjs';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const css = `body { margin: 0; background: white; } svg, img, .icon { width: 40px; height: 40px; display: inline-block; }
.external { background: url('../sprite.svg?theme=light#image') center/contain; }
.mask { background: #128040; mask: url('../mask.svg#shape') center/contain no-repeat; }`;
const integrity = 'sha256-' + crypto.createHash('sha256').update(css).digest('base64');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
<symbol id="square" viewBox="0 0 40 40"><path fill="#e84820" d="M2 2h36v36H2z"/></symbol>
<symbol id="circle" viewBox="0 0 40 40"><circle fill="#1b62ca" cx="20" cy="20" r="18"/></symbol>
<path fill="#b345b3" d="M20 2 38 38H2z"/></svg>`;
const mask = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle id="shape" fill="black" cx="20" cy="20" r="18"/></svg>';

test('SVG sprite fragments, redirected URLs, CSS icons and base URLs survive offline preview', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'replica-icons-'));
  const source = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/redirect.svg') {
      res.writeHead(302, { Location: '/sprite.svg?theme=light' }); res.end(); return;
    }
    if (pathname === '/nested/icons.css') {
      res.setHeader('Content-Type', 'text/css'); res.end(css); return;
    }
    if (pathname === '/sprite.svg' || pathname === '/mask.svg') {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.end(pathname === '/sprite.svg' ? svg : mask); return;
    }
    if (pathname === '/app.js') {
      res.setHeader('Content-Type', 'text/javascript'); res.end('window.sourceOnly = true;'); return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><base href="/nested/">
<link rel="stylesheet" href="icons.css" integrity="${integrity}">
<link rel="stylesheet" href="icons.css" crossorigin="anonymous">
<link rel="modulepreload" href="../app.js">
<style>@import "icons.css"; .inline { background: url('../sprite.svg?theme=light#image') center/contain; }</style></head>
<body><span class="ready" style="display:none">Hidden readiness match</span><span class="ready">Ready</span>
<svg><use href="../sprite.svg?theme=light#square"/></svg>
<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="../sprite.svg?theme=light#circle"/></svg>
<svg><use href="../redirect.svg#square"/></svg>
<svg><defs><path id="inline" d="M2 2h36v36H2z"/></defs><use href="#inline" fill="#128040"/></svg>
<img src="../sprite.svg?theme=light#image"><span class="icon external"></span>
<span class="icon inline"></span><span class="icon mask"></span><x-icon></x-icon>
<button id="toggle-panel" aria-expanded="false" aria-controls="panel">展开收起</button><section id="panel" hidden>面板内容</section>
<button id="hover-tip" aria-describedby="tip">悬停提示</button><div id="tip" role="tooltip" hidden>提示内容</div>
<div class="dropdown"><button id="toggle-menu" data-bs-toggle="dropdown" aria-expanded="false">菜单</button><div id="menu" class="dropdown-menu" hidden>菜单内容</div></div>
<details id="details"><summary>原生展开</summary>详细内容</details>
<script>customElements.define('x-icon', class extends HTMLElement {
  constructor() { super(); const root = this.attachShadow({mode:'open'});
    root.innerHTML = '<svg width="40" height="40"><circle class="glyph" cx="20" cy="20" r="18"/></svg>';
    const sheet = new CSSStyleSheet(); sheet.replaceSync('.glyph { fill: #e84820; }');
    root.adoptedStyleSheets = [sheet];
  }
});</script></body></html>`);
  });
  let preview;
  let browser;
  try {
    await new Promise((resolve, reject) => { source.once('error', reject); source.listen(0, '127.0.0.1', resolve); });
    const sourceUrl = `http://127.0.0.1:${source.address().port}`;
    await exec(process.execPath, ['scripts/capture.mjs', '--url', sourceUrl + '/nested/', '--out', out,
      '--ready-selector', '.ready', '--ready-timeout', '3000'], {
      cwd: root, timeout: 60000
    });
    const html = await fs.readFile(path.join(out, 'index.html'), 'utf8');
    const {resources:assets,icons} = JSON.parse(await fs.readFile(path.join(out, 'assets.json'), 'utf8'));
    assert.equal(icons.complete, true);
    assert.equal(icons.shadowRoots, 1);
    assert.ok(html.includes('shadowrootmode="open"'), 'shadow icon serialized');
    assert.ok(html.includes('.glyph'), 'adopted shadow styles serialized');
    const sprite = assets.find(asset => asset.url === sourceUrl + '/sprite.svg?theme=light');
    assert.ok(sprite, 'sprite resource saved');
    assert.ok(html.includes('href="#square"') && html.includes('<symbol id="square"'), 'sprite embedded for file previews');
    assert.ok(html.includes('xlink:href="#circle"') && html.includes('<symbol id="circle"'));
    assert.ok(html.includes('href="#inline"'), 'inline references preserved');
    assert.ok(!html.includes('integrity='), 'rewritten CSS must not retain stale SRI');
    assert.ok(!html.includes('crossorigin='), 'downloaded resources must load via file URLs');
    assert.ok(!html.includes('rel="modulepreload"'), 'removed source scripts must not be preloaded');
    assert.ok(!html.includes(sourceUrl), 'all fixture resource references localized');
    assert.match(html, /@import\s+(?:url\()?["']assets\//, 'inline CSS imports localized');
    const stylesheet = assets.find(asset => asset.type === 'stylesheet');
    const savedCss = await fs.readFile(path.join(out, stylesheet.localPath), 'utf8');
    assert.ok(savedCss.includes(`./${path.basename(sprite.localPath)}#image`));
    assert.ok(!savedCss.includes(sourceUrl));

    // 验证时关闭源站服务，任何残留远程依赖都应失败。
    await new Promise(resolve => source.close(resolve));
    preview = http.createServer(async (req, res) => {
      try {
        const filename = new URL(req.url, 'http://localhost').pathname;
        const types = { '.svg': 'image/svg+xml', '.css': 'text/css', '.html': 'text/html; charset=utf-8' };
        res.setHeader('Content-Type', types[path.extname(filename)] || 'text/html');
        res.end(await fs.readFile(path.join(out, filename === '/' ? 'index.html' : filename)));
      } catch { res.writeHead(404); res.end(); }
    });
    await new Promise(resolve => preview.listen(0, '127.0.0.1', resolve));
    const localUrl = `http://127.0.0.1:${preview.address().port}`;
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const failures = [];
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== localUrl) {
        failures.push(route.request().url()); return route.abort();
      }
      return route.continue();
    });
    page.on('requestfailed', req => failures.push(req.url()));
    page.on('response', res => { if (res.status() >= 400) failures.push(res.url()); });
    await page.goto(localUrl, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('x-icon svg').count(), 1, 'declarative shadow icon renders without scripts');
    assert.equal(await page.locator('.external').evaluate(el => getComputedStyle(el).width), '40px');
    const screenshot = await page.screenshot({ animations: 'allow' });
    assert.deepEqual(failures, [], 'offline preview has no missing or remote requests');
    if (!screenshot.equals(await fs.readFile(path.join(out, 'screenshot.png')))) {
      const evidence = path.join(root, 'test-results', 'icon-pixel-diff');
      await fs.mkdir(evidence, { recursive:true });
      await fs.writeFile(path.join(evidence, 'preview.png'), screenshot);
      await fs.copyFile(path.join(out, 'screenshot.png'), path.join(evidence, 'source.png'));
    }
    assert.ok(screenshot.equals(await fs.readFile(path.join(out, 'screenshot.png'))),
      'offline preview pixels match captured source, including all icons');
    // 默认快照不根据属性猜测原站事件，只保留原生交互。
    await page.locator('#toggle-panel').click();
    assert.equal(await page.locator('#panel').isVisible(), false);
    await page.locator('#details summary').click();
    assert.equal(await page.locator('#details').getAttribute('open'), '');
    const filePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const failedStyles = [];
    filePage.on('requestfailed', req => {
      if (req.resourceType() === 'stylesheet') failedStyles.push(req.url());
    });
    await filePage.route(/^https?:/, route => route.abort());
    const { pathToFileURL } = await import('node:url');
    await filePage.goto(pathToFileURL(path.join(out, 'index.html')).href);
    assert.deepEqual(failedStyles, [], 'localized stylesheets load without file CORS errors');
    assert.equal(await filePage.locator('body').evaluate(el => getComputedStyle(el).margin), '0px');
    assert.equal(await filePage.locator('.external').evaluate(el => getComputedStyle(el).width), '40px');
    assert.equal(await filePage.evaluate(() => window.sourceOnly), undefined);
  } finally {
    await browser?.close();
    if (source.listening) await new Promise(resolve => source.close(resolve));
    if (preview?.listening) await new Promise(resolve => preview.close(resolve));
    await fs.rm(out, { recursive: true, force: true });
  }
});
