# 网页结构、规则与行为采集规范

## 职责
输入获准访问的 URL，输出可追踪的 DOM、CSS、资源、控件和状态转换证据。Coding Agent 据此实现前端。本工具不生成组件源码、通用交互引擎或整页状态切换页面。静态预览仅恢复原始布局、资源、编码和滚动。

## 目录约定

```text
output/
  index.html
  assets/
  assets.json
  dom/tree.json
  dom/elements.json
  css/stylesheets.json
  css/matched-rules.json
  css/variables.json
  interactions/controls.json
  interactions/states.json
  interactions/transitions.json
  interactions/failures.json
  interactions/restorations.json
  interactions/overlay-diagnostics.json
  relations/state-style.json
  routes.json
  layout.json
  icons.json
  report.json
```

状态引用对应 DOM、CSS 与页面信息。DOM 保留结构、属性、文本、表单、布局、父子与触发器/面板关联。CSS 保留样式表边界、顺序、来源、源位置、声明、匹配顺序、继承、变量、伪类和条件。动态 CSSOM、Constructable Stylesheet、开放 Shadow DOM 单独标明作用域与采集通道。不能读取的信息标记缺失，不捏造源文件位置。

状态转换包含 from/to、稳定控件标识、真实动作、结构化 Diff 和相关 CSS 规则变化。状态关联只证明已观测的 DOM 和规则事实，不推断 React/Vue 代码，也不根据视觉推断因果。

## 安全探索

每个新状态重新发现控件。优先语义定位，容器作用域与唯一 CSS 定位兜底。trial 仅验证可操作性，不视为动作结果。键盘、Hover、Check、Fill、Select 使用对应 Playwright 动作。

默认只执行可逆的本地 UI 操作，危险业务动作与外站导航禁止。网络保护在动作前生效，不根据接口名称豁免 POST。恢复使用真实逆操作或已知路径；失败后停止。状态、深度、动作预算可配置，缺失和截断保存在报告中。

## 外部前端验证

原站与 Coding Agent 页面在相同视口和操作序列下比较。映射明确指定两边控件及必要的状态节点；允许容器、标签和 ID 不同。比较操作结果、必要属性/文本/表单、真实路由、边界坐标和样式。原 CSS 可直接保留或提供等效样式结果；未知或不可验证的规则来源单独报告。

统计区分采集的 discovered / eligible / actionable / observed，以及独立前端验收的通过/失败/跳过。采集不表示交互已实现或已复刻。

## CSS 采集通道

`--max-css-nodes 1000` 控制每个状态、每个 frame 的 CDP 匹配节点预算。超限节点、不可访问 frame、样式表文本读取失败等均写入缺失记录。DOM 布局证据仍按 `--max-nodes` 预算采集。

`css/stylesheets.json` 分别保存 CDP header / 文本版本、CSSOM 的 document / shadow 作用域与普通 / adopted 样式表顺序，以及 `css/original/` 中未经 URL 改写的网络响应。`assets/` 中的 CSS 仅为静态预览改写资源路径；原文件不会被覆盖。CSSOM 的规则树保留 import、条件和嵌套边界，源位置不可读时明确为 null。CDP 的规则顺序只表示协议提供的匹配顺序，不声称等于完整级联胜出顺序。

每个状态的匹配记录包含稳定元素 ID、规则 ID、原始协议声明、继承、伪元素、计算样式及变量。未激活的 hover / focus / active 规则保留在样式表文本与 CSSOM 中；不会伪造“已经执行过”的状态。原生焦点轮廓不参与探索状态去重，完整计算样式仍作为 CSS 证据保存。
