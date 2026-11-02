// HTTP surface: POST /v1/push (SPEC-PHASE3-KEEPER §5.2), GET /healthz, and the app's two read-only routes
// GET /v1/stats and GET /v1/position/<address> (SPEC-PHASE5-APP §8). Nothing else. A failing request can
// never stop the keeper loop.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAddress } from "viem";
import { log } from "./log.js";
import { ReadLimiter } from "./logic/readLimits.js";
import type { PublicDataApi } from "./publicData.js";
import type { PushService } from "./push.js";

const MAX_BODY = 256;

/** The client IP: the last X-Forwarded-For entry, appended by Railway's proxy; earlier ones are client-controlled. */
export function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff.join(",") : (xff ?? "");
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? req.socket.remoteAddress ?? "unknown";
}

/** The two read-only routes; a query string is ignored. Null for any other URL. */
function readRoute(url: string): { kind: "stats" } | { kind: "position"; address: string } | null {
  const q = url.indexOf("?");
  const path = q < 0 ? url : url.slice(0, q);
  if (path === "/v1/stats") return { kind: "stats" };
  const m = /^\/v1\/position\/([^/]*)$/.exec(path);
  return m ? { kind: "position", address: m[1] ?? "" } : null;
}

function send(res: ServerResponse, status: number, body: unknown, origin: string | null, extra: Record<string, string> = {}): void {
  const headers: Record<string, string> = { "content-type": "application/json", ...extra };
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "origin";
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

export function startHttp(
  port: number,
  appOrigins: string[],
  push: PushService,
  health: () => Record<string, unknown>,
  data?: PublicDataApi,
  readLimiter: ReadLimiter = new ReadLimiter(),
): Server {
  const server = createServer((req, res) => {
    const origin = typeof req.headers.origin === "string" && appOrigins.includes(req.headers.origin) ? req.headers.origin : null;
    void (async () => {
      try {
        if (req.method === "GET" && req.url === "/healthz") return send(res, 200, health(), origin);
        if (req.method === "OPTIONS" && req.url === "/v1/push") {
          res.writeHead(204, origin ? {
            "access-control-allow-origin": origin,
            "access-control-allow-methods": "POST",
            "access-control-allow-headers": "content-type",
            "vary": "origin",
          } : {});
          return res.end();
        }
        // The read-only routes: simple GETs (no preflight, so no OPTIONS here), answered from memory, behind their
        // own in-memory limiter. They never touch the push service or its limiter.
        const route = req.method === "GET" && data ? readRoute(req.url ?? "") : null;
        if (route && data) {
          const verdict = readLimiter.admit(clientIp(req));
          if (!verdict.ok) return send(res, 429, { error: "too many requests" }, origin, { "retry-after": String(verdict.retryAfter) });
          if (route.kind === "stats") {
            const a = data.stats();
            return send(res, a.status, a.body, origin);
          }
          if (!isAddress(route.address)) return send(res, 400, { error: "bad address" }, origin);
          const a = data.position(route.address);
          return send(res, a.status, a.body, origin);
        }
        if (req.method !== "POST" || req.url !== "/v1/push") return send(res, 404, { error: "not found" }, origin);

        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > MAX_BODY) return send(res, 400, { error: "body too large" }, origin);
          chunks.push(chunk as Buffer);
        }
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return send(res, 400, { error: "invalid JSON" }, origin);
        }
        const agent = typeof body === "object" && body !== null ? (body as { agent?: unknown }).agent : undefined;
        const decision = await push.request(agent, clientIp(req));
        return send(res, 200, decision, origin);
      } catch (e) {
        log("error", "http request failed", { error: String(e) });
        if (!res.headersSent) send(res, 500, { error: "internal error" }, origin);
      }
    })();
  });
  server.on("clientError", (_e, socket) => socket.destroy());
  server.listen(port);
  return server;
}
