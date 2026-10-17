import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 未启用的模板不会渲染；按嵌套层级排除，避免将模板内的引用误报为页面资源故障。
function withoutTemplates(html) {
  let depth = 0;
  let start = 0;
  let result = '';
  for (const match of html.matchAll(/<\/?template\b[^>]*>/gi)) {
    if (!match[0].startsWith('</')) {
      if(depth===0 && /shadowrootmode\s*=/.test(match[0]))continue;
      if (depth === 0) result += html.slice(start, match.index);
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) start = match.index + match[0].length;
    }
  }
  return result + (depth === 0 ? html.slice(start) : '');
}

// 这里只做静态诊断；没有发现引用问题不代表视觉还原通过。
export async function auditSnapshot(directory) {
  const root = path.resolve(directory);
  const html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
  const activeHtml = withoutTemplates(html);
  const {resources: assets} = JSON.parse(await fs.readFile(path.join(root, 'assets.json'), 'utf8'));
  const mapping = new Map(assets.flatMap(a => [a.url, ...(a.aliases || [])].map(url => [url, a.localPath])));
  const issues = [];
  const stats = { assets: assets.length, svgUses: 0,
    excludedTemplateSvgUses: [...html.matchAll(/<use\b/gi)].length - [...activeHtml.matchAll(/<use\b/gi)].length,
    localSvgUses: 0, remoteSvgUses: 0,
    repairableSvgUses: 0, cssReferences: 0, missingFiles: 0, missingSvgIds: 0 };
  const cache = new Map();
  const ids = text => new Set([...text.matchAll(/\bid\s*=\s*(["'])(.*?)\1/gi)].map(m => m[2]));
  const inlineIds = ids(activeHtml);
  async function readLocal(url) {
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep)) throw new Error('Path outside snapshot');
    if (!cache.has(file)) cache.set(file, fs.readFile(file, 'utf8').catch(() => null));
    return cache.get(file);
  }
  for (const asset of assets) {
    const file = path.resolve(root, asset.localPath);
    if (!file.startsWith(root + path.sep)) {
      issues.push({ kind: 'unsafe-asset-path', path: asset.localPath }); continue;
    }
    try { await fs.access(file); } catch {
      stats.missingFiles++; issues.push({ kind: 'missing-recorded-asset', path: asset.localPath });
    }
  }
  for (const use of activeHtml.matchAll(/<use\b([^>]*)>/gi)) {
    const raw = use[1].match(/(?:^|\s)(?:xlink:)?href\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!raw) continue;
    stats.svgUses++;
    if (raw.startsWith('#')) {
      if (!inlineIds.has(raw.slice(1))) {
        stats.missingSvgIds++; issues.push({ kind: 'missing-inline-svg-id', reference: raw });
      }
      continue;
    }
    const url = new URL(raw.replace(/&amp;/g, '&'), 'http://snapshot.local/index.html');
    if (url.origin !== 'http://snapshot.local') {
      stats.remoteSvgUses++;
      const fragment = url.hash; url.hash = '';
      const saved = mapping.get(url.href);
      if (saved) stats.repairableSvgUses++;
      issues.push({ kind: 'remote-svg-use', reference: raw, ...(saved ? { saved, fragment } : {}) });
      continue;
    }
    stats.localSvgUses++;
    const svg = await readLocal(url);
    if (svg === null) {
      stats.missingFiles++; issues.push({ kind: 'missing-svg-file', reference: raw });
    } else if (url.hash && !ids(svg).has(decodeURIComponent(url.hash.slice(1)))) {
      stats.missingSvgIds++; issues.push({ kind: 'missing-external-svg-id', reference: raw });
    }
  }
  const cssTexts = [{ text: [...activeHtml.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n'), base: 'http://snapshot.local/index.html' }];
  for (const asset of assets.filter(a => a.localPath.endsWith('.css'))) {
    const base = new URL(asset.localPath, 'http://snapshot.local/');
    const text = await readLocal(base);
    if (text !== null) cssTexts.push({ text, base: base.href });
  }
  for (const { text, base } of cssTexts) {
    const references=[...text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].map(m=>m[2]);
    references.push(...[...text.matchAll(/@import\s+(['"])([^'"\n]+)\1/gi)].map(m=>m[2]));
    for (const reference of references) {
      const raw = reference.trim();
      if (!raw || /^(?:#|data:|blob:)/i.test(raw)) continue;
      stats.cssReferences++;
      let url;
      try { url = new URL(raw, base); } catch { continue; }
      if (url.origin !== 'http://snapshot.local') {
        issues.push({ kind: 'remote-css-resource', reference: raw });
      } else if (await readLocal(url) === null) {
        stats.missingFiles++; issues.push({ kind: 'missing-css-resource', reference: raw });
      }
    }
  }
  return { directory: root, kind: 'static-audit', visualVerification: false, stats,
    issueCount: issues.length, issues: issues.slice(0, 1000), truncated: issues.length > 1000 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const results = [];
  for (const directory of process.argv.slice(2)) {
    const result = await auditSnapshot(directory);
    results.push(result);
    console.log(path.basename(directory), JSON.stringify(result.stats), 'issues:', result.issueCount);
  }
  await fs.mkdir('test-results', { recursive: true });
  await fs.writeFile('test-results/existing-snapshots.json', JSON.stringify(results, null, 2));
}
