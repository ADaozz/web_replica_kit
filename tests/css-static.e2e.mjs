import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {captureStylesheets} from '../css-rule-capture.mjs';
import {makeSnapshotHtml} from '../capture.mjs';
test('static CSS preserves order, conditions, dynamic rules, adopted scope and provenance',async()=>{
 const browser=await chromium.launch();try{
 const page=await browser.newPage();await page.setContent(`<style>@layer a,b; @media(min-width:1px){main{color:red}} @supports(display:grid){main{display:grid}} @container c (width>1px){main{padding:1px}} @font-face{font-family:X;src:url(data:font/woff2;base64,AAAA)}</style><style id="dynamic">:root{--x:2px}</style><main data-mode="shown">Hello</main><x-box></x-box>`);
 await page.evaluate(()=>{document.querySelector('#dynamic').sheet.insertRule('main[data-mode="shown"]{margin:var(--x)}');const root=document.querySelector('x-box').attachShadow({mode:'open'});root.innerHTML='<style>:host{display:block}</style><aside>Side</aside>';const sheet=new CSSStyleSheet();sheet.replaceSync('aside{color:blue}');root.adoptedStyleSheets=[sheet];});
 const css=await captureStylesheets(page);assert.equal(css.stylesheets.length,4);
 assert.equal(css.stylesheets[0].source,'cssom');assert.equal(css.stylesheets[0].sourceRange,null);
 assert.match(css.stylesheets[0].rules.join(' '),/@layer.*@media.*@supports.*@container.*@font-face/s);
 assert.match(css.stylesheets[1].rules.join(' '),/margin: var\(--x\)/);
 assert.equal(css.stylesheets[3].adopted,true);assert.match(css.stylesheets[3].scope,/shadow/);
 const {html}=await makeSnapshotHtml(page,{});assert.match(html,/data-mode="shown"/);assert.match(html,/margin: var\(--x\)/);assert.match(html,/aside\s*\{\s*color: blue/);
 }finally{await browser.close();}
});
