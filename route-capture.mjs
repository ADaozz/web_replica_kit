export function routeKey(url) {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search + parsed.hash;
}

export function classifyNavigation(fromUrl, toUrl, { allowSameOriginNavigation = false } = {}) {
  const from = new URL(fromUrl);
  const to = new URL(toUrl);
  if (from.origin !== to.origin) return { classification: 'blocked', reason: 'external-origin' };
  if (from.href === to.href) return { classification: 'allowed-safe', reason: 'same-document' };
  if (!allowSameOriginNavigation) return { classification: 'review-required', reason: 'same-origin navigation requires permission' };
  return { classification: 'allowed-safe', reason: 'permitted same-origin navigation' };
}

export function routesFromTransitions(transitions) {
  const routes = [];
  for (const transition of transitions) {
    for (const effect of transition.effects || []) {
      if (effect.type !== 'route') continue;
      routes.push({
        from: effect.from,
        to: effect.to,
        external: Boolean(effect.external),
        controlId: transition.control?.id || null,
        action: transition.action || null,
        classification: effect.external ? 'blocked' : 'observed'
      });
    }
  }
  return routes;
}
