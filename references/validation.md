# 静态采集验证报告

日期：2026-10-17。Linux x64，Node 24.19.0，Playwright 1.64.1 / Chromium 156。旧版基线为 `b5c5ef6`，重构位于 `refactor/agent-skill-static-capture`。所有采集使用公开目标、1440×900 视口，无私人 profile。

## 自动化回归

以下最终检查全部通过，共 48 项：

- `npm test`：39 项，URL、图标、资源、JSON Writer、DOM、CLI 与目录互斥。
- `npm run test:e2e`：4 项，导航浏览器提取、独立两命令流程、退出码、离线逐像素对照及旧式文档模式。
- `npm run test:css`：3 项，动态规则、条件、作用域、变量字体简写和 inline style。
- `npm run test:scroll`：2 项，file/HTTP 预览、嵌套和 Shadow DOM 滚动、非敏感表单显示。

安全回归确认：JS Bundle 哨兵不进入产物；注释、事件属性、Hydration、CSRF meta 和敏感输入被过滤；资源补采不继承页面 Cookie；SVG 脚本、事件和注释被移除；原站脚本不会在预览中执行。合法图像/字体 Data URL 保留，混合 Data URL srcset 的其他候选正常改写。

## 六站点验证

每个固定目标先 discover，读取候选，再 capture 预先选定的同一 URL；不访问发现的子页面。预览使用 file:// 并阻断外部 HTTP 请求，截图采用 pixelmatch threshold=0.1。差异率衡量像素，不能证明全页、响应式或交互质量。

| 固定目标 | 导航目标数 | 捕获元素/总元素 | 状态 | 采集总耗时 | 视口像素差异 |
| --- | ---: | ---: | --- | ---: | ---: |
| [tabler-dashboard](https://preview.tabler.io/) | 141 | 3931/3931 | partial | 15.07s | 0.0000% |
| [bootstrap-sidebars](https://getbootstrap.com/docs/5.3/examples/sidebars/) | 2 | 322/322 | ok | 3.03s | 0.0000% |
| [shoelace-dropdown](https://shoelace.style/components/dropdown) | 125 | 5000/5237 | partial | 10.37s | 0.0520% |
| [ant-design-switch](https://ant.design/components/switch/) | 156 | 1814/1814 | partial | 14.72s | 0.0000% |
| [css-zen-garden](https://www.csszengarden.com/) | 33 | 145/145 | partial | 3.28s | 0.0000% |
| [space-jam-1996](https://www.spacejam.com/1996/) | 15 | 115/115 | ok | 2.79s | 0.0000% |

partial 的具体原因：

- Tabler：1,284 个未显示的 CSS 资源变体引用仍指向远程地址，主要为旗帜图像。当前视口截图一致，但不能称全部 CSS 依赖离线完整。
- Shoelace：默认 5,000 节点预算截断，共 5,237 元素。预览仍序列化完整渲染 DOM，结构化证据只保留预算内元素。0.0520% 的残余像素差异尚未确证原因，不判作完全视觉通过。可增加 `--max-nodes` 再采集以取得完整结构。
- Ant Design：一个未本地化的 CSS 资源引用，截图一致。
- CSS Zen Garden：原站 HTTP Google Fonts CSS 被浏览器以 mixed-content 阻断；截图一致仅表示与浏览器实际渲染的回退字体一致，不能声称该字体已采集。

已修复且纳入测试的实际问题：旧式 background 属性资源改写、Quirks Mode 被强制 Doctype 改变、CSSOM 序列化变量 font 简写丢失、图片链接和 Open Shadow DOM 导航命名、原站 Cookie 进入补采请求错误日志。

本机完整证据：`test-results/static-sites-validated/summary.json`，各目标目录中的 screenshot.png、preview.png、report.json 和 HTML。真实网页内容不会提交到 Git。可用 `npm run test:sites -- --out FRESH_DIRECTORY` 重跑。

## 同机性能对照

固定静态夹具：`tests/fixtures/css-repros/ISSUE-001/page-800.html`。两个版本同视口，`--max-nodes 5000`，均捕获 826 个元素且未截断。旧版保留默认完整 CSS 匹配链；新版未减少必要 DOM 或 CSS。

| 指标 | 旧版 | 新版 | 降幅 |
| --- | ---: | ---: | ---: |
| CLI Wall Time | 32.69 s | 5.02 s | 84.6% |
| 采样进程树 CPU 时间 | 26.47 s | 2.76 s | 89.6% |
| Node 峰值 RSS 样本 | 470.87 MiB | 254.48 MiB | 46.0% |
| Chromium 峰值 RSS 合计样本 | 756.10 MiB | 435.05 MiB | 42.5% |
| 最终输出字节 | 26.62 MiB | 1.30 MiB | 95.1% |

CPU 与 RSS 每 200ms 采样，可能漏掉短命进程和最后一段 CPU 时间；Chromium RSS 合计包含共享页，不是唯一物理内存。输出包含截图，新旧版截图范围不同，但主要体积差异来自移除逐节点规则链和重复状态证据。该结果是单次对照，不是统计性能保证。完整指标见本机 `test-results/benchmark-release/summary.json`。

## S06 Ant Design 对照

固定目标为 `https://ant.design/components/switch/`，同机同视口、同一 DOM 预算。最终版本 CLI Wall Time **16.44s**，DOM 未截断；CSS 读取 0.69s，DOM/布局 4.62s，资源/静态快照 2.94s。Node CPU（本进程）user=2.88s，system=0.46s。

旧版达到 180 秒预算后被终止，未形成完整有效基线。因此这是删失观测，不能计算成功基线的精确加速比或最终体积降幅。Node 峰值 RSS 样本：新版 339.7 MiB，旧版终止前 593.6 MiB；Chromium RSS 合计峰值样本：新版 776.0 MiB，旧版终止前 1079.4 MiB。旧版自动滚动可能改变懒加载和 Sticky 状态，不能把这个对照当作严格的视觉等价证明；必要 DOM 数量和最终静态质量另由六站点回归记录。

完整观测位于本机 `test-results/benchmark-ant-validated/summary.json`；CPU 与内存均为采样值。当前 Ant Design 仍有一项未本地化 CSS 引用，状态为 partial，未隐藏该限制。

## 独立 Agent 使用验证

独立 Codex 会话从空上下文开始，只读取 SKILL.md、引用文档和产物：

1. 在 Bootstrap Sidebars 上执行 discover，展示真实候选，并停等页面选择。
2. 收到明确选页后只执行一次 capture，报告 partial 原因。
3. 在独立临时目录建立 React/Vite 项目，复用采集的侧栏结构、原始 CSS、头像及 SVG，不运行网页原始 JS。
4. `npm run build` 成功；浏览器中位置尺寸匹配，3 张头像、27 个 SVG 引用正常，无外部请求、失败请求或页面错误。
5. 1440×900 截图比较，1,296,000 像素中差异为 0。

该会话反馈的可见性筛选、去重入口名称、混合文本读取、缺失资源汇总和错误日志冗长问题已经修正文档或实现。会话较早的 favicon 补采错误已在最终六站点验证中消除。会话记录仅保留在本机 `/tmp/wrk-agent-frontend/evidence/`，真实采集内容不提交。

尚未完成：第二种 Coding Agent（例如 Claude Code）的全新会话端到端测试，当前环境未安装该工具，也没有其认证配置；独立 Vue 项目实现尚未单独验证。因此不把跨工具验收标记为完成。

## 剩余能力边界

CSSOM-only 的构造样式表或发生复杂修改的规则仍受浏览器序列化能力限制，原始网络 CSS 与 authored inline CSS 会单独保留；不保证每个节点的完整级联来源。Closed Shadow DOM、iframe 内容、Canvas 重绘、未渲染懒内容与组件交互均不属于当前静态采集能力。部分站点的预算截断、未本地化变体和残余视觉差异已如实记录。
