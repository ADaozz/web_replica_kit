# 网页复刻采集工具 (Web Replica Kit)

通过 Playwright 导出**已渲染网页**的静态 HTML、加载过的 CSS、图片/字体/脚本资源、DOM 层级与元素布局数据。仅采集你有权访问和复刻的页面。

## 1. 环境与安装

Node.js 20+：

```bash
npm install
npx playwright install chromium
```

## 2. 采集

```bash
node capture.mjs --url https://example.com --out ./output --width 1440 --height 900
```

可选参数：
- `--record-icon-interactions`：自动检查图标宿主，在原网页测试悬停、已声明的展开收起／菜单／标签操作，记录实际视觉状态
- `--manual-icon-interactions`：可选的人工补录模式，操作后按 Enter 保存
- `--manual`：有界面、等待人工按 Enter 确认采集
- `--profile ./private-browser-session`：使用隔离的持久登录会话（不要共享）
- `--ready-selector '[contenteditable="true"]'`：等待最终页面的可见组件
- `--ready-text 文字`：等待最终页面中的文本出现
- `--ready-timeout 120000`：选择器/文字等待上限（毫秒）
- `--wait 2500`：打开页面后额外等待的毫秒数（默认 1500）
- `--max-nodes 8000`：导出最多的 DOM 元素数（默认 5000）
- `--headed`：显示浏览器，便于检查页面内容
- `--executable /path/to/chromium`：使用已经安装的 Chrome/Chromium

## 3. 处理 ChatGPT 等动态网页一直显示「加载中」

**推荐：人工确认页面完全加载，再采集。** 脚本不会绕过登录或反自动化验证。

```bash
node capture.mjs --url https://chatgpt.com --out ./chatgpt-output \
  --manual --profile ./private-browser-session --width 1440 --height 900
```

1. 命令会打开**可见的 Chromium 浏览器**。
2. 在该浏览器窗口中正常登录目标网站，等待聊天框、侧栏等实际内容可见；如果站点拒绝自动化浏览器访问，请停止并使用网站允许的方式。
3. 回到终端按一次 Enter，才会开始采集。切勿在加载动画还在的时候按 Enter。
4. 检查 `chatgpt-output/screenshot.png`：如果截图仍是加载屏幕，说明在采集阶段页面就没有加载完成。若截图正确但本地 `index.html` 不正确，说明静态还原仍有局限。

`--profile` 使用独立持久浏览器目录，保存登录状态，下一次可以继续使用。**这个目录包含敏感登录会话；不要打包上传、提交 Git 或分享。** 不要指向正在使用的 Chrome 个人资料目录。

自动化场景也可以等待一个最终组件的选择器出现：

```bash
node capture.mjs --url https://example.com --out ./output \
  --ready-selector '[contenteditable="true"]' --ready-timeout 120000
```

只有在确实存在这个选择器时才能用它判断完成加载；加载中的占位元素不适合当成完成信号。
还可以使用 `--ready-text '页面中最终显示的某段文字'`。

原来的 `--wait 1500` 只是固定延迟，它不能确定 React/Next.js 页面何时渲染完成。`--headed` 只显示浏览器，不会等待人工确认；`--manual` 则会等待终端 Enter。

## 4. 本地预览

```bash
node serve.mjs ./output 4173
```

浏览器打开 `http://127.0.0.1:4173`。

## 输出

```text
output/
├── index.html          # 本地复刻预览：移除原站脚本，改写资源链接；录制模式附带原站状态回放
├── original.html       # 页面最终 DOM 的原始序列化（供开发者查阅）
├── styles.css          # CSS 汇总供审查，可能包含重复 @import，不作为预览入口
├── assets/             # 采集到的真实 CSS、图片、字体、JS 和部分媒体资源
├── assets.json         # URL → 本地文件映射 + MIME 类型 + 大小
├── icons.json          # 必需图标、字体依赖、补采集结果及缺失原因
├── icon-interactions.json # 所有已识别图标候选及其交互宿主，不限定页面类型
├── interactions.json   # 控件清单、实际操作记录、状态转换及待检查项
├── interactions.js     # 仅回放原网页实际记录的状态，未录制时不生成推测逻辑
├── state-000.html      # 录制模式：原站各状态的本地化 HTML，按序编号
├── interaction-states/ # 录制模式：各状态截图
├── layout.json         # 平铺节点列表：选择器、bbox、计算样式、文字、父级 ID
├── dom-tree.json       # DOM 树
├── components.json     # 基于标签/Class 的组件候选节点（非真实 React 树）
├── design-tokens.json  # 常用颜色、字体、字号、圆角、间距
├── screenshot.png      # 页面全长截图
└── report.json         # 采集统计及局限
```

## 工作原理

1. Chromium 执行真实网页的 JavaScript，等待页面渲染。
2. 通过滚动触发一部分懒加载图片与资源。
3. Playwright `requestfinished` 事件收集浏览器加载过的 CSS、JS、字体和图片响应正文。
4. `getComputedStyle` + `getBoundingClientRect` 抽取元素位置和视觉样式。
5. 将 HTML 中匹配的 `src/href/srcset` 和 CSS `url()/@import` 改写为本地路径。
6. 移除原站脚本，生成 `index.html`；启用录制时回放原网页实际捕获的状态。

### 所有图标检查与原站交互采集

默认检查 SVG、图标字体、伪元素、CSS 遮罩／背景、图标图片和开放 Shadow DOM，并关联实际 DOM 中的按钮、链接等宿主，写入 `icon-interactions.json`。检查不依赖侧栏或特定网站。图标可见、宿主可点击和交互已复刻是三个不同结果。

默认静态采集保留原生 `<details>/<summary>` 和 CSS `:hover/:focus`；不再根据图标名或 ARIA 属性编造展开样式。要自动获取原网页的实际交互状态，运行：

```bash
node capture.mjs --url https://example.com --out ./output --record-icon-interactions
# 需要登录时，先人工登录并确认页面就绪，之后自动测试控件
node capture.mjs --url https://example.com --out ./output \
  --manual --profile ./private-browser-session --record-icon-interactions
```

自动模式遍历可见图标的实际宿主，逐步悬停、移出，并点击原网页声明了展开、弹出、按下或标签状态的界面控件；关闭同样通过原页面事件完成。每一步等待状态稳定后保存真实 DOM、截图、资源依赖和事件转换，不直接改写原页面布局。新出现的可见图标会继续检查，默认最多访问 80 个宿主、保存 80 个状态及 24 MB 状态 HTML。状态和数量上限、操作失败和跳过原因在报告中保留。导航、表单提交和已识别的业务操作不主动点击；缺少状态声明的自定义控件会测试悬停并列为需要补充依据。

`--manual` 只要求你在必要时登录并确认加载完成，后续控件由自动模式操作。只有选择 `--manual-icon-interactions` 才需要手动操作控件：每一步停留至少一秒，包括关闭和反向操作，结束后回终端按 Enter。人工补录用于自动模式暂时无法判断的控件。

`interactions.json` 记录操作及状态图；有冲突的转换不会擅自选择结果。`index.html` 内嵌状态回放及脚本哈希，可以本地打开；`interactions.js` 供审查和后续 Vue／React 重构参考。回放使用采集到的整页 DOM 替换，因此会重置未采集的输入值、焦点和临时原生状态；它提供视觉状态参考，不能恢复原站组件函数、接口或任意业务交互。未测试的组合、持续变化的内容、延迟弹层和快速连续操作仍可能缺少转换。自动录制完成也会标记为待浏览器回放验收，不宣称所有交互已经复刻。

已有输出可执行通用静态检查：

```bash
python3 scripts/audit-interactions.py ./output
```

生成 `icon-interactions.static.json` 和 `interaction-audit.json`，不覆盖原网页浏览器检查结果。静态检查无法执行事件或确认伪元素、动态弹层的最终效果。若需要撤销旧版推测性交互，可运行 `node scripts/reset-preview-interactions.mjs ./output`，工具会备份入口；恢复实际交互仍需重新访问原页面采集。

### 图标保存与验证

SVG sprite 的 `sprite.svg#图标ID`、`xlink:href` 以及 CSS 背景和遮罩中的资源引用会改写到本地，并保留图标 ID；同页的 `#图标ID` 引用保持原样。资源发生 HTTP 重定向时，也会为原地址建立本地映射。CSS 改写后会移除对应标签上已失效的 `integrity` 校验值。

默认执行“图标必须采集、普通图片可缺失”的策略。导出前检查 DOM 和开放 Shadow DOM 中的 SVG 引用、SVG 图片、带图标语义或尺寸较小的位图、CSS 背景／遮罩／伪元素，以及对应的图标字体；已识别为头像的普通图片不作为图标必需项。缺少的图标资源会使用当前会话补请求，每个资源最多尝试两次，补采集阶段约 60 秒预算，仍受文件和总量上限限制。blob 图标会尝试在原页面中读取并保存。

`icons.json` 的 `complete` 表示已发现的图标依赖是否完整；`report.json` 同时提供 `iconsComplete` 和 `missingIcons`。无法保存资源、找不到引用的 SVG ID、无法导出的已知图标字体或达到检查上限时，保留输出并以退出码 **2** 标记图标不完整，不会默默算作成功。普通图片继续尽力保存，缺失允许留空，不单独判为采集失败。

开放 Shadow DOM 会使用声明式 `<template shadowrootmode="open">` 写入静态 HTML，并复制可读取的动态样式与 adopted stylesheets；需要支持声明式 Shadow DOM 的浏览器预览。闭合 Shadow DOM、尚未渲染的图标、缺乏语义线索的位图无法保证自动识别，`complete` 不代表对所有潜在图标的绝对保证。Canvas 内容仍未导出。

旧版本生成的 `index.html` 不会自动更新，需要重新采集。若仍有图标缺失，先确认 `screenshot.png` 中是否存在，再检查 `icons.json` 中的缺失原因及 `assets.json` 中的资源映射。

```bash
npm test       # 资源 URL 改写回归测试
npm run test:e2e # 本地测试页采集、关闭来源服务，再验证预览请求和截图
```

端到端测试需要已安装 Playwright Chromium，且运行环境允许启动浏览器和监听本地端口。测试只使用工具自带的本地测试页，不访问目标网站，并检查断网后的图标、开放 Shadow DOM、自动原站操作及录制状态的悬停和展开收起回放。

### 复杂公开页面测试

`tests/site-matrix.json` 列出 8 个开源项目示例／文档页：Tabler 后台、Bootstrap 后台／侧栏／结算页／图标库、Font Awesome 示例、Shoelace 图标／下拉菜单。包含来源及许可链接，覆盖图标字体、SVG sprite、长页面、复杂布局、Canvas 和 Shadow DOM 边界。默认分别采集 1440px 与 390px，共 16 组；不使用登录会话，不进行提交、登录或表单操作。

```bash
npm run test:sites
# 也可以先测部分页面或指定浏览器
npm run test:sites -- --only tabler-dashboard,shoelace-icons --widths 1440,390
npm run test:sites -- --executable /path/to/chromium
# 无需浏览器，对已有输出进行静态资源审计
npm run audit -- output chatgpt-output
```

多站点结果位于 `test-results/sites-时间/summary.json`，每组保留采集结果、`preview.png` 断网预览截图和 `compare.html` 左右对照页。预览阶段阻止所有外站 HTTP(S) 请求，记录缺失的本地请求、远程依赖、损坏图片以及截图是否完全相同；截图不同标为 `needs-review`，不能直接推断都是图标问题。源站加载失败、采集失败或环境无法启动浏览器会分别报告，不计作通过。静态审计只检查文件、CSS URL 和 SVG ID 引用；包含隐藏内容，不能判断对应图标是否可见，也不代表像素验证通过。

预览会先滚动触发懒加载，将已失败的图片与仍在等待的图片分别计数；`resourceStatus` 单独记录运行时资源情况。静态审计排除未启用的 `<template>`，但 CSS 中未使用的图标或备用字体仍可能产生远程引用提示，需要结合实际预览请求判断。

多站点测试另行提供 `iconStatus` 和 `optionalImageStatus`。普通图片缺失不再单独导致必需资源不完整；图标未拿齐会标为 `icons-incomplete`。完整截图仍可能因留空图片、Canvas 或其他布局差异而需要复核。静态审计暂不进入声明式 Shadow DOM 模板，图标依赖应结合 `icons.json` 检查。

## 重要局限和下一步

- **静态视觉复刻不等于源代码恢复**：无法恢复原来的 React/Vue 组件源码、事件处理、状态管理和服务器 API。
- **响应式**：数据对应指定 viewport；分别执行 390px/768px/1440px 采集以分析断点。
- **资源缺失**：普通资源依赖本次浏览中实际加载的响应；图标另有依赖检查与补采集。普通图片、未识别的图标、跨源 iframe 等仍可能缺失，请检查 `icons.json` 和预览。
- **边界与性能**：每个文件最大 12 MB，总量最大 120 MB；最多滚动 50 次；默认最多记录 5000 个节点。
- **安全**：输出可能包含私人页面文本、保密 URL、内嵌配置、已加载的 JS；请本地保存，勿上传未经审查的结果。`index.html` 删除原站脚本和表单值，仅在录制模式启用实际状态的本地回放；`original.html` 不做脱敏，仅用于内部核查。
- **HTML 中的 `<style>`** 保留，跨域 CSS 通常通过网络响应捕获，不依赖读取可能被浏览器限制的 `sheet.cssRules`。
- **像素级复刻**：以 screenshot 为基准，对比本地预览，逐步调整布局、字体、图片、动态内容，并手工重写必要交互。

可参考 Playwright 官方文档：https://playwright.dev/docs/network 和 https://playwright.dev/docs/api/class-page

## 交互探索与浏览器验收

```bash
node capture.mjs --url http://localhost:3000/lab --out output --explore-interactions --headless \
  --explore-max-states 24 --explore-max-depth 4 --explore-max-actions 80
npm run test:interactions
```

每个新状态会重新发现控件；恢复使用已观测的可逆动作，恢复校验失败就停止，不继续在未知状态点击。`max-actions` 限制探索及关闭探测次数；返回已知状态的恢复动作另行执行。导航仍须显式设置 `--allow-same-origin-navigation`。HTTP 写请求与 WebSocket 在探索前阻断，不能靠路径名称把 POST 当作只读请求。浏览器上下文阻止 Service Worker。

默认保留弹层的父级、Portal 挂载容器、position 和 transform。只有不同布局下的实测记录证明内联坐标跟随触发器时，才启用测量得到的锚定修正；它监听滚动、窗口和内容尺寸变化。Dialog、原生 Popover 和 CSS Tooltip 继续使用浏览器原生布局。

探索输出 `actions.json`、`states/graph.json`、`overlay-diagnostics.json`、`interaction-coverage.json`、`interaction-failures.json`。`states/evidence-*` 包含动作前后的 DOM 与截图。采集完成时 `interaction-verification.json` 明确标为 `not-run`，不会把“观测到”计为“验证通过”。

浏览器验收使用顺序执行的 scenario 文件，例如：

```json
{
  "viewport": { "width": 1440, "height": 900 },
  "steps": [
    { "control": { "selector": "#menu" }, "action": { "kind": "click" } },
    { "control": { "selector": "#menu" }, "action": { "kind": "press", "key": "Escape" } }
  ],
  "coveragePath": "output/interaction-coverage.json"
}
```

```bash
node scripts/verify-interactions.mjs --browser \
  http://localhost:3000/lab http://localhost:4173/lab scenario.json output/verification
```

两个地址须具有实际相同的 pathname/search/hash；验证器不会替换 URL 或清零坐标。`serve.mjs` 根据采集元数据保留原始入口路径，并在嵌套路由下提供本地资源；其他服务器也需要做同样的映射。验证逐步比较 DOM、属性、表单、History、边界坐标（容差 8px）及 PNG 像素差异（默认上限 1%）。每步保存截图、差异图、状态和弹层诊断，区分 passed / failed / skipped。任一步失败后的依赖步骤标为 skipped，不计入 verified。输出的诊断可区分初始重建差异和交互运行时差异；原站采集证据用于进一步判断采集阶段的问题。

本地实验页覆盖 390/768/1440 宽度的右侧菜单、动态多级菜单、滚动与 transform 祖先、Portal、Tab、Switch、侧栏、Dialog、Popover、Tooltip 与 SPA History，并验证未知写操作在服务器收到前被阻断。运行 `npm run test:interactions` 会生成 `test-results/interaction-lab/` 中的可审查证据，不提交这些采集文件。

能力边界：已有 Worker 传输无法证明安全时停止探索；closed Shadow DOM 不可读取；iframe 控件可发现并在原站探索，但未嵌入独立离线运行时的 frame 明确标为不支持回放。未知业务操作、无法恢复的状态以及没有定位证据的动态策略不会被猜测补齐。整页录制快照仍可用于调试和旧模式；同时启用探索时，图标录制的可编译局部变化合入新模型，整页回放不覆盖局部运行时。
