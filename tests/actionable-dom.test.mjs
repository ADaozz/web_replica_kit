import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyActionSafety, discoverActionableDom, loadBrowserDiscover } from '../actionable-dom.mjs';
import { el, installComputedStyle, mount } from './dom-fixture.mjs';

function discover(nodes, options = {}) {
  const styles = installComputedStyle();
  styles.use(mount(nodes));
  try { return discoverActionableDom(options); }
  finally { styles.restore(); }
}

function byName(result, name) {
  return result.controls.find(control => control.accessibleName === name);
}

test('classifies reversible controls, weak cues, and dangerous actions separately', () => {
  assert.equal(classifyActionSafety({ tag: 'button', role: 'button', expanded: 'false', enabled: true, evidenceStrength: 'semantic', accessibleName: 'More' }).classification, 'allowed-safe');
  assert.equal(classifyActionSafety({ tag: 'button', role: 'switch', controls: 'panel', enabled: true, evidenceStrength: 'semantic', accessibleName: 'Show advanced' }).classification, 'allowed-safe');
  assert.equal(classifyActionSafety({ tag: 'button', role: 'tab', enabled: true, evidenceStrength: 'semantic', accessibleName: 'Account' }).classification, 'allowed-safe');
  assert.equal(classifyActionSafety({ tag: 'div', evidenceStrength: 'weak', enabled: true, accessibleName: 'Hot' }).classification, 'review-required');
  assert.equal(classifyActionSafety({ tag: 'button', role: 'button', expanded: 'false', enabled: false, evidenceStrength: 'semantic', accessibleName: 'More' }).classification, 'review-required');
  assert.equal(classifyActionSafety({ tag: 'button', role: 'button', expanded: 'false', enabled: true, submit: true, evidenceStrength: 'semantic', accessibleName: 'More' }).classification, 'blocked');
  assert.equal(classifyActionSafety({ tag: 'button', role: 'button', expanded: 'false', enabled: true, evidenceStrength: 'semantic', accessibleName: '删除' }).classification, 'blocked');
  assert.equal(classifyActionSafety({
    tag: 'a', role: 'link', href: 'https://pay.example/checkout', enabled: true, evidenceStrength: 'semantic',
    accessibleName: 'Docs', pageOrigin: 'http://fixture.test/app'
  }).classification, 'blocked');
  assert.equal(classifyActionSafety({
    tag: 'a', role: 'link', href: '/settings', enabled: true, evidenceStrength: 'semantic',
    accessibleName: 'Settings', pageOrigin: 'http://fixture.test/app'
  }).classification, 'review-required');
  assert.equal(classifyActionSafety({
    tag: 'a', role: 'link', href: '/settings', enabled: true, evidenceStrength: 'semantic',
    accessibleName: 'Settings', pageOrigin: 'http://fixture.test/app'
  }, { allowSameOriginNavigation: true }).classification, 'allowed-safe');
});

test('discovers icon-free controls and does not treat icons or pointer cursors as proof', () => {
  const form = { method: 'post', action: '/save', getAttribute(name) { return this[name] ?? null; } };
  const result = discover([
    el('button', { id: 'plain' }, [el('span', {}, [], { text: 'Continue', cursor: 'pointer' }), el('svg')], { text: '' }),
    el('button', { id: 'more', 'aria-expanded': 'false', 'aria-controls': 'panel' }, [], { text: 'More' }),
    el('button', { id: 'mode', role: 'switch', 'aria-controls': 'advanced', 'aria-checked': 'false' }, [], { text: 'Show advanced' }),
    el('button', { id: 'account', role: 'tab' }, [], { text: 'Account' }),
    el('button', { id: 'menu', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, [], { text: 'Menu' }),
    el('div', { id: 'hot' }, [], { text: 'Hot', cursor: 'pointer' }),
    el('button', { id: 'gone', 'aria-expanded': 'false', hidden: '' }, [], { text: 'Hidden', rect: { x: 0, y: 0, width: 0, height: 0 } }),
    el('button', { disabled: '', 'aria-expanded': 'false' }, [], { text: 'Paused' }),
    el('button', { 'aria-expanded': 'false' }, [], { text: '删除' }),
    el('button', {}, [], { text: 'Save section', form }),
    el('a', { href: 'https://example.test/out' }, [], { text: 'Outside' }),
    el('a', { href: '/settings', id: 'settings' }, [], { text: 'Settings' }),
    el('details', {}, [el('summary', {}, [], { text: 'Native' })]),
    el('button', {}, [], { text: 'Open' }),
    el('button', {}, [], { text: 'Open' }),
    el('x-panel', { id: 'host' }, [], { shadow: [el('button', { id: 'inner' }, [], { text: 'Shadow action' })] }),
    el('template', { shadowrootmode: 'closed' }),
    el('iframe', { id: 'frame' }),
    el('input', { type: 'file', id: 'file' })
  ]);
  const plain = byName(result, 'Continue');
  assert.equal(plain.tag, 'button');
  assert.equal(plain.classification, 'review-required');
  assert.equal(plain.actionability, 'unverified');
  assert.equal(result.controls.some(control => control.tag === 'svg'), false);
  assert.equal(result.controls.some(control => control.accessibleName === 'Hot' && control.tag === 'span'), false);
  assert.equal(byName(result, 'More').classification, 'allowed-safe');
  assert.equal(byName(result, 'Show advanced').classification, 'allowed-safe');
  assert.equal(byName(result, 'Show advanced').controls, 'advanced');
  assert.equal(byName(result, 'Account').classification, 'allowed-safe');
  assert.equal(byName(result, 'Menu').classification, 'allowed-safe');
  const hot = result.controls.find(control => control.text === 'Hot' && control.tag === 'div');
  assert.equal(hot.classification, 'review-required');
  assert.equal(hot.evidenceStrength, 'weak');
  assert.equal(result.controls.some(control => control.tag === 'span'), false);
  assert.equal(byName(result, 'Hidden').visibility, 'currently-hidden');
  assert.equal(byName(result, 'Paused').classification, 'review-required');
  assert.equal(byName(result, '删除').classification, 'blocked');
  assert.equal(byName(result, 'Save section').classification, 'blocked');
  assert.equal(byName(result, 'Outside').classification, 'blocked');
  assert.equal(byName(result, 'Settings').classification, 'review-required');
  assert.equal(byName(result, 'Native').tag, 'summary');
  assert.equal(byName(result, 'Native').classification, 'allowed-safe');
  assert.equal(result.controls.filter(control => control.accessibleName === 'Open').every(control => control.locatorAmbiguous), true);
  assert.equal(byName(result, 'Shadow action').role, 'button');
  assert.match(byName(result, 'Shadow action').selector, />>>/);
  assert.equal(result.openShadows, 1);
  assert.equal(result.closedShadowSupported, false);
  assert.ok(result.limitations.some(item => item.reason === 'closed-shadow-dom'));
  assert.ok(result.limitations.some(item => item.reason === 'iframe-requires-frame-traversal'));
  assert.equal(result.controls.find(control => control.inputType === 'file').classification, 'blocked');
  const withPanel = discover([
    el('button', { id: 'more', 'aria-expanded': 'false', 'aria-controls': 'panel' }, [], { text: 'More' }),
    el('section', { id: 'panel', hidden: '' }, [], { text: 'Panel', rect: { x: 0, y: 0, width: 0, height: 0 } })
  ]);
  assert.equal(withPanel.regions.some(region => region.selector === '#panel' && region.visible === false), true);
  const withNav = discover([el('nav', { id: 'sidebar' }, [], { text: 'Menu' })]);
  assert.equal(withNav.regions.some(region => region.selector === '#sidebar'), true);
});

test('browser-evaluated discovery matches the node implementation', () => {
  const nodes = [el('button', { id: 'more', 'aria-expanded': 'false' }, [], { text: 'More' })];
  const styles = installComputedStyle();
  styles.use(mount(nodes));
  try {
    const direct = discoverActionableDom();
    const viaBrowser = loadBrowserDiscover()();
    assert.equal(viaBrowser.controls[0].classification, direct.controls[0].classification);
    assert.equal(viaBrowser.controls[0].accessibleName, 'More');
    assert.equal(viaBrowser.closedShadowSupported, false);
  } finally { styles.restore(); }
});
