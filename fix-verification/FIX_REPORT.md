# PR-01 修复与复测记录（阶段门槛未通过）

基线：`78b0521`；分支：`codex/interactive-replica-playwright-spec`。本次仅实施 PR-01，没有展开 PR-02～05。项目仍为 DOM/CSS/资源与真实交互证据采集器，没有增加离线交互 Runtime。

## 本次修改

- 变量声明与引用元数据在 rules 表中保留；元素只保存 sourceRuleIds、scopeId 与 resolvedSetId。相同计算结果跨元素和状态共享内容哈希集合，computedStyle 不再复制自定义属性值。
- inline / attributes 样式直接关联 owner element，空 inline 不生成规则，不读取伪 Stylesheet。真实 style、动态和 Constructable Stylesheet、原始文本、优先级和作用域证据保留。
- 源证据统一 Schema 2。CSS 匹配、CSSOM 与变量元素记录按观测分文件，manifest 通过 file 引用；不保留旧格式兼容分支。
- JSON 默认紧凑、按 64 KiB 批次写入，字符串按片段转义；单文件失败移除 partial 文件，不覆盖先前有效文件。

## 同环境合成复现

生成页面含 370 个控件、223 个继承自定义属性与大量 inline 样式，实际采集 373 个节点。比较旧 collector 与新 collector，分别在独立 Node 进程运行，浏览器均为 156.0.8078.4，Node 均为 v24.19.0，1440×900、CSS 节点预算 500。每种版本仅一个样本。

| 指标 | 基线 | PR-01 后 |
| --- | ---: | ---: |
| 重复复制的变量声明 | 166,358 | 0 |
| 唯一规则/变量组合 | 223 | 223 |
| Header 缺失的 Stylesheet 记录 | 373 | 0 |
| 变量集合序列化字节 | 24,289,426 | 107,537 |
| collector CSS 总序列化字节 | 31,990,514 | 6,047,361 |
| Node 峰值 RSS（KiB） | 408,352 | 307,524 |
| 采集加序列化耗时（ms，单样本） | 2,731 | 2,951 |

变量序列化体积减少 99.56%，collector CSS 序列化体积减少 81.1%，Node 峰值 RSS 减少 24.69%。字节数针对紧凑的 collector 导出数据，不是整个采集目录；不包括 HTML、资源、manifest 或缩进差异。内存采样位于指标分析之前，包含 Node 采集与序列化，**不含 Chromium 内存**。耗时仅为单样本，修复后该样本并未提速；不能据此声称 S04 达到 50% 提速目标。

复现方式（输出放在临时目录，避免覆盖报告）：

```bash
git show 78b0521:css-rule-capture.mjs > /tmp/wrk-baseline-css.mjs
node scripts/benchmark-css-evidence.mjs /tmp/wrk-baseline-css.mjs /tmp/wrk-before.json
node scripts/benchmark-css-evidence.mjs css-rule-capture.mjs /tmp/wrk-after.json
```

## 回归

五组命令全部通过，共 73 项测试，保留原有 68 项。详情见 regression-results.json。

- `npm test`：58 通过，含 Unicode/转义、原子写出失败与大于 V8 单字符串上限的聚合序列化。
- `npm run test:e2e`：1 通过。
- `npm run test:scroll`：2 通过。
- `npm run test:interactions`：8 通过，包含新 manifest 文件引用的端到端检查。
- `npm run test:css`：4 通过，含 inline / attributes、继承变量、important、Shadow DOM 和跨状态共享集合。

## 用户提供的最小复现

已收到精确 20 站点矩阵和 8 个问题的最小复现包。ISSUE-001 / ISSUE-008 的原始 HTML 已纳入 tests/fixtures/css-repros，CSS 回归新增一项测试，覆盖全部三个变量规模与 inline 页面。原始 check.mjs 读取 Schema 1，不用于判断 Schema 2 的 manifest 与共享变量集合。

| 同环境最小复现指标 | 78b0521 | 修复后 |
| --- | ---: | ---: |
| ISSUE-001 节点 | 822 | 822 |
| 唯一规则/变量组合 | 201 | 201 |
| 复制变量声明 | 361,220 | 0 |
| 紧凑变量证据字节 | 53,681,311 | 261,299 |
| ISSUE-008 真实及伪样式表记录 | 9 | 1 |
| ISSUE-008 无 Header 记录 | 8 | 0 |

以上变量体积下降 99.51%，口径为紧凑 collector 导出，不与上传日志中缩进后的文件字节直接比较。小页面只复现膨胀，不复现崩溃。样式来源和计算变量引用均由自动测试验证。

## 真实站点与阶段门槛

原矩阵保存为 MATRIX.md 和 sites.json。定向复测遵循第一轮 URL、1440×900、DOM 5000 / CSS 1000 预算、关闭探索和 900 秒上限。使用与原报告相同的 Node 20.19.2、Playwright 1.64.1、Chromium 156.0.8078.4。当前环境没有图形显示，使用 headless；8 GiB 内存上限、经环境代理访问，与原报告的 headed / 16 GB / 无代理不同。对照版本在当前同一环境运行，不能称为原环境逐项重现。

S01 / S05 顺序运行修复后与 78b0521 基线，S06 / S09 / S11 验证修复后采集。S09/S11 与 S06 有时间重叠，这些耗时不用于性能比较。完成记录见 retest-evidence.json，原始采集和日志留在被忽略的 test-results/ 下的各复测目录中，不提交真实站点 DOM/CSS/资源正文。

S01、S05 基线独立复现 Invalid string length。修复后的全部五站点结果如下，均未出现该错误或 OOM，但未完成的采集不能计为通过：

| 站点 | 修复后结果 | 秒 | CSS 匹配节点 | 报告资源失败数 |
| --- | --- | ---: | ---: | ---: |
| S01 | CSS 写出完成 | 118.0 | 1000 | 73 |
| S05 | CSS 写出完成 | 199.6 | 1000 | 8 |
| S06 | 超时，未完成写出 | 900.8 | — | — |
| S09 | CSS 写出完成 | 474.3 | 1006 | 23 |
| S11 | CSS 写出完成 | 879.5 | 1022 | 13 |

S06 达到 900 秒上限，由测试器终止，没有完成证据落盘。之后停止冗余基线队列；S06/S09/S11 的原始崩溃以用户报告为依据，未独立重跑其完整基线。S09/S11 与其他任务有时间重叠，所有耗时为单次记录，不能用于 PR-02 性能验收。当前 CPU 配额为 2 核。

资源失败数不是独立确认的源站缺失数，克隆请求归因仍待 PR-05。进程退出 2（图标/资源验收未通过）仅可计为 CSS 采集完成，不能声称整站通过。节点预算截断已在证据中保留，不声称 CSS 全覆盖。

复测工具：`node scripts/retest-css-sites.mjs BASELINE_DIR NODE_EXEC BROWSER_EXEC NEW_OUTPUT_DIR [SITE_IDS] [VERSIONS]`；默认两个版本，`VERSIONS=after` 可只验修复后版本。使用新输出目录，避免覆盖旧证据。当前环境的代理通过外部 browser wrapper 配置，不改变项目采集逻辑。

在用户的 822 节点 fixture 上补充分段诊断：结构化快照约 4.1 秒，CSS 指纹约 0.04 秒，匹配样式采集约 23 秒，序列化约 3.8 秒。该样本约 31 秒，结果见 retest-evidence.json diagnosticProfiles；不能直接据此断言 S06 超时的具体阶段。

遵守“前一个 PR 未通过验收，不继续叠加下一阶段功能”，S06 超时导致五站点门槛尚未通过，不实施 PR-02～05。动画、Hover、控件发现、Portal、远程 import 和 test-sites 旧字段仍未修复；不因这次两个 fixture 通过而变更其状态。
