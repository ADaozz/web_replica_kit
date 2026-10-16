import test from 'node:test';
import assert from 'node:assert/strict';
import { exploreInteractionGraph, explorePage } from '../interaction-explorer.mjs';

function harness() {
  const world = { open: false, advanced: false, route: '/app', nested: false, posted: false, deleted: false };
  const calls = [];
  function snapshot() {
    return {
      origin: 'http://fixture.test',
      route: world.route,
      world: { ...world },
      nodes: [
        { key: 'more', selector: '#more', visible: true, expanded: world.open ? 'true' : 'false', bbox: { x: 0, y: 0, width: 40, height: 20 } },
        { key: 'panel', selector: '#panel', visible: world.open, bbox: { x: 0, y: 0, width: 120, height: world.open ? 48 : 0 } },
        { key: 'nested', selector: '#nested', visible: world.open, expanded: 'false', bbox: { x: 0, y: 0, width: 40, height: 20 } },
        { key: 'mode', selector: '#mode', visible: true, checked: world.advanced ? 'true' : 'false', bbox: { x: 0, y: 0, width: 32, height: 16 } },
        { key: 'advanced', selector: '#advanced', visible: world.advanced, bbox: { x: 0, y: 0, width: 80, height: 20 } }
      ]
    };
  }
  function controls() {
    return [
      { id: 'more', semanticKey: 'more', role: 'button', tag: 'button', accessibleName: 'More', expanded: world.open ? 'true' : 'false', visibility: 'visible', enabled: true, evidenceStrength: 'semantic', selector: '#more', selectorStable: true, locatorAmbiguous: false },
      { id: 'nested', semanticKey: 'nested', role: 'button', tag: 'button', accessibleName: 'Nested', expanded: 'false', visibility: world.open ? 'visible' : 'currently-hidden', enabled: true, evidenceStrength: 'semantic', selector: '#nested', selectorStable: true, locatorAmbiguous: false },
      { id: 'mode', semanticKey: 'mode', role: 'switch', tag: 'button', accessibleName: 'Show advanced', controls: 'advanced', checked: world.advanced ? 'true' : 'false', visibility: 'visible', enabled: true, evidenceStrength: 'semantic', selector: '#mode', selectorStable: true, locatorAmbiguous: false },
      { id: 'danger', semanticKey: 'danger', role: 'button', tag: 'button', accessibleName: '删除', expanded: 'false', visibility: 'visible', enabled: true, evidenceStrength: 'semantic', selector: '#danger', selectorStable: true, locatorAmbiguous: false },
      { id: 'paused', semanticKey: 'paused', role: 'button', tag: 'button', accessibleName: 'Paused', expanded: 'false', visibility: 'visible', enabled: false, evidenceStrength: 'semantic', selector: '#paused', selectorStable: true, locatorAmbiguous: false },
      { id: 'twin', semanticKey: 'twin', role: 'button', tag: 'button', accessibleName: 'Open', expanded: 'false', visibility: 'visible', enabled: true, evidenceStrength: 'semantic', selectorStable: false, locatorAmbiguous: true },
      { id: 'post', semanticKey: 'post', role: 'button', tag: 'button', accessibleName: 'Details', expanded: 'false', visibility: 'visible', enabled: true, evidenceStrength: 'semantic', selector: '#post', selectorStable: true, locatorAmbiguous: false },
      { id: 'away', semanticKey: 'away', role: 'link', tag: 'a', href: 'https://other.test/out', accessibleName: 'Outside', visibility: 'visible', enabled: true, evidenceStrength: 'semantic', pageOrigin: 'http://fixture.test/app', selectorStable: true, locatorAmbiguous: false },
      { id: 'settings', semanticKey: 'settings', role: 'link', tag: 'a', href: '/settings', accessibleName: 'Settings', visibility: 'visible', enabled: true, evidenceStrength: 'semantic', pageOrigin: 'http://fixture.test/app', selector: '#settings', selectorStable: true, locatorAmbiguous: false }
    ];
  }
  async function perform(control, action) {
    calls.push([control.semanticKey, action.kind, action.key || null]);
    if (control.semanticKey === 'danger') world.deleted = true;
    if (control.semanticKey === 'more' && action.kind === 'click') world.open = !world.open;
    if (control.semanticKey === 'more' && action.key === 'Escape') world.open = false;
    if (control.semanticKey === 'nested') world.nested = true;
    if (control.semanticKey === 'mode') world.advanced = !world.advanced;
    if (control.semanticKey === 'settings') world.route = '/settings';
    if (control.semanticKey === 'post') {
      world.posted = true;
      return { ok: true, writes: [{ method: 'POST', path: '/save' }] };
    }
    return { ok: true, writes: [] };
  }
  return {
    world, calls,
    async discover() { return { controls: controls() }; },
    async capture() { return snapshot(); },
    async restore(state) { Object.assign(world, state.snapshot.world); },
    perform
  };
}

test('explores local state changes, rediscovers nested controls, and blocks unsafe actions', async () => {
  const ui = harness();
  const result = await exploreInteractionGraph(ui);
  assert.equal(ui.world.deleted, false);
  assert.equal(ui.world.posted, false);
  assert.equal(ui.calls.some(call => call[0] === 'danger' || call[0] === 'paused' || call[0] === 'twin' || call[0] === 'away'), false);
  assert.equal(ui.calls.some(call => call[0] === 'nested' && call[1] === 'click'), true);
  assert.equal(ui.calls.some(call => call[0] === 'settings'), false);
  assert.ok(result.transitions.some(item => item.control.semanticKey === 'more' && item.confidence === 'observed'));
  assert.ok(result.transitions.some(item => item.control.semanticKey === 'mode' && item.effects.some(effect => effect.selector === '#advanced')));
  assert.equal(result.transitions.some(item => item.control.semanticKey === 'post'), false);
  assert.ok(result.failures.some(item => item.classification === 'requires-backend'));
  assert.ok(result.failures.some(item => item.reason === 'locatorAmbiguous'));
  assert.equal(result.coverage.discovered >= 9, true);
  assert.equal(result.coverage.observed >= 2, true);
  assert.equal('model' in result, false);
  assert.equal(result.coverage.eligible >= 1, true);

  assert.equal(ui.world.open, false);
});

test('same-origin navigation can be recorded only when it is explicitly permitted', async () => {
  const ui = harness();
  const result = await exploreInteractionGraph({ ...ui, allowSameOriginNavigation: true });
  assert.equal(ui.calls.some(call => call[0] === 'settings'), true);
  assert.ok(result.routes.some(route => route.to === '/settings' && route.external === false));
  assert.equal(ui.calls.some(call => call[0] === 'away'), false);
});

test('settled exploration opens and closes without queueing a reload path', async () => {
  const ui = harness();
  const result = await exploreInteractionGraph({ ...ui, budgets: { maxDepth: 1, maxActions: 6, maxStates: 4 } });
  assert.ok(result.transitions.some(item => item.action.kind === 'click' && item.control.semanticKey === 'more'));
  assert.ok(result.transitions.some(item => item.action.key === 'Escape' && item.control.semanticKey === 'more'));
  assert.equal(ui.world.open, false);
});

test('a settled page is not reloaded before exploration', async () => {
  let reloads = 0;
  const page = {
    url: () => 'https://fixture.test/app',
    on() {},
    off() {},
    frames: () => [],
    goto: async () => { reloads++; }
  };
  await explorePage(page, { budgets: { maxActions: 1, maxStates: 1, maxDepth: 1 } });
  assert.equal(reloads, 0);
});

test('budgets stop recursive exploration', async () => {
  const ui = harness();
  const result = await exploreInteractionGraph({ ...ui, budgets: { maxDepth: 1, maxActions: 2, maxStates: 2 } });
  assert.equal(result.truncated, true);
  assert.equal(ui.calls.some(call => call[0] === 'nested'), false);
});

test('failed restoration stops the graph instead of operating on an unknown state',async()=>{
  const ui=harness();let restores=0;let callsAtFailure=0;
  const result=await exploreInteractionGraph({...ui,restore:async state=>{restores++;if(restores>2){callsAtFailure=ui.calls.length;throw new Error('target state mismatch');}await ui.restore(state);}});
  assert.equal(result.restoreFailed,true);
  assert.equal(ui.calls.length,callsAtFailure);
  assert.equal(restores,3,'do not attempt more inverse actions after restoration failed');
  assert.equal(result.failures.filter(f=>f.stage==='restore').length,1);
});
