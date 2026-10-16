import crypto from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
const equal = (a, b) => JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));
function semanticNode(node, anchor) {
  const b = node.documentBox || node.bbox || {};
  return { key: node.key, visible: Boolean(node.visible), expanded: node.expanded ?? null, pressed: node.pressed ?? null, checked: node.checked ?? null, selected: node.selected ?? null, value: node.value ?? null, attributes: node.attributes, text: node.text, popover: node.popover, modal: node.modal, appearance: node.appearance, layout: node.animating ? {...node.layout,transform:undefined} : node.layout,
    box: !node.visible || node.animating ? null : [Math.round((b.x || 0) - anchor.x), Math.round((b.y || 0) - anchor.y), Math.round(b.width || 0), Math.round(b.height || 0)] };
}
export function semanticHash(snapshot) {
  const nodes = (snapshot.nodes || []).filter(n => !n.noise);
  const box = nodes.find(n => n.visible)?.documentBox || nodes.find(n => n.visible)?.bbox || {};
  const body = { route: snapshot.route || null, historyState:snapshot.historyState ?? null, cssFingerprint:snapshot.cssFingerprint ?? null, nodes: nodes.map(n => semanticNode(n, { x: box.x || 0, y: box.y || 0 })) };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex').slice(0, 16);
}

export function semanticDiff(before, after, { strictGeometry = false, strictFocus = false, tolerance = 2 } = {}) {
  const effects = [], ignored = [];
  if (!equal(before?.route, after?.route)) effects.push({ type: 'route', from: before?.route || null, to: after?.route || null, external: Boolean(before?.origin && after?.origin && before.origin !== after.origin) });
  if (!equal(before?.historyState,after?.historyState)) effects.push({type:'history-state',from:before?.historyState ?? null,to:after?.historyState ?? null});
  if (strictFocus && !equal(before?.focus,after?.focus)) effects.push({type:'focus',from:before?.focus ?? null,to:after?.focus ?? null});
  if (!equal(before?.cssFingerprint,after?.cssFingerprint)) effects.push({type:'stylesheet',from:before?.cssFingerprint ?? null,to:after?.cssFingerprint ?? null});
  const left = new Map((before?.nodes || []).filter(n => !n.noise).map(n => [n.key,n]));
  const right = new Map((after?.nodes || []).filter(n => !n.noise).map(n => [n.key,n]));
  const movements = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(key), b = right.get(key), node = b || a;
    const base = { key, selector: node.selector || null, frameIndex: node.frameIndex || 0 };
    const push = (type, from, to, extra = {}) => effects.push({ ...base, type, from, to, ...extra });
    if (!a || !b) {
      if (node.parent !== undefined) {
        const other=a?right:left, own=a?left:right;
        const parentKey=`${node.frameIndex || 0}:${node.parent}`;
        const parent=own.get(parentKey) || own.get(node.parent);
        if(!parent || other.has(parentKey) || other.has(node.parent)) push(a?'remove':'insert',a?node.elementId || node.key:null,b?node.elementId || node.key:null,{element:node,parent:node.parent,nextSibling:node.nextSibling});
      } else if(Boolean(a?.visible)!==Boolean(b?.visible)) push('visibility',Boolean(a?.visible),Boolean(b?.visible));
      continue;
    }
    if (Boolean(a.visible) !== Boolean(b.visible)) push('visibility', Boolean(a.visible), Boolean(b.visible));
    for (const [field,name] of [['expanded','aria-expanded'],['pressed','aria-pressed'],['checked','aria-checked'],['selected','aria-selected']]) {
      if (!equal(a[field],b[field])) push(typeof b[field] === 'boolean' || typeof a[field] === 'boolean' ? 'property' : 'aria', a[field] ?? null,b[field] ?? null,{ name: typeof b[field] === 'boolean' || typeof a[field] === 'boolean' ? field : name });
    }
    for (const name of new Set([...Object.keys(a.attributes || {}),...Object.keys(b.attributes || {})])) {
      if (!equal(a.attributes?.[name],b.attributes?.[name])) push('attribute',a.attributes?.[name] ?? null,b.attributes?.[name] ?? null,{ name });
    }
    if (!equal(a.appearance,b.appearance)) push('computed-style',a.appearance,b.appearance);
    if (!equal(a.text,b.text)) push('text',a.text,b.text);
    if (!equal(a.value,b.value)) push('value',a.value ?? null,b.value ?? null);
    if (!equal(a.modal,b.modal)) push('dialog',a.modal,b.modal);
    if (!equal(a.popover,b.popover)) push('popover',a.popover,b.popover);
    if (a.bbox && b.bbox && (a.visible || b.visible)) {
      const width = Math.abs(b.bbox.width-a.bbox.width), height = Math.abs(b.bbox.height-a.bbox.height);
      const fromBox = strictGeometry ? a.bbox : (a.documentBox || a.bbox);
      const toBox = strictGeometry ? b.bbox : (b.documentBox || b.bbox);
      const dx = toBox.x-fromBox.x, dy = toBox.y-fromBox.y;
      if (width > tolerance || height > tolerance) push('geometry', a.bbox,b.bbox,{ significant: true, layout: b.layout });
      else if (Math.abs(dx)>tolerance || Math.abs(dy)>tolerance) movements.push({ ...base, type:'geometry',from:a.bbox,to:b.bbox,significant:true,dx,dy });
    }
  }
  const positioned = [...left.values()].filter(n => n.bbox && right.get(n.key)?.bbox && (n.visible || right.get(n.key).visible)).length;
  if (!strictGeometry && movements.length === positioned && movements.length && movements.every(n => Math.abs(n.dx-movements[0].dx)<=1 && Math.abs(n.dy-movements[0].dy)<=1) && !before?.frames) ignored.push('uniform-scroll');
  else effects.push(...movements.map(({dx,dy,...effect})=>effect));
  return { effects, changed: effects.length > 0, ignored };
}

export function compareInteractionSnapshots(source, replica, options = {}) {
  const diff = semanticDiff(source, replica, { strictGeometry: true, strictFocus:true, tolerance: 8, ...options });
  return { verified: diff.effects.length === 0, replicaVerified: diff.effects.length === 0, effects: diff.effects, ignored: diff.ignored };
}
