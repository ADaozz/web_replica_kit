# 静态 UI 采集可靠性修复验收

日期：2026-10-17。仓库 ADaozz/web_replica_kit，分支 refactor/agent-skill-static-capture，基线 ad269e4。环境为 Node 24.19.0、Playwright 1.64.1 / Chromium 156、Linux x64。

四项指定修复已完成。全部适用自动化检查通过；真实站点的资源完整性和局部模块就绪仍有下述限制，不能将单测或 CLI ok 等同于整站无损验收。

## 状态约定

- **FIXED**：指定问题及对应观测已验证通过。
- **PARTIALLY_FIXED**：指定能力可用，但资源或视觉验收尚不完整。
- **UNRESOLVED**：已实际观测到、尚未消除的问题。
- **NOT_TESTED**：本轮未实际验证，不能推断通过。

这些验收状态独立于 CLI 的 ok / partial / failed。

## 四阶段提交与定向测试

| 阶段 | Commit | 范围 | 定向测试结果 | 状态 |
| --- | --- | --- | --- | --- |
| PR-01 | f64c582 | 默认不调用清理；显式 clean-noise；remove-selector 只删除指定元素；删除 keep-noise 参数 | page-cleanup、cli、manual-confirmation、capture-static：12/12 | FIXED |
| PR-02 | 05c25b0 | Skill 展示可见和隐藏两组全部有效目标；保留多来源和去重；无采集器点击/Hover | discover、discover-browser、hidden-components：7/7 | FIXED |
| PR-03 | 3a45ccb | body UI 根；排除非 UI 子树；html 全局布局作为元数据；三份 ID 对齐 | dom-static、capture-static、css-static、hidden-components：12/12 | FIXED |
| PR-04 | 4fa2e32 | 提取无测试依赖的 page-readiness；报告与 partial 警告；登录页及媒体不误判；保留手动确认 | readiness、readiness.e2e、site-verification、capture-static：20/20 | FIXED |

每阶段在对应检查通过后提交。随后只追加本验收文档和 README 链接，没有进一步修改采集实现。

PR-01 覆盖默认保留广告、推广 Modal、Shadow DOM 广告与滚动锁；显式选择器不额外清理广告/遮罩；启用现有启发式规则；非法选择器失败。默认和显式清理产物均检查静态 HTML，默认预览与同次源截图逐像素一致。

PR-02 覆盖 display:none、visibility:hidden、opacity:0、Open Shadow DOM 链接，以及可见/隐藏来源共用 URL、无效 URL 和无 href 的 JS-only 按钮。真实 discover 的本地服务只收到一次目标请求，没有访问候选地址。Skill 分组规则为“任一来源可见则列入可见组，否则列入隐藏组”，不将隐藏菜单误称为已展开。

PR-03 覆盖 head/body/shadow 中 style/script/template 等非 UI 节点过滤、已挂载隐藏 UI、语义与自定义元素、预算总数/截断、根与父引用。静态 HTML 完整 head/style、原始 CSS 及 CSSOM 能力继续保留。layout.documentElement 不含伪造 elementId，html 的关键样式和几何保留于此；body 样式仍在对齐的元素数组内。

PR-04 的本地用例包括正常正文、纯 Loading、验证占位、空白、合法 /login、Canvas-only、image-only、显式 selector 成功/超时、确认后出现正文、手动确认后仍为验证页，以及隐藏媒体/开放 Shadow DOM 文字/仅表单控件。11 次采集尝试只导航 11 次，没有自动刷新、重试或绕过验证。unknown 作为诊断不确定性保留，不自动宣告失败；content-observed 不保证每个异步局部模块均完成。

## 完整自动化回归

| 命令 | 实际通过 | 失败 / 跳过 |
| --- | ---: | --- |
| npm test | 51 | 0 / 0 |
| npm run test:e2e | 27 | 0 / 0 |
| npm run test:css | 3 | 0 / 0 |
| npm run test:scroll | 2 | 0 / 0 |
| npm run test:hidden | 2 | 0 / 0 |

前四组共 83 项；hidden 的 2 项已包含在 e2e，再次单独执行，总执行计数 85。继续通过 JS Bundle/事件/敏感数据过滤、原始 CSS、SVG/字体/资源、Canvas、Video、Animation 静态保留及 file/HTTP 预览回归。

## 四站新采集与同次视觉对照

```sh
node scripts/test-sites.mjs \
  --only bootstrap-sidebars,shoelace-dropdown,tabler-dashboard,ant-design-switch \
  --out test-results/static-reliability-four \
  --wait 3000 --preview-wait 3000 --max-nodes 10000 --timeout 150000
```

每个目标独立执行 discover 和 capture；1440×900、deviceScaleFactor=1，默认不清理，额外等待 3 秒，结构预算显式为 10000。file 和 HTTP 预览均阻断外网，等待字体及相同 3 秒后对比本次 screenshot.png；pixelmatch threshold=0.1。未与历史清理后的截图混用，未覆盖初轮失败或差异结果。

| 目标 | discover 目标 / 隐藏独有目标 | UI 元素 / 截断 | CLI | file / HTTP 差异 | CSS 审计问题 | 验收 |
| --- | --- | --- | --- | --- | ---: | --- |
| Bootstrap Sidebars | 2 / 0 | 302 / 无 | ok | 0% / 0% | 0 | FIXED |
| Tabler Dashboard | 141 / 127 | 3880 / 无 | partial | 0% / 0% | 1284 | PARTIALLY_FIXED：当前视口一致，CSS 变体引用未完整本地化 |
| Shoelace Dropdown | 125 / 2 | 5215 / 无 | ok | 0.052006% / 0.052006% | 0 | PARTIALLY_FIXED：残余像素差异未消除 |
| Ant Design Switch（默认等待） | 156 / 0 | 1649 / 无 | partial | 0.682253% / 0.682253% | 1 | UNRESOLVED：局部示例仍处占位状态，之后源页面才完成渲染 |

四站 cleanup.removedCount 均为 0、automatic=false，readiness 均为 content-observed。三份 elementId 集合、父引用与 body 根均有效；没有 html/head/style/script/meta/link/template 组件。原始网络 CSS 分别为 2 / 9 / 5 / 8 份，全部与 stylesheets.json 的 sha256 一致。

额外几何核对：Bootstrap main、Tabler header/main、Shoelace header/main/aside/nav 的源结构与离线几何差值均为 0；Tabler 的隐藏 aside/nav 亦按实际零尺寸保留。Shoelace 有 379 个 Open Shadow Root，sl-dialog#wa-dialog 的 open 属性和预览节点均保留。Ant 默认产物的 main 高度相差 91.1875px，不能判作整个页面视觉验收通过。

主命令的采集耗时分别为 Bootstrap 5.22s、Tabler 17.50s、Shoelace 13.16s、Ant 14.56s；其中诊断分别约 21.7 / 19.2 / 37.4 / 920.3ms。部分采集与自动化回归并发，这些仅是观测，不是性能基准或相对旧版的加速证明。

### Ant 的显式就绪条件复测

初次尝试沿用旧式 #components-switch-demo-basic 选择器，真实站点 30 秒超时并返回 failed，没有静默采集。只读检查确认当前 ID 为 switch-demo-basic 后，使用现有 CLI 选项重新执行：

```sh
node scripts/capture.mjs --url https://ant.design/components/switch/ \
  --ready-selector '#switch-demo-basic button[role=switch]' --ready-timeout 30000 \
  --wait 3000 --max-nodes 10000 \
  --out test-results/static-reliability-ant-ready-corrected
```

新产物含 1758 个 UI 元素、14 个 Switch；离线预览同样有 14 个，main 几何差异为 0，file/HTTP 与这次新源截图均为 **0%** 差异。readiness 为 content-observed、readySelectorMatched=true；耗时 8.86s，仍为 partial（1 项远程 CSS 引用）。此项为 **PARTIALLY_FIXED**：显式等待消除了本次示例缺失，不能据此宣称任意默认等待均能识别局部模块就绪。

## 本地验证页 / Loading 对照

另以本地 HTTP 200 合成页执行完整 discover、capture、file/HTTP 对照，证据在 test-results/static-reliability-local/summary.json：

| 页面 | readiness | CLI | file / HTTP 差异 | 验收 |
| --- | --- | --- | --- | --- |
| 已知验证占位 | verification-gate | partial，退出 2 | 0% / 0% | FIXED：保留真实内容并明确警告 |
| 纯 Loading | loading-placeholder | partial，退出 2 | 0% / 0% | FIXED：不删除占位、不静默完整成功 |

## 未解决与未测试

- **UNRESOLVED**：默认 content-observed 只证明已有可观察内容。Ant 局部异步示例可能仍未挂载，初轮已观测到源截图/预览时序差异。现有 ready-selector 可解决特定目标；本次不增加通用组件加载探测、自动滚动或交互。
- **UNRESOLVED**：Tabler 有 1284 个远程 CSS 资源引用，主要是未显示的旗帜变体；像素 0% 不意味着全 CSS 依赖完整。
- **UNRESOLVED**：Shoelace 两种协议均有 674 个残余差异像素（0.052006%），本轮未确证其全部原因，不用审计 0 问题替代视觉通过。
- **UNRESOLVED**：Ant 有一个 qICoJIqqQRMeRGhPHBBS.svg 远程 CSS 引用；默认和显式等待的每个离线协议都还有 4 个 at.alicdn.com 字体备用源请求失败（webfont_6e11e43nfj、webfont_exesdog9toj 的 woff/ttf）。显式等待后的视口一致，不证明视口外或所有字体变体完整。
- **NOT_TESTED**：真实 Cloudflare 验证流程及真人桌面手动确认未在本轮执行；已覆盖本地验证页、readline 确认测试和 headless 下的实际采集确认门槛。未执行验证绕过或自动确认。
- **NOT_TESTED**：跨 Coding Agent 的新会话实际展示流程未重跑；本轮验证了 Skill 文本策略及 discover 产物的隐藏入口完整性。

四项范围内修复为 FIXED；“四站任意默认等待均无结构/视觉差异”和“全站资源完整”没有被标记为全部通过。

## 实际文件清单与 Diff

新增：

- page-readiness.mjs
- tests/readiness.test.mjs
- tests/readiness.e2e.mjs
- references/static-reliability-validation.md

修改：

- capture.mjs、dom-snapshot.mjs、page-cleanup.mjs、scripts/cli-options.mjs
- scripts/site-verification.mjs、scripts/test-sites.mjs
- README.md、SKILL.md、references/output-format.md
- package.json、tests/run.mjs
- tests/capture-static.e2e.mjs、tests/cli.test.mjs、tests/discover-browser.e2e.mjs、tests/discover.test.mjs
- tests/dom-static.test.mjs、tests/manual-confirmation.test.mjs、tests/page-cleanup.test.mjs、tests/site-verification.test.mjs

删除文件：无。删除的行为包括 keep-noise 参数兼容、Skill 可见性过滤、组件元数据/CSS 文本记录，以及仅凭登录 URL 判异常的分支。判断逻辑已从测试工具提取，而非复制进采集器。

相对 ad269e4，共 23 个文件（4 个新增、19 个修改），337 行新增、55 行删除。未变更 discover 实现、CSSOM/原始 CSS/资源采集实现、makeSnapshotHtml、Canvas/Video/Animation 冻结代码或项目依赖；只改变清理调用条件、组件证据范围、轻量诊断及其测试文档。没有交互探索、状态恢复、逐节点 CDP 匹配、跨页访问或 Agent 框架。

完整本地证据：static-reliability-four/summary.json、postchecks.json、每站 screenshot.png、preview-file.png、preview-http.png、report.json；Ant 显式等待目录中的 validation.json；以及 static-reliability-local/summary.json，均位于 test-results/ 下。真实采集文件保持 Git 忽略，不随代码提交。
