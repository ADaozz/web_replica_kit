# Interactive Replica Specification

## 1. 需求和非目标
输入 URL + 浏览器会话与许可的探索范围。输出可以本地打开的交互式网页副本，包含页面布局、资源和**可用的、经过原站观测的客户端交互**。原站脚本的原始业务实现不一定可获取；目标是用户可观察的等价行为，不是恢复 React/Vue 源码。无法离线执行的服务器写入、实时协作、支付、任意第三方 API 等必须透明标记为需要后端/未支持，而不是假成功。

原有 icon 下载、SVG sprite、CSS mask、字体、Shadow DOM 和响应式采集继续使用。

## 2. 控件发现：模仿 Playwright，而不是猜按钮
### 2.1 全量候选来源
在 **每个已知页面状态** 中遍历 DOM 与 open ShadowRoot，并检查每个 frame：
- 语义元素：button、a[href]、input（包括 checkbox/radio）、select、textarea、summary、option、[contenteditable]；
- 可访问性：role=button/link/switch/checkbox/radio/tab/combobox/menuitem/treeitem/slider/spinbutton 等，可访问名称 name/label；
- 行为属性：aria-expanded / pressed / checked / controls / haspopup、tabindex、onclick、委托事件绑定的宿主；
- 弱线索：cursor:pointer、CSS hover/focus 变化、可能点击的菜单/列表项，但仅作候选，不代表实际可操作；
- 将内嵌 SVG 或图标**归属至最近控制宿主**；图标只是资源，不能作为控制节点发现的前提。

记录控件字段：frame/route、稳定 locator 候选及唯一性、role、accessibleName、tag、bbox、visibility、enabled/editable、ARIA 状态、可用动作、风险分类和发现证据。隐藏控件保留为 `currently-hidden`，在后续展开状态重新检测。按语义节点去重（图标、span、button 不应被计为三次操作）。

### 2.2 Locator 优先级
`getByRole(role, { name, exact: true })` -> `getByLabel` / `getByPlaceholder` / `getByTestId` -> 有上下文的 CSS locator。重复时先 scope 到菜单/区域或明确容器，不盲用 `.first()`。跨 iframe 使用 FrameLocator 或对应 Frame；Open Shadow DOM Playwright locator 可以穿透，XPath 不能。定位失败必须输出 `locatorAmbiguous` 或 `locatorMissing`。

### 2.3 Playwright actionability
仅当识别出动作后进行相应检查：
- `click({ trial: true })`：唯一、Visible、Stable、Receives Events、Enabled；
- 输入：Editable + fill 或 press；select 用 selectOption；checkbox/radio 用 check/uncheck；
- trial 不实际点击，但可能滚动、触发 hover/浮层，故属于观察性探测，需留存前后差异；切勿将 trial 通过等同于行为可还原；
- `isVisible` 不验证无遮挡，`pointer-events`、hit-test 和临时遮挡必须通过 actionability 检测或实际动作结果确认。
- 用户可通过键盘操作的 UI 应测试 Enter、Space、Escape、Arrow keys；Hover UI 用 hover/leave 而不是强制点击。

## 3. 动作分类 / 安全
每个候选判定 allowed-safe、review-required 或 blocked，默认 `review-required`。自动探索仅执行本地无副作用的可逆状态切换，包括明确的下拉、开合、Tab、非持久化 Switch、无副作用选择或导航。导航只允许用户许可的同站 URL/路径；非安全动作（发送、提交、购买、删除、支付、上传、登录/登出、修改设置、授权、外部跳转）禁止自动执行。**不能只用按钮文字过滤危险动作**：结合 method、表单归属、目标 URL、事件触发的网络写请求风险和页面语境做策略判断；出现不确定性就停下并要求人工补录。必要时在受控测试环境使用后端 mock，而不是点击真实生产写接口。

## 4. 状态图与自动探索
定义 `State = {route, domSemanticSnapshot, visibleComponents, ariaStates, formValues, geometry, screenshotRef, assets, viewport}`。

定义 `Transition = {fromState, controlId, locator, action:{kind,arguments}, toState, observations, evidence, confidence, classification}`。

基础循环：
```text
captureInitialState();
queue.push(initialState);
while queue not empty and budgetsAllow:
  state = queue.pop();
  restoreSourceState(state);       # 从已知重放序列或导航稳定恢复
  controls = discoverAllControls();
  for control of controls:
    if not safelyAllowed(control): reportSkip(control); continue;
    if alreadyVisited(state,control,action): continue;
    before = captureState();
    runRealPlaywrightAction(control);  # 不使用 dispatchEvent 模拟结果
    await stabilization();            # DOM/URL/可见性/网络/动画，而非仅固定 sleep
    after = captureState();
    diff = semanticDiff(before, after);
    saveEdge(before, action, after, diff);
    if after is new and budgetsAllow: queue.push(after);
```

每个新出现的菜单项/Tab 内容/切换后的控件也加入待探索列表。区分 hover 产生的中间状态、click 产生的提交状态；重试已变化 locator 时重新发现，不使用早期的 `:nth-child` 索引。对组合状态（Switch + Tab + Menu）做可配置 pairwise / 限深覆盖以避免组合爆炸。维护每个页面/状态/动作/控件唯一的 visited key。

**稳定判定**：DOM 主要子树稳定、相关 aria 和 URL 稳定、位置动画完成；必要时捕捉多个延迟采样。排除时间戳、广告、随机 ID 与通知计数等噪声。保留取消、返回、关闭动作，尽可能复原原状态。

## 5. 跨路由与多页面
监控 History API (`pushState`/`replaceState`)、popstate、hashchange、完整 `page.goto` 导航、同域链接与受控 popup。地址变化不得导致录制结束；应创建目标 route/state 并继续新页面的 DOM、CSS、assets、icons、交互发现。生成本地路由映射（例如 `routes.json`）。外部域、OAuth、跨站支付只记录目标与阻断原因，默认不自动访问。必要时切换回初态，验证浏览器 Back/Forward。

## 6. 离线运行时（核心）
**不要长期用整个 HTML 状态替换的方式实现交互**。整页替换只可作为现有回放兼容模式/调试参考。真正的离线运行时应：
- 为 Accordion、Popover、Menu、Sidebar、Dialog、Tab、Switch、Checkbox、Selection、Filter、内页 Navigation 生成明确的局部状态机；
- 对每个状态机保留 `open/checked/selected/activeTab/currentRoute` 等值，以及可观测的 DOM/style/ARIA 差异；
- 将原站动作后显示或隐藏、插入/删除、重排、变色、调整几何的**关联元素**绑定到正确状态，不仅改变被点的按钮；
- 保留同页其他组件状态，保持焦点/文本输入/滚动/键盘可用性；
- 无法证明是通用模式时，可用录制状态差异局部重放，但必须同时验证组合状态，不得把多个状态强行覆盖或随意生成目标 DOM；
- URL、返回、前进和浏览器历史行为需与原站可观察结果一致（离线站只本地导航）。

## 7. 证据格式与报告
每条动作保存：
```json
{
  "route": "/settings",
  "control": {"role":"switch","name":"Show advanced","locatorStrategy":"role+name"},
  "before": {"stateId":"s1","checked":false},
  "action": {"type":"click"},
  "after": {"stateId":"s2","checked":true},
  "effects": [
    {"type":"visibility","target":"advancedPanel","from":false,"to":true}
  ],
  "confidence": "observed",
  "replicaVerified": false
}
```
目录建议 `actions.json`, `routes.json`, `states/`, `interaction-coverage.json`, `interaction-failures.json`。不要将 cookies、authentication headers、token、未脱敏请求正文写入任何公开输出。失效的资源也应归因：未下载、跨域、动态加载失败、Shadow DOM 限制。

## 8. 完成判定与测试矩阵
测试必须先在受控本地 demo（不会修改真实数据）运行，然后可在获准测试站点上执行。至少验证：
1. 无图标的 button 被识别，点击开合内容并能返回初态；
2. switch 切换时，控制组件与**另一处关联节点**同步变化；
3. tab 激活时对应 panel 改变，旧 panel 隐藏；
4. dropdown 打开/关闭、点击外部/ESC、键盘焦点；
5. sidebar 折叠及页面宽度重排；
6. SPA Menu navigation 更新 pathname、视图，Back/Forward 正常；
7. 完整导航、新页面的资源与新发现控件连续采集；
8. 动态新出现的控件被递归探索；
9. open Shadow DOM、iframe 可查，闭合 Shadow DOM 如实报告限制；
10. 被遮挡、disabled、重复 accessible-name 的控件不会被误判为成功；
11. 自动探索不触发删除、提交、支付、登出、发送等真实写操作；
12. 原站与离线页逐步比较可见性、ARIA、布局、URL/路由及截图；
13. 原有 icon/字体/CSS/静态页面采集与测试均保持通过。

交互覆盖率用不同阶段分别报告：`discovered` / `eligible` / `actionable` / `observed` / `implemented` / `verified`，包含跳过/失败原因；明确给出可安全探索控件的分母，禁止报告一个没有分母的“100% 交互”。

## 9. 分阶段实施给 Codex
- P0：把 `icon-interactions` 从交互发现唯一入口降为 icon 辅助模块；新增通用 `actionable-dom.mjs`、frame/shadow/语义定位、动作安全分类及测试；不要破坏原有 `capture.mjs`。
- P1：升级 `recorded-interactions.mjs` 为 `interaction-explorer.mjs` 工作流，支持 source-state/action/next-state、动态控制重发现和 route 变更；
- P2：构建局部状态机和离线路由，替代整页 `replaceChildren`；对无法恢复的业务结果输出准确的不支持状态；
- P3：自动比较原网页 vs 复刻网页的相同操作序列，输出结果与具体失败报告；
- P4：多站点、多视口、组合交互测试，不得只针对 ChatGPT 硬编码。

任何阶段不足以达成端到端行为复刻，都应说明当前能力边界。不可把“发现并可点击”直接说成“交互复刻完成”。

## 官方参考
- https://playwright.dev/docs/locators
- https://playwright.dev/docs/actionability
- https://playwright.dev/docs/aria-snapshots
- https://playwright.dev/docs/api/class-framelocator
