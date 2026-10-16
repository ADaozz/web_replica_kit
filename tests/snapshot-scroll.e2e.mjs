import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { makeSnapshotHtml } from '../capture.mjs';

const fixture = `<!doctype html><html><head><style>
body { margin:0 } #shell { width:600px; overflow:auto; scroll-timeline:--slide inline }
#layout { width:600px; display:grid; grid-template-columns:240px 1fr;
animation:shrink 1s linear both; animation-timeline:--slide }
@keyframes shrink { from {grid-template-columns:240px 1fr} to {grid-template-columns:80px 1fr} }
#rail { background:#ddd; overflow:hidden } #track {width:760px;height:1px}
.scroll { width:180px; height:60px; overflow:auto; scroll-behavior:smooth }
.content {width:400px;height:300px} #nested {height:120px}
x-scroll:not(:defined), x-pending:not(:defined) { display:none }
</style></head><body>
<div id="shell"><div id="layout"><aside id="rail">Menu without icons</aside><main>Content</main></div><div id="track"></div></div>
<div id="outer" class="scroll"><div class="content"><div id="nested" class="scroll"><div class="content">Nested content</div></div></div></div>
<p id="unicode">侧栏菜单 — café</p><button id="toggle" aria-expanded="false" aria-controls="panel">More</button><section id="panel" hidden>Observed panel</section>
<x-scroll></x-scroll><x-pending>Not upgraded on source</x-pending>
<script>customElements.define('x-scroll',class extends HTMLElement { connectedCallback() {
this.attachShadow({mode:'open'}).innerHTML='<style>#scroll{width:100px;height:40px;overflow:auto}div div{width:300px;height:200px}</style><div id="scroll"><div>Shadow content</div></div>';
}});</script></body></html>`;

test('snapshot restores zero/nonzero scroll, nested and shadow offsets under CSP in file and HTTP previews', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'replica-scroll-'));
  const browser = await chromium.launch();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(await fs.readFile(path.join(directory, 'index.html')));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const source = await browser.newPage({ viewport: { width:1000, height:700 } });
    await source.setContent(fixture);
    for (const left of [0, 160]) {
      await source.evaluate(left => {
        document.querySelector('#shell').scrollLeft = left;
        for (const [id, x, y] of [['outer', 45, 70], ['nested', 25, 30]]) {
          const el = document.getElementById(id);
          el.style.scrollBehavior = 'auto'; el.scrollLeft = x; el.scrollTop = y;
        }
        const shadow = document.querySelector('x-scroll').shadowRoot.getElementById('scroll');
        shadow.scrollLeft=60; shadow.scrollTop=50;
      }, left);
      await source.waitForTimeout(80);
      const expected = await source.locator('#rail').boundingBox();
      const snapshot = await makeSnapshotHtml(source, {});
      assert.ok(snapshot.html.includes(`data-wrk-scroll-left="${left}"`));
      const html = snapshot.html;
      await fs.writeFile(path.join(directory, 'index.html'), html);
      for (const url of [pathToFileURL(path.join(directory,'index.html')).href, `http://127.0.0.1:${server.address().port}/`]) {
        const page = await browser.newPage({ viewport: { width:1000, height:700 } });
        // Reproduce a browser-selected initial scroll position that differs from the capture.
        await page.addInitScript(other => document.addEventListener('DOMContentLoaded', () => {
          document.querySelector('#shell').scrollLeft = other;
        }), left === 0 ? 160 : 0);
        await page.goto(url);
        await page.waitForTimeout(160);
        assert.equal(await page.locator('#shell').evaluate(el=>el.scrollLeft),left);
        assert.equal(await page.locator('#unicode').textContent(),'侧栏菜单 — café');
        assert.ok(Math.abs((await page.locator('#rail').boundingBox()).width - expected.width) < 1);
        for (const [id,x,y] of [['outer',45,70],['nested',25,30]]) {
          assert.deepEqual(await page.locator(`#${id}`).evaluate(el=>[el.scrollLeft,el.scrollTop]),[x,y]);
        }
        assert.deepEqual(await page.locator('x-scroll').evaluate(el=>{
          const scroller=el.shadowRoot.getElementById('scroll');return [scroller.scrollLeft,scroller.scrollTop];
        }),[60,50]);
        assert.equal(await page.locator('x-scroll').evaluate(el=>el.matches(':defined')),true);
        assert.equal(await page.locator('x-scroll').isVisible(),true);
        assert.equal(await page.locator('x-pending').evaluate(el=>el.matches(':defined')),false);
        assert.equal(await page.locator('#shell').evaluate(el=>el.style.getPropertyValue('scroll-snap-type')),'');
        await page.getByRole('button',{name:'More',exact:true}).click();
        assert.equal(await page.locator('#panel').isVisible(),false,'static preview does not synthesize interactions');
        assert.equal(await page.locator('#toggle').getAttribute('aria-expanded'),'false');
        await page.evaluate(()=>{const el=document.createElement('script');el.textContent='window.untrustedExecuted=true';document.body.append(el)});
        assert.equal(await page.evaluate(()=>window.untrustedExecuted),undefined,'CSP still blocks unapproved scripts');
        await page.close();
      }
    }
    // A late load must not undo a real user's scroll/input after initialization.
    const pendingSnapshot = await makeSnapshotHtml(source, {});
    await fs.writeFile(path.join(directory, 'index.html'), pendingSnapshot.html.replace('</body>',
      '<img src="/held.svg" width="1" height="1"></body>'));
    const active = await browser.newPage();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await active.route('**/held.svg', async route => {
      await held;
      await route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg"/>'});
    });
    try {
      await active.goto(`http://127.0.0.1:${server.address().port}/`, {waitUntil:'domcontentloaded'});
      await active.keyboard.press('Tab');
      await active.locator('#shell').evaluate(el=>el.scrollLeft=80);
      release();
      await active.waitForLoadState('load');
      await active.waitForTimeout(100);
      assert.equal(await active.locator('#shell').evaluate(el=>el.scrollLeft),80,'late load preserves user changes');
    } finally { release(); await active.close(); }
  } finally {
    await browser.close();
    await new Promise(resolve=>server.close(resolve));
    await fs.rm(directory,{recursive:true,force:true});
  }
});
