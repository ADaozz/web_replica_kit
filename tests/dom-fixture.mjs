export function el(tag, attrs = {}, kids = [], extra = {}) {
  const node = {
    nodeType: 1,
    localName: tag,
    id: attrs.id || '',
    attrs: { ...attrs },
    childList: kids,
    children: [],
    parentElement: null,
    shadowRoot: extra.shadow || null,
    form: extra.form || null,
    checked: extra.checked,
    disabled: Boolean(extra.disabled),
    value: extra.value,
    extra,
    textLeaf: extra.text ?? null,
    get textContent() {
      if (this.textLeaf != null && this.children.length === 0) return this.textLeaf;
      const own = this.textLeaf || '';
      return own + this.children.map(child => child.textContent || '').join('');
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? String(this.attrs[name]) : null;
    },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; },
    getBoundingClientRect() { return this.extra.rect || { x: 0, y: 0, width: 80, height: 24 }; }
  };
  return node;
}

export function mount(nodes, { baseURI = 'http://fixture.test/app' } = {}) {
  const docNodes = [];
  function walk(node, parent, bucket, root) {
    node.parentElement = parent;
    node.getRootNode = () => root;
    node.children = [];
    bucket.push(node);
    for (const child of node.childList || []) {
      node.children.push(child);
      walk(child, node, bucket, root);
    }
    if (Array.isArray(node.shadowRoot)) {
      const inner = [];
      const shadow = {
        host: node,
        querySelectorAll(selector) { return filter(inner, selector); }
      };
      for (const child of node.shadowRoot) walk(child, null, inner, shadow);
      node.shadowRoot = shadow;
    }
  }
  for (const node of nodes) walk(node, null, docNodes, null);
  const document = {
    baseURI,
    URL: baseURI,
    querySelectorAll(selector) { return filter(docNodes, selector); },
    getElementById(id) { return docNodes.find(node => node.id === id) || null; }
  };
  for (const node of docNodes) node.getRootNode = () => document;
  return document;
}

function filter(nodes, selector) {
  if (selector === '*') return nodes;
  if (/^#[a-zA-Z0-9_-]+$/.test(selector)) return nodes.filter(node => node.id === selector.slice(1));
  if (selector === 'label') return nodes.filter(node => node.localName === 'label');
  if (selector === 'template') return nodes.filter(node => node.localName === 'template');
  if (selector.includes('nav')) return nodes.filter(node => node.localName === 'nav' || node.localName === 'aside' || node.getAttribute('role') === 'navigation' || node.getAttribute('role') === 'complementary');
  throw new Error(`unsupported selector ${selector}`);
}

export function installComputedStyle() {
  const previousDocument = globalThis.document;
  const previousStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = element => ({
    display: element.hasAttribute?.('hidden') ? 'none' : (element.extra?.display || 'block'),
    visibility: element.extra?.visibility || 'visible',
    cursor: element.extra?.cursor || 'auto'
  });
  return {
    use(document) { globalThis.document = document; },
    restore() {
      globalThis.document = previousDocument;
      globalThis.getComputedStyle = previousStyle;
    }
  };
}
