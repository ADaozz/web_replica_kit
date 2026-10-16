# 用户提供的最小复现

以下原始 HTML 来自用户上传的 `mini-repro.tar.gz`，未改写页面行为：

- ISSUE-001：200 个根变量、20 层容器和 50 / 200 / 800 个段落。验证继承变量仅在规则表声明一次、计算结果集合共享，并保留元素到来源规则的引用。小页面只复现膨胀，不代表已复现真实站点 OOM。
- ISSUE-008：一个真实 style、无 style 属性的元素、空 style 和非空 inline style。验证不会为元素内联样式制造 Stylesheet。

运行 `npm run test:css`。测试读取当前 Schema 2；上传包中 `check.mjs` 使用旧版内联证据格式，不能直接用来判断新格式的正确性。本项目不为旧检查脚本保留数据兼容层。

独立进程记录体积及 Node 内存：

```bash
node scripts/benchmark-css-evidence.mjs css-rule-capture.mjs /tmp/vars-after.json tests/fixtures/css-repros/ISSUE-001/page-800.html
```

指标为紧凑 collector 导出体积，与上传日志中缩进后的完整文件字节数口径不同。浏览器内存不包含在 Node 峰值内存指标中。其余交互、Portal、资源与站点测试脚本复现属于后续阶段，不因为本测试通过而声称修复。
