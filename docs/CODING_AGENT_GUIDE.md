# 使用采集证据实现前端

## 从数据开始

1. 读取 `report.json` 的 schemaVersion、预算、资源缺失、探索失败和能力限制。`index.html` 只帮助查看静态布局，不能用它推断未知组件行为。
2. 读取 `dom/elements.json` 和 `dom/tree.json`。元素的 `elementId` 是当前采集文档内的实例 ID；树中的 children 与 shadowChildren 分别表示普通子节点与开放 Shadow DOM。节点 content 保留文本、注释与元素的混合顺序。脚本、noscript 和 template 的结构化采集缺口记录在 frames.omittedTags；初始原 HTML 在 `dom/original.html`，仅作证据。
3. 按 `css/stylesheets.json` 的作用域与原始样式表顺序复用 CSS。网络原文件在 `css/original/`，静态预览用的资源改写版本在 assets/。CSSOM 的 styleSheets 和 adoptedStyleSheets 分别记录各自顺序，import 和条件保留树形边界。CDP header 的加载事件不是样式表级联顺序。来源未知时不能以采集顺序编造级联。
4. 用 `interactions/states.json` 的 domRef 打开该状态的结构化快照，用 cssRef.snapshotId 查找 `css/matched-rules.json` 的 snapshots，再读取该条目的 file。规则 ID 指向 rules，规则 source 的 stylesheetId / versionId 指向原样式表及文本版本。每条规则保留选择器、声明、源范围与协议元数据；声明正文只保存在 rules[].declarations，协议元数据不重复携带 style 正文。inline、继承、伪元素和变量都有独立证据。
5. 读取 transitions 与 `relations/state-style.json`，按 observed 的真实动作及前后规则自行实现组件状态管理。ARIA / popovertarget 关联是源 DOM 声明的关系。selector-dependency-observed 只是直接选择器依赖的证据；其他因果关系为 unresolved，不能把邻近布局变化当作按钮控制关系。
6. 图状态按语义去重；一次状态可以有多个实际 DOM 实例观测，坐标、滚动、焦点和悬停不同也会分别保存证据。转换的 beforeObservationId / afterObservationId 指向 `interactions/observations.json`，再查对应 domRef、cssRef。不要把早先状态里的元素 ID 强行用于后续重建后的菜单。

`layout.json` 保存初始布局的元素 ID、frameIndex、document 坐标及计算样式。每个状态 DOM 中的 bbox 是该 frame 视口坐标，documentBox 补偿采集时的页面与内部滚动；外部验证器使用 Playwright boundingBox，以统一主页面坐标比较弹层四边。SVG、字体、CSS mask 与图标依赖见 icons.json 和 assets.json。report.json 的 resourceFailures 记录资源请求失败与是否随后补全，missingResources 列出尚未补全的资源。未下载的资源、不可读的 CSS、闭合 Shadow DOM、frame 读取失败或超预算节点均需单独处理，不能声称已完成复刻。

## 数据版本 2

| 文件 | 主要内容 |
| --- | --- |
| dom/tree.json | schemaVersion、frames 的根节点 ID、元素父子及 shadow 邻接表 |
| dom/elements.json | 初始状态的元素事实数组 |
| dom/states/observation-*.json | 每次观测的 nodes、frames、真实 route、History、focus 等 |
| css/stylesheets.json | CDP stylesheets/versions、CSSOM 观测文件引用、resourceFiles、missing、budgets |
| css/cssom/*.json | 单次状态 / frame 的 CSSOM scopes、sheets 与条件规则树 |
| css/matched-rules.json | rules 字典数组、snapshots 的 id / stateId / file 清单 |
| css/states/*.json | 单次观测的逐元素匹配、继承、伪元素与计算样式 |
| css/variables.json | resolvedSets 的去重计算值、states 的逐状态元素文件引用 |
| css/variables/*.json | stateId、elements 的 elementId / scopeId / resolvedSetId / sourceRuleIds |
| interactions/controls.json | 控件语义、定位、安全分类及 elementRefs |
| interactions/states.json | id、hash、路径、深度、observationId、domRef、cssRef、page |
| interactions/observations.json | 实际观测 ID → DOM/CSS/page 引用；包含恢复中的观测 |
| interactions/transitions.json | id、from/to、前后 observation、control、action、effects、confidence |
| relations/state-style.json | 转换、显式目标关系、状态变化、前后规则与 unresolved 原因 |

变量查询顺序：状态 cssRef → matched-rules.snapshots[].file → snapshot.stateId → variables.states[].file → element.resolvedSetId → variables.resolvedSets[].values。element.sourceRuleIds 只引用匹配或继承规则；通过 rules[].variableNames / variableReferences 查看变量名与引用属性，通过 declarations 查看原始值、important、源范围，并通过 source 查样式表与位置。继承层级与 inline owner 在同一 CSS 状态文件中，scopeId 保留 document / shadow 边界。最终计算值是浏览器观测值，不根据规则顺序猜测哪个声明胜出。标准计算属性仍在 CSS 状态文件的 computedStyle 中，自定义属性值仅保存在 resolvedSets，不再逐元素复制。完全相同的值集合跨元素、跨状态共享同一个内容哈希 ID。

内联样式与 presentation attributes 的 source.elementId 直接指向所属元素，不将其 CDP 内部 styleSheetId 当作真实 Stylesheet。空内联样式不生成规则；真实 style 标签、动态 / Constructable Stylesheet、原始文本版本与样式表边界继续保留。真实读取失败保留错误；只有成功读取或真实 Header 才建立 Stylesheet 记录。

JSON 默认紧凑写出，逐状态 / 类型分文件；每个文件的字符串分片转义，写入批次默认 64 KiB，不拼接整个 JSON 字符串。写入失败会移除临时文件并保留原目标。读取器只接受新格式，不提供旧 variables / inline stylesheet 格式兼容层。schemaVersion=2 指源证据交付，独立的前端验收报告继续使用自己的版本。

数组类型的文件不额外包装；report.json 的 schemaVersion 标识整个交付版本。缺失数据不能用空对象解释为“已验证为空”。CSS 文件内 stateId 是该次样式采集标签（initial 或 observation-*）；查询变量和 CSSOM 时使用 cssRef 所指 snapshot 的 stateId，不假定它等于语义图的状态 ID。`source.range` 的行列沿用 CDP 零基位置，inline 样式表同时保留 header 起点；CSSOM 没有原始位置，range 为 null，并带原因。

## 验收开发完成的前端

参照 [显式映射示例](examples/frontend-scenario.json)，使用实际页面选择器填写 scenario，再运行：

```bash
node scripts/verify-interactions.mjs https://source.example/app http://127.0.0.1:5173/app scenario.json verification
```

两边在独立浏览器上下文内运行相同连续动作，CLI 在首次导航前安装网络保护。函数 API 的调用者也应在导航前安装 protectExploration，并禁用 service worker。验证器自身在动作前再次安装保护，并检查两边控件的安全分类；未知业务操作会跳过。

每一步必须显式给出 source、target 与 assertions。两边独立支持 selector（含开放 Shadow DOM）、role/name、label、testId，以及可选 frame.url 或 frame.index；定位必须唯一。支持 click、hover、press、check、uncheck、fill、select。状态检查可选择 attributes、properties（value/checked/selected/selectedIndex/open/disabled）、text（折叠空白）、visible、bbox、styles 和 cssRules。`exists:true` 比较动态节点的存在性，关闭后两边节点都移除也可检查。CSS 规则检查要求两边实际匹配对应 selector；重复规则需补 sourceUrl/targetUrl 消歧。

`styles` 证明指定属性在此状态的计算结果等效，不能证明所有 CSS 相同；`cssRules` 比较指定匹配规则的声明，不要求两边具有相同协议 ID、URL 或 DOM。可以只选等效样式验证；未检查的样式证据标记 unresolved。截图默认作为辅助证据，仅显式指定 `visual: {"maxPixelRatio":0.01}` 时参与像素验收。

默认 route 比较实际 pathname + search + hash。部署路径确实不同或语义路由不同，使用一步中的 `route:{"source":"/settings","target":"/preferences"}` 明确指定双方期望；结果仍保存真实路径。不得覆盖观测值。布局默认容许四边各 8px，支持逐项 tolerance。

失败后的剩余动作跳过，避免未知状态上的假通过。缺少映射、定位歧义、安全限制都保留原因；状态不符、错误路由、位移、样式缺失会失败。interaction-verification.json 保存逐步结果和证据。verified 只统计通过且原站在所检查事实中确有状态变化的唯一 controlId（未填写时由双方映射确定），verifiedSteps 统计动作步骤；无变化步骤可通过比较但不能增加已验证交互覆盖率。此报告属于外部前端验收，不修改采集覆盖率。

## 采集约束

使用新的空 `--out` 目录，每次采集独立保存，避免旧文件混入交付。`--max-nodes` 控制每 frame 的 DOM 预算，`--max-css-nodes` 控制每 frame 的规则匹配预算；探索的 states/depth/actions 另有限制。API 可设置 maxObservations（默认 256）。观测证据超限时转换明确标记 evidenceMissing，规则关联为 unresolved；图中已发现状态仍保存 DOM 到 state-*-dom-only.json，cssRef 为 null，并记录缺失原因。报告中的预算截断、恢复失败、missing 和 unresolved 都是后续工作清单。原站脚本不进入预览；预览仅初始化滚动和空 custom element 定义，保留非敏感表单状态对应的原生 CSS。
