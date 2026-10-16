import test from 'node:test';
import assert from 'node:assert/strict';
import { completeIcons, iconFontSources, discoverIcons, inlineSpriteSymbols } from '../icon-capture.mjs';

const svg = Buffer.from('<svg><symbol id="search"/><symbol id="close"/></svg>');
function inventory(resources = []) {
  return { resources, missing: [], fonts: [], sheets: [], inspected: 10, inlineSvg: 1, shadowRoots: 0 };
}
function adapters(overrides = {}) {
  return { inventory: inventory(), find: () => null, read: async () => svg,
    fetchResource: async url => ({ url, status: 200, contentType: 'image/svg+xml', body: svg }),
    save: async url => ({ url, localPath: 'assets/sprite.svg' }), ...overrides };
}

test('icon font collection chooses a modern source, leaving unrelated image and font dependencies optional', () => {
  const css = `@font-face{font-family:"FontAwesome";src:url(icon.eot);src:url(icon.woff2?v=1) format('woff2'),url(icon.woff) format('woff')}
@font-face{font-family:Body;src:url(body.woff2)} .hero{background:url(photo.jpg)}`;
  assert.deepEqual(iconFontSources(css, 'https://example.test/css/icons.css', [{ family: 'fontawesome' }]), [
    { url: 'https://example.test/css/icon.woff2?v=1', kind: 'icon-font', family: 'fontawesome' }
  ]);
});

test('supplements a shared sprite once and validates each referenced symbol', async () => {
  let requests = 0;
  const result = await completeIcons(adapters({ inventory: inventory([
    { url: 'https://example.test/sprite.svg#search', kind: 'svg-use' },
    { url: 'https://example.test/sprite.svg#close', kind: 'svg-use' }
  ]), fetchResource: async url => { requests++; return { url, status: 200, body: svg }; } }));
  assert.equal(requests, 1);
  assert.equal(result.complete, true);
  assert.deepEqual(result.resources.map(r => r.fragment), ['#search', '#close']);
});

test('missing icons retry once and are explicitly incomplete', async () => {
  let requests = 0;
  const result = await completeIcons(adapters({ inventory: inventory([
    { url: 'https://example.test/missing.svg', kind: 'icon-image' }
  ]), fetchResource: async () => { requests++; return { status: 404 }; } }));
  assert.equal(requests, 2);
  assert.equal(result.complete, false);
  assert.match(result.missing[0].reason, /404/);
});

test('saved files still require valid SVG fragment IDs', async () => {
  const result = await completeIcons(adapters({ inventory: inventory([
    { url: 'https://example.test/sprite.svg#absent', kind: 'svg-use' }
  ]), find: () => ({ localPath: 'assets/sprite.svg' }),
  fetchResource: () => { throw new Error('must not refetch'); } }));
  assert.equal(result.complete, false);
  assert.equal(result.missing[0].reason, 'SVG fragment ID not found');
});

test('size/storage failures cannot silently count as saved icons', async () => {
  const result = await completeIcons(adapters({ inventory: inventory([
    { url: 'https://example.test/icon.svg', kind: 'icon-image' }
  ]), save: async () => { throw new Error('Resource exceeds capture size budget'); } }));
  assert.equal(result.complete, false);
  assert.match(result.missing[0].reason, /size budget/);
});

test('a 200 HTML error page is rejected as an icon', async () => {
  let saves = 0;
  const result = await completeIcons(adapters({ inventory: inventory([
    { url: 'https://example.test/icon.svg', kind: 'icon-image' }
  ]), fetchResource: async () => ({ status: 200, contentType: 'text/html', body: Buffer.from('Login') }),
  save: async () => { saves++; } }));
  assert.equal(result.complete, false);
  assert.equal(saves, 0);
});

test('an already recorded HTML error page is not counted as a saved icon', async () => {
  const result = await completeIcons(adapters({ inventory: inventory([
    { url: 'https://example.test/icon.svg', kind: 'icon-image' }
  ]), find: () => ({ localPath: 'assets/error.svg', contentType: 'text/html' }) }));
  assert.equal(result.complete, false);
  assert.match(result.missing[0].reason, /HTML/);
});

test('inline failures are retained while embedded icon images need no network request', async () => {
  const inv = inventory([{ url: 'data:image/svg+xml,%3Csvg/%3E', kind: 'icon-image' }]);
  inv.missing.push({ kind: 'missing-svg-id', reference: '#missing' });
  const result = await completeIcons(adapters({ inventory: inv,
    fetchResource: () => { throw new Error('embedded resources must not fetch'); } }));
  assert.equal(result.complete, false);
  assert.equal(result.resources[0].status, 'embedded');
  assert.equal(result.missing[0].reference, '#missing');
});

test('known icon font families with no exportable font source are incomplete', async () => {
  const inv = inventory(); inv.fonts = [{ family: 'material icons' }];
  const result = await completeIcons(adapters({ inventory: inv }));
  assert.equal(result.complete, false);
  assert.equal(result.missing[0].kind, 'unresolved-icon-font');
});

test('external sprite references become symbols in the same document', () => {
  const html = inlineSpriteSymbols(
    '<body><svg><use href="assets/sprite.svg#search"/></svg><use href="#close"/></body>',
    ['<svg><symbol id="search"><path d="M0 0"/></symbol><symbol id="close"><path d="M1 1"/></symbol></svg>']
  );
  assert.equal(html.includes('assets/sprite.svg'), false);
  assert.match(html, /id="wrk-sprite"/);
  assert.match(html, /id="search"/);
  assert.match(html, /id="close"/);
  assert.equal(html.match(/id="search"/g).length, 1);
});

test('system symbol fallbacks are not missing icon fonts; custom symbol fonts remain required', async () => {
  const inv = inventory();
  inv.fonts = [{ family: 'segoe ui symbol' }, { family: 'apple symbols' }];
  assert.equal((await completeIcons(adapters({ inventory: inv }))).complete, true);
  inv.fonts.push({ family: 'site symbols' }, { family: 'site symbols' });
  const result = await completeIcons(adapters({ inventory: inv }));
  assert.deepEqual(result.missing, [{ kind: 'unresolved-icon-font', family: 'site symbols' }]);
});

test('sprite inlining preserves missing, conflicting, non-symbol and non-use references', () => {
  const html = '<body><use href="assets/a.svg#missing"/><use href="assets/a.svg#conflict"/><use href="assets/a.svg#existing"/><svg id="existing"></svg><image href="assets/a.svg#ok"/><a href="assets/a.svg#ok">Image</a></body>';
  const sources = ['<svg><symbol id="conflict"><path d="M0 0"/></symbol><symbol id="existing"><path d="M1 1"/></symbol><symbol id="ok"><path/></symbol></svg>',
    '<svg><symbol id="conflict"><path d="M2 2"/></symbol></svg>'];
  assert.equal(inlineSpriteSymbols(html, sources), html);
});

test('blob-backed icons are saved through the browser adapter', async () => {
  const result = await completeIcons(adapters({ inventory: inventory([
    { url: 'blob:https://example.test/icon', kind: 'icon-image' }
  ]) }));
  assert.equal(result.complete, true);
  assert.equal(result.resources[0].localPath, 'assets/sprite.svg');
});

function element(tag, attrs = {}, style = {}) {
  return { localName: tag, id: attrs.id || '', textContent: '', namespaceURI: '',
    currentSrc: attrs.src || '', sheet: null, shadowRoot: null,
    getAttribute: name => attrs[name] || null, querySelector: () => null,
    getBoundingClientRect: () => ({ width: 24, height: 24 }),
    style: { display: 'inline', visibility: 'visible', fontFamily: 'sans-serif',
      backgroundImage: 'none', maskImage: 'none', ...style } };
}
function discoverWithDocument(nodes, ids = [], sheets = []) {
  const previousDocument = globalThis.document;
  const previousStyle = globalThis.getComputedStyle;
  globalThis.document = { URL: 'https://example.test/page', baseURI: 'https://example.test/page',
    styleSheets: sheets, adoptedStyleSheets: [], querySelectorAll: () => nodes,
    getElementById: id => ids.includes(id) ? {} : null };
  globalThis.getComputedStyle = (el, pseudo) => pseudo ? { content: 'none' } : el.style;
  try { return discoverIcons(); }
  finally { globalThis.document = previousDocument; globalThis.getComputedStyle = previousStyle; }
}

test('discovers required SVG and CSS icons while known avatars remain optional', () => {
  const avatar = element('img', { src: 'https://github.com/example.png' });
  const icon = element('img', { src: '/icons/search.svg' });
  const mask = element('span', {}, { maskImage: 'url("https://example.test/page#mask")' });
  const bg = element('span', {}, { backgroundImage: 'url("https://example.test/icons/arrow.png")' });
  const result = discoverWithDocument([avatar, icon, mask, bg], ['mask']);
  assert.deepEqual(result.resources.map(r => r.url), [
    'https://example.test/icons/search.svg', 'https://example.test/icons/arrow.png'
  ]);
  assert.deepEqual(result.missing, []);
});

test('shadow icon IDs resolve within their root and missing custom icon contents are reported', () => {
  const use = element('use', { href: '#shadow-glyph' });
  const host = element('x-icon');
  host.shadowRoot = { querySelectorAll: () => [use], getElementById: id => id === 'shadow-glyph' ? {} : null,
    adoptedStyleSheets: [{ cssRules: [{ cssText: '.glyph { fill: red; }' }] }] };
  const result = discoverWithDocument([host, element('missing-icon')]);
  assert.equal(result.shadowRoots, 1);
  assert.equal(result.sheets.length, 1);
  assert.deepEqual(result.missing, [{ kind: 'unresolved-icon-component', tag: 'missing-icon' }]);
});
