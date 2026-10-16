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
    if (['src', 'href', 'poster', 'data', 'xlink:href', 'srcset', 'imagesrcset'].some(name =>
      /^(?:\.\/)?assets\//i.test(attrs.get(name) || ''))) {
      return tag.replace(/\s([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g,
        (attribute, name) => /^(?:crossorigin|integrity)$/i.test(name) ? '' : attribute);
    }
    return tag;
  });
}
