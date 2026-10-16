// Structured evidence for controls AND changed content, including open shadow roots.
export function readDocumentState({ limit = 8000, includeLayoutStyles = false } = {}) {
  const layoutProperties = [
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
  const skip = new Set(['script','noscript','template']);
  const identityKey=Symbol.for('web-replica-kit.identities');
  const ids=globalThis[identityKey] ||= {documentId:globalThis.crypto?.randomUUID?.() || `${performance.timeOrigin}-${Math.random()}`,nodes:new WeakMap(),sheets:new WeakMap(),nextNode:0,nextSheet:0};
  function elementId(el) {if(!el)return null;if(!ids.nodes.has(el))ids.nodes.set(el,`${ids.documentId}:e${++ids.nextNode}`);return ids.nodes.get(el);}
  const parentOf=el=>el.parentElement || el.getRootNode()?.host || null;
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
      const sensitive = el.matches('input[type=password],input[type=file],input[type=hidden]') || /token|secret|password/i.test(`${el.id} ${el.getAttribute('name') || ''}`);
      const popover = el.hasAttribute('popover') ? el.matches(':popover-open') : null;
      nodes.push({ key: selector(el), elementId:elementId(el), tagName:el.localName, scopeId:el.getRootNode().host ? `${elementId(el.getRootNode().host)}:shadow` : `${ids.documentId}:document`, nextSiblingElementId:elementId(el.nextElementSibling), shadowChildElementIds:el.shadowRoot ? [...el.shadowRoot.children].map(elementId):[], selector: selector(el), parentElementId:elementId(parentOf(el)), childElementIds:[...el.children].map(elementId), ancestorElementIds:(()=>{const list=[];for(let p=parentOf(el);p;p=parentOf(p))list.push(elementId(p));return list;})(), parent: el.parentElement ? selector(el.parentElement) : (root.host ? `${selector(root.host)} >>>` : null), nextSibling: el.nextElementSibling ? selector(el.nextElementSibling) : null,
        visible: !el.hidden && s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0 && popover !== false,
        attributes: Object.fromEntries([...el.attributes].filter(a => !(['style','class'].includes(a.name) && !a.value.trim())).filter(a=> !/^on|nonce|token|secret|password/i.test(a.name) && a.name!=='value').map(a => [a.name,a.value])),
        modal: el.localName === 'dialog' ? el.matches(':modal') : null,
        text: sensitive ? null : [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(''),
        content:[...el.childNodes].map(child=>child.nodeType===1?{type:'element',elementId:elementId(child),selector:selector(child)}:child.nodeType===3?{type:'text',text:sensitive?null:child.textContent}:child.nodeType===8?{type:'comment',text:child.textContent}:null).filter(Boolean),
        leaf: el.children.length === 0, hovered:el.matches(':hover'), focused:el.matches(':focus'), popover,
        value: !sensitive && 'value' in el ? String(el.value) : null,
        checked: 'checked' in el ? el.checked : null, selected: 'selected' in el ? el.selected : null,
        bbox: { x: b.x, y: b.y, width: b.width, height: b.height },
        animating,
        documentBox: { x: b.x + scrollX + internalX, y: b.y + scrollY + internalY, width: b.width, height: b.height },
        appearance:Object.fromEntries(['color','background-color','opacity','font-family','font-size','font-weight','line-height','border-top-color','border-top-width','box-shadow','display','visibility','transform'].map(name=>[name,s.getPropertyValue(name)])),
        ...(includeLayoutStyles ? {layoutStyles:Object.fromEntries(layoutProperties.map(name=>[name,s.getPropertyValue(name)]))}:{}),
        layout: { position: s.position, transform: s.transform, display: s.display, visibility: s.visibility, offsetParent: el.offsetParent ? selector(el.offsetParent) : null },
        scroll: { x: el.scrollLeft, y: el.scrollTop }, contentOmitted:sensitive?'sensitive form data':null });
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  }
  walk(document);
  let historyState = null;
  try { historyState = JSON.parse(JSON.stringify(history.state)); } catch {}
  let active=document.activeElement;
  while (active?.shadowRoot?.activeElement) active=active.shadowRoot.activeElement;
  return { documentId:ids.documentId, focus:active ? selector(active):null, nodes, viewport: { width: innerWidth, height: innerHeight }, pageSize:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}, scroll: { x: scrollX, y: scrollY }, historyState, omittedTags:[...skip],truncated: nodes.length >= limit };
}

export async function captureStructuredState(page, {limit=8000,includeLayoutStyles=false} = {}) {
  const url = new URL(page.url());
  const nodes = [], frames = [];
  for (const [index, frame] of page.frames().entries()) {
    try {
      const snapshot = await frame.evaluate(readDocumentState, {limit,includeLayoutStyles});
      frames.push({ index,url:frame.url(), documentId:snapshot.documentId, viewport: snapshot.viewport, pageSize:snapshot.pageSize, scroll: snapshot.scroll, historyState: snapshot.historyState, focus:snapshot.focus, omittedTags:snapshot.omittedTags,truncated: snapshot.truncated });
      nodes.push(...snapshot.nodes.map(node => ({ ...node, key: `${index}:${node.key}`, frameIndex: index })));
    } catch (error) { frames.push({ index,url:frame.url(), unsupported: String(error.message || error) }); }
  }
  return { origin: url.origin, route: url.pathname + url.search + url.hash, historyState: frames[0]?.historyState ?? null, focus:frames[0]?.focus ?? null, nodes, frames };
}
