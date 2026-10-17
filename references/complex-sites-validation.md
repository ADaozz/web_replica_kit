# 20 个复杂网页与隐藏菜单验证

日期：2026-10-17。Node 24.19.0、Playwright 1.64.1 / Chromium 156，Linux x64。测试选择公开、未登录页面，无账户资料或私人 profile。

## 结论

20 个固定目标全部尝试 discover 和 capture；两个阶段独立，发现失败不会跳过采集。15 个形成结构化产物，均为 partial；5 个访问失败，复测后仍未取得有效页面。**没有把 20 个站点称为全部通过。**

15 个有产物的页面都通过 Schema 3、元素 ID 对齐、父子关系、有限几何、无脚本资源检查；10,000 元素预算下均未截断。file:// 与本地 HTTP 预览均取得截图，未出现 undefined 空白产物。Claude 实际是登录入口，不是认证后的聊天应用。

至少 6 个目标仍有超过 1% 的视口像素差异。Canvas/WebGL 不导出像素、视频/动画画面随时间变化、资源缺失和字体绘制等问题仍然存在；这些结果不是无损离线复刻的验收通过证据。原页面截图仍作为视觉参考保留。

## 方法

- 固定 1440×900；DOMContentLoaded 后等待 3 秒；max-nodes=10000；CLI 进程预算 150 秒。没有自动滚动、点击、递归访问发现的链接，也没有传入认证资料。
- 初轮预览等待 300ms。另对全部 15 个已有产物统一等待 fonts.ready + 3000ms 复核 file/HTTP，未重写源截图、HTML 或资源，也未选择最有利的一帧。下表保留两种测量。
- 预览阻断外部 HTTP 请求，只允许当前本地预览服务。pixelmatch threshold=0.1；差异取对应 file/HTTP 两者较大值。动画与媒体未做遮罩，未剔除不利样本。
- measured 表示取得数据，partial 表示缺失或限制；都不等于视觉通过。耗时含资源补全，采用两批各 10 站的测试进程，不是严格性能基准。

## 逐站结果

| 目标 | discover | capture | 元素数 | CLI 耗时 | 初轮差异 | 统一等待后差异 | 主要结果 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| [chatgpt](https://chatgpt.com/) | ok（35 个目标） | partial | 863 | 9.0s | 0.000% | 0.000% | 17 个 SVG 片段引用未解析；当前视口一致。 |
| [cursor](https://cursor.com/) | ok（73 个目标） | partial | 2088 | 14.3s | 0.047% | 0.048% | CSP 图像失败、248 个 CSS 引用未本地化；含 iframe。 |
| [anthropic](https://www.anthropic.com/) | ok（120 个目标） | partial | 1261 | 8.9s | 0.860% | 0.860% | 存在 2 个 Canvas；12 个 CSS 引用未本地化。 |
| [claude](https://claude.ai/) | ok（51 个目标） | partial | 1126 | 13.9s | 29.664% | 21.412% | 实际是登录页，不是登录后的 Claude；媒体画面随时间变化。 |
| [openai](https://openai.com/) | ok（89 个目标） | partial | 957 | 14.5s | 2.690% | 2.690% | 媒体响应中止/单文件预算超限，230 个 CSS 引用未本地化。 |
| [perplexity](https://www.perplexity.ai/) | ok（20 个目标） | partial | 1855 | 10.9s | 0.049% | 0.049% | 124 个 CSS 引用未本地化，含 iframe；仅验证未登录入口。 |
| [v0](https://v0.app/) | ok（120 个目标） | partial | 2361 | 11.3s | 0.116% | 0.116% | 144 个 CSS 引用未本地化。 |
| [lovable](https://lovable.dev/) | ok（61 个目标） | partial | 1602 | 11.6s | 49.290% | 49.290% | Canvas 主视觉未保存在 HTML 中，渐变背景明显缺失；图像响应失败。 |
| [bolt](https://bolt.new/) | ok（19 个目标） | partial | 868 | 15.6s | 0.001% | 0.001% | 3 个 Canvas，当前视口差异很小。 |
| [replit](https://replit.com/) | failed | failed | — | — | — | — | HTTP 503；独立复测仍失败。 |
| [vercel](https://vercel.com/) | ok（91 个目标） | partial | 1012 | 15.2s | 13.137% | 13.137% | 2 个 Canvas；预览缺失悬挂容器主视觉。 |
| [linear](https://linear.app/) | ok（53 个目标） | partial | 4757 | 17.9s | 0.000% | 0.000% | 1 个 CSS 引用与补采字体未完成；当前视口一致。 |
| [notion](https://www.notion.com/) | ok（70 个目标） | partial | 891 | 15.4s | 0.444% | 0.441% | 80 个 CSS 引用未本地化，含 iframe。 |
| [figma](https://www.figma.com/) | failed | failed | — | — | — | — | page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://www.figma.com/；独立复测仍失败。 |
| [framer](https://www.framer.com/) | ok（117 个目标） | partial | 3020 | 34.5s | 22.121% | 22.121% | 媒体帧/字体绘制时机差异待定位，不能判作视觉通过。 |
| [supabase](https://supabase.com/) | ok（99 个目标） | partial | 7456 | 24.0s | 0.000% | 0.000% | 7,456 元素未截断；15 个 CSS 引用未本地化，含 iframe。 |
| [stripe](https://stripe.com/) | ok（137 个目标） | partial | 2837 | 23.3s | 27.338% | 27.338% | 2 个 Canvas；源站图像响应错误。静态审计 0 问题仍不能证明视觉通过。 |
| [github-copilot](https://github.com/features/copilot) | failed | failed | — | — | — | — | HTTP 503；独立复测仍失败。 |
| [shadcn-sidebar](https://ui.shadcn.com/docs/components/sidebar) | failed | failed | — | — | — | — | HTTP 503；独立复测仍失败。 |
| [ant-design-table](https://ant.design/components/table/) | failed | failed | — | — | — | — | HTTP 503；独立复测仍失败。 |

访问失败只能证实本环境未拿到页面；503 或代理隧道失败可能来自站点或环境链路，不能仅凭这些错误断言反爬，也不能据此归咎采集器。相关目标应在具备桌面显示的用户环境中用 --manual 再验证。

Framer 的独立诊断中存在首次截图少文字、随后截图出现文字的现象，但统一等待后的主对照仍有 22.121% 差异；尚未确证全部原因。报告未将等待字体当作解决全部差异的证据。

## 默认隐藏组件

**已经挂在 DOM 中、只是由 CSS 隐藏的菜单可以发现。悬停后才由 JS 创建的菜单，悬停前无法推断。**

受控夹具的两项浏览器测试通过：

1. display:none 菜单、opacity:0 菜单及其子节点在悬停前就存在于 components.json/导航证据中，visible=false；定点悬停后 visible=true。装饰性 SVG 的 aria-hidden=true 不被误当作视觉隐藏。
2. Open Shadow DOM 内的隐藏菜单可读取；未挂载的 JS 菜单初始不存在，测试显式悬停创建后才可读取。采集器没有自动执行悬停。

真实目标的证据：

| 目标 | 悬停前的证据 | 定点悬停验证 | 能得出的结论 |
| --- | --- | --- | --- |
| Cursor | 在线测试发现 22 个隐藏链接；未暴露明确面板 ID | 单次 Hover 后总元素数及可见链接数变化，URL 未变化 | 只证明前后读到不同 DOM/可见性；没有把全部变化归因于该菜单，也未伪造面板对应关系 |
| Anthropic | 已采集 w-dropdown-list-0，包含 8 个隐藏链接 | 在线复测 HTTP 503；静态预览 Hover 后仍隐藏 | DOM 发现成立；原站 JS 展开行为未在静态预览恢复 |
| Vercel | 已采集 nav-panel-products，包含 18 个隐藏链接 | 在线复测 HTTP 503；静态预览 Hover 后仍隐藏 | DOM 发现成立；原站 JS 展开行为未在静态预览恢复 |

静态产物检查与在线检查分别记录，没有混为原站行为测试；都没有点击或访问菜单链接。若菜单尚未挂载，可在 --manual 中由用户展开后再确认；CSS :hover 不会自动锁定，JS 控件行为不会自动实现。

## 修复与回归

- 修复 DOM/layout 和 discover 对 opacity:0 及透明祖先的可见性误判；使用 Chromium checkVisibility，在 layout 新增 inViewport。仍不承诺完整像素遮挡/裁剪判断。
- 补采请求先报告 HTTP 错误，避免把错误页误诊为单纯资源类型错误；缺失 SVG 不再输出无上下文的 undefined，也不重复拼接同一组缺失警告。
- 测试器将发现/采集独立运行，新增结构不变量、认证/验证/加载页面识别、file/HTTP 对照和明确失败分类；预算超时不会静默归类为网站问题。
- 自动化回归共 61 项通过：npm test 47 项，test:e2e 9 项，test:css 3 项，test:scroll 2 项。新增测试证明 discover 失败仍继续 capture，且不跟随链接。

## 可复现命令

```bash
npm run test:complex-sites -- --out test-results/complex-new
npm run test:hidden
node scripts/verify-hover-menus.mjs test-results/hover-new
```

离线复核已有产物：

```bash
node scripts/review-previews.mjs test-results/review-new \
  test-results/complex-20-a/summary.json test-results/complex-20-b/summary.json
node scripts/verify-hover-menus.mjs test-results/hover-offline-new --offline \
  test-results/complex-20-a/summary.json test-results/complex-20-b/summary.json
```

本次完整本机记录：

- `test-results/complex-20-a/summary.json`、`complex-20-b/summary.json`：20 个目标的初轮结果、源截图。
- `test-results/complex-20-retry/summary.json`：5 个访问失败目标的独立重试。
- `test-results/complex-20-settled/summary.json`：15 个产物的统一等待复核。
- `test-results/hover-menus-live-retry/summary.json`：在线定点 Hover。
- `test-results/hover-menus-offline/summary.json`：静态产物中的隐藏 DOM 检查。

网页内容、样式和截图只保留在工作区；Git 仅提交测试工具、目标矩阵、回归测试及本报告。
