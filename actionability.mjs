import { discoverAllFrames } from './actionable-dom.mjs';

export async function resolveLocator(scope, control) {
  const strategies = control.locatorStrategies || [];
  let ambiguous = false;
  for (const strategy of strategies) {
    let locator = null;
    try {
      if (strategy.type === 'role' && !control.locatorAmbiguous) {
        locator = scope.getByRole(strategy.role, { name: strategy.name, exact: strategy.exact !== false });
      } else if (strategy.type === 'label') locator = scope.getByLabel(strategy.name, { exact: strategy.exact !== false });
      else if (strategy.type === 'placeholder') locator = scope.getByPlaceholder(strategy.name, { exact: strategy.exact !== false });
      else if (strategy.type === 'testid') locator = scope.getByTestId(strategy.name);
      else if (strategy.type === 'css' && strategy.stable && strategy.selector) locator = scope.locator(strategy.selector);
    } catch (error) {
      return { locator: null, reason: 'locatorMissing', detail: String(error.message || error) };
    }
    if (!locator) continue;
    const count = await locator.count();
    if (count === 1) return { locator, strategy: strategy.type };
    if (count > 1) { ambiguous = true; continue; }
  }
  if (control.selector && control.selectorStable && scope.locator) {
    const locator = scope.locator(control.selector.replaceAll('>>>', ' '));
    if (await locator.count() === 1) return { locator, strategy: 'css' };
  }
  return { locator: null, reason: control.locatorAmbiguous || ambiguous ? 'locatorAmbiguous' : 'locatorMissing' };
}

export function frameFor(page, control) {
  const frames = page.frames();
  if (control.frameUrl) {
    const match = frames.find(frame => frame.url() === control.frameUrl);
    if (match) return match;
    if (control.framePath?.length) return null;
  }
  return page.mainFrame?.() || page;
}

export async function stabilize(page, timeout = 1200) {
  await page.waitForLoadState?.('domcontentloaded').catch(() => {});
  await page.evaluate?.(ms => new Promise(resolve => {
    const root = document.documentElement;
    if (!root) { resolve(); return; }
    let last = Date.now();
    const observer = new MutationObserver(() => { last = Date.now(); });
    observer.observe(root, { subtree: true, childList: true, attributes: true });
    const timer = setInterval(() => {
      if (Date.now() - last > 80) { clearInterval(timer); observer.disconnect(); resolve(); }
    }, 40);
    setTimeout(() => { clearInterval(timer); observer.disconnect(); resolve(); }, ms);
  }), timeout).catch(() => {});
}

async function scrollOf(page) {
  if (!page.evaluate) return null;
  return page.evaluate(() => ({ x: scrollX, y: scrollY })).catch(() => null);
}

export async function verifyActionability(page, control) {
  const scope = frameFor(page, control);
  if (!scope) return { actionable: false, reason: 'frame-inaccessible', stage: 'actionable' };
  const resolved = await resolveLocator(scope, control);
  if (!resolved.locator) return { actionable: false, reason: resolved.reason, stage: 'actionable' };
  const before = await scrollOf(page);
  try {
    if (control.role === 'textbox' || control.editable) {
      const editable = resolved.locator.isEditable ? await resolved.locator.isEditable() : true;
      if (!editable) return { actionable: false, reason: 'not-editable', strategy: resolved.strategy, stage: 'actionable' };
    } else if (['checkbox', 'radio'].includes(control.role) && control.role !== 'switch') {
      await resolved.locator.click({ trial: true, timeout: 3000 });
    } else {
      await resolved.locator.click({ trial: true, timeout: 3000 });
    }
  } catch (error) {
    return { actionable: false, reason: String(error.message || error), strategy: resolved.strategy, stage: 'actionable', trial: { scrollBefore: before } };
  }
  const after = await scrollOf(page);
  return {
    actionable: true,
    reason: 'playwright-actionability',
    strategy: resolved.strategy,
    stage: 'actionable',
    trial: { scrollBefore: before, scrollAfter: after, mutated: false }
  };
}

export async function runPlaywrightAction(page, control, action) {
  const scope = frameFor(page, control);
  if (!scope) return { ok: false, reason: 'frame-inaccessible' };
  const resolved = await resolveLocator(scope, control);
  if (!resolved.locator) return { ok: false, reason: resolved.reason };
  const before = await scrollOf(page);
  try {
    if (action.kind === 'press') await resolved.locator.focus?.({ timeout: 3000 });
    else if (action.kind === 'hover') await resolved.locator.hover({ trial: true, timeout: 3000 });
    else if (action.kind === 'fill') { if (!await resolved.locator.isEditable()) return { ok: false, reason: 'not-editable' }; }
    else await resolved.locator.click({ trial: true, timeout: 3000 });
  } catch (error) {
    return { ok: false, reason: String(error.message || error), strategy: resolved.strategy, trial: { scrollBefore: before } };
  }
  const afterTrial = await scrollOf(page);
  if (action.kind === 'click' || action.kind === 'check' || action.kind === 'uncheck') {
    if (action.kind === 'check' && resolved.locator.check) await resolved.locator.check({ timeout: 3000 });
    else if (action.kind === 'uncheck' && resolved.locator.uncheck) await resolved.locator.uncheck({ timeout: 3000 });
    else await resolved.locator.click({ timeout: 3000 });
  } else if (action.kind === 'press') await resolved.locator.press(action.key, { timeout: 3000 });
  else if (action.kind === 'hover') await resolved.locator.hover({ timeout: 3000 });
  else if (action.kind === 'fill') await resolved.locator.fill(action.value, { timeout: 3000 });
  else if (action.kind === 'select') await resolved.locator.selectOption(action.value, { timeout: 3000 });
  else return { ok: false, reason: 'unsupported-action' };
  await stabilize(page);
  return { ok: true, strategy: resolved.strategy, trial: { scrollBefore: before, scrollAfter: afterTrial } };
}

export async function discoverActionableInventory(page, options = {}) {
  return discoverAllFrames(page, options);
}
