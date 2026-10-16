import test from 'node:test';
import assert from 'node:assert/strict';
import { compareInteractionSnapshots, semanticDiff } from '../state-diff.mjs';
import { classifyNavigation, routeKey } from '../route-capture.mjs';
import { verifyInteractionReport } from '../scripts/verify-interactions.mjs';

test('semantic diff keeps visibility, aria, and route changes while ignoring noise and scroll', () => {
  const before = {
    origin: 'http://fixture.test', route: '/app',
    nodes: [
      { key: 'clock', noise: true, visible: true, value: '10:00' },
      { key: 'panel', selector: '#panel', visible: false, expanded: null, bbox: { x: 0, y: 10, width: 100, height: 40 } },
      { key: 'more', selector: '#more', visible: true, expanded: 'false', bbox: { x: 0, y: 10, width: 40, height: 20 } }
    ]
  };
  const after = {
    origin: 'http://fixture.test', route: '/app/settings',
    nodes: [
      { key: 'clock', noise: true, visible: true, value: '10:05' },
      { key: 'panel', selector: '#panel', visible: true, expanded: null, bbox: { x: 0, y: 30, width: 100, height: 40 } },
      { key: 'more', selector: '#more', visible: true, expanded: 'true', bbox: { x: 0, y: 30, width: 40, height: 20 } }
    ]
  };
  const diff = semanticDiff(before, after);
  assert.ok(diff.effects.some(effect => effect.type === 'route' && effect.to === '/app/settings'));
  assert.ok(diff.effects.some(effect => effect.type === 'visibility' && effect.selector === '#panel' && effect.to === true));
  assert.ok(diff.effects.some(effect => effect.type === 'aria' && effect.name === 'aria-expanded' && effect.to === 'true'));
  assert.equal(diff.effects.some(effect => effect.key === 'clock'), false);
  assert.deepEqual(diff.ignored, ['uniform-scroll']);
  assert.equal(compareInteractionSnapshots(before, after).verified, false);
  assert.equal(compareInteractionSnapshots(after, after).verified, true);
});

test('route policy blocks other origins unless same-origin exploration is permitted', () => {
  assert.equal(routeKey('http://fixture.test/app?tab=1#top'), '/app?tab=1#top');
  assert.equal(classifyNavigation('http://fixture.test/app', 'https://other.test/app').classification, 'blocked');
  assert.equal(classifyNavigation('http://fixture.test/app', 'http://fixture.test/settings').classification, 'review-required');
  assert.equal(classifyNavigation('http://fixture.test/app', 'http://fixture.test/settings', { allowSameOriginNavigation: true }).classification, 'allowed-safe');
});

test('verification report keeps a denominator and fails closed on mismatch', () => {
  const report = verifyInteractionReport({
    steps: [{ snapshot: { route: '/app', nodes: [{ key: 'panel', visible: true }] }, action: { kind: 'click' } }]
  }, {
    steps: [{ snapshot: { route: '/app', nodes: [{ key: 'panel', visible: false }] }, action: { kind: 'click' } }]
  });
  assert.equal(report.replicaVerified, false);
  assert.equal(report.denominator, 1);
  assert.equal(report.verified, 0);
});
