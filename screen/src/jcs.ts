// RFC 8785 (JCS) canonical JSON for artifacts (SPEC-PHASE3-SCREEN §5). Artifacts hold no JSON numbers:
// every integer is a decimal string, so only strings, booleans, null, arrays and objects are allowed.

export type Json = string | boolean | null | Json[] | { [key: string]: Json };

/** Canonical text of `v`: keys sorted by UTF-16 code units, no whitespace, JSON.stringify string escaping. */
export function canonicalize(v: Json): string {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v).sort(); // default sort compares UTF-16 code units, as JCS requires
    return `{${keys
      .map((k) => {
        const x = v[k];
        if (x === undefined) throw new TypeError(`artifact field ${k} is undefined`);
        return `${JSON.stringify(k)}:${canonicalize(x)}`;
      })
      .join(",")}}`;
  }
  throw new TypeError(`artifacts hold no ${typeof v} values; write integers as decimal strings`);
}

/** Parse artifact text and check it is already canonical. */
export function parseCanonical(text: string): Json {
  const v = JSON.parse(text) as Json;
  if (canonicalize(v) !== text) throw new Error("artifact is not in canonical form");
  return v;
}
