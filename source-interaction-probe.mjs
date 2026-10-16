import { analyzeIconInteractions } from './icon-interactions.mjs';

// 只主动点击具有本地界面状态声明的控件，其余候选仍检查悬停并报告。
export function classifySourceControl(control) {
  const text = `${control.label || ''} ${control.text || ''} ${control.icon || ''}`;
  if (control.disabled) return { click: false, reason: '控件不可用' };
  if (control.tag === 'a' || control.submit || /删除|提交|发送|购买|支付|退出|登出|授权|安装|下载|delete|remove|submit|send|purchase|checkout|logout|sign.out|authorize|install|download/i.test(text)) {
    return { click: false, reason: '导航、表单或业务操作，仅检查悬停' };
  }
  if (control.tag === 'summary' || control.expanded != null || control.pressed != null ||
      (control.popup && control.popup !== 'false') || ['tab', 'combobox'].includes(control.role)) {
    return { click: true, reason: '原网页声明的本地界面状态控件' };
  }
  return { click: false, reason: '缺少可确认的界面状态声明，仅检查悬停' };
}

export async function probeSourceIconInteractions({ page, flush, maxHosts = 80 }) {
  const visited = new Set();
  const attempts = [];
  let truncated = false;
  while (visited.size < maxHosts) {
    const inventory = await page.evaluate(analyzeIconInteractions);
    const row = inventory.icons.find(row => row.visible && row.host && !row.host.disabled && !visited.has(row.host.selector));
    if (!row) break;
    const selector = row.host.selector;
    visited.add(selector);
    const attempt = { selector, actions: [], click: false, reason: null, errors: [] };
    attempts.push(attempt);
    const target = page.locator(selector.replaceAll(' >>> ', ' '));
    try {
      const control = await target.evaluate(el => ({
        tag: el.localName, role: el.getAttribute('role'), label: el.getAttribute('aria-label') || el.getAttribute('title'),
        text: el.textContent?.slice(0, 300), icon: el.querySelector('[data-icon-name]')?.getAttribute('data-icon-name'),
        expanded: el.getAttribute('aria-expanded'), pressed: el.getAttribute('aria-pressed'), popup: el.getAttribute('aria-haspopup'),
        disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
        submit: Boolean(el.form && ['submit', 'image'].includes(el.type))
      }));
      const decision = classifySourceControl(control);
      attempt.reason = decision.reason;
      await target.hover({ timeout: 3000 }); attempt.actions.push('hover'); await flush();
      if (decision.click && await target.isVisible()) {
        await target.click({ timeout: 3000 }); attempt.actions.push('click'); attempt.click = true; await flush();
        // 关闭时仍通过原网页自身事件处理器操作，不直接修改其 DOM 或样式。
        const reversible = control.tag === 'summary' || control.expanded != null || control.pressed != null;
        if (reversible && await target.isVisible()) {
          await target.click({ timeout: 3000 }); attempt.actions.push('click-return'); await flush();
        } else if (await target.isVisible()) {
          await target.press('Escape', { timeout: 3000 }); attempt.actions.push('Escape'); await flush();
        }
      }
      // 视口外移出可触发原站悬停结束逻辑，避免固定坐标恰好落在另一个控件上。
      await page.mouse.move(-1, -1); attempt.actions.push('leave'); await flush();
    } catch (error) {
      attempt.errors.push(String(error.message || error));
      await flush();
    }
  }
  if (visited.size >= maxHosts) truncated = true;
  return { attempts, visitedHosts: visited.size, truncated, automatic: true,
    limitations: ['未声明界面状态的自定义点击控件只测试悬停，仍需补充交互依据。',
      '自动记录不代表离线回放已经通过浏览器验收。'] };
}
