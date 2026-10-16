// Structured evidence for controls AND changed content, including open shadow roots.
export function readDocumentState({ limit = 8000 } = {}) {
  const nodes = [];
  const skip = new Set(['html','head','script','style','link','meta','title','noscript','template']);
  function selector(el) {
    const root = el.getRootNode();
    const prefix = root.host ? `${selector(root.host)} >>> ` : '';
    if (el.id && root.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return prefix + `#${CSS.escape(el.id)}`;
    const parent = el.parentElement;
    const part = `${el.localName}:nth-of-type(${parent ? [...parent.children].filter(n => n.localName === el.localName).indexOf(el) + 1 : 1})`;
    return parent ? `${selector(parent)} > ${part}` : prefix + part;
  }
  function walk(root) {
    for (const el of root.querySelectorAll('*')) {
      if (nodes.length >= limit) return;
      if (skip.has(el.localName)) continue;
      const s = getComputedStyle(el), b = el.getBoundingClientRect();
      let internalX=0, internalY=0;
      for (let p=el.parentElement;p && p!==document.documentElement && p!==document.body;p=p.parentElement) {internalX+=p.scrollLeft;internalY+=p.scrollTop;}
      const animating = el.getAnimations?.().some(a => a.playState === 'running') || false;
      const sensitive = el.matches('input[type=password],input[type=file]') || /token|secret|password/i.test(`${el.id} ${el.getAttribute('name') || ''}`);
      const clone = el.cloneNode(true);
      clone.querySelectorAll('script').forEach(n => n.remove());
      for (const node of [clone,...clone.querySelectorAll('*')]) for (const a of [...node.attributes]) if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^javascript:/i.test(a.value))) node.removeAttribute(a.name);
      for (const field of [clone, ...clone.querySelectorAll('input,textarea')]) {
        if (field.localName === 'textarea') field.textContent = '';
        if (field.localName === 'input') field.removeAttribute('value');
      }
      const popover = el.hasAttribute('popover') ? el.matches(':popover-open') : null;
      nodes.push({ key: selector(el), selector: selector(el), parent: el.parentElement ? selector(el.parentElement) : (root.host ? `${selector(root.host)} >>>` : null), nextSibling: el.nextElementSibling ? selector(el.nextElementSibling) : null,
        visible: !el.hidden && s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0 && popover !== false,
        attributes: Object.fromEntries([...el.attributes].filter(a => !(['style','class'].includes(a.name) && !a.value.trim())).filter(a => /^(aria-|data-state$|class$|style$|hidden$|open$|popover$)/.test(a.name)).map(a => [a.name,a.value])),
        modal: el.localName === 'dialog' ? el.matches(':modal') : null,
        text: sensitive ? null : [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(''),
        html: sensitive ? null : clone.outerHTML, leaf: el.children.length === 0, popover,
        value: !sensitive && 'value' in el ? String(el.value) : null,
        checked: 'checked' in el ? el.checked : null, selected: 'selected' in el ? el.selected : null,
        bbox: { x: b.x, y: b.y, width: b.width, height: b.height },
        animating,
        documentBox: { x: b.x + scrollX + internalX, y: b.y + scrollY + internalY, width: b.width, height: b.height },
        layout: { position: s.position, transform: s.transform, display: s.display, visibility: s.visibility, offsetParent: el.offsetParent ? selector(el.offsetParent) : null },
        scroll: { x: el.scrollLeft, y: el.scrollTop }, noise: /timestamp|clock|nonce|uuid/i.test(`${el.id} ${el.className}`) });
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  }
  walk(document);
  let historyState = null;
  try { historyState = JSON.parse(JSON.stringify(history.state)); } catch {}
  let active=document.activeElement;
  while (active?.shadowRoot?.activeElement) active=active.shadowRoot.activeElement;
  return { focus:active ? selector(active):null, nodes, viewport: { width: innerWidth, height: innerHeight }, scroll: { x: scrollX, y: scrollY }, historyState, truncated: nodes.length >= limit };
}

export async function captureStructuredState(page) {
  const url = new URL(page.url());
  const nodes = [], frames = [];
  for (const [index, frame] of page.frames().entries()) {
    try {
      const snapshot = await frame.evaluate(readDocumentState, {});
      frames.push({ index, viewport: snapshot.viewport, scroll: snapshot.scroll, historyState: snapshot.historyState, focus:snapshot.focus, truncated: snapshot.truncated });
      nodes.push(...snapshot.nodes.map(node => ({ ...node, key: `${index}:${node.key}`, frameIndex: index })));
    } catch (error) { frames.push({ index, unsupported: String(error.message || error) }); }
  }
  return { origin: url.origin, route: url.pathname + url.search + url.hash, historyState: frames[0]?.historyState ?? null, focus:frames[0]?.focus ?? null, nodes, frames };
}
