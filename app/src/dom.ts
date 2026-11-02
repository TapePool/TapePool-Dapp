import type { Html } from './html';

/**
 * A small DOM morph: it patches the live tree to match new markup, so focus and the caret survive while someone types.
 *
 * The markup never carries a `style` attribute (the CSP forbids inline styles). Widths and positions travel as
 * `data-pct` and are written through the CSSOM after each morph, which the CSP allows. The morph leaves
 * the `style` attribute alone, so the values set by `applyDynamic` are not stripped and set again on every render.
 */

export function morph(a: Node, b: Node): void {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) {
    (a as ChildNode).replaceWith(b.cloneNode(true));
    return;
  }
  if (a.nodeType === 3) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  if (a.nodeType !== 1) return;
  const ea = a as Element;
  const eb = b as Element;
  if (ea.hasAttribute('data-ascii-live') && !eb.hasAttribute('data-ascii')) {
    // the page no longer asks for the effect here: this is another element that happens to sit in the same place
    ea.replaceWith(eb.cloneNode(true));
    return;
  }
  for (const at of Array.from(ea.attributes)) {
    if (at.name === 'style' || at.name === 'data-ascii-live') continue;
    if (!eb.hasAttribute(at.name) && !(ea.tagName === 'DETAILS' && at.name === 'open')) ea.removeAttribute(at.name); // a <details> keeps the state the reader gave it
  }
  for (const at of Array.from(eb.attributes)) if (ea.getAttribute(at.name) !== at.value) ea.setAttribute(at.name, at.value);
  if (ea.tagName === 'INPUT') {
    const input = ea as HTMLInputElement;
    if (input.type === 'checkbox' || input.type === 'radio') input.checked = eb.hasAttribute('checked');
    else if (ea.ownerDocument.activeElement !== ea) {
      const next = eb.getAttribute('value') ?? '';
      if (input.value !== next) input.value = next;
    }
  }
  if (import.meta.env.DEV && ea.hasAttribute('data-trace-owned') && eb.hasAttribute('data-trace-owned')) return;
  if (ea.hasAttribute('data-ascii-live')) return; // a text effect owns the children (src/ascii.ts); it takes the new text from `data-ascii-text`
  morphKids(ea, eb);
}

export function morphKids(a: Node, b: Node): void {
  const ak = Array.from(a.childNodes);
  const bk = Array.from(b.childNodes);
  for (let i = 0; i < bk.length; i++) {
    const next = bk[i] as Node;
    const cur = ak[i];
    if (cur) morph(cur, next);
    else a.appendChild(next.cloneNode(true));
  }
  for (let j = bk.length; j < ak.length; j++) (ak[j] as ChildNode).remove();
}

/** Replace the content of `el` with `markup`, patching what changed. */
export function put(el: Element, markup: Html): void {
  if (!el.firstChild) {
    el.innerHTML = markup.value;
    return;
  }
  const tpl = el.ownerDocument.createElement('template'); // inert: nothing loads until it is in the page
  tpl.innerHTML = markup.value;
  morphKids(el, tpl.content);
}

/** Write `data-pct` into the `--pct` custom property, and clear it where the markup no longer asks for it. */
export function applyDynamic(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-pct]').forEach((el) => {
    const v = el.getAttribute('data-pct') ?? '0';
    if (el.style.getPropertyValue('--pct') !== `${v}%`) el.style.setProperty('--pct', `${v}%`);
  });
  root.querySelectorAll<HTMLElement>('[style]').forEach((el) => {
    if (el.hasAttribute('data-pct')) return;
    el.style.removeProperty('--pct');
    if (!el.getAttribute('style')) el.removeAttribute('style');
  });
}
