// 将此函数写入本地快照，只处理采集器已标记的控件，不加载原站脚本。
export function installBasicInteractions() {
  const entries = [];
  function install(root) {
    const find = id => root.getElementById ? root.getElementById(id) : null;
    for (const trigger of root.querySelectorAll('[data-wrk-toggle], [data-wrk-hover]')) {
      const hover = trigger.hasAttribute('data-wrk-hover');
      const ids = trigger.getAttribute(hover ? 'data-wrk-hover' : 'data-wrk-toggle').split(/\s+/);
      const targets = ids.map(find).filter(Boolean);
      if (!targets.length) continue;
      const menu = trigger.getAttribute('data-wrk-mode') === 'menu';
      const saved = new Map(targets.map(target => [target, {
        display: target.style.getPropertyValue('display'), priority: target.style.getPropertyPriority('display')
      }]));
      const entry = { trigger, targets, menu, root, expanded: trigger.getAttribute('aria-expanded') === 'true' };
      function setExpanded(expanded) {
        entry.expanded = expanded;
        if (!hover) trigger.setAttribute('aria-expanded', String(expanded));
        trigger.classList.toggle('collapsed', !expanded);
        if (trigger.hasAttribute('data-state')) trigger.setAttribute('data-state', expanded ? 'open' : 'closed');
        for (const target of targets) {
          target.hidden = !expanded;
          target.setAttribute('aria-hidden', String(!expanded));
          target.classList.toggle('show', expanded);
          target.classList.remove('collapsing');
          if (expanded) target.classList.remove('hidden');
          if (target.hasAttribute('data-state')) target.setAttribute('data-state', expanded ? 'open' : 'closed');
          if (expanded) {
            const original = saved.get(target);
            if (original.display && original.display !== 'none') target.style.setProperty('display', original.display, original.priority);
            else target.style.removeProperty('display');
            if (getComputedStyle(target).display === 'none') target.style.setProperty('display', 'block', 'important');
            if (menu || target.getAttribute('role') === 'tooltip') {
              const rect = trigger.getBoundingClientRect();
              const width = target.getBoundingClientRect().width;
              target.style.setProperty('position', 'fixed', 'important');
              target.style.setProperty('inset', 'auto', 'important');
              target.style.setProperty('left', Math.max(4, Math.min(rect.left, innerWidth - width - 4)) + 'px', 'important');
              target.style.setProperty('top', rect.bottom + 4 + 'px', 'important');
              target.style.setProperty('transform', 'none', 'important');
            }
          } else target.style.setProperty('display', 'none', 'important');
        }
        // 同一面板可能由多个按钮控制，需要同步按钮状态，避免第二次点击方向错误。
        for (const other of entries) {
          if (other === entry || !other.targets.every(t => targets.includes(t))) continue;
          other.expanded = expanded;
          if (!other.trigger.hasAttribute('data-wrk-hover')) other.trigger.setAttribute('aria-expanded', String(expanded));
          other.trigger.classList.toggle('collapsed', !expanded);
        }
        if (expanded) {
          for (const other of entries) {
            if (other === entry || !other.expanded) continue;
            const groups = targets.map(t => t.getAttribute('data-bs-parent') || t.getAttribute('data-parent')).filter(Boolean);
            const sameGroup = other.root === root && other.targets.some(t => groups.includes(t.getAttribute('data-bs-parent') || t.getAttribute('data-parent')));
            if ((menu && other.menu) || sameGroup) other.setExpanded(false);
          }
        }
      }
      entry.setExpanded = setExpanded;
      entries.push(entry);
      if (hover) {
        let timer;
        const open = () => { clearTimeout(timer); setExpanded(true); };
        const close = event => {
          if (targets.some(t => t.contains(event.relatedTarget)) || trigger.contains(event.relatedTarget)) return;
          clearTimeout(timer); timer = setTimeout(() => setExpanded(false), 120);
        };
        trigger.addEventListener('pointerenter', open);
        trigger.addEventListener('pointerleave', close);
        trigger.addEventListener('focusin', open);
        trigger.addEventListener('focusout', close);
        for (const target of targets) {
          target.addEventListener('pointerenter', open); target.addEventListener('pointerleave', close);
          target.addEventListener('focusin', open); target.addEventListener('focusout', close);
        }
      } else {
        trigger.addEventListener('click', event => { event.preventDefault(); setExpanded(!entry.expanded); });
        if (!['button', 'a', 'input'].includes(trigger.localName)) {
          trigger.addEventListener('keydown', event => {
            if (['Enter', ' '].includes(event.key)) { event.preventDefault(); setExpanded(!entry.expanded); }
          });
        }
      }
    }
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) install(el.shadowRoot);
  }
  install(document);
  document.addEventListener('click', event => {
    const path = event.composedPath();
    for (const entry of entries) {
      if (entry.menu && entry.expanded && !path.includes(entry.trigger) && !entry.targets.some(t => path.includes(t))) entry.setExpanded(false);
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    for (const entry of entries) if (entry.expanded && (entry.menu || entry.trigger.hasAttribute('data-wrk-hover'))) {
      entry.setExpanded(false); entry.trigger.focus();
    }
  });
}

// 在脱离原页面的克隆节点上识别交互；生成的 Shadow DOM 模板按独立作用域处理，
// 普通未启用的模板不参与识别。
export function annotateBasicInteractions(root, { applyBindings = true } = {}) {
  const controls = [];
  const unresolved = [];
  let nativeDetails = 0;
  let nativeControls = 0;
  let tooltipFallbacks = 0;
  let sequence = 0;
  const usedIds = new Set();
  function collectIds(scope) {
    for (const el of scope.querySelectorAll('[id]')) usedIds.add(el.id);
    for (const template of scope.querySelectorAll('template[shadowrootmode]')) collectIds(template.content);
  }
  collectIds(root);
  function ensureId(el) {
    if (!el.id && !applyBindings) return null;
    if (!el.id) {
      let id;
      do { id = `wrk-interaction-${++sequence}`; } while (usedIds.has(id));
      usedIds.add(id); el.id = id;
    }
    return el.id;
  }
  function walk(scope, scopeName) {
    const find = id => [...scope.querySelectorAll('[id]')].find(el => el.id === id);
    function describe(el, reason) {
      return { tag: el.localName, id: el.id || null, scope: scopeName,
        label: el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent?.trim().slice(0, 80) || null,
        role: el.getAttribute('role'), popup: el.getAttribute('aria-haspopup'),
        expanded: el.getAttribute('aria-expanded'), pressed: el.getAttribute('aria-pressed'),
        iconNames: [...(el.querySelectorAll?.('[data-icon-name]') || [])].map(icon => icon.getAttribute('data-icon-name')),
        reason };
    }
    for (const el of scope.querySelectorAll('*')) {
      if (el.localName === 'details') nativeDetails++;
      const role = el.getAttribute('role') || '';
      const native = ['summary', 'select', 'textarea', 'input'].includes(el.localName) ||
        (el.localName === 'a' && el.getAttribute('href') && !/^(?:#?$|javascript:)/i.test(el.getAttribute('href')));
      if (native) nativeControls++;
      // 原站提示组件的内容可能未挂载；已有操作标签时保留浏览器原生悬停提示。
      if (applyBindings && (el.hasAttribute('data-base-ui-tooltip-trigger') || el.getAttribute('data-bs-toggle') === 'tooltip') &&
          !el.hasAttribute('title') && el.getAttribute('aria-label')) {
        el.setAttribute('title', el.getAttribute('aria-label')); tooltipFallbacks++;
      }
      const mode = el.getAttribute('data-bs-toggle') || el.getAttribute('data-toggle');
      let targets = [];
      let hover = false;
      if (el.hasAttribute('aria-expanded') && el.hasAttribute('aria-controls')) {
        targets = el.getAttribute('aria-controls').trim().split(/\s+/).map(find);
      } else if (mode === 'collapse') {
        const ref = el.getAttribute('data-bs-target') || el.getAttribute('data-target') || el.getAttribute('href') || '';
        try { targets = [...scope.querySelectorAll(ref)]; } catch {}
      } else if (mode === 'dropdown') {
        targets = [el.parentElement?.querySelector('.dropdown-menu')];
      }
      if (!targets.length && el.hasAttribute('aria-describedby')) {
        targets = el.getAttribute('aria-describedby').trim().split(/\s+/).map(find)
          .filter(t => t?.getAttribute('role') === 'tooltip');
        hover = targets.length > 0;
      }
      if (!targets.length && !['collapse', 'dropdown'].includes(mode) && !el.hasAttribute('aria-expanded')) {
        // 无展开属性也可能依赖组件事件，例如纯图标按钮、状态按钮、标签页或菜单入口。
        const candidate = el.localName === 'button' || ['button', 'combobox', 'tab', 'switch', 'menuitem'].includes(role) ||
          el.hasAttribute('aria-haspopup') || el.hasAttribute('aria-pressed') ||
          (el.localName === 'a' && /^(?:#?$|javascript:)/i.test(el.getAttribute('href') || ''));
        if (candidate && !native && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true') {
          unresolved.push(describe(el, '未恢复点击行为：没有明确的本地目标，可能依赖原站组件事件或尚未挂载的面板'));
        }
        continue;
      }
      if (!targets.length || targets.some(t => !t || t === el || t.contains(el))) {
        unresolved.push(describe(el, '没有明确的本地目标；需检查面板是否被采集、目标是否同作用域或是否需要专门适配')); continue;
      }
      hover ||= /hover/.test(el.getAttribute('data-bs-trigger') || el.getAttribute('data-trigger') || '');
      const ids = targets.map(ensureId);
      if (applyBindings) el.setAttribute(hover ? 'data-wrk-hover' : 'data-wrk-toggle', ids.join(' '));
      const menu = mode === 'dropdown' || /^(?:true|menu)$/.test(el.getAttribute('aria-haspopup') || '');
      if (menu && applyBindings) el.setAttribute('data-wrk-mode', 'menu');
      if (applyBindings && !hover && !['button', 'a', 'input'].includes(el.localName)) {
        el.setAttribute('role', 'button'); if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      }
      controls.push({ triggerId: ensureId(el), targetIds: ids, scope: scopeName,
        behavior: hover ? 'hover-focus' : menu ? 'dropdown' : 'toggle',
        basis: 'source-attributes', runtimeEnabled: applyBindings, visualVerified: false });
    }
    for (const template of scope.querySelectorAll('template[shadowrootmode]')) {
      walk(template.content, ensureId(template.parentElement));
    }
  }
  walk(root, 'document');
  return { controls, unresolved, nativeDetails, nativeControls, tooltipFallbacks,
    status: unresolved.length ? 'needs-review' : 'recognized-controls-only',
    cssHover: 'preserved in captured stylesheets',
    limitations: ['Only existing DOM content and explicit control relationships are reconstructed.',
      'Source-site JavaScript events, remote data loading and custom element controllers are not restored.'] };
}

export const interactionScript = `(${installBasicInteractions.toString()})();`;
