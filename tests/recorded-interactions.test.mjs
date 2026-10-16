import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildRecordedPreview, recordedInteractionScript, rewriteRecordedAssets, validateRecordedTransitions } from '../recorded-interactions.mjs';

test('conflicting source transitions are excluded instead of guessing a result', () => {
  const click = { from: 'closed', type: 'click', selector: '#control', key: null };
  const hover = { from: 'closed', type: 'pointerover', selector: '#control', key: null, to: 'hovered' };
  const graph = validateRecordedTransitions([{ ...click, to: 'open' }, { ...click, to: 'other' }, hover, hover]);
  assert.deepEqual(graph.replayable, [hover]);
  assert.equal(graph.ambiguous.length, 2);
});

test('recorded preview embeds exact captured states with a matching script hash', () => {
  const initial = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src \'none\'; connect-src \'none\'"></head><body><button id="menu">菜单</button></body></html>';
  const expanded = '<html><head></head><body><div style="width:173px">原站内容 &lt;script&gt;</div></body></html>';
  const recording = { states: [{ id: 'a', html: initial, scroll: { x: 0, y: 0 } },
    { id: 'b', html: expanded, scroll: { x: 0, y: 0 } }],
  transitions: [{ from: 'a', to: 'b', selector: '#menu', type: 'click' }] };
  const html = buildRecordedPreview(recording);
  const payload = html.match(/<script id="wrk-recorded-states" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.ok(!payload.includes('<'));
  assert.deepEqual(JSON.parse(payload).states, recording.states);
  assert.ok(html.includes(recordedInteractionScript));
  const hash = crypto.createHash('sha256').update(recordedInteractionScript).digest('base64');
  assert.ok(html.includes(`script-src 'sha256-${hash}'`));
  assert.ok(!recordedInteractionScript.includes('layout-sidebar-left'));
});

test('asset completion rewrites all recorded states while preserving local CSS and ordinary text', () => {
  const url = 'https://example.test/icons.svg?v=1&theme=light';
  const html = `<html><head><style>.x{mask:url("${url}#shape")} .y{background:url("assets/already.svg")}</style></head><body>
<i class="[&amp;>svg]:red" style="mask:url(&quot;${url.replace('&', '&amp;')}#shape&quot;)"></i>
<img src="${url.replace('&', '&amp;')}#image"><p>${url}</p></body></html>`;
  const result = rewriteRecordedAssets(html, { [url]: 'assets/sprite.svg' }, 'https://example.test/page');
  assert.ok(result.includes('mask:url("assets/sprite.svg#shape")'));
  assert.ok(result.includes('background:url("assets/already.svg")'));
  assert.ok(result.includes('src="assets/sprite.svg#image"'));
  assert.ok(result.includes(`<p>${url}</p>`));
  assert.ok(result.includes('class="[&amp;>svg]:red"'));
});

test('a preview without original states is rejected', () => {
  assert.throws(() => buildRecordedPreview({ states: [] }), /没有可用/);
});
