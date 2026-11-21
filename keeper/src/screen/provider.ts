// Which provider serves a URL (SPEC-PHASE5-REGISTER §6.1, owner's Q2, 2026-11-21): the last two labels of its host, so two
// keys or endpoints of one provider (`a.bsc.quiknode.pro`, `b.bsc.quiknode.pro`) count as one provider, and a run whose check
// and reproduction would be served by one provider never yields a PASS. Never the full URL: keys live in paths and hosts.

/** `quiknode.pro`, `binance.org`, `blastapi.io`; for something that is not a URL, the trimmed lower-case text itself. */
export function providerOf(url: string): string {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase().replace(/\.$/, "");
    if (/^[\d.]+$/.test(host) || host.startsWith("[")) return host; // an IP address is its own provider
    const parts = host.split(".");
    return parts.length <= 2 ? host : parts.slice(-2).join(".");
  } catch {
    return url.trim().toLowerCase();
  }
}

/** A comma-separated, ordered list of URLs; empty entries dropped. */
export const urlList = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
