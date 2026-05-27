// 軽量 DOM ヘルパー (= Spira と同じパターン)

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    if (k === 'style' && typeof v === 'string') node.setAttribute('style', v);
    else if (k === 'class') node.setAttribute('class', String(v));
    else if (k === 'html') (node as HTMLElement).innerHTML = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      (node as unknown as Record<string, unknown>)[k.toLowerCase()] = v;
    } else if (typeof v === 'boolean') {
      if (v) node.setAttribute(k, '');
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (typeof c === 'string') node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}
