# 静态 CSS 回归夹具

保留原最小复现 HTML：ISSUE-001 覆盖大量根变量、深层容器与 50/200/800 个段落；ISSUE-008 覆盖元素 inline style。

`node scripts/benchmark-static.mjs --baseline /path/to/previous-checkout` 默认使用 page-800.html，比对同页同视口的采集时间、内存样本和输出体积。CSSOM 来源、条件规则、动态规则和 Shadow DOM 的可执行覆盖在 `tests/css-static.e2e.mjs`。
