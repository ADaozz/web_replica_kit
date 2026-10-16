// 在每个页面状态下枚举可操作候选。图标不是发现前提。
// 闭合 Shadow DOM 不可读，本模块不声称支持。

export function classifyActionSafety(control, options = {}) {
  function dangerous(value) {
    return /(?:删除|提交|发送|购买|支付|付款|退出|登出|授权|安装|上传|下单|注销|下载)|(?:\b(?:delete|remove|submit|send|purchase|buy|checkout|pay|payment|logout|log out|sign out|authorize|install|upload|download|place order)\b)/i.test(value);
  }
  function navigationKind(href, pageOrigin) {
    const raw = String(href || '').trim();
    if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw)) return 'local';
    let url;
    try { url = new URL(raw, pageOrigin || 'http://local.invalid'); }
    catch { return 'local'; }
    if (url.protocol === 'mailto:' || url.protocol === 'tel:') return 'external';
    if (!pageOrigin || !/^https?:$/.test(new URL(pageOrigin).protocol || 'http:')) return 'local';
    let origin;
    try { origin = new URL(pageOrigin).origin; } catch { return 'local'; }
    if (url.origin !== origin) return 'external';
    const here = new URL(pageOrigin);
    if (url.pathname === here.pathname && url.search === here.search) return 'local';
    return 'same-origin';
  }
  const allowSameOriginNavigation = Boolean(options.allowSameOriginNavigation);
  const pageOrigin = options.pageOrigin || control.pageOrigin || null;
  const blob = `${control.accessibleName || ''} ${control.text || ''}`;
  if (control.inputType === 'file' || control.inputType === 'password' || control.inputType === 'hidden') {
    return { classification: 'blocked', reason: 'credential, file, or hidden input' };
  }
  if (control.submit) return { classification: 'blocked', reason: 'form submit control' };
  if (control.download) return { classification: 'blocked', reason: 'download' };
  if (control.form && control.form.method && control.form.method !== 'get' && control.submitsForm) {
    return { classification: 'blocked', reason: 'non-GET form submission' };
  }
  if (dangerous(blob)) return { classification: 'blocked', reason: 'dangerous or mutating action label' };
  if (control.tag === 'a' && control.href) {
    const kind = navigationKind(control.href, pageOrigin);
    if (kind === 'external') return { classification: 'blocked', reason: 'external navigation' };
    if (kind === 'same-origin' && !allowSameOriginNavigation) {
      return { classification: 'review-required', reason: 'same-origin navigation requires permission' };
    }
    if (kind === 'same-origin' && allowSameOriginNavigation) {
      return { classification: 'allowed-safe', reason: 'permitted same-origin navigation' };
    }
  }
  if (control.enabled === false) return { classification: 'review-required', reason: 'disabled control' };
  const popup = Boolean(control.popup) && control.popup !== 'false';
  const local = control.tag === 'summary'
    || control.expanded != null
    || control.pressed != null
    || popup
    || control.role === 'tab'
    || Boolean(control.describedby)
    || (['textbox','combobox'].includes(control.role) && Boolean(control.controls) && !control.form)
    || (['switch', 'checkbox', 'radio'].includes(control.role) && Boolean(control.controls));
  if (local && control.evidenceStrength !== 'weak') {
    return { classification: 'allowed-safe', reason: 'reversible local interface state' };
  }
  if (control.evidenceStrength === 'weak') {
    return { classification: 'review-required', reason: 'pointer or weak cue is not actionability' };
  }
  return { classification: 'review-required', reason: 'no confirmed reversible local effect' };
}

export function discoverActionableDom(options = {}) {
  const SKIP_TAGS = new Set(['script', 'style', 'link', 'meta', 'title', 'head', 'html', 'noscript', 'template', 'br', 'wbr']);
  const TEXT_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'switch']);
  function cssEscape(value) {
    const text = String(value);
    if (globalThis.CSS?.escape) return CSS.escape(text);
    return text.replace(/[^a-zA-Z0-9_-]/g, char => '\\' + char);
  }
  const framePath = options.framePath || [];
  const frameUrl = options.frameUrl || null;
  const pageOrigin = options.pageOrigin || readOrigin();
  const limitations = [];
  const controls = [];
  let scanned = 0;
  let truncated = false;
  let openShadows = 0;
  const limit = options.limit || 8000;

  function readOrigin() {
    try { return document.baseURI || document.URL || null; } catch { return null; }
  }
  function styleOf(el) {
    try { return getComputedStyle(el) || {}; } catch { return {}; }
  }
  function boxOf(el) {
    try {
      const box = el.getBoundingClientRect();
      return { x: box.x || 0, y: box.y || 0, width: box.width || 0, height: box.height || 0 };
    } catch { return { x: 0, y: 0, width: 0, height: 0 }; }
  }
  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode?.();
    return root?.host || null;
  }
  function byId(root, id) {
    if (!id) return null;
    if (typeof root.getElementById === 'function') {
      const found = root.getElementById(id);
      if (found) return found;
    }
    const all = root.querySelectorAll ? [...root.querySelectorAll('*')] : [];
    return all.find(node => node.id === id) || null;
  }
  function labelTextFor(el, root) {
    if (!el.id || !root.querySelectorAll) return null;
    const label = [...root.querySelectorAll('label')].find(node => node.getAttribute('for') === el.id);
    return label?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 160) || null;
  }
  function accessibleName(el, root, role) {
    const aria = el.getAttribute?.('aria-label');
    if (aria && aria.trim()) return aria.trim().slice(0, 160);
    const labelledby = el.getAttribute?.('aria-labelledby');
    if (labelledby) {
      const text = labelledby.split(/\s+/).map(id => byId(root, id)?.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 160);
    }
    if (el.id && root.querySelectorAll) {
      const label = [...root.querySelectorAll('label')].find(node => node.getAttribute('for') === el.id);
      const text = label?.textContent?.replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 160);
    }
    for (let parent = parentOf(el); parent; parent = parentOf(parent)) {
      if (parent.localName === 'label') {
        const text = parent.textContent?.replace(/\s+/g, ' ').trim();
        if (text) return text.slice(0, 160);
      }
    }
    const placeholder = el.getAttribute?.('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim().slice(0, 160);
    const title = el.getAttribute?.('title');
    if (title && title.trim()) return title.trim().slice(0, 160);
    if (role && TEXT_ROLES.has(role) || ['button', 'a', 'summary', 'option'].includes(el.localName)) {
      return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    }
    return '';
  }
  function implicitRole(el) {
    const tag = el.localName;
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'option') return 'option';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'hidden') return null;
      return 'textbox';
    }
    const editable = el.getAttribute('contenteditable');
    if (editable && editable !== 'false') return 'textbox';
    return null;
  }
  function visibility(el) {
    if (el.hasAttribute?.('hidden')) return 'currently-hidden';
    const style = styleOf(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return 'currently-hidden';
    const box = boxOf(el);
    if (box.width <= 0 || box.height <= 0) return 'currently-hidden';
    if (el.getAttribute?.('aria-hidden') === 'true') return 'currently-hidden';
    return 'visible';
  }
  function cssPath(el) {
    const root = el.getRootNode?.();
    const prefix = root?.host ? `${cssPath(root.host).selector} >>> ` : '';
    const unique = value => {try {return (root || document).querySelectorAll(value).length === 1;} catch {return false;}};
    if (el.id && unique(`#${cssEscape(el.id)}`)) return { selector: `${prefix}#${cssEscape(el.id)}`, stable: true };
    const testId = el.getAttribute?.('data-testid');
    if (testId && unique(`[data-testid="${cssEscape(testId)}"]`)) return { selector: `${prefix}[data-testid="${cssEscape(testId)}"]`, stable: true };
    const parts = [];
    let current = el;
    while (current && current.nodeType === 1 && current.localName !== 'html' && current.localName !== 'body') {
      if (current.id && unique(`#${cssEscape(current.id)}`)) { parts.unshift(`#${cssEscape(current.id)}`); break; }
      const siblings = current.parentElement?.children || [];
      let nth = 0;
      for (const sibling of siblings) {
        if (sibling.localName === current.localName) nth++;
        if (sibling === current) break;
      }
      parts.unshift(`${current.localName}:nth-of-type(${nth || 1})`);
      current = current.parentElement;
    }
    const selector = `${prefix}${parts.join(' > ')}`;
    const local = selector.split('>>>').pop().trim();
    let scopedUnique = false;
    try { scopedUnique = el.getRootNode?.()?.querySelectorAll?.(local)?.length === 1; } catch {}
    return { selector, stable: scopedUnique };
  }

  function consider(el, root) {
    if (!el || el.nodeType !== 1 || SKIP_TAGS.has(el.localName)) return;
    const explicit = el.getAttribute?.('role');
    const role = explicit || implicitRole(el);
    const style = styleOf(el);
    const evidence = [];
    const semantic = ['button', 'input', 'select', 'textarea', 'summary', 'option'].includes(el.localName)
      || (el.localName === 'a' && el.hasAttribute('href'));
    if (semantic) evidence.push('semantic-html');
    if (explicit) evidence.push('role');
    if (['aria-expanded', 'aria-pressed', 'aria-checked', 'aria-haspopup', 'aria-controls', 'aria-selected'].some(name => el.hasAttribute(name))) {
      evidence.push('aria-state');
    }
    const editableAttr = el.getAttribute('contenteditable');
    if (editableAttr && editableAttr !== 'false') evidence.push('contenteditable');
    if (el.hasAttribute('onclick')) evidence.push('onclick-attribute');
    const tabIndex = el.getAttribute('tabindex');
    if (tabIndex !== null && Number(tabIndex) >= 0) evidence.push('tabindex');
    if (style.cursor === 'pointer') evidence.push('cursor-pointer');
    const strong = evidence.some(item => item !== 'cursor-pointer' && item !== 'tabindex');
    if (!strong && evidence.length === 0 && !role) return;
    const inputType = el.localName === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : null;
    const buttonType = el.localName === 'button' ? (el.getAttribute('type') || '').toLowerCase() : null;
    const form = el.form || null;
    const method = form ? String(form.getAttribute?.('method') || form.method || 'get').toLowerCase() : null;
    const inForm = Boolean(form);
    const submit = inputType === 'submit' || inputType === 'image' || buttonType === 'submit'
      || (el.localName === 'button' && inForm && buttonType !== 'button' && buttonType !== 'reset');
    let expanded = el.getAttribute('aria-expanded');
    if (el.localName === 'summary') {
      const details = el.parentElement?.localName === 'details' ? el.parentElement : null;
      expanded = details?.hasAttribute('open') ? 'true' : 'false';
    }
    const name = accessibleName(el, root, role);
    const path = cssPath(el);
    const checked = el.getAttribute('aria-checked') ?? (el.checked === true ? 'true' : el.checked === false ? 'false' : (el.hasAttribute('checked') ? 'true' : null));
    const box = boxOf(el);
    const enabled = !(el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || el.disabled === true);
    const draft = {
      tag: el.localName,
      role: role || null,
      accessibleName: name,
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      placeholder: el.getAttribute('placeholder'),
      testId: el.getAttribute('data-testid'),
      label: null,
      href: el.getAttribute('href'),
      download: el.hasAttribute('download'),
      labelText: labelTextFor(el, root),
      inputType,
      buttonType: buttonType || null,
      submit,
      submitsForm: submit,
      form: form ? { method: method || 'get', action: safePath(form.getAttribute?.('action') || form.action || '', pageOrigin) } : null,
      expanded,
      pressed: el.getAttribute('aria-pressed'),
      checked,
      selected: el.getAttribute('aria-selected'),
      popup: el.getAttribute('aria-haspopup'),
      controls: el.getAttribute('aria-controls') || el.getAttribute('popovertarget'),
      describedby: el.getAttribute('aria-describedby'),
      enabled,
      editable: role === 'textbox' || evidence.includes('contenteditable'),
      visibility: visibility(el),
      bbox: box,
      evidence,
      evidenceStrength: strong ? 'semantic' : 'weak',
      selector: path.selector,
      selectorStable: path.stable,
      framePath,
      frameUrl,
      pageOrigin,
      hitTest: 'unverified',
      actionability: 'unverified',
      value: null,
      options: el.localName === 'select' ? [...(el.options || [])].filter(o => !o.disabled).map(o => o.value) : null,
      sensitive: inputType === 'password' || /token|secret|password/i.test(`${name} ${el.getAttribute('name') || ''}`),
      noise: /timestamp|clock|nonce|uuid/i.test(`${el.id || ''} ${el.getAttribute('class') || ''}`)
    };
    if (!draft.sensitive && (el.localName === 'input' || el.localName === 'textarea' || el.localName === 'select')) {
      draft.value = 'value' in el && el.value != null ? String(el.value).slice(0, 120) : (el.getAttribute('value') || '').slice(0, 120);
    }
    controls.push({ el, root, draft });
  }

  function safePath(action, origin) {
    if (!action) return '';
    try { return new URL(action, origin || 'http://local.invalid').pathname; } catch { return ''; }
  }

  function walk(root) {
    if (truncated || !root?.querySelectorAll) return;
    for (const template of root.querySelectorAll('template')) {
      if (template.getAttribute('shadowrootmode') === 'closed') {
        limitations.push({ reason: 'closed-shadow-dom', detail: 'Closed shadow roots are not readable and are not supported.' });
      }
    }
    for (const el of root.querySelectorAll('*')) {
      if (++scanned > limit) { truncated = true; return; }
      if (el.localName === 'iframe') {
        limitations.push({ reason: 'iframe-requires-frame-traversal', selector: el.id ? `#${el.id}` : 'iframe' });
      }
      consider(el, root);
      if (el.shadowRoot) { openShadows++; walk(el.shadowRoot); }
    }
  }

  walk(document);
  limitations.push({ reason: 'closed-shadow-dom', detail: 'Closed shadow roots are not readable and are not claimed as supported.' });

  const semanticHosts = new Set(controls.filter(item => item.draft.evidenceStrength !== 'weak').map(item => item.el));
  const kept = controls.filter(item => {
    if (item.draft.evidenceStrength !== 'weak') return true;
    for (let parent = parentOf(item.el); parent; parent = parentOf(parent)) {
      if (semanticHosts.has(parent)) return false;
    }
    return true;
  });

  const nameCounts = new Map();
  for (const item of kept) {
    const key = `${item.draft.role || ''}|${item.draft.accessibleName}`;
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }
  const seenName = new Map();
  const regions = [];
  const seenRegions = new Set();
  function addRegion(el) {
    if (!el || el.nodeType !== 1 || seenRegions.has(el)) return;
    seenRegions.add(el);
    const path = cssPath(el);
    regions.push({ selector: path.selector, visible: visibility(el) === 'visible', bbox: boxOf(el) });
  }
  for (const item of kept) {
    if (item.draft.controls) {
      for (const id of item.draft.controls.split(/\s+/)) addRegion(byId(item.root, id) || byId(document, id));
    }
    if (item.el.localName === 'summary' && item.el.parentElement?.localName === 'details') addRegion(item.el.parentElement);
  }
  try {
    for (const el of document.querySelectorAll('nav, aside, [role="navigation"], [role="complementary"]')) addRegion(el);
  } catch { /* 测试用的简化文档没有这些选择器 */ }
  const result = kept.map(item => {
    const key = `${item.draft.role || ''}|${item.draft.accessibleName}`;
    const occurrence = seenName.get(key) || 0;
    seenName.set(key, occurrence + 1);
    const ambiguous = (nameCounts.get(key) || 0) > 1 && Boolean(item.draft.accessibleName);
    const strategies = [];
    if (item.draft.role && item.draft.accessibleName && !ambiguous) {
      strategies.push({ type: 'role', role: item.draft.role, name: item.draft.accessibleName, exact: true });
    }
    if (item.draft.labelText) strategies.push({ type: 'label', name: item.draft.labelText, exact: true });
    if (item.draft.placeholder) strategies.push({ type: 'placeholder', name: item.draft.placeholder, exact: true });
    if (item.draft.testId) strategies.push({ type: 'testid', name: item.draft.testId });
    if (item.draft.selectorStable) strategies.push({ type: 'css', selector: item.draft.selector.replaceAll('>>>', ' '), stable: true });
    const safety = classifyActionSafety(item.draft, { allowSameOriginNavigation: options.allowSameOriginNavigation, pageOrigin });
    const semanticKey = item.draft.selectorStable ? [frameUrl || 'main', JSON.stringify(framePath), item.draft.selector].join('|') : [frameUrl || 'main', item.draft.role || item.draft.tag, item.draft.accessibleName, occurrence].join('|');
    return {
      ...item.draft,
      id: semanticKey,
      semanticKey,
      locatorAmbiguous: ambiguous && !item.draft.selectorStable,
      locatorStrategies: strategies,
      classification: safety.classification,
      classificationReason: safety.reason,
      stage: 'discovered'
    };
  });

  return {
    controls: result,
    regions,
    scanned,
    truncated,
    openShadows,
    limitations,
    closedShadowSupported: false
  };
}

export function loadBrowserDiscover() {
  return new Function('options', `${classifyActionSafety.toString()}
    return (${discoverActionableDom.toString()})(options);`);
}

export async function discoverAllFrames(page, options = {}) {
  const controls = [];
  const regions = [];
  const limitations = [];
  let openShadows = 0;
  for (const [frameIndex, frame] of page.frames().entries()) {
    const framePath = [];
    let cursor = frame;
    while (cursor.parentFrame()) {
      const parent = cursor.parentFrame();
      const handle = await cursor.frameElement().catch(() => null);
      const meta = handle ? await handle.evaluate(el => ({
        id: el.id || null,
        name: el.getAttribute('name'),
        title: el.getAttribute('title')
      })).catch(() => null) : null;
      framePath.unshift(meta || { url: cursor.url(), inaccessible: true });
      cursor = parent;
    }
    try {
      const runner = loadBrowserDiscover();
      const found = await frame.evaluate(runner, {
        ...options,
        frameUrl: frame.url(),
        framePath,
        pageOrigin: options.pageOrigin || frame.url()
      });
      for (const control of found.controls || []) controls.push({ ...control, frameIndex });
      for (const region of found.regions || []) regions.push(region);
      limitations.push(...(found.limitations || []));
      openShadows += found.openShadows || 0;
    } catch (error) {
      limitations.push({ frameUrl: frame.url(), reason: 'frame-inaccessible', detail: String(error.message || error) });
    }
  }
  return { controls, regions, limitations, openShadows, closedShadowSupported: false };
}
