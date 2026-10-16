import crypto from 'node:crypto';

function stableSelector(selector) {
  if (!selector) return true;
  return !selector.includes(':nth-of-type') && !selector.includes('>>>');
}

export function semanticHash(snapshot) {
  const body = JSON.stringify({
    route: snapshot.route || null,
    nodes: (snapshot.nodes || []).filter(node => !node.noise).map(node => ({
      key: node.key,
      visible: Boolean(node.visible),
      expanded: node.expanded ?? null,
      pressed: node.pressed ?? null,
      checked: node.checked ?? null,
      selected: node.selected ?? null,
      value: node.value ?? null,
      width: Math.round(node.bbox?.width || 0),
      height: Math.round(node.bbox?.height || 0)
    }))
  });
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
}

export function semanticDiff(before, after) {
  const effects = [];
  const ignored = [];
  if ((before?.route || null) !== (after?.route || null)) {
    effects.push({
      type: 'route',
      from: before?.route || null,
      to: after?.route || null,
      external: Boolean(before?.origin && after?.origin && before.origin !== after.origin)
    });
  }
  const left = new Map((before?.nodes || []).filter(node => !node.noise).map(node => [node.key, node]));
  const right = new Map((after?.nodes || []).filter(node => !node.noise).map(node => [node.key, node]));
  const yDeltas = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const source = left.get(key);
    const target = right.get(key);
    const selector = target?.selector || source?.selector || null;
    if (!source || !target) {
      const from = Boolean(source?.visible);
      const to = Boolean(target?.visible);
      if (from !== to && stableSelector(selector)) effects.push({ type: 'visibility', key, selector, from, to });
      continue;
    }
    if (Boolean(source.visible) !== Boolean(target.visible) && stableSelector(selector)) {
      effects.push({ type: 'visibility', key, selector, from: Boolean(source.visible), to: Boolean(target.visible) });
    }
    for (const [field, name] of [['expanded', 'aria-expanded'], ['pressed', 'aria-pressed'], ['checked', 'aria-checked'], ['selected', 'aria-selected']]) {
      if (String(source[field] ?? '') !== String(target[field] ?? '') && stableSelector(selector)) {
        effects.push({ type: 'aria', key, selector, name, from: source[field] ?? null, to: target[field] ?? null });
      }
    }
    if ((source.value ?? null) !== (target.value ?? null)) {
      effects.push({ type: 'value', key, selector, from: source.value ?? null, to: target.value ?? null });
    }
    if (source.bbox && target.bbox) {
      const widthChanged = Math.abs((source.bbox.width || 0) - (target.bbox.width || 0)) > 2;
      const heightChanged = Math.abs((source.bbox.height || 0) - (target.bbox.height || 0)) > 2;
      const dy = (target.bbox.y || 0) - (source.bbox.y || 0);
      if (widthChanged || heightChanged) {
        if (stableSelector(selector)) effects.push({
          type: 'geometry', key, selector, significant: true,
          from: { width: source.bbox.width, height: source.bbox.height },
          to: { width: target.bbox.width, height: target.bbox.height }
        });
      } else if (Math.abs(dy) > 2) yDeltas.push(dy);
    }
  }
  if (yDeltas.length > 0 && yDeltas.every(delta => Math.abs(delta - yDeltas[0]) <= 1)) ignored.push('uniform-scroll');
  return { effects, changed: effects.length > 0, ignored };
}

export function compareInteractionSnapshots(source, replica) {
  const diff = semanticDiff(source, replica);
  const meaningful = diff.effects.filter(effect => effect.type !== 'geometry' || effect.significant);
  return { verified: meaningful.length === 0, replicaVerified: meaningful.length === 0, effects: meaningful, ignored: diff.ignored };
}
