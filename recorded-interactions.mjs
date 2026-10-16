import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { analyzeIconInteractions } from './icon-interactions.mjs';
import { probeSourceIconInteractions } from './source-interaction-probe.mjs';

// 用户在原页面实际操作，采集器只监听事件并保存稳定后的 DOM 与截图。
export async function recordIconInteractions({ page, out, snapshot, settle = 1000, maxStates = 80, manual = false }) {
  if (manual && !process.stdin.isTTY) throw new Error('--manual-icon-interactions 需要交互式终端。');
  const binding = '__wrkRecord_' + crypto.randomBytes(8).toString('hex');
  const states = [];
  const transitions = [];
  const observations = [];
  const errors = [];
  let current = null;
  let accepting = true;
  let timer = null;
  let pending = null;
  let sequence = 0;
  let dropped = 0;
  let htmlBytes = 0;
  let brokenChain = false;
  let queue = Promise.resolve();
  const startURL = page.url();
  await fs.mkdir(path.join(out, 'interaction-states'), { recursive: true });
  async function capture(event = null, revision = sequence) {
    if (page.url() !== startURL) { errors.push('页面地址发生变化，未将跨页结果作为当前页面交互记录。'); return; }
    try {
      const html = await snapshot();
      if (revision !== sequence) { dropped++; brokenChain = true; return; }
      const hash = crypto.createHash('sha256').update(html).digest('hex');
      let state = states.find(s => s.hash === hash);
      if (!state) {
        if (states.length >= maxStates || htmlBytes + Buffer.byteLength(html) > 24 * 1024 * 1024) {
          errors.push('交互状态达到数量或 HTML 大小限制，未继续扩展状态图。'); return;
        }
        const id = 'state-' + String(states.length).padStart(3, '0');
        const screenshot = `interaction-states/${id}.png`;
        const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
        await page.screenshot({ path: path.join(out, screenshot), fullPage: true, animations: 'disabled', timeout: 30000 });
        if (revision !== sequence) { dropped++; brokenChain = true; return; }
        state = { id, hash, html, screenshot, scroll };
        states.push(state); htmlBytes += Buffer.byteLength(html);
        await fs.writeFile(path.join(out, `${id}.html`), html);
      }
      if (event && current) {
        observations.push({ ...event, from: current, to: state.id, changed: current !== state.id, linked: !brokenChain });
        if (current !== state.id && !brokenChain) transitions.push({ ...event, from: current, to: state.id, basis: 'observed-on-original-page' });
      }
      current = state.id; brokenChain = false;
      if (event) console.log('已记录原网页交互：', event.type, '|', states.length, '个状态');
    } catch (error) { errors.push(String(error.message || error)); }
  }
  await capture();
  await page.exposeBinding(binding, (_source, event) => {
    if (!accepting) return;
    const strong = value => value.type === 'click' || value.type === 'keydown';
    // 点击引发的同一控件失焦、移出等被动事件，不应覆盖真正触发状态变化的点击。
    if (pending && strong(pending.event) && !strong(event) && pending.event.selector === event.selector) return;
    if (pending && (pending.event.selector !== event.selector || (strong(pending.event) && strong(event)))) brokenChain = true;
    sequence++;
    if (timer) { clearTimeout(timer); dropped++; }
    pending = { event, revision: sequence };
    timer = setTimeout(() => {
      const item = pending; pending = null; timer = null;
      queue = queue.then(() => capture(item.event, item.revision));
    }, settle);
  });
  const inventory = await page.evaluate(analyzeIconInteractions, { recordBinding: binding });
  console.log(`检查到 ${inventory.totalIcons} 个图标候选、${inventory.interactiveHosts} 个交互宿主。`);
  if (manual) console.log('现在请在原网页操作图标及其控件：点击、悬停、移出或展开收起，每一步停留至少 1 秒。');
  console.log('保存原网页的实际 DOM 和截图；未操作的控件保留为待记录。');
  let probe = null;
  const flush = async () => {
    await page.waitForTimeout(settle + 150);
    await queue;
  };
  const rl = manual ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    if (manual) await rl.question('完成后回到这里按 Enter，保存实际状态和本地回放：');
    else {
      console.log('自动检查原网页图标宿主的悬停及已声明的界面状态操作。');
      probe = await probeSourceIconInteractions({ page, flush });
    }
  }
  finally {
    accepting = false; rl?.close();
    await page.evaluate(() => globalThis.__wrkIconObserver?.stop?.()).catch(() => {});
    if (timer) {
      clearTimeout(timer); timer = null;
      const item = pending; pending = null;
      await page.waitForTimeout(settle);
      queue = queue.then(() => capture(item.event, item.revision));
    }
    await queue;
  }
  const graph = validateRecordedTransitions(transitions);
  return { states, transitions: graph.replayable, ambiguousTransitions: graph.ambiguous, observations, inventory, dropped, errors,
    basis: 'observed-on-original-page', browserReplayVerified: false, probe,
    limitations: ['只回放已经操作并捕获的视觉状态，不恢复原站接口、业务函数或未录制的交互。',
      '连续操作过快、延迟超过等待时间或后台持续变化会影响状态关联，需要检查截图和操作记录。'] };
}

// 同一状态和同一操作如果得到不同结果，不能随便选择一个结果回放。
export function validateRecordedTransitions(transitions) {
  const groups = new Map();
  for (const transition of transitions) {
    const signature = JSON.stringify([transition.from, transition.type, transition.selector, transition.key || null]);
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(transition);
  }
  const replayable = [];
  const ambiguous = [];
  for (const group of groups.values()) {
    if (new Set(group.map(t => t.to)).size > 1) ambiguous.push(...group);
    else replayable.push(group[0]);
  }
  return { replayable, ambiguous };
}

// 录制后才补齐的资源也要改写进每一个状态，避免初始缺失地址继续指向源站。
export function rewriteRecordedAssets(html, mappings, sourceURL) {
  const decode = value => value.replace(/&quot;/g, '"').replace(/&#(?:39|x27);/gi, "'").replace(/&amp;/g, '&');
  const encode = (value, quote) => value.replace(/&/g, '&amp;').replace(quote === '"' ? /"/g : /'/g, quote === '"' ? '&quot;' : '&#39;');
  function map(raw) {
    if (!raw || /^(?:assets\/|#|data:|about:|javascript:)/i.test(raw)) return raw;
    try {
      const url = new URL(raw, sourceURL); const fragment = url.hash; url.hash = '';
      return mappings[url.href] ? mappings[url.href] + fragment : raw;
    } catch { return raw; }
  }
  const rewriteCSS = css => css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi,
    (_all, _quote, value) => `url("${map(value).replace(/"/g, '%22')}")`)
    .replace(/(@import\s+)(['"])([^'"\n]+)\2/gi,
      (_all, prefix, quote, value) => `${prefix}${quote}${map(value)}${quote}`);
  return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>|<(?:[^>"']|"[^"]*"|'[^']*')*>/gi, tag => {
    if (/^<style\b/i.test(tag)) return tag.replace(/(^<style\b[^>]*>)([\s\S]*)(<\/style>$)/i,
      (_all, open, css, close) => open + rewriteCSS(css) + close);
    return tag.replace(/\b(src|href|poster|data|xlink:href|style|srcset|imagesrcset)\s*=\s*(["'])([\s\S]*?)\2/gi,
      (_all, name, quote, raw) => {
        const value = decode(raw);
        const rewritten = name.toLowerCase() === 'style' ? rewriteCSS(value) :
          /srcset$/i.test(name) && !value.includes('data:') ? value.split(',').map(item => {
            const parts = item.trim().match(/^(\S+)(\s+.*)?$/); return parts ? map(parts[1]) + (parts[2] || '') : item;
          }).join(', ') : map(value);
        return `${name}=${quote}${encode(rewritten, quote)}${quote}`;
      });
  });
}

// 本地只回放原网页实际记录的状态，不按图标名称生成任何界面。
export function installRecordedInteractions() {
  const data = JSON.parse(document.getElementById('wrk-recorded-states').textContent);
  const states = new Map(data.states.map(s => [s.id, s]));
  let active = data.states[0]?.id;
  let switching = false;
  const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.cloneNode(true);
  function find(selector) {
    let root = document;
    const parts = selector.split(' >>> ');
    for (let i = 0; i < parts.length; i++) {
      const node = root.querySelector(parts[i]);
      if (!node) return null;
      if (i === parts.length - 1) return node;
      root = node.shadowRoot; if (!root) return null;
    }
  }
  function activateShadow(root) {
    for (const template of root.querySelectorAll('template[shadowrootmode="open"]')) {
      const host = template.parentElement;
      if (!host || host.shadowRoot) continue;
      const shadow = host.attachShadow({ mode: 'open', delegatesFocus: template.hasAttribute('shadowrootdelegatesfocus') });
      shadow.append(template.content); template.remove(); activateShadow(shadow);
    }
  }
  function apply(id) {
    const state = states.get(id); if (!state) return;
    switching = true;
    const parsed = new DOMParser().parseFromString(state.html, 'text/html');
    parsed.querySelectorAll('script,meta[http-equiv="Content-Security-Policy"]').forEach(el => el.remove());
    if (csp) parsed.head.prepend(csp.cloneNode(true));
    for (const attr of [...document.documentElement.attributes]) document.documentElement.removeAttribute(attr.name);
    for (const attr of parsed.documentElement.attributes) document.documentElement.setAttribute(attr.name, attr.value);
    document.documentElement.replaceChildren(document.importNode(parsed.head, true), document.importNode(parsed.body, true));
    activateShadow(document); active = id;
    window.scrollTo(state.scroll.x, state.scroll.y);
    requestAnimationFrame(() => requestAnimationFrame(() => { switching = false; }));
  }
  for (const type of ['click', 'pointerover', 'pointerout', 'focusin', 'focusout', 'keydown']) {
    document.addEventListener(type, event => {
      if (switching) return;
      for (const transition of data.transitions) {
        if (transition.from !== active || transition.type !== type || (type === 'keydown' && transition.key !== event.key)) continue;
        let target;
        try { target = find(transition.selector); } catch { continue; }
        if (!target || !event.composedPath().includes(target)) continue;
        if (['pointerover', 'pointerout', 'focusin', 'focusout'].includes(type) && target.contains(event.relatedTarget)) continue;
        if (type === 'click' || type === 'keydown') event.preventDefault();
        apply(transition.to); return;
      }
    }, true);
  }
}

export const recordedInteractionScript = `(${installRecordedInteractions.toString()})();`;

export function buildRecordedPreview(recording) {
  if (!recording.states.length) throw new Error('没有可用的原网页状态。');
  const runtime = recordedInteractionScript;
  const hash = crypto.createHash('sha256').update(runtime).digest('base64');
  const graph = validateRecordedTransitions(recording.transitions);
  const payload = JSON.stringify({ states: recording.states, transitions: graph.replayable }).replace(/</g, '\\u003c');
  const html = recording.states[0].html.replace(/script-src\s+[^;\"]+/i, `script-src 'sha256-${hash}'`);
  return html.replace(/<\/body>/i, `<script id="wrk-recorded-states" type="application/json">${payload}</script><script>${runtime}</script></body>`);
}
