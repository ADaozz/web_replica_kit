// 在原网页中检查所有常见图标形式，按实际 DOM 向上寻找交互宿主，不推断网站类型。
export function analyzeIconInteractions({ limit = 30000 } = {}) {
  const roles = new Set(['button', 'link', 'combobox', 'tab', 'switch', 'menuitem', 'checkbox', 'radio']);
  const rows = [];
  let scanned = 0;
  let truncated = false;
  function selector(el) {
    const parts = [];
    let current = el;
    while (current?.nodeType === 1) {
      if (current.id) { parts.unshift('#' + CSS.escape(current.id)); break; }
      let nth = 1;
      for (let previous = current.previousElementSibling; previous; previous = previous.previousElementSibling) {
        if (previous.localName === current.localName) nth++;
      }
      parts.unshift(`${current.localName}:nth-of-type(${nth})`);
      current = current.parentElement;
    }
    const scope = el.getRootNode();
    return scope.host ? selector(scope.host) + ' >>> ' + parts.join(' > ') : parts.join(' > ');
  }
  function owner(icon) {
    let fallback = null;
    for (let el = icon; el; el = el.parentElement || el.getRootNode()?.host) {
      if (el.localName === 'body' || el.localName === 'html') break;
      if (['button', 'a', 'summary', 'input', 'select'].includes(el.localName) || roles.has(el.getAttribute('role')) ||
          ['aria-expanded', 'aria-haspopup', 'aria-pressed', 'onclick'].some(name => el.hasAttribute(name))) {
        return { element: el, basis: 'semantic-or-declared-control' };
      }
      if (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') fallback = el;
      if (!fallback && getComputedStyle(el).cursor === 'pointer') fallback = el;
    }
    return fallback ? { element: fallback, basis: 'focusable-element-only' } : null;
  }
  function walk(root) {
    for (const el of root.querySelectorAll('*')) {
      if (++scanned > limit) { truncated = true; return; }
      const tag = el.localName;
      const hint = `${el.getAttribute('class') || ''} ${el.getAttribute('data-icon-name') || ''}`;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const formats = [];
      if (tag === 'svg') formats.push('svg');
      if (el.hasAttribute('data-icon-name') || /(?:icon|glyph|\bfa[sbrl]?\b|\bbi\b)/i.test(hint)) formats.push('icon-element');
      if (tag === 'img' && (/\.svg(?:[?#]|$)/i.test(el.currentSrc || el.getAttribute('src') || '') || /icon|glyph/i.test(hint))) formats.push('icon-image');
      if (tag === 'img' && !formats.length && rect.width > 0 && rect.width <= 96 && rect.height > 0 && rect.height <= 96) formats.push('small-image-candidate');
      if (style.maskImage && style.maskImage !== 'none') formats.push('css-mask');
      if (rect.width > 0 && rect.width <= 96 && rect.height > 0 && rect.height <= 96 &&
          style.backgroundImage && style.backgroundImage !== 'none') formats.push('small-css-background');
      for (const pseudo of ['::before', '::after']) {
        const ps = getComputedStyle(el, pseudo);
        if (ps.content && !['none', 'normal', '""', "''"].includes(ps.content) &&
            (/[\uE000-\uF8FF]/u.test(ps.content) || /icon|awesome|glyph|symbol/i.test(ps.fontFamily) || /url\(/i.test(ps.content))) {
          formats.push(pseudo);
        }
      }
      if (formats.length) {
        const host = owner(el);
        const row = { id: rows.length + 1, selector: selector(el), formats,
          iconName: el.getAttribute('data-icon-name'),
          visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
          host: host ? { selector: selector(host.element), tag: host.element.localName,
            label: host.element.getAttribute('aria-label') || host.element.getAttribute('title') || null,
            role: host.element.getAttribute('role'), expanded: host.element.getAttribute('aria-expanded'),
            pressed: host.element.getAttribute('aria-pressed'), popup: host.element.getAttribute('aria-haspopup'),
            disabled: host.element.hasAttribute('disabled') || host.element.getAttribute('aria-disabled') === 'true',
            basis: host.basis } : null,
          status: host ? 'control-host-associated' : 'no-host-identified' };
        rows.push(row);
      }
      if (el.shadowRoot) walk(el.shadowRoot);
      if (truncated) return;
    }
  }
  walk(document);
  return { totalIcons: rows.length, scannedElements: scanned, truncated, icons: rows,
    interactiveHosts: new Set(rows.filter(r => r.host).map(r => r.host.selector)).size,
    limitations: ['装饰图标和自定义事件宿主可能无法仅凭 DOM 区分。',
      '闭合 Shadow DOM、跨源 iframe 和尚未渲染的图标不在本次检查范围。',
      '同一图标可能由多个候选 DOM 节点构成，候选数量不等于独立图形数量。',
      '宿主关系不是原站逻辑；交互后的 DOM、截图和状态变化须在原网页操作后记录。'] };
}
