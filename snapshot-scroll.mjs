import crypto from 'node:crypto';

// Keep independently injected offline runtimes authorized without enabling arbitrary scripts.
export function allowInlineScript(html, script) {
  const hash = `'sha256-${crypto.createHash('sha256').update(script).digest('base64')}'`;
  return html.replace(/script-src\s+([^;"<>]+)/i, (_match, sources) => {
    const tokens = sources.trim().split(/\s+/).filter(value => value !== "'none'");
    return `script-src ${[...new Set([...tokens, hash])].join(' ')}`;
  });
}

export function restoreSnapshotScroll(root = document) {
  const saved = [];
  const pending = restoreSnapshotScroll.pending ||= new WeakMap();
  const elements = [];
  function walk(scope) {
    for (const el of scope.querySelectorAll('*')) {
      elements.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  }
  walk(root);
  // Preserve observed :defined CSS without running the original component code.
  // Already rendered shadow content remains intact; unobserved behavior is not recreated.
  for (const el of elements) {
    if (el.hasAttribute('data-wrk-defined') && !customElements.get(el.localName)) {
      try { customElements.define(el.localName, class extends HTMLElement {}); } catch {}
    }
  }
  for (const el of elements) {
    if (el.hasAttribute('data-wrk-scroll-left')) {
      const left = Number(el.getAttribute('data-wrk-scroll-left'));
      const top = Number(el.getAttribute('data-wrk-scroll-top'));
      if (Number.isFinite(left) && Number.isFinite(top)) {
        const properties = ['scroll-behavior', 'scroll-snap-type', 'overflow-anchor'];
        const record = { el, properties: pending.get(el)?.properties || properties.map(name => [name,
          el.style.getPropertyValue(name), el.style.getPropertyPriority(name)]) };
        saved.push(record);
        pending.set(el, record);
        el.style.setProperty('scroll-behavior', 'auto', 'important');
        el.style.setProperty('scroll-snap-type', 'none', 'important');
        el.style.setProperty('overflow-anchor', 'none', 'important');
        el.scrollLeft = left;
        el.scrollTop = top;
      }
    }
  }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const record of saved) {
      const { el, properties } = record;
      if (pending.get(el) !== record) continue;
      pending.delete(el);
      for (const [name, value, priority] of properties) {
        if (value) el.style.setProperty(name, value, priority);
        else el.style.removeProperty(name);
      }
    }
  }));
}

function initializeSnapshotScroll(restore) {
  let interacted = false;
  const onInput = event => { if (event.isTrusted) interacted = true; };
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, onInput, { capture: true, passive: true });
  }
  restore();
  const ready = () => {
    requestAnimationFrame(() => {
      if (!interacted) restore();
      for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
        window.removeEventListener(type, onInput, true);
      }
    });
  };
  if (document.readyState === 'complete') ready();
  else window.addEventListener('load', ready, { once: true });
}

export const snapshotScrollScript = `(${initializeSnapshotScroll.toString()})(${restoreSnapshotScroll.toString()});`;

export function injectSnapshotScrollRuntime(html) {
  if ((!html.includes('data-wrk-scroll-left=') && !html.includes('data-wrk-defined')) || html.includes('id="wrk-snapshot-scroll"')) return html;
  return allowInlineScript(html, snapshotScrollScript).replace(/<\/body>/i,
    `<script id="wrk-snapshot-scroll">${snapshotScrollScript}</script></body>`);
}
