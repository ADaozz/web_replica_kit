# 20 站点验收矩阵（与本次测试完全一致的条件）

- 仓库：https://github.com/ADaozz/web_replica_kit
- 分支：codex/interactive-replica-playwright-spec
- 提交：78b0521900a6185102a8eac6be579aba02c75916（测试期间固定）
- 浏览器：有界面 Chromium（Chrome for Testing 156.0.8078.4，Playwright 1.64.1），DISPLAY=:6，未使用 xvfb
- Node v20.19.2 / npm 9.2.0，Debian 13 x64，16 GB 内存，无代理
- 站点 URL 机器可读版：sites.json

## 第一轮：全部 20 站点
视口 1440x900，不开交互探索，单次超时 900s，被拦截时最多重试 1 次：

    node capture.mjs --url <URL> --out test-results/sites/<SID>/desktop --width 1440 --height 900 --headed --max-nodes 5000 --max-css-nodes 1000

## 第二轮：S01 S02 S03 S04 S05 S06 S09 S17
三个视口：desktop 1440x900、tablet 768x1024、mobile 390x844；单次超时 1500s；未开启 --allow-same-origin-navigation：

    node capture.mjs --url <URL> --out test-results/sites/<SID>/<vp>-interactions --width <W> --height <H> --headed --max-nodes 5000 --max-css-nodes 1000 --explore-interactions --explore-max-states 24 --explore-max-depth 4 --explore-max-actions 80

## 站点
| ID | URL |
|---|---|
| S01 | https://preview.tabler.io/ |
| S02 | https://getbootstrap.com/docs/5.3/examples/sidebars/ |
| S03 | https://shoelace.style/components/dropdown |
| S04 | https://ui.shadcn.com/docs/components/radix/dropdown-menu |
| S05 | https://mui.com/material-ui/react-tabs/ |
| S06 | https://ant.design/components/switch/ |
| S07 | https://www.ikea.com/us/en/cat/sofas-sectionals-fu003/ |
| S08 | https://www.apple.com/macbook-air/ |
| S09 | https://stripe.com/ |
| S10 | https://linear.app/ |
| S11 | https://github.com/explore |
| S12 | https://developer.mozilla.org/en-US/docs/Web/CSS |
| S13 | https://www.gov.uk/ |
| S14 | https://www.wikipedia.org/ |
| S15 | https://www.nasa.gov/ |
| S16 | https://www.pentagram.com/ |
| S17 | https://www.csszengarden.com/ |
| S18 | https://art.yale.edu/ |
| S19 | https://www.spacejam.com/1996/ |
| S20 | https://www.paulgraham.com/articles.html |

运行脚本见 tools.tar.gz（round1.sh、run-r1.sh、run-r2.sh、shots.mjs 等）。
