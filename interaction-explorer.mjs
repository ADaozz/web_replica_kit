import { classifyActionSafety, discoverAllFrames } from './actionable-dom.mjs';
import { runPlaywrightAction, stabilize } from './actionability.mjs';
import { semanticDiff, semanticHash } from './state-diff.mjs';
import { routeKey, routesFromTransitions } from './route-capture.mjs';
import { compileLocalMachines } from './offline-runtime.mjs';

const DEFAULT_BUDGETS = { maxStates: 24, maxDepth: 4, maxActions: 40 };

export function consequentialWrites(writes = []) {
  return writes.filter(write => !/\/analytics(?:\/|$)|track-events|telemetry|heartbeat|\/api\/t$|client-action|\/get-[^/]*$|\/list-[^/]*$/i.test(write.path || ''));
}

export function actionsFor(control) {
  const actions = [];
  if (['checkbox', 'radio'].includes(control.role) && control.role !== 'switch') {
    actions.push({ kind: control.checked === 'true' ? 'uncheck' : 'check' });
  } else if (control.role === 'switch' || control.pressed != null || control.expanded != null || control.tag === 'summary' || control.popup || control.role === 'tab' || control.tag === 'a') {
    actions.push({ kind: 'click' });
  } else actions.push({ kind: 'click' });
  if (control.expanded === 'true' || (control.popup && control.popup !== 'false' && control.expanded !== 'false')) {
    actions.push({ kind: 'press', key: 'Escape' });
  }
  return actions;
}

export function snapshotFromDiscovery(discovery, url) {
  const parsed = new URL(url);
  return {
    url,
    origin: parsed.origin,
    route: routeKey(url),
    nodes: [
      ...(discovery.controls || []).filter(control => !control.noise).map(control => ({
        key: control.semanticKey,
        selector: control.selector,
        visible: control.visibility === 'visible',
        expanded: control.expanded ?? null,
        pressed: control.pressed ?? null,
        checked: control.checked ?? null,
        selected: control.selected ?? null,
        value: control.sensitive ? null : (control.value ?? null),
        bbox: control.bbox || null,
        noise: false
      })),
      ...(discovery.regions || []).map(region => ({
        key: `region:${region.selector}`,
        selector: region.selector,
        visible: Boolean(region.visible),
        expanded: null,
        pressed: null,
        checked: null,
        selected: null,
        value: null,
        bbox: region.bbox || null,
        noise: false
      }))
    ]
  };
}

export function summarizeCoverage({ controls, checks, transitions, machines, verified }) {
  const list = controls || [];
  const eligible = list.filter(control => control.classification !== 'blocked' && control.visibility !== 'currently-hidden');
  const denominator = eligible.filter(control => control.classification === 'allowed-safe' && control.enabled !== false && !control.locatorAmbiguous);
  const actionable = (checks || []).filter(check => check.actionable);
  const observed = new Set((transitions || []).filter(item => item.confidence === 'observed').map(item => item.control?.id));
  const implemented = new Set((machines || []).map(machine => machine.control?.id));
  const verifiedIds = new Set(verified || []);
  return {
    discovered: list.length,
    eligible: eligible.length,
    actionable: actionable.length,
    observed: observed.size,
    implemented: implemented.size,
    replayed: implemented.size,
    verified: verifiedIds.size,
    denominator: denominator.length,
    blocked: list.filter(control => control.classification === 'blocked').length,
    reviewRequired: list.filter(control => control.classification === 'review-required').length,
    note: 'Counts are staged. verified/denominator uses enabled, unambiguous, allowed-safe controls. Discovery is not replication.'
  };
}

async function attachRevealedMarkup(diff, describeNodes) {
  if (!describeNodes) return;
  const selectors = [...new Set((diff.effects || []).filter(effect => effect.type === 'visibility' && effect.to === true && effect.selector).map(effect => effect.selector))];
  if (!selectors.length) return;
  const described = await describeNodes(selectors);
  for (const effect of diff.effects) {
    const match = (described || []).find(item => item && item.selector === effect.selector && item.html);
    if (match) effect.html = match.html;
  }
}

async function closeInPlace({ perform, capture, control, opened, describeNodes }) {
  for (const action of [{ kind: 'press', key: 'Escape' }, { kind: 'click' }]) {
    const result = await perform(control, action).catch(error => ({ ok: false, reason: String(error.message || error) }));
    if (!result?.ok || consequentialWrites(result.writes).length) continue;
    const after = await capture();
    const diff = semanticDiff(opened, after);
    await attachRevealedMarkup(diff, describeNodes);
    if (diff.changed) return { action, diff };
  }
  return null;
}

export async function exploreInteractionGraph({
  discover,
  capture,
  perform,
  restore,
  describeNodes,
  budgets = {},
  allowSameOriginNavigation = false,
  preserveSettledDocument = false
}) {
  const limits = { ...DEFAULT_BUDGETS, ...budgets };
  const failures = [];
  const transitions = [];
  const checks = [];
  const seen = new Set();
  const states = [];
  const byHash = new Map();
  let truncated = false;
  let actionsRun = 0;

  function remember(snapshot, path, depth) {
    const hash = semanticHash(snapshot);
    let state = byHash.get(hash);
    if (!state) {
      if (states.length >= limits.maxStates) return { truncated: true };
      state = { id: `state-${String(states.length).padStart(3, '0')}`, hash, snapshot, path, depth };
      states.push(state);
      byHash.set(hash, state);
    }
    return { state };
  }

  const initialSnapshot = await capture();
  const initial = remember(initialSnapshot, [], 0).state;
  const queue = [initial];
  const queued = new Set([initial.id]);
  const seenControls = new Map();
  const reported = new Set();
  function report(failure) {
    const key = JSON.stringify([failure.controlId || failure.stateId, failure.stage, failure.reason, failure.classification || null]);
    if (reported.has(key)) return;
    reported.add(key);
    failures.push(failure);
  }

  while (queue.length) {
    if (actionsRun >= limits.maxActions) { truncated = true; break; }
    const state = queue.shift();
    if (state.path.length >= limits.maxDepth) continue;
    try { await restore(state); }
    catch (error) {
      report({ stateId: state.id, stage: 'restore', reason: String(error.message || error) });
      continue;
    }
    const discovered = await discover();
    for (const control of discovered.controls || []) {
      if (seenControls.has(control.id)) continue;
      const safety = classifyActionSafety(control, { allowSameOriginNavigation, pageOrigin: state.snapshot.origin });
      seenControls.set(control.id, { ...control, classification: safety.classification, classificationReason: safety.reason });
    }
    for (const control of discovered.controls || []) {
      if (actionsRun >= limits.maxActions) { truncated = true; break; }
      const safety = classifyActionSafety(control, { allowSameOriginNavigation, pageOrigin: state.snapshot.origin });
      if (safety.classification !== 'allowed-safe') {
        report({ controlId: control.id, name: control.accessibleName, stage: 'eligible', classification: safety.classification, reason: safety.reason });
        continue;
      }
      if (control.visibility === 'currently-hidden') {
        report({ controlId: control.id, stage: 'eligible', reason: 'currently-hidden' });
        continue;
      }
      if (control.enabled === false) {
        report({ controlId: control.id, stage: 'actionable', reason: 'disabled control' });
        continue;
      }
      if (control.locatorAmbiguous) {
        report({ controlId: control.id, stage: 'actionable', reason: 'locatorAmbiguous' });
        continue;
      }
      for (const action of actionsFor(control)) {
        if (actionsRun >= limits.maxActions) { truncated = true; break; }
        const visit = `${state.id}|${control.semanticKey}|${action.kind}|${action.key || ''}`;
        if (seen.has(visit)) continue;
        seen.add(visit);
        try { await restore(state); }
        catch (error) {
          report({ controlId: control.id, stage: 'restore', reason: String(error.message || error) });
          continue;
        }
        actionsRun++;
        const before = await capture();
        let result;
        try { result = await perform(control, action); }
        catch (error) { result = { ok: false, reason: String(error.message || error) }; }
        checks.push({ controlId: control.id, action, actionable: Boolean(result.ok), reason: result.reason || 'playwright-actionability' });
        if (!result.ok) {
          report({ controlId: control.id, stage: 'actionable', reason: result.reason || 'action-failed', action });
          continue;
        }
        const writes = consequentialWrites(result.writes);
        if (writes.length) {
          report({ controlId: control.id, stage: 'observed', classification: 'requires-backend', reason: 'write request observed', writes, action });
          continue;
        }
        const after = await capture();
        const diff = semanticDiff(before, after);
        await attachRevealedMarkup(diff, describeNodes);
        const nextPath = diff.changed ? [...state.path, { semanticKey: control.semanticKey, action }] : state.path;
        const next = remember(after, nextPath, nextPath.length);
        if (next.truncated) truncated = true;
        transitions.push({
          from: state.id,
          to: next.state?.id || null,
          control: publicControl(control),
          action,
          effects: diff.effects,
          trial: result.trial || null,
          confidence: diff.changed ? 'observed' : 'observed-no-visible-change',
          classification: safety.classification,
          replicaVerified: false
        });
        if (preserveSettledDocument && action.kind === 'click' && diff.changed) {
          const closed = await closeInPlace({ perform, capture, control, opened: after, describeNodes });
          if (closed) {
            transitions.push({
              from: next.state?.id || state.id,
              to: state.id,
              control: publicControl(control),
              action: closed.action,
              effects: closed.diff.effects,
              trial: null,
              confidence: 'observed',
              classification: safety.classification,
              replicaVerified: false
            });
          }
        }
        if (!preserveSettledDocument && diff.changed && next.state && next.state.id !== state.id && !queued.has(next.state.id)) {
          queue.push(next.state);
          queued.add(next.state.id);
        }
      }
    }
  }
  try { await restore(initial); } catch (error) {
    report({ stateId: initial.id, stage: 'restore', reason: String(error.message || error) });
  }
  const controls = [...seenControls.values()];
  const machines = compileLocalMachines(transitions).machines;
  return {
    states: states.map(state => ({ id: state.id, hash: state.hash, route: state.snapshot.route, depth: state.depth, path: state.path })),
    transitions,
    failures,
    checks,
    truncated,
    coverage: summarizeCoverage({ controls, checks, transitions, machines, verified: [] }),
    controls,
    routes: routesFromTransitions(transitions),
    model: compileLocalMachines(transitions),
    limitations: ['Trial clicks are not treated as replicated behavior.', 'Unobserved actions stay unverified.', 'Closed shadow roots are not supported.']
  };
}

function publicControl(control) {
  return {
    id: control.id,
    semanticKey: control.semanticKey,
    role: control.role,
    accessibleName: control.accessibleName,
    tag: control.tag,
    selector: control.selectorStable ? control.selector : null,
    selectorStable: Boolean(control.selectorStable),
    frameUrl: control.frameUrl || null,
    classification: control.classification
  };
}

export async function explorePage(page, options = {}) {
  const allowSameOriginNavigation = Boolean(options.allowSameOriginNavigation);
  const initialUrl = page.url();
  const pendingWrites = [];
  const onRequest = request => {
    const method = request.method?.() || request.method;
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;
    try {
      const url = new URL(request.url());
      pendingWrites.push({ method, path: url.pathname });
    } catch { pendingWrites.push({ method, path: null }); }
  };
  page.on?.('request', onRequest);
  const budgets = options.budgets || {};
  try {
    return await exploreInteractionGraph({
      allowSameOriginNavigation,
      preserveSettledDocument: Boolean(options.preserveSettledDocument),
      budgets,
      discover: async () => discoverAllFrames(page, { allowSameOriginNavigation, pageOrigin: new URL(page.url()).origin }),
      capture: async () => snapshotFromDiscovery(await discoverAllFrames(page, { allowSameOriginNavigation, pageOrigin: new URL(page.url()).origin }), page.url()),
      restore: async state => {
        if (options.preserveSettledDocument) return;
        await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await stabilize(page);
        for (const step of state.path || []) {
          const found = await discoverAllFrames(page, { allowSameOriginNavigation, pageOrigin: new URL(page.url()).origin });
          const control = found.controls.find(item => item.semanticKey === step.semanticKey);
          if (!control) throw new Error('locatorMissing during restore');
          const result = await runPlaywrightAction(page, control, step.action);
          if (!result.ok) throw new Error(result.reason || 'restore action failed');
        }
      },
      perform: async (control, action) => {
        pendingWrites.length = 0;
        const result = await runPlaywrightAction(page, control, action);
        return { ...result, writes: pendingWrites.splice(0) };
      },
      describeNodes: selectors => page.evaluate(selectors => selectors.map(selector => {
        const el = document.querySelector(selector);
        if (!el) return { selector, html: null };
        const clone = el.cloneNode(true);
        clone.querySelectorAll('script').forEach(node => node.remove());
        const html = clone.outerHTML;
        return { selector, html: html.length > 200000 ? null : html };
      }), selectors)
    });
  } finally {
    page.off?.('request', onRequest);
  }
}
