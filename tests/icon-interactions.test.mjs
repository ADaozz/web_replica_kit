import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeIconInteractions } from '../icon-interactions.mjs';

// DOM 替身只验证通用的图标覆盖和宿主关系，不替代真实浏览器验收。
class Element {
  constructor(tag, attrs = {}, style = {}, pseudo = {}) {
    this.localName = tag; this.attrs = attrs; this.style = style; this.pseudo = pseudo;
    this.nodeType = 1; this.id = attrs.id || ''; this.parentElement = null;
    this.previousElementSibling = null; this.shadowRoot = null; this.children = [];
    this.currentSrc = attrs.src || '';
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  hasAttribute(name) { return name in this.attrs; }
  getRootNode() { return this.root; }
  getBoundingClientRect() { return { width: 20, height: 20 }; }
  contains(other) { for (let el = other; el; el = el.parentElement) if (el === this) return true; return false; }
}
class Root extends EventTarget {
  constructor(nodes, host = null) { super(); this.nodes = nodes; this.host = host; for (const node of nodes) node.root = this; }
  querySelectorAll() { return this.nodes; }
}
function child(parent, child) {
  child.parentElement = parent; child.previousElementSibling = parent.children.at(-1) || null;
  parent.children.push(child); return child;
}
function withDocument(nodes, run) {
  const saved = { document: globalThis.document, CSS: globalThis.CSS, getComputedStyle: globalThis.getComputedStyle,
    __wrkIconObserver: globalThis.__wrkIconObserver };
  const root = new Root(nodes);
  globalThis.document = root;
  globalThis.CSS = { escape: value => value.replace(/[^\w-]/g, '\\$&') };
  globalThis.getComputedStyle = (el, pseudo) => ({ content: 'none', fontFamily: 'sans-serif',
    display: 'block', visibility: 'visible', backgroundImage: 'none', maskImage: 'none', cursor: 'auto',
    ...(pseudo ? el.pseudo[pseudo] || {} : el.style) });
  try { return run(root); }
  finally { globalThis.__wrkIconObserver?.stop?.(); Object.assign(globalThis, saved); }
}

test('all icon forms map to their actual semantic hosts without assuming a page layout', () => {
  const button = new Element('button', { id: 'action', 'aria-label': '展开', 'aria-pressed': 'true' });
  const icon = child(button, new Element('i', { class: 'ui-icon', 'data-icon-name': 'any-name' }));
  const svg = child(button, new Element('svg'));
  const role = new Element('div', { id: 'picker', role: 'combobox', 'aria-haspopup': 'dialog' });
  const mask = child(role, new Element('span', {}, { maskImage: 'url(mask.svg)' }));
  const pseudo = new Element('button', { id: 'font-icon' }, {}, { '::before': { content: '"\ue001"', fontFamily: 'Example Icons' } });
  const image = new Element('img', { src: '/plain-small.png' });
  withDocument([button, icon, svg, role, mask, pseudo, image], () => {
    const report = analyzeIconInteractions();
    assert.equal(report.totalIcons, 5);
    assert.equal(report.interactiveHosts, 3);
    assert.equal(report.icons.find(row => row.iconName === 'any-name').host.selector, '#action');
    assert.equal(report.icons.find(row => row.formats.includes('css-mask')).host.popup, 'dialog');
    assert.equal(report.icons.find(row => row.formats.includes('::before')).host.selector, '#font-icon');
    assert.equal(report.icons.find(row => row.formats.includes('small-image-candidate')).host, null);
    assert.equal(report.browserBehaviorVerified, false);
  });
});

test('open shadow roots retain separate selectors and report inspection limits', () => {
  const host = new Element('custom-control', { id: 'component' });
  const button = new Element('button', { id: 'inside' });
  const svg = child(button, new Element('svg'));
  host.shadowRoot = new Root([button, svg], host);
  withDocument([host], () => {
    const report = analyzeIconInteractions();
    assert.equal(report.icons[0].host.selector, '#component >>> #inside');
    assert.equal(analyzeIconInteractions({ limit: 1 }).truncated, true);
  });
});

test('the source observer reports real events without clicking or preventing site handlers', () => {
  const button = new Element('button', { id: 'action', 'aria-label': '菜单' });
  const icon = child(button, new Element('i', { 'data-icon-name': 'menu' }));
  const events = [];
  globalThis.__testIconBinding = payload => events.push(payload);
  try {
    withDocument([button, icon], root => {
      analyzeIconInteractions({ recordBinding: '__testIconBinding' });
      const event = new Event('click', { cancelable: true });
      Object.defineProperty(event, 'composedPath', { value: () => [icon, button, root] });
      root.dispatchEvent(event);
      assert.equal(events.length, 1);
      assert.equal(events[0].selector, '#action');
      assert.equal(event.defaultPrevented, false);
    });
  } finally { delete globalThis.__testIconBinding; }
});
