/** What the app needs from the async clipboard API. */
export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

/**
 * Put `text` on the clipboard. The async API first; where it is missing or refuses (an old browser, a wallet's in-app browser, no
 * permission), the old way through a throw-away text field. Resolves false when neither worked, so the caller can say so.
 */
export async function copyText(doc: Document, text: string, clipboard: ClipboardLike | undefined): Promise<boolean> {
  try {
    if (clipboard && typeof clipboard.writeText === 'function') {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the old way */
  }
  const field = doc.createElement('textarea');
  const before = doc.activeElement;
  try {
    field.value = text;
    field.setAttribute('readonly', '');
    field.setAttribute('aria-hidden', 'true');
    field.className = 'copy-field';
    doc.body.appendChild(field);
    field.select();
    return typeof doc.execCommand === 'function' && doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
    if (before instanceof HTMLElement) before.focus();
  }
}
