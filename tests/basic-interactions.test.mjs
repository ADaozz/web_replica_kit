import test from 'node:test';
import assert from 'node:assert/strict';
import { annotateBasicInteractions, installBasicInteractions } from '../basic-interactions.mjs';

// 用最小 DOM 替身验证控件关系和事件状态；像素及浏览器行为由端到端测试验证。
class Element extends EventTarget {
  constructor(tag, attrs = {}) {
    super(); this.localName = tag; this.attrs = new Map(Object.entries(attrs));
    this.children = []; this.parentElement = null; this.shadowRoot = null; this.hidden = 'hidden' in attrs;
    this.focused = false;
    const values = new Map();
    this.style = { getPropertyValue: key => values.get(key)?.value || '',
      getPropertyPriority: key => values.get(key)?.priority || '',
      setProperty: (key, value, priority = '') => values.set(key, { value, priority }), removeProperty: key => values.delete(key) };
    this.classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
    this.classList = { toggle: (key, state) => state ? this.classes.add(key) : this.classes.delete(key),
      remove: key => this.classes.delete(key) };
  }
  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  getAttribute(key) { return this.attrs.get(key) ?? null; }
  setAttribute(key, value) { this.attrs.set(key, String(value)); }
  removeAttribute(key) { this.attrs.delete(key); }
  hasAttribute(key) { return this.attrs.has(key); }
  contains(el) { return this === el || this.children.some(child => child.contains(el)); }
  querySelector(selector) { return selector === '.dropdown-menu' ? this.children.find(el => el.classes.has('dropdown-menu')) : null; }
  getBoundingClientRect() { return { left: 10, bottom: 40, width: 100 }; }
  focus() { this.focused = true; }
  cloneNode() { return new Element(this.localName, Object.fromEntries(this.attrs)); }
  after(el) { this.adjacent = el; }
}
class Root extends EventTarget {
  constructor(nodes) { super(); this.nodes = nodes; }
  getElementById(id) { return this.nodes.find(el => el.id === id) || null; }
  querySelectorAll(selector) {
    if (selector === '*') return this.nodes;
    if (selector === '[id]') return this.nodes.filter(el => el.id);
    if (selector === 'template[shadowrootmode]') return [];
    if (selector === '[data-wrk-sidebar]') return this.nodes.filter(el => el.hasAttribute('data-wrk-sidebar'));
    if (selector.startsWith('#')) return this.nodes.filter(el => el.id === selector.slice(1));
    return this.nodes.filter(el => el.hasAttribute('data-wrk-toggle') || el.hasAttribute('data-wrk-hover'));
  }
}
function withRuntime(nodes, callback) {
  const previous = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle, innerWidth: globalThis.innerWidth };
  const root = new Root(nodes);
  globalThis.document = root; globalThis.innerWidth = 1000;
  globalThis.getComputedStyle = el => ({ display: el.style.getPropertyValue('display') ||
    (el.hidden || (el.classes.has('collapse') && !el.classes.has('show')) ? 'none' : 'block') });
  try { installBasicInteractions(); callback(root); }
  finally { Object.assign(globalThis, previous); }
}
const click = el => el.dispatchEvent(new Event('click', { cancelable: true }));

test('reconstructs explicit toggle relationships and reports ambiguous controls', () => {
  const panel = new Element('section', { id: 'panel' });
  const button = new Element('button', { 'aria-expanded': 'false', 'aria-controls': 'panel' });
  const unknown = new Element('button', { 'aria-expanded': 'false', 'aria-controls': 'missing' });
  const report = annotateBasicInteractions(new Root([button, panel, unknown, new Element('details')]));
  assert.equal(report.controls.length, 1);
  assert.equal(button.getAttribute('data-wrk-toggle'), 'panel');
  assert.equal(report.unresolved.length, 1);
  assert.equal(report.nativeDetails, 1);
});

test('click toggles visibility and synchronizes multiple buttons for the same panel', () => {
  const first = new Element('button', { 'data-wrk-toggle': 'panel', 'aria-expanded': 'false' });
  const second = new Element('button', { 'data-wrk-toggle': 'panel', 'aria-expanded': 'false' });
  const panel = new Element('section', { id: 'panel', class: 'collapse' });
  withRuntime([first, second, panel], () => {
    click(first);
    assert.equal(panel.hidden, false); assert.equal(panel.classes.has('show'), true);
    assert.equal(second.getAttribute('aria-expanded'), 'true');
    click(second);
    assert.equal(panel.hidden, true); assert.equal(first.getAttribute('aria-expanded'), 'false');
  });
});

test('accordion expansion closes its sibling panel', () => {
  const first = new Element('button', { 'data-wrk-toggle': 'one' });
  const second = new Element('button', { 'data-wrk-toggle': 'two' });
  const one = new Element('section', { id: 'one', 'data-bs-parent': '#group' });
  const two = new Element('section', { id: 'two', 'data-bs-parent': '#group' });
  withRuntime([first, second, one, two], () => {
    click(first); click(second);
    assert.equal(one.hidden, true); assert.equal(two.hidden, false);
    assert.equal(first.getAttribute('aria-expanded'), 'false');
  });
});

test('dropdown closes on outside click and Escape returns focus to its trigger', () => {
  const trigger = new Element('button', { 'data-wrk-toggle': 'menu', 'data-wrk-mode': 'menu' });
  const menu = new Element('div', { id: 'menu' });
  withRuntime([trigger, menu], root => {
    click(trigger); click(root); assert.equal(menu.hidden, true);
    click(trigger);
    const event = new Event('keydown'); Object.defineProperty(event, 'key', { value: 'Escape' });
    root.dispatchEvent(event);
    assert.equal(menu.hidden, true); assert.equal(trigger.focused, true);
  });
});

test('hover content also supports focus without turning the trigger into a click toggle', () => {
  const trigger = new Element('button', { 'aria-describedby': 'tip' });
  const tip = new Element('div', { id: 'tip', role: 'tooltip', hidden: '' });
  const root = new Root([trigger, tip]);
  const report = annotateBasicInteractions(root);
  assert.equal(report.controls[0].behavior, 'hover-focus');
  assert.equal(trigger.hasAttribute('data-wrk-toggle'), false);
  withRuntime([trigger, tip], () => {
    trigger.dispatchEvent(new Event('focusin'));
    assert.equal(tip.hidden, false); assert.equal(tip.getAttribute('aria-hidden'), 'false');
    assert.equal(trigger.hasAttribute('aria-expanded'), false);
  });
});

test('source attributes can be inspected without enabling guessed handlers', () => {
  const trigger = new Element('button', { 'aria-expanded': 'false', 'aria-controls': 'panel' });
  const panel = new Element('div', { id: 'panel' });
  const report = annotateBasicInteractions(new Root([trigger, panel]), { applyBindings: false });
  assert.equal(report.controls.length, 1);
  assert.equal(report.controls[0].runtimeEnabled, false);
  assert.equal(report.controls[0].visualVerified, false);
  assert.equal(trigger.hasAttribute('data-wrk-toggle'), false);
});

test('unbound icon buttons, pressed controls and lazy popup triggers are reported instead of silently skipped', () => {
  const icon = new Element('button', { 'aria-label': '搜索', 'data-base-ui-tooltip-trigger': '' });
  const pressed = new Element('button', { 'aria-label': '固定', 'aria-pressed': 'true' });
  const menu = new Element('div', { role: 'combobox', 'aria-haspopup': 'dialog', 'aria-label': '选择模型' });
  const disabled = new Element('button', { disabled: '', 'aria-label': '不可用' });
  const input = new Element('input');
  const anchor = new Element('a', { href: '/help' });
  const report = annotateBasicInteractions(new Root([icon, pressed, menu, disabled, input, anchor]));
  assert.equal(report.controls.length, 0);
  assert.equal(report.unresolved.length, 3);
  assert.deepEqual(report.unresolved.map(c => c.label), ['搜索', '固定', '选择模型']);
  assert.equal(report.unresolved[1].pressed, 'true');
  assert.equal(report.unresolved[2].popup, 'dialog');
  assert.equal(report.nativeControls, 2);
  assert.equal(report.tooltipFallbacks, 1);
  assert.equal(icon.getAttribute('title'), '搜索');
  assert.equal(report.status, 'needs-review');
});
