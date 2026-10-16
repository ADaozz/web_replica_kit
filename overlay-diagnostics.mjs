// Runs inside each frame; no page scripts or request bodies are serialized.
export function inspectOverlayLayout() {
  const records = [];
  const properties = ['position', 'transform', 'top', 'left', 'right', 'bottom', 'z-index', 'overflow', 'overflow-x', 'overflow-y', 'display', 'visibility'];
  const path = el => {
    if (!el) return null;
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parent = el.parentElement;
    const segment = `${el.localName}:nth-of-type(${parent ? [...parent.children].filter(n => n.localName === el.localName).indexOf(el) + 1 : 1})`;
    return parent ? `${path(parent)} > ${segment}` : segment;
  };
  const rect = el => el ? Object.fromEntries(['x','y','width','height','top','left','right','bottom'].map(k => [k, el.getBoundingClientRect()[k]])) : null;
  const roots = [document];
  for (let i = 0; i < roots.length; i++) {
    for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
    for (const popup of roots[i].querySelectorAll('[role="menu"],[role="dialog"],[role="tooltip"],[role="listbox"],[popover],dialog')) {
      const root = popup.getRootNode();
      const trigger = [...root.querySelectorAll('[aria-controls],[popovertarget],[aria-describedby]')].find(el =>
        [el.getAttribute('aria-controls'), el.getAttribute('popovertarget'), el.getAttribute('aria-describedby')].some(v => v?.split(/\s+/).includes(popup.id)));
      const ancestors = [];
      for (let el = popup.parentElement; el; el = el.parentElement) {
        const s = getComputedStyle(el);
        ancestors.push({ selector: path(el), position: s.position, transform: s.transform, overflow: s.overflow, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop });
      }
      const s = getComputedStyle(popup);
      records.push({ selector: path(popup), shadowHost: root.host ? path(root.host) : null, trigger: path(trigger), triggerRect: rect(trigger), popupRect: rect(popup), parent: path(popup.parentElement), offsetParent: path(popup.offsetParent), portalContainer: trigger && !trigger.parentElement?.contains(popup) ? path(popup.parentElement) : null, positioningAncestor: ancestors.find(a => a.position !== 'static' || a.transform !== 'none') || null, ancestors, styles: Object.fromEntries(properties.map(k => [k, s.getPropertyValue(k)])), attributes: Object.fromEntries([...popup.attributes].filter(a => /^(aria-|data-state|class|style|hidden|open)/.test(a.name)).map(a => [a.name,a.value])) });
    }
  }
  return { viewport: { width: innerWidth, height: innerHeight }, scroll: { x: scrollX, y: scrollY }, overlays: records };
}

export async function collectOverlayDiagnostics(page, label) {
  const frames = [];
  for (const [index, frame] of page.frames().entries()) {
    try { frames.push({ index, ...await frame.evaluate(inspectOverlayLayout) }); }
    catch (error) { frames.push({ index, unsupported: String(error.message || error) }); }
  }
  return { label, frames };
}
