import { allowInlineScript } from './snapshot-scroll.mjs';
import { updateMeasuredOverlay } from './overlay-positioning.mjs';

export function compileLocalMachines(transitions) {
  const grouped = new Map(), unsupported = [];
  for (const transition of transitions || []) {
    const control = transition.control || {};
    if (transition.confidence !== 'observed' || (control.framePath?.length || control.frameIndex)) {
      unsupported.push({ controlId:control.id, reason: control.framePath?.length || control.frameIndex ? 'iframe replay requires a captured frame runtime' : transition.confidence || 'not observed' });
      continue;
    }
    const effects = (transition.effects || []).filter(e => e.selector && e.type !== 'route' && (e.type !== 'geometry' || e.style));
    const route = (transition.effects || []).find(e => e.type === 'route');
    const historyState = (transition.effects || []).find(e => e.type === 'history-state');
    if (route?.external || (!effects.length && !route)) {
      unsupported.push({ controlId:control.id, reason:route?.external ? 'external navigation' : 'no observable local effect' }); continue;
    }
    const id = control.id || control.semanticKey;
    if (!grouped.has(id)) grouped.set(id,{ control:{ id, role:control.role || null, name:control.accessibleName || '', selector:control.selector || null }, edges:[] });
    grouped.get(id).edges.push({ sourceState:transition.from,targetState:transition.to, action:transition.action,
      from:effects.filter(e => e.type !== 'geometry' && !e.initialization).map(e => ({selector:e.selector,type:e.type,name:e.name || null,value:e.from})),effects,historyState:historyState?.to ?? null,route:route ? {from:route.from,to:route.to}:null });
  }
  const machines=[];
  for (const machine of grouped.values()) {
    const signatures=new Map(), conflicts=new Set();
    for (const edge of machine.edges) {
      const signature=JSON.stringify({action:edge.action,from:edge.from,route:edge.route?.from || null});
      const outcome=JSON.stringify({effects:edge.effects,route:edge.route,historyState:edge.historyState});
      const existing=signatures.get(signature);
      if (existing && existing.outcome !== outcome) conflicts.add(signature);
      else if (!existing) signatures.set(signature,{edge,outcome});
    }
    machine.edges=[...signatures.entries()].filter(([signature])=>!conflicts.has(signature)).map(([,value])=>value.edge);
    if (conflicts.size) unsupported.push({controlId:machine.control.id,reason:'ambiguous observed outcome for the same local state and action'});
    if (machine.edges.length) machines.push(machine);
  }
  return { version:2, machines,unsupported };
}

export function installOfflineInteractions() {
  const data = JSON.parse(document.getElementById('wrk-offline-interactions').textContent);
  const componentStates = new Map();
  function query(selector) {
    if (!selector) return null;
    let root = document;
    const parts = selector.split('>>>').map(p => p.trim());
    for (let i=0;i<parts.length;i++) {
      if (!parts[i]) return root;
      const node = root?.querySelector(parts[i]);
      if (i === parts.length-1) return node;
      root = node?.shadowRoot || node?.querySelector?.('template[shadowrootmode="open"]')?.content;
    }
    return null;
  }
  function visible(el) {
    if (!el || el.hidden || el.hasAttribute('hidden')) return false;
    if (el.hasAttribute('popover') && !el.matches(':popover-open')) return false;
    const s = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0;
  }
  function matches(part) {
    const el = query(part.selector);
    if (part.type === 'insert') return !el;
    if (part.type === 'remove') return !!el;
    if (!el) return part.type === 'visibility' && !part.value;
    if (part.type === 'visibility') return visible(el) === Boolean(part.value);
    if (part.type === 'aria' || part.type === 'attribute') {
      const value=el.getAttribute(part.name);
      const normalized=['class','style'].includes(part.name) && !value?.trim() ? null : value;
      return (normalized ?? null) === (part.value ?? null);
    }
    if (part.type === 'property') return el[part.name] === part.value;
    if (part.type === 'value') return el.value === part.value;
    if (part.type === 'text') return [...(el.childNodes || [])].filter(n => n.nodeType === 3).map(n => n.textContent).join('') === (part.value || '');
    if (part.type === 'dialog') return el.matches(':modal') === part.value;
    if (part.type === 'popover') return el.matches(':popover-open') === part.value;
    return part.type === 'geometry';
  }
  function insert(effect) {
    if (!effect.html && !effect.to) return null;
    const holder = document.createElement('div');
    holder.innerHTML = effect.html || effect.to;
    holder.querySelectorAll?.('script').forEach(n => n.remove());
    const node = holder.firstElementChild;
    if (!node) return null;
    // Legacy evidence without a parent is retained as an explicit compatibility fallback.
    const parent = effect.parent ? query(effect.parent) : document.body;
    if (!parent) return null;
    const next = query(effect.nextSibling);
    if (next?.parentNode === parent) parent.insertBefore(node,next); else parent.append(node);
    return node;
  }
  function apply(effect, trigger) {
    let el = query(effect.selector);
    if (effect.type === 'insert') { if (!el) insert(effect); return; }
    if (effect.type === 'remove') { el?.remove(); return; }
    if (!el && effect.type === 'visibility' && effect.to) el = insert(effect);
    if (!el) return;
    if (effect.type === 'visibility') {
      if (effect.nativeVisibility) return;
      el.hidden = !effect.to;
      if (effect.to) el.removeAttribute('hidden'); else el.setAttribute('hidden','');
      if (effect.to && el.hasAttribute('popover')) { try { el.showPopover(); } catch {} }
      if (!effect.to && el.hasAttribute('popover')) { try { el.hidePopover(); } catch {} }
      if (effect.positioning && typeof updateMeasuredOverlay === 'function') updateMeasuredOverlay(el,trigger,effect.positioning);
    } else if (effect.type === 'aria' || effect.type === 'attribute') {
      if (effect.to == null) el.removeAttribute(effect.name); else el.setAttribute(effect.name,String(effect.to));
    } else if (effect.type === 'property') el[effect.name] = effect.to;
    else if (effect.type === 'value') el.value = effect.to ?? '';
    else if (effect.type === 'text') {
      const textNodes = [...el.childNodes].filter(n => n.nodeType === 3);
      if (textNodes.length) { textNodes[0].textContent = effect.to || ''; for (const n of textNodes.slice(1)) n.textContent = ''; }
      else el.insertBefore(document.createTextNode(effect.to || ''),el.firstChild);
    } else if (effect.type === 'dialog') { try { if (effect.to) {el.removeAttribute('open');el.showModal();} else el.close(); if (!effect.to && trigger) trigger.focus({preventScroll:true}); } catch {}
    } else if (effect.type === 'popover') { try { effect.to ? el.showPopover() : el.hidePopover(); } catch {} }
  }
  function controlOf(spec,event) {
    const path = event.composedPath?.() || [event.target];
    if (spec.selector) { const el = query(spec.selector); return el && path.includes(el) ? el : null; }
    return path.find(el => {
      const role = el.getAttribute?.('role') || (el.localName === 'button' || el.localName === 'summary' ? 'button' : el.localName === 'a' ? 'link' : '');
      const name = el.getAttribute?.('aria-label') || el.textContent?.replace(/\s+/g,' ').trim();
      return role === spec.role && name === spec.name;
    }) || null;
  }
  let positioningPending=false;
  function updateOverlays() {
    positioningPending=false;
    for (const policy of data.overlays || []) {
      const popup=query(policy.selector),trigger=query(policy.trigger);
      if (popup && trigger && visible(popup)) updateMeasuredOverlay(popup,trigger,policy);
    }
  }
  function schedulePositioning() {
    if (positioningPending || !(data.overlays || []).length) return;
    positioningPending=true;
    requestAnimationFrame(updateOverlays);
  }
  window.addEventListener('scroll',schedulePositioning,true);
  window.addEventListener('resize',schedulePositioning);
  if ((data.overlays || []).length && typeof ResizeObserver !== 'undefined') {
    const observer=new ResizeObserver(schedulePositioning);
    for (const p of data.overlays) for (const el of [query(p.selector),query(p.trigger)]) if (el) observer.observe(el);
  }
  if ((data.overlays || []).length && typeof MutationObserver !== 'undefined') new MutationObserver(schedulePositioning).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class','hidden']});
  const routeJournal = [];
  function activate(machine,edge,trigger,recordRoute=true) {
    const active = document.activeElement;
    const scroll = {x:window.scrollX,y:window.scrollY};
    // Structural edits first; visibility and recorded attributes then restore exact native styles.
    const priority = e => (e.type === 'dialog' && !e.to) || ['insert','remove'].includes(e.type) ? 0 : e.type === 'visibility' ? 1 : 2;
    for (const effect of [...edge.effects].sort((a,b)=>priority(a)-priority(b))) apply(effect,trigger);
    componentStates.set(machine.control.id,edge.targetState);
    schedulePositioning();
    if (active?.isConnected && document.activeElement !== active) active.focus?.({preventScroll:true});
    if (window.scrollX !== scroll.x || window.scrollY !== scroll.y) window.scrollTo?.(scroll.x,scroll.y);
    if (edge.route?.to && recordRoute) {
      routeJournal.push({machine,edge});
      history.pushState(edge.historyState ?? null,'',edge.route.to);
    }
  }
  function handle(event,kind,key) {
    for (const machine of data.machines || []) {
      const trigger = controlOf(machine.control,event);
      if (!trigger) continue;
      const edge = machine.edges.find(e => {
        const action = e.action || {kind:'click'};
        const actionMatches = action.kind === kind || (kind === 'click' && ['check','uncheck'].includes(action.kind));
        const nativeCheck = kind === 'click' && trigger.localName === 'input' && ['checkbox','radio'].includes(trigger.type);
        const stateMatches = part => kind === 'select' && part.type === 'property' && part.name === 'selected' && trigger.contains?.(query(part.selector)) ? true : nativeCheck && part.selector === machine.control.selector && part.type === 'property' && part.name === 'checked' ? part.value === !trigger.checked : ['fill','select'].includes(kind) && part.selector === machine.control.selector && part.type === 'value' ? true : matches(part);
        return actionMatches && (!['fill','select'].includes(kind) || action.value === trigger.value) && (kind !== 'press' || action.key === key) && e.from.every(stateMatches) && (!e.route?.from || e.route.from === location.pathname+location.search+location.hash);
      });
      if (!edge) continue;
      if (kind === 'press' || (kind === 'click' && !(trigger.localName === 'input' && ['checkbox','radio'].includes(trigger.type)))) event.preventDefault();
      activate(machine,edge,trigger); return;
    }
    if (kind === 'press' && key === 'Escape') {
      const candidates=[];
      for (const machine of data.machines || []) for (const edge of machine.edges) {
        if (edge.action?.kind !== 'press' || edge.action.key !== key || !edge.from.every(matches)) continue;
        const closes=edge.effects.some(e => (e.type === 'visibility' || e.type === 'dialog' || e.type === 'popover') && e.to === false);
        if (closes) candidates.push({machine,edge,inside:edge.effects.some(e => query(e.selector)?.contains?.(event.target))});
      }
      const found=candidates.find(c=>c.inside) || candidates[candidates.length-1];
      if (found) {event.preventDefault();activate(found.machine,found.edge,query(found.machine.control.selector));}
    }
  }
  document.addEventListener('click',e => handle(e,'click'),true);
  document.addEventListener('keydown',e => handle(e,'press',e.key),true);
  document.addEventListener('pointerover',e => {
    if (e.target?.contains?.(e.relatedTarget)) return;
    handle(e,'hover');
  },true);
  document.addEventListener('input',e => handle(e,'fill'),true);
  document.addEventListener('change',e => handle(e,'select'),true);
  window.addEventListener('popstate',() => {
    const route = location.pathname+location.search+location.hash;
    const record = [...routeJournal].reverse().find(r => r.edge.route.from === route || r.edge.route.to === route);
    if (!record) return;
    const {machine,edge} = record;
    const reverse = edge.route.from === route;
    const next = reverse ? {...edge,effects:edge.effects.map(e => ({...e,from:e.to,to:e.from,type:e.type === 'insert' ? 'remove' : e.type === 'remove' ? 'insert' : e.type,html:e.from || e.html}))} : edge;
    activate(machine,next,query(machine.control.selector),false);
  });
}

export const offlineInteractionScript = `const updateMeasuredOverlay = ${updateMeasuredOverlay.toString()};\n(${installOfflineInteractions.toString()})();`;
export function injectOfflineRuntime(html,model) {
  const payload = JSON.stringify(model).replace(/</g,'\\u003c');
  return allowInlineScript(html,offlineInteractionScript).replace(/<\/body>/i,`<script id="wrk-offline-interactions" type="application/json">${payload}</script><script>${offlineInteractionScript}</script></body>`);
}
