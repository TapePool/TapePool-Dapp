import { afterEach, describe, expect, it, vi } from "vitest";
import { Rpc, RpcError, RpcView, RevertError } from "../src/chain.js";

// a fake endpoint whose URL carries a "key": no error message may ever contain it
const URL = "https://rpc.example/secret-key-123";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stub(answers: ((body: { method: string; params: unknown[] }) => Response | Promise<Response>)[]) {
  const seen: { method: string; params: unknown[] }[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { method: string; params: unknown[] };
      seen.push(body);
      return answers[Math.min(i++, answers.length - 1)]!(body);
    }),
  );
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("JSON-RPC: revert vs transport failure (§3)", () => {
  it("a code 3 error with data is a revert carrying that data, and is not retried", async () => {
    const seen = stub([() => json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted", data: "0xe915f0ea" } })]);
    await expect(new Rpc(URL, "BSC").request("eth_call", [])).rejects.toEqual(new RevertError("0xe915f0ea"));
    expect(seen.length).toBe(1);
  });

  it("'execution reverted' without data is a revert with empty data", async () => {
    stub([() => json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted" } })]);
    const e = await new Rpc(URL, "BSC").request("eth_call", []).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RevertError);
    expect((e as RevertError).data).toBe("0x");
  });

  it("HTTP errors, rate limits and network errors are retried three times, then fail without the URL", async () => {
    for (const answer of [
      () => json({}, 500),
      () => json({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "limit exceeded" } }),
      () => Promise.reject(new TypeError(`fetch failed for ${URL}`)),
    ]) {
      const seen = stub([answer]);
      const e = await new Rpc(URL, "BSC").request("eth_getCode", []).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RpcError);
      expect((e as Error).message).not.toContain("secret-key");
      expect((e as Error).message).toMatch(/BSC eth_getCode failed after 3 attempts/);
      expect(seen.length).toBe(3);
    }
  }, 30_000);

  it("RpcView pins the block, checks the chain id, and turns a revert into { ok: false, data }", async () => {
    const seen = stub([
      () => json({ jsonrpc: "2.0", id: 1, result: "0x38" }),
      () => json({ jsonrpc: "2.0", id: 2, result: { number: "0x7b", hash: `0x${"aa".repeat(32)}` } }),
      () => json({ jsonrpc: "2.0", id: 3, error: { code: 3, message: "execution reverted", data: "0x7e409b38" } }),
      () => json({ jsonrpc: "2.0", id: 4, result: "0x01" }),
    ]);
    const v = await RpcView.open(URL, "BSC", 56, "finalized");
    expect(v.block).toBe(123n);
    expect(await v.call("0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46", "0x1234")).toEqual({ ok: false, data: "0x7e409b38" });
    expect(await v.call("0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46", "0x1234", 60_000n)).toEqual({ ok: true, data: "0x01" });
    expect(seen[2]!.params).toEqual([{ to: "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46", data: "0x1234" }, "0x7b"]);
    expect(seen[3]!.params).toEqual([{ to: "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46", data: "0x1234", gas: "0xea60" }, "0x7b"]);
  });

  it("refuses an endpoint on the wrong chain", async () => {
    stub([() => json({ jsonrpc: "2.0", id: 1, result: "0x1" })]);
    await expect(RpcView.open(URL, "BSC", 56, "finalized")).rejects.toThrow(/chain id 1, expected 56/);
  });
});
