// Localized resources no longer share their original CORS origin.
// Never edit inline scripts: their CSP hashes must remain valid.
export function finalizeSnapshotResources(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<!--[\s\S]*?-->|<(?:[^>"']|"[^"]*"|'[^']*')*>/gi, tag => {
    if (/^<(?:script|style)\b|^<!--/i.test(tag)) return tag;
    const attrs = new Map();
    for (const match of tag.matchAll(/\s([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attrs.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
    }
    if (/^<link\b/i.test(tag)) {
      const rel = (attrs.get('rel') || '').toLowerCase().split(/\s+/);
      if (rel.includes('modulepreload') ||
          (rel.some(value => ['preload', 'prefetch'].includes(value)) && attrs.get('as')?.toLowerCase() === 'script')) return '';
    }
    if (['src', 'href', 'poster', 'background', 'data', 'xlink:href', 'srcset', 'imagesrcset'].some(name =>
      /^(?:\.\/)?assets\//i.test(attrs.get(name) || ''))) {
      return tag.replace(/\s([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g,
        (attribute, name) => /^(?:crossorigin|integrity)$/i.test(name) ? '' : attribute);
    }
    return tag;
  });
}

// Rewrite late resources without changing stylesheet boundaries or text nodes.
export function rewriteSnapshotAssets(html, mappings, sourceURL) {
  const decode = value => value.replace(/&quot;/g, '"').replace(/&#(?:39|x27);/gi, "'").replace(/&amp;/g, '&');
  const encode = (value, quote) => value.replace(/&/g, '&amp;').replace(quote === '"' ? /"/g : /'/g, quote === '"' ? '&quot;' : '&#39;');
  function map(raw) {
    if (!raw || /^(?:assets\/|#|data:|about:|javascript:)/i.test(raw)) return raw;
    try {
      const url = new URL(raw, sourceURL); const fragment = url.hash; url.hash = '';
      return mappings[url.href] ? mappings[url.href] + fragment : raw;
    } catch { return raw; }
  }
  const rewriteCSS = css => css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi,
    (_all, _quote, value) => `url("${map(value).replace(/"/g, '%22')}")`)
    .replace(/(@import\s+)(['"])([^'"\n]+)\2/gi,
      (_all, prefix, quote, value) => `${prefix}${quote}${map(value)}${quote}`);
  const rewritten = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>|<(?:[^>"']|"[^"]*"|'[^']*')*>/gi, tag => {
    if (/^<style\b/i.test(tag)) return tag.replace(/(^<style\b[^>]*>)([\s\S]*)(<\/style>$)/i,
      (_all, open, css, close) => open + rewriteCSS(css) + close);
    return tag.replace(/\b(src|href|poster|background|data|xlink:href|style|srcset|imagesrcset)\s*=\s*(["'])([\s\S]*?)\2/gi,
      (_all, name, quote, raw) => {
        const value = decode(raw);
        const rewritten = name.toLowerCase() === 'style' ? rewriteCSS(value) :
          /srcset$/i.test(name) ? rewriteSrcsetUrls(value,map) : map(value);
        return `${name}=${quote}${encode(rewritten, quote)}${quote}`;
      });
  });
  return finalizeSnapshotResources(rewritten);
}

// URL tokens may contain commas (notably data URLs); descriptors end a candidate.
export function rewriteSrcsetUrls(input,map) {
  const candidates=[];let i=0;
  while(i<input.length) {
    while(/[\s,]/.test(input[i] || '')&&i<input.length)i++;
    if(i>=input.length)break;
    const start=i;while(i<input.length&&!/\s/.test(input[i]))i++;
    let url=input.slice(start,i),descriptor='';
    if(url.endsWith(',')){url=url.replace(/,+$/,'');}
    else {
      let parens=0;const d=i;
      while(i<input.length){const c=input[i];if(c==='(')parens++;if(c===')')parens--;if(c===','&&!parens)break;i++;}
      descriptor=input.slice(d,i).trim();if(input[i]===',')i++;
    }
    if(url)candidates.push(map(url)+(descriptor?' '+descriptor:''));
  }
  return candidates.join(', ');
}
