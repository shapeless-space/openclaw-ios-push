// Minimal DOM stand-in for driving the browser module in Node: only what the page uses.
export class FakeElement {
  tagName: string;
  children: FakeElement[] = [];
  parent: FakeElement | undefined;
  textContent = "";
  type = "";
  checked = false;
  disabled = false;
  className = "";
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  private listeners = new Map<string, ((event: { target: FakeElement }) => void)[]>();

  constructor(tagName: string) { this.tagName = tagName.toLowerCase(); }

  append(...nodes: FakeElement[]) {
    for (const node of nodes) { node.parent?.removeChild(node); node.parent = this; this.children.push(node); }
  }
  replaceChildren(...nodes: FakeElement[]) {
    for (const child of this.children) child.parent = undefined;
    this.children = [];
    this.append(...nodes);
  }
  removeChild(node: FakeElement) {
    this.children = this.children.filter((c) => c !== node);
    node.parent = undefined;
  }
  remove() { this.parent?.removeChild(this); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(type: string, listener: (event: { target: FakeElement }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string) { for (const listener of this.listeners.get(type) ?? []) listener({ target: this }); }
  /** Every matching element, depth-first. */
  findAll(predicate: (element: FakeElement) => boolean): FakeElement[] {
    return [...(predicate(this) ? [this] : []), ...this.children.flatMap((c) => c.findAll(predicate))];
  }
  /** Depth-first search over this element and its descendants. */
  find(predicate: (element: FakeElement) => boolean): FakeElement | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) { const hit = child.find(predicate); if (hit) return hit; }
    return undefined;
  }
}

export class FakeDocument {
  createElement(tagName: string) { return new FakeElement(tagName); }
}
