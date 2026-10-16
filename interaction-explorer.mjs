import { protectExploration } from './exploration-safety.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { captureStructuredState } from './interaction-snapshot.mjs';
import { collectOverlayDiagnostics } from './overlay-diagnostics.mjs';
import { classifyActionSafety, discoverAllFrames } from './actionable-dom.mjs';
import { runPlaywrightAction, stabilize } from './actionability.mjs';
import { semanticDiff, semanticHash } from './state-diff.mjs';
import { routeKey, routesFromTransitions } from './route-capture.mjs';

const DEFAULT_BUDGETS = { maxStates: 24, maxDepth: 4, maxActions: 40 };

export function actionsFor(control) {
  const actions = [];
  if (control.describedby && !control.popup && control.expanded == null) return [{kind:'hover'}];
  if (control.editable) return [{ kind: 'fill', value: 'replica test' }];
  if (control.tag === 'select') return (control.options || []).filter(v => v !== control.value).slice(0, 2).map(value => ({ kind: 'select', value }));
  if (control.role === 'radio' && control.checked === 'true') return [];
  if (['checkbox', 'radio'].includes(control.role) && control.role !== 'switch') {
    actions.push({ kind: control.checked === 'true' ? 'uncheck' : 'check' });
  } else if (control.role === 'switch' || control.pressed != null || control.expanded != null || control.tag === 'summary' || control.popup || control.role === 'tab' || control.tag === 'a') {
    actions.push({ kind: 'click' });
  } else actions.push({ kind: 'click' });
  if (control.expanded === 'true' || (control.popup && control.popup !== 'false' && control.expanded !== 'false')) {
    actions.push({ kind: 'press', key: 'Escape' });
  }
  if (control.popup && control.popup !== 'false') actions.push({ kind: 'hover' }, { kind: 'press', key: 'ArrowDown' });
  if (control.tag === 'button' && !control.popup) actions.push({kind:'press',key:'Enter'}, {kind:'press',key:' '});
  return actions;
}

export function summarizeCoverage({controls=[],checks=[],transitions=[]}) {
  return {discovered:controls.length,
    eligible:controls.filter(c=>c.classification==='allowed-safe' && c.visibility==='visible').length,
    actionable:new Set(checks.filter(c=>c.actionable).map(c=>c.controlId)).size,
    observed:new Set(transitions.filter(t=>t.confidence==='observed').map(t=>t.control.id)).size,
    blocked:controls.filter(c=>c.classification==='blocked').length,
    reviewRequired:controls.filter(c=>c.classification==='review-required').length};
}

async function closeInPlace({ perform, capture, control, opened }) {
  for (const action of [{ kind: 'press', key: 'Escape' }, { kind: 'click' }]) {
    const result = await perform(control, action).catch(error => ({ ok: false, reason: String(error.message || error) }));
    if (!result?.ok || (result.writes || []).length) continue;
    const after = await capture();
    const diff = semanticDiff(opened, after);
    if (diff.changed) return { action, diff, after };
  }
  return null;
}

export async function exploreInteractionGraph({
  discover,
  capture,
  perform,
  restore,
  budgets = {},
  allowSameOriginNavigation = false,
  onState
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
  let restoreFailed = false;

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

  const enrich = async state => {if (state && !state.evidenceCollected) {state.evidenceCollected=true;state.evidence=await onState?.(state) || null;}};
  const initialSnapshot = await capture();
  const initial = remember(initialSnapshot, [], 0).state;
  await enrich(initial);
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

  exploration: while (queue.length) {
    if (actionsRun >= limits.maxActions) { truncated = true; break; }
    const state = queue.shift();
    if (state.path.length >= limits.maxDepth) continue;
    try { await restore(state); }
    catch (error) {
      report({ stateId: state.id, stage: 'restore', reason: String(error.message || error) });
      restoreFailed = true;
      break exploration;
    }
    const discovered = await discover();
    for (const control of discovered.controls || []) {
      const previous = seenControls.get(control.id);
      const safety = classifyActionSafety(control, { allowSameOriginNavigation, pageOrigin: state.snapshot.origin });
      seenControls.set(control.id, { ...control, visibility: previous?.visibility === 'visible' || control.visibility === 'visible' ? 'visible' : control.visibility, classification: safety.classification, classificationReason: safety.reason });
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
        const visit = `${state.id}|${control.semanticKey}|${JSON.stringify(action)}`;
        if (seen.has(visit)) continue;
        seen.add(visit);
        try { await restore(state); }
        catch (error) {
          report({ controlId: control.id, stage: 'restore', reason: String(error.message || error) });
          restoreFailed = true;
          break exploration;
        }
        actionsRun++;
        const before = await capture();
        let result;
        try { result = await perform(control, action); }
        catch (error) { result = { ok: false, reason: String(error.message || error) }; }
        checks.push({ controlId: control.id, action, actionable: Boolean(result.actionable ?? result.ok), reason: result.reason || 'playwright-actionability' });
        if (!result.ok) {
          report({ controlId: control.id, classification: result.writes?.length ? 'requires-backend' : undefined, stage: 'actionable', reason: result.reason || 'action-failed', action });
          continue;
        }
        const writes = (result.writes || []);
        if (writes.length) {
          report({ controlId: control.id, stage: 'observed', classification: 'requires-backend', reason: 'write request observed', writes, action });
          continue;
        }
        const after = await capture();
        const diff = semanticDiff(before, after);
        const nextPath = diff.changed ? [...state.path, { semanticKey: control.semanticKey, action }] : state.path;
        const next = remember(after, nextPath, nextPath.length);
        if (next.truncated) truncated = true;
        await enrich(next.state);
        transitions.push({
          from: state.id,
          to: next.state?.id || null,
          control: publicControl(control),
          action,
          effects: diff.effects,
          trial: result.trial || null,
          confidence: diff.changed ? 'observed' : 'observed-no-visible-change',
          classification: safety.classification
        });
        if (action.kind === 'click' && diff.changed && control.tag !== 'a' && control.role !== 'tab') {
          const closed = await closeInPlace({ perform: async (c,a) => { if (actionsRun >= limits.maxActions) {truncated=true;return {ok:false,reason:'action budget exhausted'};} actionsRun++; return perform(c,a); }, capture, control, opened: after });
          if (closed && semanticHash(closed.after) === semanticHash(before)) {
            transitions.push({
              from: next.state?.id || state.id,
              to: state.id,
              control: publicControl(control),
              action: closed.action,
              effects: closed.diff.effects,
              trial: null,
              confidence: 'observed',
              classification: safety.classification
            });
          }
        }
        if (diff.changed && next.state && next.state.id !== state.id && !queued.has(next.state.id)) {
          queue.push(next.state);
          queued.add(next.state.id);
        }
      }
    }
  }
  try { if (!restoreFailed) await restore(initial); } catch (error) {
    restoreFailed = true;
    report({ stateId: initial.id, stage: 'restore', reason: String(error.message || error) });
  }
  const controls = [...seenControls.values()];
  return {
    states: states.map(state => ({ id: state.id, hash: state.hash, snapshot: state.snapshot, evidence:state.evidence, route: state.snapshot.route, depth: state.depth, path: state.path })),
    transitions,
    failures,
    checks,
    truncated,
    restoreFailed,
    budgetUsage: { actions: actionsRun, states: states.length, limits },
    coverage: summarizeCoverage({ controls, checks, transitions }),
    controls,
    routes: routesFromTransitions(transitions),
    limitations: ['Actionability is not evidence of a state change.', 'Unobserved behavior is unknown.', 'Closed shadow roots are not supported.']
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
    locatorStrategies: control.locatorStrategies,
    framePath: control.framePath,
    frameIndex: control.frameIndex || 0,
    selectorStable: Boolean(control.selectorStable),
    frameUrl: control.frameUrl || null,
    classification: control.classification
  };
}

export async function explorePage(page, options = {}) {
  const allowSameOriginNavigation = Boolean(options.allowSameOriginNavigation);
  const initialUrl = page.url();
  const origin = new URL(initialUrl).origin;
  const pendingWrites = [], journal = [], diagnostics = [], restorations = [];
  const capture = () => page.evaluate ? captureStructuredState(page) : Promise.resolve({ route: new URL(page.url()).pathname, nodes: [] });
  const discover = () => discoverAllFrames(page, { allowSameOriginNavigation, pageOrigin: page.url() });
  const safety = page.route ? await protectExploration(page,{origin}) : {blocked:[],dispose:async()=>{}};
  let evidenceIndex = 0;
  async function evidence(label) {
    if (!page.evaluate) return;
    const item = await collectOverlayDiagnostics(page, label);
    if (options.evidenceDir) {
      const name = `interactions/screenshots/evidence-${String(evidenceIndex++).padStart(4,'0')}`;
      await fs.mkdir(path.join(options.evidenceDir,'interactions/screenshots'), { recursive: true });
      await page.screenshot({ path: path.join(options.evidenceDir, name+'.png'), animations:'disabled' }).catch(() => {});
      item.screenshot = name+'.png';
    }
    diagnostics.push(item);
  }
  async function execute(control, action) {
    pendingWrites.length = 0;
    safety.blocked.length = 0;
    const result = await runPlaywrightAction(page, control, action);
    await safety.checkBlockedSockets?.();
    pendingWrites.push(...safety.blocked);
    if (pendingWrites.length) return { ...result, actionable: Boolean(result.ok), ok: false, reason: 'network operation blocked before transmission', writes: pendingWrites.splice(0) };
    return result;
  }
  async function reverse(entry) {
    const current = await discover();
    const control = current.controls.find(c => c.id === entry.control.id) || entry.control;
    const candidates = [];
    if (entry.before.route !== entry.after.route) candidates.push({ navigationBack: true });
    if (entry.action.kind === 'hover') candidates.push({ leave: true });
    const prior = entry.before.nodes.find(n => n.selector === entry.control.selector);
    if (entry.action.kind === 'fill' || entry.action.kind === 'select') candidates.push({ control, action: { kind: entry.action.kind, value: prior?.value || '' } });
    if (entry.control.role === 'tab') {
      const old = entry.before.nodes.find(n => n.attributes?.['aria-selected'] === 'true');
      const tab = old && current.controls.find(c => c.selector === old.selector);
      if (tab) candidates.push({ control: tab, action: { kind:'click' } });
    }
    if (entry.control.role === 'checkbox') candidates.push({ control, action: { kind: prior?.checked ? 'check':'uncheck' } });
    candidates.push({ control, action: { kind:'press',key:'Escape' } }, { control, action: { kind:'click' } });
    const afterHash = semanticHash(entry.after);
    for (const candidate of candidates) {
      const beforeInverse = await capture();
      if (candidate.navigationBack) { await page.goBack({ waitUntil:'domcontentloaded' }).catch(() => {}); await stabilize(page); }
      else if (candidate.leave) { await page.mouse.move(0,0); await stabilize(page); }
      else { const result = await execute(candidate.control, candidate.action).catch(() => ({ok:false})); if (!result.ok) continue; }
      const snapshot = await capture();
      const success = semanticHash(snapshot) === semanticHash(entry.before);
      restorations.push({ control: publicControl(candidate.control || control), action: candidate.navigationBack ? {kind:'history-back'} : candidate.leave ? {kind:'leave'} : candidate.action, fromHash:semanticHash(beforeInverse),toHash:semanticHash(snapshot),success,effects:semanticDiff(beforeInverse,snapshot).effects });
      if (success) return;
      if (semanticHash(snapshot) !== afterHash) throw new Error('restore failed: inverse reached an unknown state');
    }
    throw new Error('restore failed: no observed inverse returns to prior state');
  }
  async function restoreScroll(snapshot) {
    if (!page.evaluate) return;
    for (const frameMeta of snapshot.frames || []) {
      const frame=page.frames()[frameMeta.index];
      if (!frame) continue;
      const nodes=snapshot.nodes.filter(n=>n.frameIndex===frameMeta.index).map(n=>({selector:n.selector,scroll:n.scroll}));
      await frame.evaluate(({nodes,scroll})=>{
        function find(selector) {let root=document;const parts=selector.split('>>>').map(p=>p.trim());for(let i=0;i<parts.length;i++){const el=root?.querySelector(parts[i]);if(i===parts.length-1)return el;root=el?.shadowRoot;}return null;}
        for(const node of nodes){const el=find(node.selector);if(el && node.scroll){el.scrollLeft=node.scroll.x;el.scrollTop=node.scroll.y;}}
        window.scrollTo({left:scroll.x,top:scroll.y,behavior:'instant'});
      },{nodes,scroll:frameMeta.scroll});
    }
  }
  async function perform(control, action, recordEvidence = true) {
    const before = await capture();
    if (recordEvidence) await evidence({ phase:'before',controlId:control.id,action });
    const result = await execute(control,action);
    const after = await capture();
    if (recordEvidence) await evidence({ phase:'after',controlId:control.id,action });
    if (semanticHash(before) !== semanticHash(after)) {
      if (journal.length && semanticHash(journal[journal.length-1].before) === semanticHash(after)) journal.pop();
      else journal.push({ before,after,control,action });
    }
    return result;
  }
  try {
    const result = await exploreInteractionGraph({
      allowSameOriginNavigation, budgets: options.budgets || {}, discover, capture, perform, onState:options.onState,
      restore: async state => {
        if (semanticHash(await capture()) === state.hash) {await restoreScroll(state.snapshot);return;}
        while (journal.length) {
          await reverse(journal[journal.length-1]); journal.pop();
          if (semanticHash(await capture()) === state.hash) {await restoreScroll(state.snapshot);return;}
        }
        for (const step of state.path || []) {
          const found = await discover();
          const control = found.controls.find(c => c.semanticKey === step.semanticKey);
          if (!control) throw new Error('locatorMissing during restore');
          const result = await perform(control,step.action,false);
          if (!result.ok) throw new Error(result.reason || 'restore action failed');
        }
        if (semanticHash(await capture()) !== state.hash) throw new Error('restore failed: target state mismatch');
        await restoreScroll(state.snapshot);
      },

    });
    for (const inverse of restorations.filter(r=>r.success && !['history-back','leave'].includes(r.action.kind))) {
      const from=result.states.find(s=>s.hash===inverse.fromHash),to=result.states.find(s=>s.hash===inverse.toHash);
      if (!from || !to || !inverse.effects.length) continue;
      result.transitions.push({from:from.id,to:to.id,control:inverse.control,action:inverse.action,effects:inverse.effects,confidence:'observed',classification:'allowed-safe',basis:'observed-restoration'});
    }
    result.coverage=summarizeCoverage({controls:result.controls,checks:result.checks,transitions:result.transitions});
    result.budgetUsage.restorationActions=restorations.length;
    return { ...result, restorations, overlayDiagnostics: diagnostics };
  } finally { await safety.dispose(); }
}
