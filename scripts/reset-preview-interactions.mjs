import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 撤销旧版本的推测性交互，保留原页面结构、资源和原生 CSS 行为。
export function clearGuessedInteractions(html) {
  const decode = value => value.replace(/&#(?:x27|39);/gi, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, tag => {
      tag = tag.replace(/\sdata-wrk-[\w-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '');
      if (!/^<meta\b/i.test(tag) || !/http-equiv\s*=\s*["']Content-Security-Policy["']/i.test(tag)) return tag;
      return tag.replace(/\bcontent\s*=\s*(["'])(.*?)\1/i, (_all, quote, raw) => {
        let policy = decode(raw);
        policy = /script-src\s/i.test(policy) ? policy.replace(/script-src\s+[^;]+/i, "script-src 'none'") : "script-src 'none'; " + policy;
        const escaped = policy.replace(/&/g, '&amp;').replace(quote === '"' ? /"/g : /'/g, quote === '"' ? '&quot;' : '&#39;');
        return `content=${quote}${escaped}${quote}`;
      });
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const directory = path.resolve(args[0] || 'output');
  const from = args.indexOf('--from');
  const sourceFile = from >= 0 ? path.resolve(args[from + 1]) : path.join(directory, 'index.html');
  const indexFile = path.join(directory, 'index.html');
  const original = await fs.readFile(indexFile, 'utf8');
  const backup = path.join(directory, 'index.before-original-recording.html');
  try { await fs.writeFile(backup, original, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const html = clearGuessedInteractions(await fs.readFile(sourceFile, 'utf8'));
  await fs.writeFile(indexFile, html);
  await fs.writeFile(path.join(directory, 'interactions.js'), '// 尚未记录原网页操作，不执行推测的交互逻辑。\n');
  for (const file of ['interactions.json', 'report.json']) {
    const fullPath = path.join(directory, file);
    try {
      const data = JSON.parse(await fs.readFile(fullPath, 'utf8'));
      if (file === 'interactions.json') {
        data.retiredInferredControls = data.controls || []; data.controls = [];
        data.mode = 'native-css-only'; data.guessedHandlersEnabled = false;
      } else {
        data.basicInteractions = 0; data.interactionMode = 'native-css-only';
        data.interactionStatus = 'source-recording-required';
      }
      await fs.writeFile(fullPath, JSON.stringify(data, null, 2));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  console.log('已移除推测性交互；原生 HTML/CSS 行为保留，原站自定义交互需要重新记录。');
}
