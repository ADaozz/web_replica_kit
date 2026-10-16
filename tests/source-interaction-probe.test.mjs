import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySourceControl, probeSourceIconInteractions } from '../source-interaction-probe.mjs';
import { clearGuessedInteractions } from '../scripts/reset-preview-interactions.mjs';

test('automatic clicks require local state evidence and exclude business actions', () => {
  assert.equal(classifySourceControl({ tag: 'button', expanded: 'false' }).click, true);
  assert.equal(classifySourceControl({ tag: 'div', role: 'tab' }).click, true);
  assert.equal(classifySourceControl({ tag: 'summary' }).click, true);
  for (const control of [
    { tag: 'button', label: '删除', popup: 'menu' },
    { tag: 'a', expanded: 'false' },
    { tag: 'button', submit: true, expanded: 'false' },
    { tag: 'button', label: 'Send message' },
    { tag: 'button', label: '未知功能' },
    { tag: 'button', disabled: true, expanded: 'false' }
  ]) assert.equal(classifySourceControl(control).click, false);
});

test('probe uses source hover and click events and reports skipped custom clicks', async () => {
  const events = [];
  let flushes = 0;
  const rows = ['#menu', '#unknown'].map(selector => ({ visible: true, host: { selector } }));
  const page = {
    evaluate: async () => ({ icons: rows }),
    locator: selector => ({
      evaluate: async () => ({ tag: 'button', expanded: selector === '#menu' ? 'false' : null }),
      hover: async () => events.push([selector, 'hover']),
      click: async () => events.push([selector, 'click']),
      isVisible: async () => true
    }),
    mouse: { move: async () => events.push(['mouse', 'leave']) }
  };
  const result = await probeSourceIconInteractions({ page, flush: async () => { flushes++; } });
  assert.deepEqual(events, [['#menu', 'hover'], ['#menu', 'click'], ['#menu', 'click'], ['mouse', 'leave'],
    ['#unknown', 'hover'], ['mouse', 'leave']]);
  assert.equal(flushes, 6);
  assert.equal(result.visitedHosts, 2);
  assert.equal(result.attempts[1].click, false);
});

test('reset removes inferred handlers and retains original layout and native HTML', () => {
  const html = `<html><head><meta http-equiv="Content-Security-Policy" content="script-src &#39;sha256-old&#39;; connect-src &#39;none&#39;"></head><body>
<details data-wrk-toggle="x"><summary>展开</summary><div style="width:173px">内容</div></details><script>bad()</script></body></html>`;
  const clean = clearGuessedInteractions(html);
  assert.ok(clean.includes("script-src 'none'"));
  assert.ok(clean.includes('<details><summary>展开</summary>'));
  assert.ok(clean.includes('style="width:173px"'));
  assert.ok(!clean.includes('<script'));
  assert.ok(!clean.includes('data-wrk-'));
});

test('automatic recording stores source event transitions without an interactive terminal', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { recordIconInteractions } = await import('../recorded-interactions.mjs');
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'replica-recorder-unit-'));
  let binding;
  let expanded = true;
  const event = type => binding(null, { type, selector: '#control', key: null });
  const page = {
    url: () => 'https://fixture.test/',
    exposeBinding: async (_name, callback) => { binding = callback; },
    evaluate: async fn => fn.name === 'analyzeIconInteractions'
      ? { totalIcons: 1, interactiveHosts: 1, icons: [{ visible: true, host: { selector: '#control' } }] }
      : { x: 0, y: 0 },
    screenshot: async () => {},
    waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, ms)),
    locator: () => ({
      evaluate: async () => ({ tag: 'button', expanded: String(expanded) }),
      hover: async () => { event('pointerover'); },
      click: async () => { event('click'); expanded = !expanded; },
      isVisible: async () => true
    }),
    mouse: { move: async () => { event('pointerout'); } }
  };
  try {
    const recording = await recordIconInteractions({ page, out, settle: 1,
      snapshot: async () => `<html><body><button id="control" aria-expanded="${expanded}"></button><div style="width:${expanded ? 271 : 173}px"></div></body></html>` });
    assert.deepEqual(recording.errors, []);
    assert.equal(recording.states.length, 2);
    assert.equal(recording.transitions.length, 2);
    assert.deepEqual(recording.transitions.map(t => [t.type, t.from, t.to]), [
      ['click', 'state-000', 'state-001'], ['click', 'state-001', 'state-000']]);
    assert.equal(recording.probe.automatic, true);
    assert.equal(recording.browserReplayVerified, false);
  } finally { await fs.rm(out, { recursive: true, force: true }); }
});
