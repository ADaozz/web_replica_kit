import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeSnapshotResources } from '../snapshot-resources.mjs';
import { rewriteSnapshotAssets } from '../snapshot-resources.mjs';

test('localized resources shed CORS and stale SRI attributes while remote URLs retain them', () => {
  const html = '<link crossorigin="anonymous" href="assets/main.css" integrity="sha256-old">' +
    '<img src="./assets/icon.svg" crossorigin>' +
    '<link rel="stylesheet" href="https://cdn.example/site.css" crossorigin="anonymous" integrity="sha256-remote">' +
    '<p data-crossorigin="keep">Text</p>';
  const result = finalizeSnapshotResources(html);
  assert.ok(result.includes('<link href="assets/main.css">'));
  assert.ok(result.includes('<img src="./assets/icon.svg">'));
  assert.ok(result.includes('href="https://cdn.example/site.css" crossorigin="anonymous" integrity="sha256-remote"'));
  assert.ok(result.includes('data-crossorigin="keep"'));
});

test('script resource hints are removed without changing CSS preloads or inline script hashes', () => {
  const script = '<script>const example = \'<link href="assets/x.css" crossorigin>\'; const n = 1 < 2;</script>';
  const html = '<link rel="modulepreload" href="assets/app.js">' +
    '<link rel="preload" as="script" href="assets/other.js">' +
    '<link rel="preload" as="style" href="assets/main.css" crossorigin>' + script;
  const result = finalizeSnapshotResources(html);
  assert.ok(!result.includes('app.js'));
  assert.ok(!result.includes('other.js'));
  assert.ok(result.includes('<link rel="preload" as="style" href="assets/main.css">'));
  assert.ok(result.includes(script));
});

test('late downloaded styles lose CORS and integrity requirements in static snapshots', () => {
  const result = rewriteSnapshotAssets('<link rel="stylesheet" crossorigin="anonymous" integrity="old" href="https://cdn.example/new.css">',
    { 'https://cdn.example/new.css': 'assets/new.css' }, 'https://example.test/');
  assert.equal(result, '<link rel="stylesheet" href="assets/new.css">');
});

test('attribute-like text inside a value is preserved verbatim', () => {
  const html = '<img src="assets/icon.png" title=\'keep crossorigin="anonymous" and integrity="old"\' crossorigin="anonymous">';
  assert.equal(finalizeSnapshotResources(html),
    '<img src="assets/icon.png" title=\'keep crossorigin="anonymous" and integrity="old"\'>');
});

test('mixed data URL srcset preserves embedded bytes and localizes external candidates',async()=>{
  const {rewriteSrcsetUrls}=await import('../snapshot-resources.mjs');
  const input='data:image/svg+xml,%3Csvg%3E%3C/svg%3E 1x, https://example.test/large.png 2x';
  const expected='data:image/svg+xml,%3Csvg%3E%3C/svg%3E 1x, assets/large.png 2x';
  assert.equal(rewriteSrcsetUrls(input,url=>url==='https://example.test/large.png'?'assets/large.png':url),expected);
  assert.ok(rewriteSnapshotAssets(`<img srcset="${input}">`,{'https://example.test/large.png':'assets/large.png'},'https://example.test/').includes(expected));
});
