# Agent Skill 端到端验收

基线 `d4e60c5`。本轮只修正 cleanup 报告元数据，并记录 Skill 的发现、单页采集和静态复刻结果。没有新增采集功能，没有交互探索，也没有自动递归。

真实页面、Vue 工程、截图和运行日志在本地忽略目录 `test-results/agent-skill-acceptance/`。下文只保留可复现命令、计数和问题分类。

## 1. Cleanup 元数据

`page-cleanup.mjs` 原先在显式清理时写出 `automatic: !cleanNoise`。输出约定是：只有显式 `--clean-noise` 时 `automatic` 为 `true`。现改为 `automatic: Boolean(cleanNoise)`。删除哪些节点没有变化。

| 调用 | automatic | removedCount |
| --- | --- | --- |
| 默认 capture | false | 0 |
| 仅 `--remove-selector` | false | 匹配到的元素数 |
| 仅 `--clean-noise` | true | 实际清理数量 |
| 两者同时使用 | true | 实际清理数量 |

覆盖位置：

- `tests/page-cleanup.test.mjs`：默认、仅选择器、仅 `cleanNoise`、两者同时，并核对保留下来的节点。
- `tests/capture-static.e2e.mjs`：默认 capture、仅 `--remove-selector`、仅 `--clean-noise`，以及 `--clean-noise` 加 `#shadow-ad`。最后一组删除 4 个节点（用户选择器、广告、推广对话框、孤立遮罩），`automatic` 为 `true`。

真实页面的默认采集也符合该字段：Bootstrap 与 Tabler 的 `cleanup.automatic` 都是 `false`，`removedCount` 都是 0。

## 2. Skill 执行记录

执行环境是当前 Cloud Agent 会话：Node.js 22.14.0、Playwright 1.64.1、Chromium、视口 1440×900、`deviceScaleFactor` 1。Codex CLI 和 Claude Code CLI 都未安装，因此没有第二套 Agent 会话。跨 Agent 结果记为 `NOT_TESTED`，不记为产品缺陷。

本会话在执行 Skill 场景前已经阅读过仓库实现。下面记录的是按 `SKILL.md` 实际发出的命令和产物，用来检查发现、选择和采集是否可独立完成。

### 测试 A：发现后等待选择

```bash
node scripts/discover.mjs --url https://preview.tabler.io/ --out test-results/agent-skill-acceptance/discovery/tabler
```

退出码 0。`navigation.json` 为 schema 3，最终 URL 为 `https://preview.tabler.io/`。

| 项目 | 结果 |
| --- | --- |
| 候选 | 141 |
| 去重后的重复 URL | 0 |
| 至少一个来源可见 | 14 |
| 已挂载但全部不可见 | 127 |
| unsupported | 0 |
| 发现期间的 capture | 未调用 |
| 发现后访问的子页面 | 无 |

可见入口包括当前页、页内锚点、Invoice、License、Illustrations、Changelog、暗色主题和若干站外链接。隐藏入口保留了侧栏中的 Default（`index.html`）、Crypto、CRM 以及其余示例页。限制说明写明只包含已渲染 DOM 和开放 Shadow DOM 中的显式 URL，没有推断 JS-only 路由。

候选里没有标签恰好为 “Dashboard” 的链接。对应桌面 Dashboard 的已挂载入口是隐藏项 Default：`https://preview.tabler.io/index.html`。Crypto 与 CRM 是另外两个 Dashboard 变体。

### 测试 B：只采集选中的 Dashboard

```bash
node scripts/capture.mjs --url https://preview.tabler.io/index.html --width 1440 --height 900 --out test-results/agent-skill-acceptance/captures/tabler
```

| 项目 | 结果 |
| --- | --- |
| 退出码 | 2 |
| status | partial |
| 最终 URL | `https://preview.tabler.io/index.html` |
| 页面标题 | Dashboard - Tabler |
| readiness | content-observed |
| DOM | 3880 / 3880，未截断 |
| 样式表 | 26，其中 9 份原始网络 CSS |
| 资源 | 125；`missingResources` 为 0 |
| cleanup | automatic false，removedCount 0 |
| 警告 | Static resource audit found 1284 unresolved references |

退出码 2 表示证据可用且不完整。采集继续保留了报告、截图和静态预览，并记录了缺失引用。`staticAudit.issues` 列出 1000 条，种类都是 `remote-css-resource`，样本是旗帜、社交和支付精灵图的绝对 URL。`validPreview` 为 true。

这次 capture 只针对选中的 `index.html`。其余 140 个发现 URL 没有打开。

### 测试 C：明确 URL 直接采集

```bash
node scripts/capture.mjs --url https://getbootstrap.com/docs/5.3/examples/sidebars/ --width 1440 --height 900 --out test-results/agent-skill-acceptance/captures/bootstrap
```

没有先运行 discover。退出码 0，status `ok`，readiness `content-observed`，DOM 302 / 302，样式表 3，资源 7，无缺失资源。cleanup 为 automatic false、removedCount 0。

### 测试 D：本地就绪夹具

本地页面使用与 `tests/readiness.e2e.mjs` 相同的正文，只采集一次，没有点击、刷新、更换页面或代按 Enter。

| 夹具 | 退出码 | status | readiness |
| --- | --- | --- | --- |
| `<main>Loading…</main>` | 2 | partial | loading-placeholder |
| 标题 “Just a moment...” 且正文为浏览器检查 | 2 | partial | verification-gate |
| 空 body | 2 | partial | empty-rendered-body |
| `<main>Real content</main>` | 0 | ok | content-observed |
| `http://127.0.0.1:1/` | 1 | failed | 无 report.json |

四份成功写出的报告中，cleanup 都是 automatic false、removedCount 0。失败命令的 stdout 是单行 JSON：`status` 为 `failed`，错误为 `net::ERR_UNSAFE_PORT`。stderr 是诊断。没有使用 `--manual`。需要用户准备页面时，Skill 要求在用户自己的交互终端中运行 `--manual` 并等待用户按 Enter；本次没有代替用户确认。

## 3. Vue 复刻

两个独立项目都使用 Vue 3.5.22 与 Vite 6.3.6。实现阶段只读取已经生成的采集目录，比较时拦截采集站点和其它外部 HTTP。

Bootstrap 拆成 14 个单文件组件：两份图标 sprite、主题切换、隐藏标题，以及 `main` 下的 10 个栏。Tabler 拆成 11 个组件：促销条、跳转链接、垂直导航、顶栏、横向菜单、页头、主内容、页脚、报告对话框、设置面板和地图提示。`App.vue` 按采集到的 DOM 层级组合这些组件。样式来自静态预览中的 `<style>`，也就是采集保存并改写过的原始 CSS；资源通过 `public/assets` 指向采集目录。应用入口是 Vite 的 `index.html`，不是采集得到的 `index.html`。没有使用 iframe。组件没有为了缩小差异而删除。

| 项目 | 写出的源文件 | 首次构建 | 首次视口差异 |
| --- | --- | --- | --- |
| bootstrap-vue | 20 | 资源 URL 被 Vite 当成模块导入而失败；改为站点根路径 `/assets/...` 后成功 | 0 像素 |
| tabler-vue | 17 | 同一轮修正后成功 | 0 像素 |

构建修正发生在第一张成功截图之前。之后没有为像素差异再改代码。视觉修正轮次为 0。

复现：

```bash
node test-results/agent-skill-acceptance/agent-runs/build-vue-replicas.mjs
npm install --prefix test-results/agent-skill-acceptance/implementations/bootstrap-vue
npm install --prefix test-results/agent-skill-acceptance/implementations/tabler-vue
npm run build --prefix test-results/agent-skill-acceptance/implementations/bootstrap-vue
npm run build --prefix test-results/agent-skill-acceptance/implementations/tabler-vue
node test-results/agent-skill-acceptance/agent-runs/compare-replicas.mjs
```

## 4. 视觉测量

比较使用 Playwright，视口 1440×900，`deviceScaleFactor` 1。静态预览沿用 `scripts/site-verification.mjs`：file 与 HTTP 都阻断外部请求，等待字体，再等待 3000ms。pixelmatch 阈值 0.1。另测了阈值 0 的逐通道相等像素。截图位于 `test-results/agent-skill-acceptance/screenshots/`。

| 页面 | 原站截图 vs 静态预览 | 原站截图 vs Vue | 静态预览 vs Vue | 视口像素 |
| --- | --- | --- | --- | --- |
| Bootstrap Sidebars | 0 | 0 | 0 | 1,296,000 |
| Tabler Dashboard | 0 | 0 | 0 | 1,296,000 |

file 与 HTTP 预览的差异都是 0，失败请求和 pageerror 都是 0。Vue 页面的外部请求失败数也是 0。

相对 `layout.json` 的几何差（Vue 减采集值）均为 0：

| 区域 | Bootstrap | Tabler |
| --- | --- | --- |
| main | 0,0 1440×900 | 0,244 1440×3311.40625 |
| header | 页面没有 header | 0,40 1440×56 |
| aside | 页面没有 aside | 0,0 0×0 |
| footer | 页面没有 footer | 0,3579.40625 1440×84 |
| Bootstrap 的 10 个 main 子栏 | 宽 280/24/280/24/72/24/280/24/380/24，偏差 0 | — |

Tabler 的垂直 `aside` 在 1440 宽下采集盒为 0×0，Vue 保持这个盒。可见导航是顶栏和横向菜单。隐藏侧栏仍在组件里，没有被删掉。

整页补充：Bootstrap 的 Vue 与静态预览同为 1440×900，差异 0。Tabler 同为 1440×3663。两次测量分别是 1312 像素（0.0249%）和 4457 像素，差异行集中在 y=12–28 的促销条文字和 y=3615–3625 的页脚文字。这是文字栅格化波动，原始数值保留，没有为此改实现。视口内的三方比较仍然是 0。

## 5. 问题分类

| 分类 | 本次观察 | 是否继续改采集器 |
| --- | --- | --- |
| CAPTURE_MISSING | Tabler 有 1284 条未落地的 CSS `url()`，主要是旗帜、社交和支付精灵。视口三方差异为 0，这些引用没有进入本次可见画面。审计已经给出 partial。 | 否。现有报告已经暴露，两个目标的可见 UI 已完整。 |
| EVIDENCE_AMBIGUOUS | 组件类型是 DOM 语义。按层级把区域放进 Vue 组件后，几何和视口像素与采集一致。 | 否 |
| AGENT_MISREAD | 最终页面使用了采集 CSS 和资源。 | 否 |
| IMPLEMENTATION_ERROR | 第一次 Vite 构建把 `assets/...` 解析成模块导入。改为 `/assets/...`，并用 `#app { display: contents }` 避免多出一个布局盒。修正后视口差异为 0。 | 否 |
| ENVIRONMENT_ERROR | `tests/animation-static.e2e.mjs` 的逐字节截图断言失败。同一浏览器里计算样式一致，差异带在 “Shadow notice” 一行，约 0.4%。隔离重跑仍失败，且与 cleanup 字段无关。Codex / Claude Code 未安装。 | 否 |
| DYNAMIC_CONTENT | Tabler 整页文字边在两次全页截图间波动。两个目标都没有视频或 canvas 快照。 | 否 |

## 6. 原有回归

| 命令 | 结果 |
| --- | --- |
| `npm test` | 52 通过 |
| `npm run test:e2e` | 26 通过，1 失败：动画预览的逐字节 PNG 比较，见 ENVIRONMENT_ERROR |
| `npm run test:scroll` | 2 通过 |
| `npm run test:css` | 3 通过 |
| `node --test tests/page-cleanup.test.mjs` | 3 通过 |
| `node --test tests/capture-static.e2e.mjs` | 5 通过 |

## 7. 验收清单

功能：

- [x] `report.cleanup.automatic` 只在显式 `--clean-noise` 时为 true。
- [x] 与本次字段相关的单元测试和 capture 端到端测试通过。既有动画 PNG 字节断言在本环境失败，已单独记录。
- [x] 按 `SKILL.md` 完成发现、等待选择和单页采集。独立的全新 Codex 会话未运行。
- [x] Discover 之后没有自动 capture。
- [x] Capture 只打开选中的 Dashboard URL。
- [x] `ok` 为退出码 0，`partial` 为 2，`failed` 为 1。partial 的缺失引用保留在报告中。
- [x] 没有自动访问其它发现页面。
- [x] 没有执行未授权点击、悬停或 `--manual` 确认。

实战：

- [x] Bootstrap Vue 构建成功。
- [x] Tabler Vue 构建成功。
- [x] 两个目标都有原站、静态预览和 Vue 视口截图。
- [x] 首次视口差异为 0。没有后续视觉修正轮。
- [x] 采集缺口、构建期实现错误和环境差异已分开。
- [x] Tabler 未落地的 CSS 精灵已列入报告；本次视口没有因此缺图。
- [x] 复刻流程没有手工改 Vue 源码；构建失败后的路径修正由生成脚本完成。

## 8. 结论

1. Skill 可用性成立。`SKILL.md` 规定的两个原子命令足以完成发现、展示可见与隐藏入口、等待选择、只采集选中页，以及对 `ok` / `partial` / `failed` 的区分。明确 URL 可以跳过发现。本次没有第二 Agent 的冷启动会话。
2. 证据有效性成立。只使用采集产物时，两个 Vue 页面的 1440×900 视口与原站截图、静态预览逐像素相同，主要区域几何偏差为 0。静态预览与 Vue 同时成立，说明这组可见 UI 的差异不是 Agent 漏读证据。
3. 没有需要继续开发的高优先级采集缺陷。Tabler 的 partial 来自已经报告的 CSS 精灵引用，不影响这两个视口。本轮到此停止，后续把项目作为稳定 Skill 使用。
