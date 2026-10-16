#!/usr/bin/env python3
"""审计已有 HTML 中可能丢失的控件行为，不执行脚本或猜测业务逻辑。"""
import json
import sys
import re
from pathlib import Path
from runpy import run_path

SnapshotParser = run_path(str(Path(__file__).with_name('snapshot-parser.py')))["SnapshotParser"]


def audit(directory):
    directory = Path(directory).resolve()
    parser = SnapshotParser((directory / "index.html").read_text(encoding="utf-8"))
    parser.feed(parser.source)
    bound = []
    unresolved = []
    icon_rows = []
    layout_file = directory / 'layout.json'
    layout = json.loads(layout_file.read_text(encoding='utf-8')).get('nodes', []) if layout_file.exists() else []
    for node in parser.nodes:
        if node['inert']:
            continue
        attrs = node['attrs']
        formats = []
        if node['tag'] == 'svg':
            formats.append('svg')
        if 'data-icon-name' in attrs or re.search(r'icon|glyph|\bfa[sbrl]?\b|\bbi\b', attrs.get('class', ''), re.I):
            formats.append('icon-element')
        item = next((row for row in layout if node['path'] == row.get('selector') or node['path'].endswith(' > ' + row.get('selector', '\0'))), {})
        rect = item.get('rect', {})
        small = 0 < rect.get('width', 0) <= 96 and 0 < rect.get('height', 0) <= 96
        if node['tag'] == 'img' and (small or re.search(r'\.svg(?:[?#]|$)', attrs.get('src', ''), re.I)):
            formats.append('image-candidate')
        if re.search(r'(?:^|;)\s*(?:-webkit-)?mask(?:-image)?\s*:', attrs.get('style', ''), re.I):
            formats.append('css-mask')
        background = item.get('styles', {}).get('background-image', 'none')
        if small and background != 'none':
            formats.append('small-css-background')
        if not formats:
            continue
        host = node
        while host:
            ha = host['attrs']
            if host['tag'] in {'button', 'a', 'summary', 'input', 'select'} or ha.get('role') in {'button', 'link', 'combobox', 'tab', 'switch', 'menuitem'} or any(
                key in ha for key in ('aria-expanded', 'aria-haspopup', 'aria-pressed', 'onclick')):
                break
            host = host['parent']
        icon_rows.append({'selector': node['path'], 'formats': formats, 'iconName': attrs.get('data-icon-name'),
                          'host': {'selector': host['path'], 'tag': host['tag'], 'label': host['attrs'].get('aria-label') or host['attrs'].get('title') or host['text'].strip() or None,
                                   'expanded': host['attrs'].get('aria-expanded'), 'pressed': host['attrs'].get('aria-pressed')} if host else None,
                          'status': 'requires-original-interaction-recording' if host else 'no-host-identified'})
    for node in parser.nodes:
        tag, attrs = node["tag"], node["attrs"]
        if node["inert"] or "disabled" in attrs or attrs.get("aria-disabled") == "true":
            continue
        native = tag in {"input", "select", "textarea", "summary"} or (
            tag == "a" and attrs.get("href") and attrs["href"] != "#" and not attrs["href"].lower().startswith("javascript:"))
        if native:
            continue
        candidate = tag == "button" or attrs.get("role") in {"button", "combobox", "tab", "switch", "menuitem"} or any(
            key in attrs for key in ("aria-haspopup", "aria-pressed", "aria-expanded"))
        if not candidate:
            continue
        item = {"tag": tag, "id": attrs.get("id"), "label": attrs.get("aria-label") or attrs.get("title") or node["text"].strip() or None,
                "role": attrs.get("role"), "popup": attrs.get("aria-haspopup"), "expanded": attrs.get("aria-expanded"),
                "pressed": attrs.get("aria-pressed"), "iconNames": node["icons"]}
        if any(key in attrs for key in ("data-wrk-toggle", "data-wrk-hover")):
            item["status"] = "已配置本地行为，尚需浏览器验证"
            bound.append(item)
        else:
            item["reason"] = "没有本地交互绑定；可能依赖原站事件或未保存的弹出内容"
            unresolved.append(item)
    result = {"kind": "static-interaction-audit", "browserVerified": False,
              "boundControls": bound, "unresolvedControls": unresolved,
              "limitations": ["不能仅凭 HTML 恢复原站事件、未渲染菜单或接口逻辑；不根据图标名称编造弹出内容。"]}
    (directory / "interaction-audit.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    icons = {'kind': 'static-icon-interaction-audit', 'browserBehaviorVerified': False,
             'totalIcons': len(icon_rows), 'interactiveHosts': len({row['host']['selector'] for row in icon_rows if row['host']}),
             'icons': icon_rows, 'limitations': ['静态检查不能穷尽伪元素、动态样式和事件监听器；重新采集时会在原浏览器中检查这些形式。']}
    (directory / 'icon-interactions.static.json').write_text(json.dumps(icons, ensure_ascii=False, indent=2), encoding='utf-8')
    print('图标候选：', icons['totalIcons'], '；关联交互宿主：', icons['interactiveHosts'])
    return len(bound), len(unresolved)


if __name__ == "__main__":
    bound, unresolved = audit(sys.argv[1] if len(sys.argv) > 1 else "output")
    print("已配置本地行为的控件：", bound, "；仍需检查的控件：", unresolved)
