import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { auditSnapshot } from './audit-snapshot.mjs';
import { scrollToLoadLazyAssets } from '../capture.mjs';

const root = path.resolve(import.meta.dirname, '..');
const exec = promisify(execFile);
const matrix = JSON.parse(await fs.readFile(path.join(root, 'tests/site-matrix.json'), 'utf8'));
const args = process.argv.slice(2);
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const selected = arg('--only', '').split(',').filter(Boolean);
const cases = matrix.filter(site => !selected.length || selected.includes(site.id));
if (!cases.length) throw new Error('No matching sites');
const out = path.resolve(arg('--out', path.join(root, 'test-results/sites-' + new Date().toISOString().replace(/[:.]/g, '-'))));
const widths = arg('--widths', '1440,390').split(',').map(Number);
if (widths.some(w => !Number.isInteger(w) || w < 320 || w > 3840)) throw new Error('Invalid widths');
const executable = arg('--executable', undefined);
const launchOptions = executable ? { executablePath: executable } : {};
await fs.mkdir(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), widths, cases: [], environmentError: null,
  notes: ['No private browser profile is used.', 'Exact screenshot equality is strict; differences require review.',
    'Canvas, Shadow DOM, animation, form sanitization and responsive layouts may differ.',
    'This tests the captured initial state; it does not test source-site interactions.'] };
const writeReport = () => fs.writeFile(path.join(out, 'summary.json'), JSON.stringify(report, null, 2));
let browser;
let server;
try {
  // 先检查浏览器和本地监听是否可用，避免环境异常被误记为网站采集失败。
  browser = await chromium.launch(launchOptions);
  const types = { '.html': 'text/html', '.svg': 'image/svg+xml', '.css': 'text/css',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon' };
  server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const file = path.resolve(out, '.' + pathname);
      if (!file.startsWith(out + path.sep)) { res.writeHead(403); res.end(); return; }
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const site of cases) for (const width of widths) {
    const id = site.id + '-' + width;
    const directory = path.join(out, id);
    const result = { id, url: site.url, coverage: site.coverage, width, status: 'running' };
    report.cases.push(result);
    console.log('Testing', id, site.url);
    let context;
    try {
      const captureArgs = ['capture.mjs', '--url', site.url, '--out', directory, '--width', String(width),
        '--height', '900', '--wait', '3000', '--max-nodes', '20000',
        '--ready-selector', site.ready, '--ready-timeout', '60000'];
      if (executable) captureArgs.push('--executable', executable);
      let captured;
      try { captured = await exec(process.execPath, captureArgs, { cwd: root, timeout: 240000, maxBuffer: 4 * 1024 * 1024 }); }
      catch (error) {
        // 退出码 2 表示图标未拿齐，但输出和报告已保留，仍可继续检查预览。
        if (error.code !== 2) throw error;
        captured = { stdout: error.stdout || '', stderr: error.stderr || '' };
      }
      await fs.writeFile(path.join(directory, 'capture.log'), captured.stdout + captured.stderr);
      result.capture = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8'));
      result.icons = JSON.parse(await fs.readFile(path.join(directory, 'icons.json'), 'utf8'));
      result.controls = JSON.parse(await fs.readFile(path.join(directory, 'interactions/controls.json'), 'utf8'));
      result.iconStatus = result.icons.complete ? 'complete' : 'incomplete';
      result.audit = await auditSnapshot(directory);
      context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
      const remote = new Set();
      const missing = new Set();
      const requiredRemote = new Set();
      const requiredMissing = new Set();
      const iconURLs = new Set(result.icons.resources.map(r => r.url));
      const iconPaths = new Set(result.icons.resources.filter(r => r.localPath)
        .map(r => `${origin}/${id}/${r.localPath}`));
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) {
          remote.add(url.href);
          url.hash = '';
          if (route.request().resourceType() !== 'image' || iconURLs.has(url.href)) requiredRemote.add(url.href);
          return route.abort();
        }
        return route.continue();
      });
      const page = await context.newPage();
      page.on('response', res => {
        if (res.status() >= 400) {
          missing.add(res.url());
          if (res.request().resourceType() !== 'image' || iconPaths.has(res.url())) requiredMissing.add(res.url());
        }
      });
      page.on('requestfailed', req => {
        if (req.url().startsWith(origin + '/')) {
          missing.add(req.url());
          if (req.resourceType() !== 'image' || iconPaths.has(req.url())) requiredMissing.add(req.url());
        }
      });
      await page.goto(`${origin}/${id}/index.html`, { waitUntil: 'load', timeout: 60000 });
      await scrollToLoadLazyAssets(page);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1000);
      result.preview = await page.evaluate(() => ({
        brokenImages: [...document.images].filter(img => img.complete && img.naturalWidth === 0 &&
          (img.currentSrc || img.getAttribute('src'))).length,
        pendingImages: [...document.images].filter(img => !img.complete).length,
        svgUses: document.querySelectorAll('use').length,
        canvasElements: document.querySelectorAll('canvas').length,
        pageSize: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }
      }));
      const sourceLayout = JSON.parse(await fs.readFile(path.join(directory, 'layout.json'), 'utf8'));
      result.layout = await page.evaluate(nodes => {
        let checked = 0;
        let missing = 0;
        let changed = 0;
        const differences = [];
        for (const node of nodes.filter(node => !node.frameIndex && node.visible && node.rect.width > 0 && node.rect.height > 0)) {
          let el;
          try {let scope=document;for(const part of node.selector.split('>>>').map(s=>s.trim())){el=scope?.querySelector(part);scope=el?.shadowRoot;}} catch { missing++;continue; }
          checked++;
          if (!el) { missing++; continue; }
          const rect = el.getBoundingClientRect();
          const actual = { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
          if (Object.keys(actual).some(key => Math.abs(actual[key] - node.rect[key]) > 2)) {
            changed++;
            if (differences.length < 30) differences.push({ selector: node.selector, expected: node.rect, actual });
          }
        }
        return { checked, missing, changed, matches: missing === 0 && changed === 0, tolerancePx: 2, differences };
      }, sourceLayout.nodes);
      const screenshot = await page.screenshot({ path: path.join(directory, 'preview.png'), fullPage: true,
        animations: 'disabled', timeout: 30000 });
      result.screenshotIdentical = screenshot.equals(await fs.readFile(path.join(directory, 'screenshot.png')));
      result.remoteRequests = [...remote];
      result.missingLocalRequests = [...missing];
      result.requiredRemoteRequests = [...requiredRemote];
      result.requiredMissingLocalRequests = [...requiredMissing];
      result.optionalImageStatus = result.preview.brokenImages || result.preview.pendingImages ? 'missing-or-pending' : 'loaded';
      result.resourceStatus = !result.icons.complete || requiredMissing.size || requiredRemote.size ? 'incomplete' : 'no-runtime-failures';
      result.status = result.capture.captureDiagnostics.loadingScreenPossible ? 'source-not-ready' :
        !result.icons.complete ? 'icons-incomplete' :
        result.resourceStatus !== 'no-runtime-failures' ||
        result.capture.errors.length || result.capture.capped || result.interactions.unresolved.length ||
        !result.layout.matches || !result.screenshotIdentical ? 'needs-review' : 'passed';
      await fs.writeFile(path.join(directory, 'compare.html'), `<!doctype html><meta charset="utf-8"><title>Source / offline preview</title>
<style>body{font:16px system-ui}main{display:flex;gap:16px}section{width:50%;min-width:0}img{width:100%}</style>
<p>Source / offline preview. Any visual difference requires review.</p><main><section><h2>Source</h2><img src="screenshot.png"></section><section><h2>Offline preview</h2><img src="preview.png"></section></main>`);
    } catch (error) {
      result.status = 'failed'; result.error = String(error.stderr || error.message || error).slice(0, 12000);
    } finally {
      await context?.close();
      await writeReport();
      console.log(id, result.status);
    }
  }
} catch (error) {
  report.environmentError = String(error.message || error).slice(0, 12000);
  for (const site of cases) for (const width of widths) {
    report.cases.push({ id: site.id + '-' + width, url: site.url, coverage: site.coverage, width,
      status: 'not-run', reason: 'Environment preflight failed; no website capture attempted.' });
  }
  console.error('Environment preflight failed:', report.environmentError.split('\n')[0]);
} finally {
  await browser?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  report.finishedAt = new Date().toISOString();
  await writeReport();
  console.log('Report:', path.join(out, 'summary.json'));
  if (report.environmentError || report.cases.some(c => c.status !== 'passed')) process.exitCode = 1;
}
