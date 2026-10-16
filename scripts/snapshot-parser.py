"""读取本地 HTML 控件和图标，不推断网站类型或执行业务脚本。"""
from html.parser import HTMLParser


class SnapshotParser(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.source = source
        self.stack = []
        self.nodes = []
        self.root_counts = {}

    def handle_starttag(self, tag, attrs):
        node = {"tag": tag, "attrs": dict(attrs), "icons": [], "text": "",
                "inert": any(n["tag"] == "template" and "shadowrootmode" not in n["attrs"] for n in self.stack)}
        node["parent"] = self.stack[-1] if self.stack else None
        counts = self.stack[-1].setdefault("child_counts", {}) if self.stack else self.root_counts
        counts[tag] = counts.get(tag, 0) + 1
        node["path"] = ("#" + node["attrs"]["id"]) if node["attrs"].get("id") else (
            (node["parent"]["path"] + " > " if node["parent"] else "") + tag + ":nth-of-type(" + str(counts[tag]) + ")")
        self.nodes.append(node)
        icon_name = node["attrs"].get("data-icon-name")
        if icon_name:
            for ancestor in reversed(self.stack):
                if ancestor["tag"] == "button" or ancestor["attrs"].get("role") in {"button", "combobox", "tab", "menuitem", "switch"}:
                    ancestor["icons"].append(icon_name)
                    break
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.stack.append(node)

    def handle_data(self, data):
        if any(n["tag"] in {"script", "style"} for n in self.stack):
            return
        for node in self.stack:
            if node["tag"] == "button" or node["attrs"].get("role") in {"button", "combobox", "tab", "menuitem", "switch"}:
                node["text"] = (node["text"] + data)[:120]

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index]["tag"] == tag:
                self.stack = self.stack[:index]
                break
