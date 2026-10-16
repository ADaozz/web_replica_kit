# Web Replica Kit

采集网页的原始 DOM、CSS 规则、资源及真实交互状态，供 Coding Agent 实现前端。`index.html` 是静态结构和样式预览，不是交互应用。

## 安装和采集

```bash
npm install
npx playwright install chromium
node capture.mjs --url https://example.com --out output --headless
node capture.mjs --url https://example.com --out evidence-output --explore-interactions --headless \
  --explore-max-states 24 --explore-max-depth 4 --explore-max-actions 80
node serve.mjs output 4173
```

保留 `--manual`、`--profile ./private-session`、`--ready-selector`、`--ready-text`、`--wait`、`--width`、`--height`、`--max-nodes` 和 `--max-css-nodes`。同站导航须显式使用 `--allow-same-origin-navigation`。登录会话目录不要提交或分享。每次采集使用新的空 `--out` 目录。

探索使用原站处理器和 Playwright 动作，递归发现新控件并校验恢复结果。HTTP 写入和 WebSocket 写入在探索前阻断；已有 Worker 传输无法证明安全时停止。未知行为不会被猜测实现。

原始样式表保持边界和顺序。CDP、CSSOM 和资源响应分别标注来源；跨域、frame、Shadow DOM 或浏览器协议限制保存在缺失记录中。状态、DOM 元素和 CSS 规则通过标识关联；不能证明的关系为 `unresolved`。

Coding Agent 的读取顺序、字段说明和验证示例见 [使用指南](docs/CODING_AGENT_GUIDE.md)。输出约定见 [采集规范](docs/INTERACTIVE_REPLICA_SPEC.md)。Coding Agent 应使用 DOM/CSS/状态证据实现组件状态管理，直接复用原 CSS；截图只用于辅助校验。

## 回归与前端验收

```bash
npm test
npm run test:e2e
npm run test:scroll
npm run test:interactions
npm run test:css
```

`scripts/verify-interactions.mjs` 用于比较原站与开发完成的前端。它不验证静态预览具有业务交互。不同 DOM 的控件须显式映射；真实 URL、属性、布局和样式结果不得被替换以通过验收。

验证命令：`node scripts/verify-interactions.mjs SOURCE_URL TARGET_URL scenario.json verification`。映射格式见 [示例](docs/examples/frontend-scenario.json)。

源证据格式为 Schema 2：CSS 观测按状态分文件，变量采用规则引用和共享计算值集合；JSON 使用有界紧凑写出。读取时沿 manifest 中的 file 引用访问，不假定 CSS snapshots 内嵌全部元素。
