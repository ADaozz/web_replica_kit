import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocator, runPlaywrightAction, verifyActionability } from '../actionability.mjs';

function pageWith(locator) {
  const scope = {
    url: () => 'http://fixture.test/',
    getByRole: () => locator,
    getByLabel: () => locator,
    getByPlaceholder: () => locator,
    getByTestId: () => locator,
    locator: () => locator,
    frames: () => [scope],
    mainFrame: () => scope,
    evaluate: async () => ({ x: 0, y: 0 }),
    waitForLoadState: async () => {}
  };
  return scope;
}

const control = {
  role: 'button',
  accessibleName: 'More',
  locatorAmbiguous: false,
  locatorStrategies: [{ type: 'role', role: 'button', name: 'More', exact: true }]
};

test('trial click checks actionability before a real click and does not dispatch synthetic events', async () => {
  const calls = [];
  const locator = {
    count: async () => 1,
    click: async options => { calls.push(options || {}); },
    focus: async () => calls.push('focus'),
    press: async key => calls.push(key)
  };
  const result = await verifyActionability(pageWith(locator), control);
  assert.equal(result.actionable, true);
  assert.equal(result.strategy, 'role');
  assert.equal(calls[0].trial, true);
  const played = await runPlaywrightAction(pageWith(locator), control, { kind: 'click' });
  assert.equal(played.ok, true);
  assert.equal(calls.filter(call => call?.trial).length >= 1, true);
  assert.equal(calls.some(call => call && call.trial === undefined), true);
  assert.equal(calls.includes('dispatchEvent'), false);
});

test('disabled, obscured, and ambiguous targets are not actionable', async () => {
  const disabled = { count: async () => 1, click: async options => { if (options?.trial) throw new Error('element is disabled'); } };
  const obscured = { count: async () => 1, click: async options => { if (options?.trial) throw new Error('intercepts pointer events'); } };
  const ambiguous = { count: async () => 2, click: async () => { throw new Error('clicked'); } };
  assert.equal((await verifyActionability(pageWith(disabled), control)).actionable, false);
  assert.match((await verifyActionability(pageWith(disabled), control)).reason, /disabled/);
  assert.match((await verifyActionability(pageWith(obscured), control)).reason, /pointer/);
  const resolved = await resolveLocator(pageWith(ambiguous), control);
  assert.equal(resolved.reason, 'locatorAmbiguous');
  assert.equal((await verifyActionability(pageWith(ambiguous), control)).actionable, false);
});
