# PR-01 修复记录（完整站点验收尚未完成）

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

五组命令全部通过，共 72 项测试，保留原有 68 项。详情见 regression-results.json。

- `npm test`：58 通过，含 Unicode/转义、原子写出失败与大于 V8 单字符串上限的聚合序列化。
- `npm run test:e2e`：1 通过。
- `npm run test:scroll`：2 通过。
- `npm run test:interactions`：8 通过，包含新 manifest 文件引用的端到端检查。
- `npm run test:css`：3 通过，含 inline / attributes、继承变量、important、Shadow DOM 和跨状态共享集合。

## 真实站点与阶段门槛

Grok 原始报告、日志、截图和 20 站点精确矩阵尚未提供。仓库仅有旧的 8 站点矩阵；远端 PR 没有报告评论，基线没有 workflow runs，仓库没有 issue 报告。用户给出的 S02 与 S04 数字记录在 baseline.json 的 userReportedNotIndependentlyVerified 中，与本次合成复现分开。

**S01 / S05 / S06 / S09 / S11 的 CSS 崩溃修复验收尚未完成，全部 NOT_RETESTED。** 原始缺陷逐项状态见 confirmed-issues.json；PR-01 对应问题为 PARTIALLY_FIXED，没有因为本地测试通过而将真实站点缺陷标为 FIXED。

遵守用户要求“前一个 PR 未通过验收，不继续叠加下一阶段功能”，PR-02～05 暂不实施。继续推进需要原 20 站点的准确 URL、视口、采集预算、环境/浏览器版本，以及原报告与日志/截图的路径或可访问链接。敏感 HTML、Worker 支持、旧测试脚本字段和资源问题仍明确列为未解决，不能将这份报告视为全部修复完成。
