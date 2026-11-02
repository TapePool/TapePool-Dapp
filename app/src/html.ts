/** Markup helpers. Every dynamic value that reaches the page goes through `esc` (SPEC-PHASE5-APP §10). */

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for element content and for quoted attribute values. */
export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

/** A fragment that is already safe markup. Only `html` and `raw` create one. */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export type Part = Html | string | number | bigint | null | undefined | false | readonly Part[];

function render(part: Part): string {
  if (part instanceof Html) return part.value;
  if (part === null || part === undefined || part === false) return '';
  if (Array.isArray(part)) return (part as readonly Part[]).map(render).join('');
  return esc(part);
}

/**
 * Tagged template: static text is trusted markup, every `${}` is escaped unless it is an `Html`.
 * A line break and its indentation in the static text are dropped, so templates can be laid out freely;
 * keep a space before the break where one is wanted.
 */
export function html(strings: TemplateStringsArray, ...values: Part[]): Html {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += (strings[i] ?? '').replace(/\n\s*/g, '');
    if (i < values.length) out += render(values[i] as Part);
  }
  return new Html(out);
}

/** Trusted markup that was built elsewhere (a constant SVG, say). Never pass external text. */
export function raw(markup: string): Html {
  return new Html(markup);
}

export const EMPTY = new Html('');

export function join(parts: readonly Part[], sep: Part = ''): Html {
  const s = render(sep);
  return new Html(parts.map(render).join(s));
}
