// Structured logging with secret redaction (SPEC-PHASE3-KEEPER §7).

let secrets: string[] = [];

/** Register values that must never appear in a log line or an alert. */
export function registerSecrets(values: string[]): void {
  secrets = values.filter((v) => v.length >= 8);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("***");
  return out;
}

function stringify(fields: Record<string, unknown>): string {
  return JSON.stringify(fields, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  const line = redact(stringify({ t: new Date().toISOString(), level, msg, ...fields }));
  if (level === "error") console.error(line);
  else console.log(line);
}
