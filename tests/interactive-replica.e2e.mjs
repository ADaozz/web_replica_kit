import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { explorePage } from '../interaction-explorer.mjs';
import { injectOfflineRuntime } from '../offline-runtime.mjs';
import { compareInteractionSnapshots } from '../state-diff.mjs';

const frameHtml = `<!doctype html><html><body>
<button id="frame-more" aria-expanded="false" aria-controls="frame-panel">Frame more</button>
<section id="frame-panel" hidden>In frame</section>
<script>
document.getElementById('frame-more').addEventListener('click', event => {
  const open = event.currentTarget.getAttribute('aria-expanded') !== 'true';
  event.currentTarget.setAttribute('aria-expanded', String(open));
  document.getElementById('frame-panel').hidden = !open;
});
</script></body></html>`;

const pageHtml = `<!doctype html><html><body>
<button id="more" aria-expanded="false" aria-controls="panel">More</button>
<section id="panel" hidden>Panel</section>
<button id="mode" role="switch" aria-checked="false" aria-controls="advanced">Show advanced</button>
<section id="advanced" hidden>Advanced</section>
<div role="tablist">
  <button id="tab-a" role="tab" aria-selected="true" aria-controls="panel-a">Account</button>
  <button id="tab-b" role="tab" aria-selected="false" aria-controls="panel-b">Billing</button>
</div>
<section id="panel-a">Account panel</section>
<section id="panel-b" hidden>Billing panel</section>
<button id="menu" aria-haspopup="menu" aria-expanded="false" aria-controls="menu-pop">Menu</button>
<div id="menu-pop" role="menu" hidden>Menu body</div>
<button id="side" aria-expanded="true" aria-controls="sidebar">Sidebar</button>
<aside id="sidebar" style="display:block;width:240px;height:40px">Side</aside>
<a id="settings" href="/settings">Settings</a>
<div id="view">Home</div>
<button id="danger">删除</button>
<form action="/send" method="post"><button id="send" type="submit">Send</button></form>
<button id="paused" disabled aria-expanded="false">Paused</button>
<button id="open-a">Open</button>
<button id="open-b">Open</button>
<div id="hot" style="cursor:pointer">Hot</div>
<x-box id="host"></x-box>
<x-closed id="closed-host"></x-closed>
<iframe id="frame" src="/frame.html"></iframe>
<input id="note" value="hello">
<script>
function bindToggle(id) {
  const button = document.getElementById(id);
  const panel = document.getElementById(button.getAttribute('aria-controls'));
  button.addEventListener('click', () => {
    const isSwitch = button.getAttribute('role') === 'switch';
    const attribute = isSwitch ? 'aria-checked' : 'aria-expanded';
    const open = button.getAttribute(attribute) !== 'true';
    button.setAttribute(attribute, String(open));
    panel.hidden = !open;
    if (id === 'side') panel.style.width = open ? '240px' : '72px';
  });
}
for (const id of ['more', 'mode', 'menu', 'side']) bindToggle(id);
for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('[role="tab"]')) {
      const on = other === tab;
      other.setAttribute('aria-selected', String(on));
      document.getElementById(other.getAttribute('aria-controls')).hidden = !on;
    }
  });
}
document.getElementById('settings').addEventListener('click', event => {
  event.preventDefault();
  history.pushState({}, '', '/settings');
  document.getElementById('view').textContent = 'Settings';
});
document.getElementById('danger').addEventListener('click', () => fetch('/danger', { method: 'POST' }));
customElements.define('x-box', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<button id="inner" aria-expanded="false" aria-controls="shadow-panel">Shadow more</button><section id="shadow-panel" hidden>Shadow panel</section>';
    const button = root.getElementById('inner');
    button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(open));
      root.getElementById('shadow-panel').hidden = !open;
    });
  }
});
customElements.define('x-closed', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<button>Secret</button>';
  }
});
</script></body></html>`;

function serve() {
  const posts = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST') { posts.push(url.pathname); res.writeHead(204); res.end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(url.pathname === '/frame.html' ? frameHtml : pageHtml);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server, posts, url: `http://127.0.0.1:${server.address().port}/`
  })));
}

async function readState(page) {
  return page.evaluate(() => ({
    route: location.pathname + location.search + location.hash,
    origin: location.origin,
    nodes: [
      ['more', '#more', 'aria-expanded'],
      ['panel', '#panel'],
      ['mode', '#mode', 'aria-checked'],
      ['advanced', '#advanced'],
      ['panel-a', '#panel-a'],
      ['panel-b', '#panel-b'],
      ['tab-b', '#tab-b', 'aria-selected'],
      ['sidebar', '#sidebar']
    ].map(([key, selector, aria]) => {
      const el = document.querySelector(selector);
      const box = el.getBoundingClientRect();
      return {
        key, selector, visible: !!el && !el.hidden && box.width > 0 && box.height > 0,
        expanded: aria === 'aria-expanded' ? el.getAttribute(aria) : null,
        checked: aria === 'aria-checked' ? el.getAttribute(aria) : null,
        selected: aria === 'aria-selected' ? el.getAttribute(aria) : null,
        bbox: { width: box.width, height: box.height, x: box.x, y: box.y }
      };
    })
  }));
}

test('source exploration and offline runtime reproduce observed local interactions', async () => {
  const fixture = await serve();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
    const exploration = await explorePage(page, {
      allowSameOriginNavigation: true,
      budgets: { maxStates: 24, maxDepth: 3, maxActions: 40 }
    });
    assert.equal(fixture.posts.includes('/danger'), false);
    assert.equal(fixture.posts.includes('/send'), false);
    assert.equal(exploration.controls.some(control => control.accessibleName === 'More' && control.tag === 'button'), true);
    assert.equal(exploration.controls.some(control => control.accessibleName === 'Secret'), false);
    assert.equal(exploration.controls.some(control => control.accessibleName === 'Shadow more'), true);
    assert.equal(exploration.controls.some(control => control.accessibleName === 'Frame more'), true);
    assert.equal(exploration.transitions.some(item => item.control.accessibleName === '删除'), false);
    assert.ok(exploration.transitions.some(item => item.control.accessibleName === 'More' && item.confidence === 'observed'));
    assert.equal(exploration.coverage.verified, 0);
    assert.equal(exploration.coverage.denominator > 0, true);

    const offline = injectOfflineRuntime(pageHtml.replace(/<script>[\s\S]*<\/script>/, ''), exploration.model);
    const replica = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await replica.route(fixture.url, route => route.fulfill({contentType:'text/html',body:offline}));
    await replica.goto(fixture.url);
    await replica.click('#more');
    await replica.click('#mode');
    await replica.click('#tab-b');
    assert.equal(await replica.locator('#note').inputValue(), 'hello');
    assert.equal(await replica.locator('#panel').isVisible(), true);
    assert.equal(await replica.locator('#advanced').isVisible(), true);
    assert.equal(await replica.locator('#panel-a').isHidden(), true);
    assert.equal(await replica.locator('#panel-b').isVisible(), true);

    await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
    await page.click('#more');
    await page.click('#mode');
    await page.click('#tab-b');
    const sourceState = await readState(page);
    const replicaState = await readState(replica);
    const compared = compareInteractionSnapshots(sourceState, replicaState);
    assert.equal(compared.verified, true, JSON.stringify(compared.effects));
  } finally {
    await browser.close();
    fixture.server.close();
  }
});
