const activeContexts = new WeakMap();
const socketContexts = new WeakSet();
let socketSequence = 0;
const dangerousPath = pathname => /(?:delete|logout|signout|checkout|purchase|authorize|unsubscribe)(?:[/?-]|$)/i.test(pathname);

// Install before exploratory actions; request names never authorize HTTP writes.
export async function protectExploration(page, { origin = new URL(page.url()).origin } = {}) {
  if (page.context?.().serviceWorkers?.().length || page.workers?.().length) {
    throw new Error('unsupported: existing worker transports cannot be safely explored');
  }
  const blocked = [];
  const socketKey = '__wrkSocketGuard' + (++socketSequence);
  const socketFrames = [];
  // Routing covers new sockets. Patch send on existing window-owned sockets too.
  for (const frame of page.frames?.() || []) {
    await frame.evaluate(key => {
      const prototype = globalThis.WebSocket?.prototype;
      if (!prototype) return;
      const state = { original: prototype.send, count: 0, wrapper: null };
      state.wrapper = function() {
        state.count++;
        throw new DOMException('WebSocket writes blocked during exploration', 'SecurityError');
      };
      globalThis[key] = state;
      prototype.send = state.wrapper;
    }, socketKey);
    socketFrames.push({ frame, seen: 0 });
  }
  const guard = async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method)
      || (request.isNavigationRequest() && (url.origin !== origin || dangerousPath(url.pathname)));
    if (unsafe) {
      blocked.push({ method, path: url.pathname, blocked: true });
      await route.abort('blockedbyclient');
    } else await route.fallback();
  };
  await page.route('**/*', guard);
  const context = page.context?.();
  const scope = { page, origin, blocked };
  if (context) {
    const scopes = activeContexts.get(context) || new Set();
    scopes.add(scope);
    activeContexts.set(context, scopes);
  }
  // Popup first navigations may arrive before their Frame/opener exists.
  const contextGuard = async route => {
    const request = route.request();
    let owner;
    try { owner = request.frame().page(); } catch {}
    const scopes = [...(activeContexts.get(context) || [])];
    if (!owner || !scopes.some(s => s.page === owner)) {
      const url = new URL(request.url());
      const registeredOrigin = scopes.some(s => s.origin === url.origin);
      if ((request.isNavigationRequest() && (!registeredOrigin || dangerousPath(url.pathname)))
          || !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return guard(route);
    }
    if (!owner) return route.fallback();
    if (owner !== page) {
      let opener = await owner.opener?.();
      while (opener && opener !== page) opener = await opener.opener?.();
      if (opener !== page) return route.fallback();
    }
    return guard(route);
  };
  if (context?.route) await context.route('**/*', contextGuard);
  const socketScope = context?.routeWebSocket ? context : page;
  if (socketScope.routeWebSocket && !socketContexts.has(socketScope)) {
    socketContexts.add(socketScope);
    await socketScope.routeWebSocket('**/*', socket => {
      const scopes = [...(activeContexts.get(context) || [])];
      if (!scopes.length) {socket.connectToServer();return;}
      for (const scope of scopes) scope.blocked.push({method:'WEBSOCKET',path:null,blocked:true});
      socket.close();
    });
  }
  return {
    blocked,
    checkBlockedSockets: async () => {
      for (const item of socketFrames) {
        const count = await item.frame.evaluate(key => globalThis[key]?.count || 0, socketKey).catch(() => item.seen);
        if (count > item.seen) blocked.push({ method: 'WEBSOCKET', path: null, blocked: true, count: count - item.seen });
        item.seen = count;
      }
    },
    dispose: async () => {
      for (const { frame } of socketFrames) await frame.evaluate(key => {
        const state = globalThis[key];
        if (state && WebSocket.prototype.send === state.wrapper) WebSocket.prototype.send = state.original;
        delete globalThis[key];
      }, socketKey).catch(() => {});
      await page.unroute('**/*', guard);
      if (context?.unroute) await context.unroute('**/*', contextGuard);
      if (context) {
        const scopes = activeContexts.get(context);
        scopes?.delete(scope);
        if (!scopes?.size) activeContexts.delete(context);
      }
    }
  };
}
