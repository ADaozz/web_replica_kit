# AGENTS.md — Web Replica Kit / Codex 任务约束

## 产品目标（最高优先级）
本项目不是单页静态截图器，而是 **交互式网站行为复刻器**。输入一个获准访问的网页 URL，通过 Playwright 在原站识别用户可操作控件、探索安全的 UI 状态转换、抓取对应 DOM/CSS/图标资源/截图/路由，最终在本地离线实现可操作的高保真界面。

**行为复刻** 的含义：用户在复刻页进行展开/收起、弹层开关、Tab、Switch、下拉、多级菜单、页面内导航、筛选或表单输入等操作，产生与已观测原站等价的可见反馈。只有能点击、没有正确反馈，不视为完成。

项目的原有静态资源采集与图标完整性策略继续保留，不允许因新增交互功能而回退。

## 核心约束
1. **发现控件以 Playwright 的 locator/actionability 语义为基准，不能只从图标宿主出发。** 结合可访问性语义（role/name/label）、原生 HTML（button/link/input/select/summary）、ARIA（expanded/pressed/checked/controls/haspopup）、contenteditable、tabindex、pointer 样式、动态 Shadow DOM 与 iframe 中的可见/隐藏状态。不要把 cursor:pointer 当成确证，也不要把没有图标的按钮漏掉。
2. **“可操作”不等于“可以自动点击”。** Playwright `locator.click({ trial: true })` 仅验证点击可行性；测试源页面时按 Visible / Stable / Receives Events / Enabled 检查。trial 可能滚动或引起悬停，因此应记录影响；不能靠 `dispatchEvent('click')` 替代真实交互。输入元素用相应的 fill/check/selectOption/press 等动作。
3. 优先使用 `getByRole` + accessible name、`getByLabel`、`getByPlaceholder`、`getByTestId`；CSS selector 最后兜底。Locator 必须唯一且能在 DOM 重新渲染后再次定位。记录 locator 策略、frame 路径与失效原因。开放 Shadow DOM 要支持；闭合 Shadow DOM 不得声称支持。
4. 发现后 **实际观察原站动作结果**：从前态触发动作，等待稳定，采集后态的 URL/route、DOM/ARIA/表单值、可见节点树与几何、相关资源和截图，生成 State -> Action -> State 关系与差异。每产生新状态就重新发现控件，递归探索，并限制广度/深度/状态数，避免爆炸。
5. 跨页面菜单/导航必须跟踪 `page.url()`、History API 单页路由、同站页面跳转，以及受控的新标签页。不得继续在 `startURL` 改变后静默放弃；应新建路由状态并继续资源采集。外站跳转只记录，不自动跨域探索。
6. 复刻页不能把整个 `document.documentElement` 反复替换作为长期交互架构。这样会丢失输入、焦点、滚动和状态组合。应优先构建可复用的局部状态机/组件更新器和本地路由；整页回放仅作为证据、临时后备和调试手段。
7. **绝不编造未知行为**：无法观察、无法安全执行或需要后端的操作，标为 `unverified` / `unsupported` / `requires-backend`，并产生可供人工补录的证据。不能根据 icon 名称或 CSS class 猜一个“看起来合理”的结果。
8. **安全界限**：自动探索不得提交真实表单、发送消息、删除数据、支付、下单、退出登录、授权、安装、上传、外部跳转或更改用户账户。仅对明确无副作用的 UI 操作自动执行。需要业务写操作时人工授权且默认模拟数据。保护 cookies/token/个人内容，输出与日志必须脱敏，不把私人 profile 提交至 Git。
9. 验收以 Playwright 实测为准：在原站和本地相同初始条件下运行同一操作序列，比对交互后可见组件、URL/路由、展开/选中状态、尺寸/位置与截图。任何未验证行为不得算“成功复刻”。
10. 不要删掉静态采集能力；不要为迎合测试而硬编码 ChatGPT、侧栏、某特定 icon、某一网站 CSS 类名。代码应面向通用网站，允许显式站点适配器作为隔离扩展。

## 推荐模块
- `actionable-dom.mjs`：枚举所有状态下候选控件 + 语义标识 + actionability 检查 + 控件分类。
- `interaction-explorer.mjs`：安全动作队列、状态图 BFS/DFS、重发现、复原初态、预算与危险操作拦截。
- `state-diff.mjs`：语义化 DOM/ARIA/geometry/route/input 差异；忽略时钟、随机 ID 与其他噪声。
- `route-capture.mjs`：SPA/history/同域导航与新增页面状态。
- `offline-runtime.mjs`：按真实观测到的状态机实施局部 UI 变化，保留输入/焦点/组合状态。
- `scripts/verify-interactions.mjs`：在原网页 vs 离线页重复动作，并生成覆盖率/差异报告。
模块名称是建议，不必为了名字无谓重构。

## 开发次序与完成定义
依次实现：通用控件清单 -> 可操作性验证 -> 安全探索和跨路由状态录制 -> 局部交互运行时 -> 自动回归验证。
每一步提交可测试、可复用的模块；新增单元和浏览器 E2E 测试。至少覆盖：无 icon 按钮、展开/收起、Switch 控制另一个元素、Tab 内容切换、下拉菜单、侧边栏、SPA 导航与跨页导航、Shadow DOM 中的控件。关键误判也须有测试（遮挡、disabled、重复 accessible name、危险业务按钮）。

对 `interactions.json` 等输出区分 `discovered`、`actionable`、`observed`、`replayed`、`verified`，分别报告数量和理由。禁止“发现了 N 个按钮”就宣称“复刻了 N 个交互”。

详细设计与验收约定：`docs/INTERACTIVE_REPLICA_SPEC.md`。
