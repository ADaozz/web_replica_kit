# Web Replica Kit — 任务约束

## 项目职责
Web Replica Kit 是网页结构、原始样式规则、资源和交互行为的采集器。Coding Agent 使用证据实现前端；本项目不生成完整交互应用。`index.html` 仅用于静态结构和样式预览。

1. 优先保留原 DOM、CSS 样式表边界、级联顺序、选择器、来源和资源。不能通过内联计算样式或拼接所有样式表代替原规则。
2. 控件发现使用 Playwright 语义定位与可操作性检查，覆盖普通控件、开放 Shadow DOM 与可访问 iframe。图标只提供宿主关联，不能推断行为。定位必须唯一；未知或失效定位明确报告。
3. 在原站实际执行安全动作，记录前后 DOM、属性、表单、布局、路由和匹配 CSS。每个新状态重新发现控件，使用已观测逆操作恢复，并限制状态、深度和动作预算。恢复失败立即停止。
4. 禁止自动提交、发送、删除、支付、购买、退出、授权、安装、上传或账户写操作。探索前阻断 HTTP 写入与 WebSocket 写入，未知 Worker 传输不能声称安全。不要把 POST 的路径名称当作只读证明。
5. CSS 采集通过 CDP 获取样式表文本、匹配规则、计算样式、继承、变量、伪类和条件规则。CDP 不完整时保留缺失原因，并以资源响应、CSSOM 作为明确标注的补充，不能编造来源或规则顺序。
6. 使用稳定元素 ID 与规则 ID 关联状态差异。区分元素实例延续与语义对应；无法证明的跨状态映射或因果关系标记 `unresolved`。
7. 不开发通用交互 Runtime、整页 HTML 切换或猜测性行为注入。只允许静态预览的滚动恢复、编码和空自定义元素定义初始化。
8. 删除失去用途的模块、参数、测试和导出，不保留旧模式或空兼容层。资源 URL 改写集中在 `snapshot-resources.mjs`。
9. 输出结构见 `docs/INTERACTIVE_REPLICA_SPEC.md`。采集指标只报告 discovered / eligible / actionable / observed；外部前端验收单独报告，不能声称采集等于复刻完成。
10. 验证原站与 Coding Agent 实现时，允许 DOM 不同，但不同控件必须有显式映射；比较必要状态、行为、布局、定位、样式与真实路由，不得清零坐标或改写结果冒充通过。
11. 不提交 cookies、认证头、私人 profile 或实际采集内容。未知行为、资源缺失和能力边界必须可追踪。

## 回归
每个架构阶段提交对应测试。最终运行 `npm test`、`npm run test:e2e`、`npm run test:scroll`、`npm run test:interactions` 和 `npm run test:css`。原有字体、图片、SVG、CSS mask、Shadow DOM 和滚动预览不得回退。
