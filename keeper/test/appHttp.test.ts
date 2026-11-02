// The app's two read-only routes (SPEC-PHASE5-APP §8.3): CORS, address validation, the separate limiter, and
// that the push path and /healthz are left alone. A real server on a free port; the data behind it is a stub.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { getAddress } from "viem";
import { startHttp } from "../src/http.js";
import { ReadLimiter } from "../src/logic/readLimits.js";
import type { PublicDataApi } from "../src/publicData.js";
import type { PushService } from "../src/push.js";

const APP = "https://app.example";
const ADDR = getAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"); // an EIP-55 address with mixed-case letters
const ALL_LOWER = ADDR.toLowerCase();
// the same address with one letter's case flipped: a mixed-case string whose checksum is wrong
const BAD_CHECKSUM = ADDR.replace(/[a-f]/i, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function boot(data: PublicDataApi | undefined, limiter?: ReadLimiter) {
  const push = { request: vi.fn(async () => ({ status: "queued" })) };
  const health = vi.fn(() => ({ ok: true }));
  server = startHttp(0, [APP], push as unknown as PushService, health, data, limiter);
  await new Promise((r) => server!.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, push, health };
}

const stub = (): PublicDataApi & { stats: ReturnType<typeof vi.fn>; position: ReturnType<typeof vi.fn> } => ({
  stats: vi.fn(() => ({ status: 200, body: { sharePrice: "100000000", apy7d: null, history: [] } })),
  position: vi.fn((a: string) => ({ status: 200, body: { netDeposited: "0", transferred: false, firstDepositAt: null, indexedTo: 1, asked: a } })),
});

describe("GET /v1/stats and /v1/position/<address>", () => {
  it("answers from the data layer as JSON, ignores a query string, and sends CORS only to the app's origin", async () => {
    const data = stub();
    const { base } = await boot(data);
    const ok = await fetch(`${base}/v1/stats?cache=1`, { headers: { origin: APP } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/json");
    expect(ok.headers.get("access-control-allow-origin")).toBe(APP);
    expect(await ok.json()).toEqual({ sharePrice: "100000000", apy7d: null, history: [] });
    const foreign = await fetch(`${base}/v1/stats`, { headers: { origin: "https://evil.example" } });
    expect(foreign.status).toBe(200);
    expect(foreign.headers.get("access-control-allow-origin")).toBe(null);
    const none = await fetch(`${base}/v1/stats`);
    expect(none.headers.get("access-control-allow-origin")).toBe(null);
    const p = await fetch(`${base}/v1/position/${ADDR}`, { headers: { origin: APP } });
    expect(p.status).toBe(200);
    expect(p.headers.get("access-control-allow-origin")).toBe(APP);
    expect((await p.json()).asked).toBe(ADDR);
  });

  it("takes a checksummed or an all-lowercase address and answers 400, with CORS, for anything else", async () => {
    const data = stub();
    const { base } = await boot(data);
    expect((await fetch(`${base}/v1/position/${ALL_LOWER}`)).status).toBe(200);
    expect((await fetch(`${base}/v1/position/${ADDR}`)).status).toBe(200);
    const asked = data.position.mock.calls.length;
    const bad = [
      "",
      "0x123",
      "hello",
      ADDR.slice(0, -1),
      `${ADDR}0`,
      ADDR.replace("0x", "0X"),
      ADDR.replace("0x", "xx"),
      BAD_CHECKSUM,
      `%30x${ADDR.slice(2)}`,
      `${ALL_LOWER.slice(0, -1)}g`,
    ];
    for (const b of bad) {
      const r = await fetch(`${base}/v1/position/${b}`, { headers: { origin: APP } });
      expect(r.status, b).toBe(400);
      expect(r.headers.get("access-control-allow-origin")).toBe(APP);
      expect(await r.json()).toEqual({ error: "bad address" });
    }
    expect(data.position.mock.calls.length).toBe(asked); // nothing invalid reached the data layer
  });

  it("is a plain GET: no preflight answer, no other methods, no deeper paths", async () => {
    const { base, push } = await boot(stub());
    const pre = await fetch(`${base}/v1/stats`, { method: "OPTIONS", headers: { origin: APP, "access-control-request-method": "GET" } });
    expect(pre.status).toBe(404);
    expect(pre.headers.get("access-control-allow-methods")).toBe(null);
    expect((await fetch(`${base}/v1/position/${ADDR}`, { method: "OPTIONS", headers: { origin: APP } })).status).toBe(404);
    expect((await fetch(`${base}/v1/stats`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(`${base}/v1/position/${ADDR}/more`)).status).toBe(404);
    expect((await fetch(`${base}/v1/stats/`)).status).toBe(404);
    expect(push.request).not.toHaveBeenCalled();
    // the push route's own preflight is unchanged
    const own = await fetch(`${base}/v1/push`, { method: "OPTIONS", headers: { origin: APP } });
    expect(own.status).toBe(204);
    expect(own.headers.get("access-control-allow-methods")).toBe("POST");
    expect(own.headers.get("access-control-allow-origin")).toBe(APP);
  });

  it("has no such routes when no data layer is configured", async () => {
    const { base } = await boot(undefined);
    expect((await fetch(`${base}/v1/stats`)).status).toBe(404);
    expect((await fetch(`${base}/v1/position/${ADDR}`)).status).toBe(404);
  });

  it("a failing request answers 500 and the server keeps serving", async () => {
    const data = stub();
    data.stats.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const { base } = await boot(data);
    expect((await fetch(`${base}/v1/stats`)).status).toBe(500);
    expect((await fetch(`${base}/v1/stats`)).status).toBe(200);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it("passes the data layer's own status through (not ready yet)", async () => {
    const data = stub();
    data.stats.mockReturnValue({ status: 503, body: { error: "not ready" } });
    const { base } = await boot(data);
    const r = await fetch(`${base}/v1/stats`, { headers: { origin: APP } });
    expect(r.status).toBe(503);
    expect(r.headers.get("access-control-allow-origin")).toBe(APP);
  });
});

describe("the read limiter on the routes", () => {
  it("answers 429 with CORS and Retry-After past 60 requests a minute from one address, counting bad ones", async () => {
    const t = 3_000_030;
    const { base } = await boot(stub(), new ReadLimiter(() => t));
    for (let i = 0; i < 30; i++) expect((await fetch(`${base}/v1/stats`)).status).toBe(200);
    for (let i = 0; i < 30; i++) expect((await fetch(`${base}/v1/position/nope`)).status).toBe(400); // counted too
    const over = await fetch(`${base}/v1/stats`, { headers: { origin: APP } });
    expect(over.status).toBe(429);
    expect(over.headers.get("access-control-allow-origin")).toBe(APP);
    expect(over.headers.get("retry-after")).toBe("30");
    expect(await over.json()).toEqual({ error: "too many requests" });
    expect((await fetch(`${base}/v1/position/${ADDR}`)).status).toBe(429);
    expect((await fetch(`${base}/v1/position/${ADDR}`, { headers: { "x-forwarded-for": "6.6.6.6, 8.8.8.8" } })).status).toBe(200); // another address
  });

  it("stops everyone at 600 requests a minute in total", async () => {
    const { base } = await boot(stub(), new ReadLimiter(() => 3_000_030));
    // 10 addresses (the last X-Forwarded-For entry is the client) of 60 requests each use the whole budget
    for (let ip = 1; ip <= 10; ip++) {
      const results = await Promise.all(Array.from({ length: 60 }, () => fetch(`${base}/v1/stats`, { headers: { "x-forwarded-for": `10.0.0.${ip}` } }).then((r) => r.status)));
      expect(results.every((s) => s === 200)).toBe(true);
    }
    const late = await fetch(`${base}/v1/stats`, { headers: { "x-forwarded-for": "10.0.0.250", origin: APP } });
    expect(late.status).toBe(429);
    expect(late.headers.get("access-control-allow-origin")).toBe(APP);
  });

  it("neither counts /healthz nor /v1/push, and never calls the push service for a read", async () => {
    const { base, push, health } = await boot(stub(), new ReadLimiter(() => 3_000_030));
    for (let i = 0; i < 70; i++) expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect(health).toHaveBeenCalledTimes(70);
    for (let i = 0; i < 70; i++) expect((await fetch(`${base}/v1/push`, { method: "POST", body: JSON.stringify({ agent: ADDR }) })).status).toBe(200);
    expect(push.request).toHaveBeenCalledTimes(70);
    for (let i = 0; i < 60; i++) expect((await fetch(`${base}/v1/stats`)).status).toBe(200);
    expect(push.request).toHaveBeenCalledTimes(70); // reads never touch it
  });
});
