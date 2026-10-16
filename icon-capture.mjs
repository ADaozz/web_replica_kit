// 在原页面中检查图标依赖；忽略未启用的模板，递归检查图标库常用的开放 Shadow DOM。
export function discoverIcons({ limit = 30000 } = {}) {
  const resources = [];
  const missing = [];
  const fonts = [];
  const sheets = [];
  let inspected = 0;
  let inlineSvg = 0;
  let shadowRoots = 0;
  let truncated = false;
  const seenSheets = new Set();
  function readSheet(sheet) {
    if (!sheet || seenSheets.has(sheet)) return;
    seenSheets.add(sheet);
    try { sheets.push({ css: [...sheet.cssRules].map(r => r.cssText).join('\n'), base: sheet.href || document.baseURI }); }
    catch { /* 无法读取的跨域样式表，改由 Node 端已保存的网络响应正文补查。 */ }
  }
  function add(raw, kind, base = document.baseURI, root = document) {
    if (!raw) return;
    if (raw.startsWith('#')) {
      if (kind === 'icon-mask' && !root.getElementById(raw.slice(1))) {
        missing.push({ kind: 'missing-svg-id', reference: raw });
      }
      return;
    }
    try {
      const url = new URL(raw, base);
      const doc = new URL(document.URL); doc.hash = '';
      const noHash = new URL(url); noHash.hash = '';
      if (url.hash && noHash.href === doc.href) {
        if (!root.getElementById(decodeURIComponent(url.hash.slice(1)))) {
          missing.push({ kind: 'missing-svg-id', reference: url.hash });
        }
        return;
      }
      resources.push({ url: url.href, kind });
    } catch {}
  }
  function urls(value, kind, root) {
    for (const m of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) add(m[2], kind, document.baseURI, root);
  }
  function font(style) {
    if (!style.fontFamily) return;
    for (const family of style.fontFamily.split(',')) {
      fonts.push({ family: family.trim().replace(/^["']|["']$/g, '').toLowerCase(), weight: style.fontWeight });
    }
  }
  function walk(root) {
    for (const sheet of [...(root.styleSheets || []), ...(root.adoptedStyleSheets || [])]) readSheet(sheet);
    for (const el of root.querySelectorAll('*')) {
      if (++inspected > limit) { truncated = true; return; }
      const tag = el.localName;
      if (tag === 'style' || tag === 'link') readSheet(el.sheet);
      const label = `${el.getAttribute('class') || ''} ${el.id || ''} ${el.getAttribute('role') || ''}`;
      const semanticIcon = /(?:icon|glyph|symbol|\bfa[sbrl]?\b|\bbi\b)/i.test(label) || /icon/i.test(tag);
      const rect = el.getBoundingClientRect();
      const small = rect.width > 0 && rect.height > 0 && rect.width <= 96 && rect.height <= 96;
      const style = getComputedStyle(el);
      if (tag === 'svg') inlineSvg++;
      if (tag === 'use') {
        const raw = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
        if (raw.startsWith('#')) {
          if (!root.getElementById(raw.slice(1))) missing.push({ kind: 'missing-svg-id', reference: raw });
        } else add(raw, 'svg-use');
      }
      if (tag === 'image' && el.namespaceURI?.includes('svg')) {
        add(el.getAttribute('href') || el.getAttribute('xlink:href'), 'svg-image');
      }
      if (tag === 'img') {
        const src = el.currentSrc || el.getAttribute('src') || '';
        const avatar = /(?:avatar|portrait|photo|profile|userpic)/i.test(label + ' ' + src) ||
          /^https?:\/\/github\.com\/[^/?]+\.png(?:[?#]|$)/i.test(src);
        if (semanticIcon || (!avatar && small) || /\.svg(?:[?#]|$)/i.test(src)) add(src, 'icon-image');
      }
      if (tag === 'link' && /(?:^|\s)(?:icon|apple-touch-icon)(?:\s|$)/i.test(el.rel)) add(el.href, 'favicon');
      if (semanticIcon && style.display !== 'none' && style.visibility !== 'hidden') font(style);
      if (small || semanticIcon) urls(style.backgroundImage, 'icon-background', root);
      urls(style.maskImage || style.webkitMaskImage || '', 'icon-mask', root);
      for (const pseudo of ['::before', '::after']) {
        const ps = getComputedStyle(el, pseudo);
        if (!ps.content || ['none', 'normal', '""', "''"].includes(ps.content)) continue;
        font(ps);
        urls(ps.content, 'pseudo-image', root);
        urls(ps.backgroundImage, 'icon-background', root);
        urls(ps.maskImage || ps.webkitMaskImage || '', 'icon-mask', root);
      }
      if (el.shadowRoot) { shadowRoots++; walk(el.shadowRoot); }
      else if (/icon/i.test(tag) && tag.includes('-') && !el.querySelector('svg,img') && !el.textContent.trim()) {
        missing.push({ kind: 'unresolved-icon-component', tag });
      }
      if (truncated) return;
    }
  }
  walk(document);
  if (truncated) missing.push({ kind: 'inspection-limit', limit });
  return { resources, missing, fonts: [...new Map(fonts.map(f => [JSON.stringify(f), f])).values()],
    sheets, inspected, inlineSvg, shadowRoots, truncated };
}

export function iconFontSources(css, base, fonts) {
  const families = new Set(fonts.map(f => f.family.toLowerCase()));
  const results = [];
  for (const match of css.matchAll(/@font-face\s*\{([^}]+)\}/gi)) {
    const body = match[1];
    const family = body.match(/font-family\s*:\s*([^;]+)/i)?.[1].trim().replace(/^["']|["']$/g, '').toLowerCase();
    if (!families.has(family)) continue;
    const src = [...body.matchAll(/(?:^|;)\s*src\s*:\s*([^;]+)/gi)].at(-1)?.[1] || '';
    const urls = [...src.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].map(m => m[2]);
    // 每个字体定义选择一种支持的格式，不把旧格式的备用文件列为必需项。
    const chosen = urls.find(u => /\.woff2(?:[?#]|$)/i.test(u)) ||
      urls.find(u => /\.(?:woff|ttf|otf)(?:[?#]|$)/i.test(u)) || urls[0];
    if (chosen) {
      try { results.push({ url: new URL(chosen, base).href, kind: 'icon-font', family }); } catch {}
    }
  }
  return results;
}

// 将请求和存储作为适配器传入，便于离线验证失败、重试和资源预算处理。
export async function completeIcons({ inventory, stylesheets = [], find, read, fetchResource, save }) {
  const deadline = Date.now() + 60000;
  const requirements = [...inventory.resources];
  for (const sheet of [...inventory.sheets, ...stylesheets]) {
    requirements.push(...iconFontSources(sheet.css, sheet.base, inventory.fonts));
  }
  const missing = [...inventory.missing];
  const resources = [];
  const seenRequirements = new Set();
  const fetched = new Map();
  for (const requirement of requirements) {
    let url;
    try { url = new URL(requirement.url); } catch { continue; }
    const fragment = url.hash; url.hash = '';
    const key = url.href;
    const signature = JSON.stringify([key, fragment, requirement.kind]);
    if (seenRequirements.has(signature)) continue;
    seenRequirements.add(signature);
    if (url.protocol === 'data:') {
      resources.push({ ...requirement, url: key, fragment, status: 'embedded' }); continue;
    }
    let resource = find(key);
    if (!resource) {
      if (!fetched.has(key)) {
        fetched.set(key, (async () => {
          let error;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              if (Date.now() >= deadline) throw new Error('Icon collection time budget exhausted');
              const response = await fetchResource(key);
              if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
              if (/text\/html/i.test(response.contentType)) throw new Error('Resource returned HTML');
              return await save(key, response);
            } catch (e) { error = e; }
          }
          throw error;
        })().catch(e => ({ error: String(e.message || e) })));
      }
      resource = await fetched.get(key);
    }
    if (resource && /text\/html/i.test(resource.contentType || '')) {
      resource = { error: 'Saved resource is HTML, not an icon' };
    }
    if (!resource || resource.error) {
      const failure = { ...requirement, fragment, reason: resource?.error || 'Resource not saved' };
      missing.push(failure); resources.push({ ...failure, status: 'missing' }); continue;
    }
    if (fragment && ['svg-use', 'icon-mask'].includes(requirement.kind)) {
      let source;
      try { source = (await read(resource)).toString('utf8'); }
      catch (error) {
        missing.push({ ...requirement, reason: String(error.message || error) });
        resources.push({ ...requirement, status: 'missing' }); continue;
      }
      let id;
      try { id = decodeURIComponent(fragment.slice(1)); } catch { id = fragment.slice(1); }
      const ids = new Set([...source.matchAll(/\bid\s*=\s*(['"])(.*?)\1/g)].map(m => m[2]));
      if (!ids.has(id)) {
        const failure = { ...requirement, fragment, reason: 'SVG fragment ID not found' };
        missing.push(failure); resources.push({ ...failure, status: 'missing' }); continue;
      }
    }
    resources.push({ ...requirement, url: key, fragment, localPath: resource.localPath, status: 'saved' });
  }
  const unresolvedFamilies = new Set();
  for (const font of inventory.fonts) {
    // Platform fallback fonts are not downloadable site icon fonts.
    if (!/^(?:segoe ui symbol|apple symbols)$/i.test(font.family) &&
        /(?:icon|awesome|glyph|material|symbol)/i.test(font.family) &&
        !unresolvedFamilies.has(font.family) &&
        !requirements.some(r => r.kind === 'icon-font' && r.family === font.family)) {
      missing.push({ kind: 'unresolved-icon-font', family: font.family });
      unresolvedFamilies.add(font.family);
    }
  }
  return { policy: 'icons-required-images-optional', complete: missing.length === 0,
    inspected: inventory.inspected, inlineSvg: inventory.inlineSvg, shadowRoots: inventory.shadowRoots,
    resources, missing, limitations: ['Raster icon detection uses size and semantic hints; ambiguous images require review.',
      'Closed shadow roots and icons that have not been rendered cannot be inspected.'] };
}

export function inlineSpriteSymbols(html, sources = []) {
  const byId = new Map();
  for (const source of sources) {
    for (const match of String(source).matchAll(/<symbol\b[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<\/symbol>/g)) {
      if (!byId.has(match[1])) byId.set(match[1], match[0]);
      else if (byId.get(match[1]) !== match[0]) byId.set(match[1], null);
    }
  }
  const present = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
  // Keep external references unless the matching symbol can actually be embedded.
  // Images, links and non-symbol fragments must retain their own resource URLs.
  const next = html.replace(/<use\b[^>]*>/gi, tag => tag.replace(
    /((?:href|xlink:href)=")(?:\.\/)?assets\/[^"]+\.svg#([^"]+)"/g,
    (reference, prefix, id) => byId.get(id) && !present.has(id) ? prefix + '#' + id + '"' : reference));
  const needed = [];
  for (const match of next.matchAll(/(?:href|xlink:href)="#([^"]+)"/g)) {
    if (!present.has(match[1]) && byId.get(match[1]) && !needed.includes(match[1])) needed.push(match[1]);
  }
  if (!needed.length) return next;
  const sprite = `<svg id="wrk-sprite" aria-hidden="true" width="0" height="0" style="position:absolute"><defs>${needed.map(id => byId.get(id)).join('')}</defs></svg>`;
  return next.replace(/<body([^>]*)>/i, `<body$1>${sprite}`);
}
