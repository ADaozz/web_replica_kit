import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteCss } from '../capture.mjs';

const base = 'https://example.test/styles/icons.css';
const assets = {
  'https://example.test/sprite.svg?theme=light': 'assets/sprite.svg',
  'https://example.test/mask.svg': 'assets/mask.svg',
  'https://example.test/fonts/icon.woff2': 'assets/icon.woff2',
  'https://example.test/styles/extra.css': 'assets/extra.css'
};

test('preserves SVG fragments and queries when mapping CSS icon assets', () => {
  assert.equal(rewriteCss('a{background:url("../sprite.svg?theme=light#search")}', base, assets),
    'a{background:url("assets/sprite.svg#search")}');
});

test('writes paths relative to downloaded CSS, retaining mask fragment IDs', () => {
  assert.equal(rewriteCss('a{mask:url(../mask.svg#shape)}', base, assets, 'assets'),
    'a{mask:url("./mask.svg#shape")}');
});

test('retains local SVG references and embedded images', () => {
  const css = 'a{filter:url(#shadow);background:url("data:image/svg+xml;base64,PHN2Zy8+")}';
  assert.equal(rewriteCss(css, base, assets),
    'a{filter:url("#shadow");background:url("data:image/svg+xml;base64,PHN2Zy8+")}');
});

test('localizes icon fonts and both forms of CSS imports', () => {
  assert.equal(rewriteCss('@import "extra.css";@import url(extra.css);@font-face{src:url(../fonts/icon.woff2)}',
    base, assets, 'assets'),
    '@import "./extra.css";@import url("./extra.css");@font-face{src:url("./icon.woff2")}');
});

test('preserves absolute fallback including fragment for unrecorded assets', () => {
  assert.equal(rewriteCss('a{mask:url(../missing.svg#icon)}', base, assets),
    'a{mask:url("https://example.test/missing.svg#icon")}');
});

test('does not conflate asset URLs with different query parameters', () => {
  assert.equal(rewriteCss('a{background:url(../sprite.svg?theme=dark#search)}', base, assets),
    'a{background:url("https://example.test/sprite.svg?theme=dark#search")}');
});

test('localizes exported blob-backed icon URLs', () => {
  assert.equal(rewriteCss('a{mask:url(blob:https://example.test/icon)}', base,
    { 'blob:https://example.test/icon': 'assets/icon.svg' }), 'a{mask:url("assets/icon.svg")}');
});
