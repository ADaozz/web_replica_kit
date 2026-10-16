import { allowInlineScript } from './snapshot-scroll.mjs';

export function compileLocalMachines(transitions) {
  const grouped = new Map();
  const unsupported = [];
  for (const transition of transitions || []) {
    if (transition.confidence !== 'observed') {
      unsupported.push({ controlId: transition.control?.id || null, reason: transition.confidence || 'not observed' });
      continue;
    }
    const effects = (transition.effects || []).filter(effect => effect.selector && effect.type !== 'route' && effect.type !== 'geometry');
    const route = (transition.effects || []).find(effect => effect.type === 'route');
    if (route?.external) {
      unsupported.push({ controlId: transition.control?.id || null, reason: 'external navigation' });
      continue;
    }
    if (!effects.length && !route) {
      unsupported.push({ controlId: transition.control?.id || null, reason: 'no observable local effect' });
      continue;
    }
    const id = transition.control?.semanticKey || transition.control?.id;
    if (!grouped.has(id)) {
      grouped.set(id, {
        control: {
          id,
          role: transition.control?.role || null,
          name: transition.control?.accessibleName || '',
          selector: transition.control?.selectorStable ? transition.control.selector : null
        },
        edges: []
      });
    }
    grouped.get(id).edges.push({
      action: transition.action,
      from: effects.map(effect => ({ selector: effect.selector, type: effect.type, name: effect.name || null, value: effect.from })),
      effects,
      route: route ? { from: route.from, to: route.to } : null
    });
  }
  return { machines: [...grouped.values()], unsupported };
}

export function installOfflineInteractions() {
  const data = JSON.parse(document.getElementById('wrk-offline-interactions').textContent);
  function query(selector) {
    if (!selector) return null;
    if (!selector.includes('>>>')) return document.querySelector(selector);
    const [hostSelector, inner] = selector.split('>>>').map(part => part.trim());
    const host = document.querySelector(hostSelector);
    const root = host?.shadowRoot || host?.querySelector?.('template[shadowrootmode="open"]')?.content;
    return root?.querySelector(inner) || null;
  }
  function visible(el) {
    if (!el) return false;
    if (el.hidden || el.hasAttribute('hidden')) return false;
    if (el.hasAttribute('popover') && el.matches && !el.matches(':popover-open')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }
  function matches(part) {
    const el = query(part.selector);
    if (!el) return part.type === 'visibility' && !part.value;
    if (part.type === 'visibility') return visible(el) === Boolean(part.value);
    if (part.type === 'aria') return (el.getAttribute(part.name) ?? null) === (part.value ?? null) || String(el.getAttribute(part.name)) === String(part.value);
    if (part.type === 'geometry') return true;
    return false;
  }
  function overlay(el) {
    const role = el.getAttribute?.('role');
    if (['dialog', 'menu', 'listbox', 'tooltip'].includes(role)) return true;
    return Boolean(el.querySelector?.('[role="menu"],[role="dialog"],[role="listbox"]'));
  }
  function placeOverlay(el, trigger) {
    const host = el.parentElement?.closest?.('[data-wrk-placed]');
    if (host) {
      el.style.position = 'relative';
      el.style.top = 'auto';
      el.style.left = 'auto';
      el.style.transform = 'none';
      el.style.maxHeight = 'min(360px, 60vh)';
      el.style.overflow = 'auto';
      return;
    }
    for (const node of el.querySelectorAll('*')) {
      if (getComputedStyle(node).display === 'contents') node.style.display = 'block';
    }
    const box = trigger.getBoundingClientRect();
    el.style.position = 'fixed';
    el.style.zIndex = '80';
    el.style.margin = '0';
    el.style.transform = 'none';
    el.style.height = 'auto';
    el.style.overflow = 'visible';
    const width = el.offsetWidth || el.getBoundingClientRect().width || 280;
    const height = el.offsetHeight || el.getBoundingClientRect().height || 0;
    const side = el.getAttribute('data-side') || (box.bottom + Math.min(height, 360) + 8 > window.innerHeight && box.top > 200 ? 'top' : 'bottom');
    let left = box.left;
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(8, side === 'top' ? box.top - Math.min(height, 360) - 4 : box.bottom + 4)}px`;
    el.dataset.wrkPlaced = 'true';
  }
  function sideShell(trigger) {
    let node = trigger;
    let found = null;
    while (node && node !== document.body) {
      const box = node.getBoundingClientRect?.();
      if (box && box.left <= 8 && box.height >= window.innerHeight * 0.7 && box.width >= 48 && box.width < window.innerWidth * 0.5) found = node;
      node = node.parentElement;
    }
    return found;
  }
  function restoreShell(shell) {
    shell.removeAttribute('data-wrk-collapsed');
    shell.style.width = '';
    shell.style.flexBasis = '';
    shell.style.minWidth = '';
    shell.style.overflow = '';
  }
  function apply(effect, trigger) {
    let el = query(effect.selector);
    if (effect.type === 'visibility') {
      const show = Boolean(effect.to);
      if (!el && show && effect.html) {
        const holder = document.createElement('div');
        holder.innerHTML = effect.html;
        const created = holder.firstElementChild;
        if (created?.id && document.getElementById(created.id)) el = document.getElementById(created.id);
        else if (created) {
          document.body.append(created);
          el = created;
        }
      }
      if (!el) return;
      if (show) {
        el.hidden = false;
        el.removeAttribute('hidden');
        el.style.visibility = 'visible';
        if (trigger && overlay(el) && el.parentElement !== document.body) document.body.append(el);
        if (el.hasAttribute?.('popover')) {
          try { if (!el.matches?.(':popover-open')) el.showPopover?.(); } catch {}
        }
        if (trigger && overlay(el)) placeOverlay(el, trigger);
      } else {
        if (el.hasAttribute?.('popover')) {
          try { if (el.matches?.(':popover-open')) el.hidePopover?.(); } catch {}
        }
        el.hidden = true;
        el.setAttribute('hidden', '');
        el.style.visibility = '';
      }
      el.setAttribute('aria-hidden', show ? 'false' : 'true');
    } else if (effect.type === 'aria' && el) el.setAttribute(effect.name, String(effect.to));
  }
  function controlOf(spec, event) {
    const path = event.composedPath?.() || [event.target];
    if (spec.selector) {
      const el = query(spec.selector);
      if (el && path.includes(el)) return el;
    }
    if (spec.role && spec.name) {
      const candidates = [...document.querySelectorAll('button,a,summary,input,select,textarea,[role]')];
      const match = candidates.find(el => {
        const role = el.getAttribute('role') || (el.localName === 'button' || el.localName === 'summary' ? 'button' : el.localName === 'a' ? 'link' : '');
        const name = el.getAttribute('aria-label') || el.textContent?.replace(/\s+/g, ' ').trim();
        return role === spec.role && name === spec.name && path.includes(el);
      });
      if (match) return match;
    }
    return null;
  }
  function matching(edge) {
    return edge.from.length === 0 || edge.from.every(matches);
  }
  function edgeFor(machine) {
    return machine.edges.find(edge => ['click', 'check', 'uncheck'].includes(edge.action?.kind || 'click') && matching(edge))
      || machine.edges.find(edge => edge.action?.kind === 'press' && edge.action.key === 'Escape' && matching(edge))
      || null;
  }
  function activate(edge, trigger) {
    const shell = trigger && sideShell(trigger);
    const hidesTrigger = Boolean(shell && (edge.effects || []).some(effect => effect.type === 'visibility' && effect.to === false && query(effect.selector) === trigger));
    if (hidesTrigger) {
      shell.setAttribute('data-wrk-collapsed', 'true');
      shell.style.width = '0px';
      shell.style.flexBasis = '0px';
      shell.style.minWidth = '0px';
      shell.style.overflow = 'hidden';
      const replacement = (edge.effects || []).find(effect => effect.html && effect.to === true);
      if (replacement && !document.querySelector('[data-wrk-sidebar-open]')) {
        const holder = document.createElement('div');
        holder.innerHTML = replacement.html;
        const opener = holder.firstElementChild;
        if (opener) {
          opener.hidden = false;
          opener.removeAttribute('hidden');
          opener.setAttribute('data-wrk-sidebar-open', 'true');
          opener.style.position = 'fixed';
          opener.style.left = '8px';
          opener.style.top = '8px';
          opener.style.zIndex = '70';
          document.body.append(opener);
        }
      }
      return;
    }
    for (const effect of edge.effects || []) apply(effect, trigger);
    if (edge.route?.to) history.pushState({ wrk: true, route: edge.route.to }, '', edge.route.to);
  }
  function closeOpenMenus(event) {
    for (const machine of data.machines || []) {
      const edge = machine.edges.find(item => item.action?.kind === 'press' && item.action.key === 'Escape' && matching(item));
      if (!edge) continue;
      const popup = (edge.effects || []).find(effect => effect.type === 'visibility' && effect.to === false);
      const el = popup && query(popup.selector);
      if (el && (event.target === el || el.contains?.(event.target))) continue;
      activate(edge, query(machine.control.selector));
    }
  }
  document.addEventListener('click', event => {
    if (event.target?.closest?.('[data-wrk-sidebar-open]')) {
      const shell = document.querySelector('[data-wrk-collapsed="true"]');
      if (shell) restoreShell(shell);
      event.target.closest('[data-wrk-sidebar-open]').remove();
      event.preventDefault();
      return;
    }
    for (const machine of data.machines || []) {
      const trigger = controlOf(machine.control, event);
      if (!trigger) continue;
      const edge = edgeFor(machine);
      if (!edge) continue;
      event.preventDefault();
      activate(edge, trigger);
      return;
    }
    closeOpenMenus(event);
  }, true);
  document.addEventListener('keydown', event => {
    if (!['Enter', ' ', 'Escape'].includes(event.key)) return;
    for (const machine of data.machines || []) {
      const edge = machine.edges.find(item => item.action?.kind === 'press' && item.action.key === event.key && (item.from.length === 0 || item.from.every(matches)));
      if (!edge || !controlOf(machine.control, event)) continue;
      event.preventDefault();
      activate(edge);
      return;
    }
  }, true);
  window.addEventListener('popstate', () => {
    const route = location.pathname + location.search + location.hash;
    for (const machine of data.machines || []) {
      const edge = machine.edges.find(item => item.route && (item.route.to === route || item.route.from === route));
      if (edge) activate(edge);
    }
  });
}

export const offlineInteractionScript = `(${installOfflineInteractions.toString()})();`;

export function injectOfflineRuntime(html, model) {
  const runtime = offlineInteractionScript;
  const payload = JSON.stringify(model).replace(/</g, '\\u003c');
  const withPolicy = allowInlineScript(html, runtime);
  return withPolicy.replace(/<\/body>/i, `<script id="wrk-offline-interactions" type="application/json">${payload}</script><script>${runtime}</script></body>`);
}
