import test from 'node:test';
import assert from 'node:assert/strict';
import { compileLocalMachines, injectOfflineRuntime, installOfflineInteractions } from '../offline-runtime.mjs';

function element(tag, id, attrs = {}, text = '') {
  return {
    localName: tag, id, attrs: { ...attrs }, text, hidden: Boolean(attrs.hidden), style: {}, value: tag === 'input' ? 'hello' : undefined,
    get textContent() { return this.text; },
    getAttribute(name) { return this.attrs[name] ?? null; },
    setAttribute(name, value) { this.attrs[name] = String(value); if (name === 'hidden') this.hidden = true; },
    hasAttribute(name) { return this.attrs[name] != null; },
    removeAttribute(name) { delete this.attrs[name]; if (name === 'hidden') this.hidden = false; },
    getBoundingClientRect() { return { width: Number.parseFloat(this.style.width || '200'), height: 20, x: 0, y: 0 }; },
    querySelector() { return null; }
  };
}

test('local runtime updates related nodes and preserves unrelated input', () => {
  const nodes = new Map([
    ['switch', element('button', 'switch', { role: 'switch', 'aria-checked': 'false' }, 'Show advanced')],
    ['advanced', element('section', 'advanced', { hidden: '' }, 'Advanced')],
    ['tab-a', element('button', 'tab-a', { role: 'tab', 'aria-selected': 'true' }, 'Account')],
    ['tab-b', element('button', 'tab-b', { role: 'tab', 'aria-selected': 'false' }, 'Billing')],
    ['panel-a', element('section', 'panel-a', {}, 'Account panel')],
    ['panel-b', element('section', 'panel-b', { hidden: '' }, 'Billing panel')],
    ['note', element('input', 'note')],
    ['sidebar', element('aside', 'sidebar')]
  ]);
  nodes.get('switch').text = 'Show advanced';
  const model = {
    machines: [
      {
        control: { id: 'mode', role: 'switch', name: 'Show advanced', selector: '#switch' },
        edges: [
          { action: { kind: 'click' }, from: [
            { selector: '#switch', type: 'aria', name: 'aria-checked', value: 'false' },
            { selector: '#advanced', type: 'visibility', value: false }
          ], effects: [
            { selector: '#switch', type: 'aria', name: 'aria-checked', to: 'true' },
            { selector: '#advanced', type: 'visibility', to: true }
          ] },
          { action: { kind: 'click' }, from: [
            { selector: '#switch', type: 'aria', name: 'aria-checked', value: 'true' }
          ], effects: [
            { selector: '#switch', type: 'aria', name: 'aria-checked', to: 'false' },
            { selector: '#advanced', type: 'visibility', to: false }
          ] }
        ]
      },
      {
        control: { id: 'billing', role: 'tab', name: 'Billing', selector: '#tab-b' },
        edges: [{ action: { kind: 'click' }, from: [
          { selector: '#panel-b', type: 'visibility', value: false }
        ], effects: [
          { selector: '#panel-a', type: 'visibility', to: false },
          { selector: '#panel-b', type: 'visibility', to: true },
          { selector: '#tab-a', type: 'aria', name: 'aria-selected', to: 'false' },
          { selector: '#tab-b', type: 'aria', name: 'aria-selected', to: 'true' },
          { selector: '#sidebar', type: 'geometry', to: { width: 72, height: 20 } }
        ] }]
      }
    ]
  };
  const script = { id: 'wrk-offline-interactions', textContent: JSON.stringify(model) };
  const listeners = {};
  const previous = { document: globalThis.document, style: globalThis.getComputedStyle, history: globalThis.history, location: globalThis.location };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  globalThis.history = { pushState() {} };
  globalThis.location = { pathname: '/', search: '', hash: '' };
  globalThis.document = {
    getElementById: id => id === 'wrk-offline-interactions' ? script : nodes.get(id) || null,
    querySelector: selector => nodes.get(selector.slice(1)) || null,
    querySelectorAll: () => [...nodes.values()],
    addEventListener: (type, handler) => { listeners[type] = handler; }
  };
  globalThis.window = { addEventListener() {} };
  try {
    installOfflineInteractions();
    listeners.click({ target: nodes.get('switch'), composedPath: () => [nodes.get('switch')], preventDefault() { this.defaultPrevented = true; } });
    assert.equal(nodes.get('advanced').hidden, false);
    assert.equal(nodes.get('switch').getAttribute('aria-checked'), 'true');
    listeners.click({ target: nodes.get('tab-b'), composedPath: () => [nodes.get('tab-b')], preventDefault() {} });
    assert.equal(nodes.get('panel-a').hidden, true);
    assert.equal(nodes.get('panel-b').hidden, false);
    assert.equal(nodes.get('advanced').hidden, false);
    assert.equal(nodes.get('note').value, 'hello');
    assert.equal(nodes.get('sidebar').style.width, undefined);
    assert.equal(installOfflineInteractions.toString().includes('replaceChildren'), false);
  } finally {
    globalThis.document = previous.document;
    globalThis.getComputedStyle = previous.style;
    globalThis.history = previous.history;
    globalThis.location = previous.location;
  }
});

test('a recorded menu is inserted when the closed page did not contain it', () => {
  const model = { machines: [{ control: { id: 'repo', role: 'combobox', name: 'Start from scratch', selector: '#repo' }, edges: [{
    action: { kind: 'click' },
    from: [{ selector: '#repo', type: 'aria', name: 'aria-expanded', value: 'false' }, { selector: '#menu', type: 'visibility', value: false }],
    effects: [{ selector: '#repo', type: 'aria', name: 'aria-expanded', to: 'true' }, { selector: '#menu', type: 'visibility', to: true, html: '<div id="menu">Blog</div>' }]
  }, {
    action: { kind: 'press', key: 'Escape' },
    from: [{ selector: '#repo', type: 'aria', name: 'aria-expanded', value: 'true' }, { selector: '#menu', type: 'visibility', value: true }, { selector: '#menu', type: 'geometry', value: { width: 240 } }],
    effects: [{ selector: '#repo', type: 'aria', name: 'aria-expanded', to: 'false' }, { selector: '#menu', type: 'visibility', to: false }, { selector: '#menu', type: 'geometry', to: { width: 200, height: 20 } }]
  }] }] };
  const repo = element('button', 'repo', { role: 'combobox', 'aria-expanded': 'false' }, 'Start from scratch');
  const nodes = new Map([['repo', repo]]);
  const script = { id: 'wrk-offline-interactions', textContent: JSON.stringify(model) };
  const listeners = {};
  const previous = { document: globalThis.document, style: globalThis.getComputedStyle, history: globalThis.history, location: globalThis.location };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  globalThis.history = { pushState() {} };
  globalThis.location = { pathname: '/', search: '', hash: '' };
  globalThis.document = {
    getElementById: id => id === 'wrk-offline-interactions' ? script : nodes.get(id) || null,
    querySelector: selector => nodes.get(selector.slice(1)) || null,
    querySelectorAll: () => [...nodes.values()],
    createElement: () => ({ firstElementChild: null, set innerHTML(html) { const match = /id="([^"]+)"[^>]*>([^<]*)</.exec(html); if (!match) return; const node = element('div', match[1], {}, match[2]); this.firstElementChild = node; nodes.set(match[1], node); } }),
    addEventListener: (type, handler) => { listeners[type] = handler; },
    body: { append(node) { nodes.set(node.id, node); } }
  };
  globalThis.window = { addEventListener() {} };
  try {
    installOfflineInteractions();
    listeners.click({ target: repo, composedPath: () => [repo], preventDefault() {} });
    assert.equal(nodes.get('menu').text, 'Blog');
    assert.equal(repo.getAttribute('aria-expanded'), 'true');
    listeners.click({ target: repo, composedPath: () => [repo], preventDefault() {} });
    assert.equal(nodes.get('menu').hidden, false, 'click must not execute an Escape-only edge');
    listeners.keydown({ key: 'Escape', target: repo, composedPath: () => [repo], preventDefault() {} });
    assert.equal(nodes.get('menu').hidden, true);
    assert.equal(repo.getAttribute('aria-expanded'), 'false');
  } finally {
    globalThis.document = previous.document;
    globalThis.getComputedStyle = previous.style;
    globalThis.history = previous.history;
    globalThis.location = previous.location;
  }
});

test('a same-name control opens the clicked instance, and a popover is shown', () => {
  const model = { machines: [{ control: { id: 'brand', role: 'button', name: 'ChatGPT', selector: null }, edges: [{
    action: { kind: 'click' },
    from: [{ selector: '#card', type: 'visibility', value: false }],
    effects: [{ selector: '#card', type: 'visibility', to: true, html: '<div id="card" popover="auto">Try advanced features</div>' }]
  }] }] };
  const sidebar = element('span', 'side', { role: 'button' }, 'ChatGPT');
  const header = element('span', 'header', { role: 'button' }, 'ChatGPT');
  const nodes = new Map([['side', sidebar], ['header', header]]);
  const script = { id: 'wrk-offline-interactions', textContent: JSON.stringify(model) };
  const listeners = {};
  const previous = { document: globalThis.document, style: globalThis.getComputedStyle, history: globalThis.history, location: globalThis.location };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  globalThis.history = { pushState() {} };
  globalThis.location = { pathname: '/', search: '', hash: '' };
  globalThis.document = {
    getElementById: id => id === 'wrk-offline-interactions' ? script : nodes.get(id) || null,
    querySelector: selector => nodes.get(selector.slice(1)) || null,
    querySelectorAll: () => [...nodes.values()],
    createElement: () => ({ firstElementChild: null, set innerHTML(html) { const match = /id="([^"]+)"[^>]*>([^<]*)</.exec(html); if (!match) return; const node = element('div', match[1], { popover: 'auto' }, match[2]); node.popoverOpen = false; node.showPopover = () => { node.popoverOpen = true; }; node.hidePopover = () => { node.popoverOpen = false; }; node.matches = sel => sel === ':popover-open' && node.popoverOpen; this.firstElementChild = node; nodes.set(match[1], node); } }),
    addEventListener: (type, handler) => { listeners[type] = handler; },
    body: { append(node) { nodes.set(node.id, node); } }
  };
  globalThis.window = { addEventListener() {} };
  try {
    installOfflineInteractions();
    listeners.click({ target: header, composedPath: () => [header], preventDefault() {} });
    assert.equal(nodes.get('card').popoverOpen, true);
    assert.equal(nodes.get('card').text, 'Try advanced features');
  } finally {
    globalThis.document = previous.document;
    globalThis.getComputedStyle = previous.style;
    globalThis.history = previous.history;
    globalThis.location = previous.location;
  }
});

test('compiled machines keep observed effects and injection does not enable a page-wide swap', () => {
  const model = compileLocalMachines([
    { confidence: 'observed', control: { id: 'more', semanticKey: 'more', role: 'button', accessibleName: 'More', selector: '#more', selectorStable: true }, action: { kind: 'click' }, effects: [
      { type: 'visibility', selector: '#panel', from: false, to: true },
      { type: 'aria', selector: '#more', name: 'aria-expanded', from: 'false', to: 'true' }
    ] },
    { confidence: 'observed', control: { id: 'away', semanticKey: 'away', role: 'link', accessibleName: 'Outside' }, action: { kind: 'click' }, effects: [
      { type: 'route', from: '/app', to: 'https://other.test', external: true }
    ] }
  ]);
  assert.equal(model.machines.length, 1);
  assert.equal(model.unsupported.some(item => item.reason === 'external navigation'), true);
  const html = injectOfflineRuntime('<html><head><meta content="script-src \'none\'; connect-src \'none\'"></head><body></body></html>', model);
  assert.match(html, /wrk-offline-interactions/);
  assert.equal(html.includes('replaceChildren'), false);
  assert.equal(html.includes("script-src 'none'"), false);
});

test('conflicting local outcomes are unsupported instead of choosing the first observed result',()=>{
  const base={from:'s0',control:{id:'menu',semanticKey:'menu',selector:'#menu',selectorStable:true},confidence:'observed',action:{kind:'click'}};
  const model=compileLocalMachines([{...base,to:'s1',effects:[{selector:'#panel',type:'text',from:'',to:'First'}]},{...base,to:'s2',effects:[{selector:'#panel',type:'text',from:'',to:'Second'}]}]);
  assert.equal(model.machines.length,0);
  assert.ok(model.unsupported.some(item=>/ambiguous/.test(item.reason)));
});
