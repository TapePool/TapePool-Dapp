// RB4-03: existing environment keys, pool-derived policy, and consistent cached HTTP deployment identity.
import { describe, expect, it, vi } from "vitest";
import { getAddress, zeroAddress } from "viem";
import { DEPLOYMENT } from "../src/addresses.js";
import type { Clients } from "../src/chains.js";
import { loadDeployment } from "../src/config.js";
import { deploymentStatus, withDeploymentStatus } from "../src/deploymentStatus.js";
import { PublicData, type PublicDataApi } from "../src/publicData.js";
import { checkStack, readPolicy } from "../src/reads.js";
import { emptyState } from "../src/state.js";

const A = (id: number) => getAddress(`0x${id.toString(16).padStart(40, "0")}`);
const POLICY = A(70);
const env = () => ({ KEEPER_POOL: A(11), KEEPER_FACTORY: A(12), KEEPER_SCREEN: A(13), KEEPER_LENS: A(14), KEEPER_RECEIVER: A(15), KEEPER_REPORTER: A(16),
  KEEPER_FACTORY_DEPLOY_BLOCK: "81000001", KEEPER_POOL_DEPLOY_BLOCK: "81000002", KEEPER_RECEIVER_DEPLOY_BLOCK: "81000003", KEEPER_REPORTER_DEPLOY_BLOCK: "140000001", KEEPER_CUTOVER_RD02: "confirmed" });
const deployment = () => loadDeployment(env())!;

describe("RB4-03 deployment configuration", () => {
  it("keeps the existing key names and replaces the stack and both feed ends together", () => {
    expect(deployment()).toEqual({ legacy: false, pool: A(11), factory: A(12), screen: A(13), lens: A(14), receiver: A(15), reporter: A(16),
      factoryDeployBlock: 81_000_001n, poolDeployBlock: 81_000_002n, receiverDeployBlock: 81_000_003n, reporterDeployBlock: 140_000_001n });
    expect(Object.hasOwn(deployment(), "policy")).toBe(false);
    expect(loadDeployment({})).toBe(DEPLOYMENT);
  });

  it.each(["POOL", "FACTORY", "SCREEN", "LENS", "RECEIVER", "REPORTER", "FACTORY_DEPLOY_BLOCK", "POOL_DEPLOY_BLOCK", "RECEIVER_DEPLOY_BLOCK", "REPORTER_DEPLOY_BLOCK"])("rejects a cutover missing KEEPER_%s", (key) => {
    const values: Record<string, string> = env(); delete values[`KEEPER_${key}`];
    expect(() => loadDeployment(values)).toThrow(`KEEPER_${key}`);
  });

  it("retains the old-stack confirmation gate", () => {
    expect(() => loadDeployment({ ...env(), KEEPER_CUTOVER_RD02: "" })).toThrow("KEEPER_CUTOVER_RD02=confirmed");
  });
});

describe("RB4-03 pool policy", () => {
  it.each([false, true])("reads the selected pool's policy with legacy=%s, never an independent environment address", async (legacy) => {
    const d = loadDeployment({ ...env(), KEEPER_POLICY: A(99) })!;
    const readContract = vi.fn(async () => POLICY), clients = { xlayer: { public: { readContract } } } as unknown as Clients;
    expect(await readPolicy(clients, { ...d, legacy })).toBe(POLICY);
    expect(readContract).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ address: d.pool, functionName: "policy" }));
  });

  it.each([zeroAddress, "0x01", "not an address", undefined, null, 0n])("rejects an invalid pool policy: %s", async (answer) => {
    const clients = { xlayer: { public: { readContract: async () => answer } } } as unknown as Clients;
    await expect(readPolicy(clients, deployment())).rejects.toThrow("invalid policy");
  });

  it("propagates an unreadable policy rather than using a stale address", async () => {
    const clients = { xlayer: { public: { readContract: async () => { throw new Error("RPC unavailable"); } } } } as unknown as Clients;
    await expect(readPolicy(clients, deployment())).rejects.toThrow("RPC unavailable");
  });

  it("keeps the existing interface check and then reads the policy from the new pool", async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => functionName === "FEED_SETTLE" ? 360n : functionName === "feedEnabledAt" ? 0n : POLICY);
    const clients = { xlayer: { public: { readContract } } } as unknown as Clients, d = deployment();
    await checkStack(clients, d);
    expect(await readPolicy(clients, d)).toBe(POLICY);
    expect(readContract.mock.calls.map(([q]) => q.functionName)).toEqual(["FEED_SETTLE", "feedEnabledAt", "policy"]);
  });
});

describe("RB4-03 HTTP deployment identity", () => {
  it.each([200, 503])("identifies the new stack in both health and stats with stats status %s", (status) => {
    const d = deployment(), body = status === 200 ? { sharePrice: "123", asOf: 100, block: 90 } : { error: "not ready" };
    const data = { stats: vi.fn(() => ({ status, body })), position: vi.fn() } as unknown as PublicDataApi;
    const view = withDeploymentStatus(data, d, POLICY), identity = deploymentStatus(d, POLICY);
    expect(identity).toEqual({ pool: A(11), receiver: A(15), reporter: A(16), policy: POLICY });
    expect(view.stats()).toEqual({ status, body: { ...body, ...identity } });
    expect(deploymentStatus(null, null)).toEqual({ pool: null, receiver: null, reporter: null, policy: null });
  });

  it("preserves the position API and uses the cached policy without HTTP chain reads", async () => {
    const readContract = vi.fn(async () => POLICY), clients = { xlayer: { public: { readContract } } } as unknown as Clients, d = deployment();
    const policy = await readPolicy(clients, d);
    const answer = { status: 200, body: { address: A(1), netDeposited: "5" } };
    const position = vi.fn(() => answer), data = { stats: () => ({ status: 503, body: { error: "not ready" } }), position };
    const view = withDeploymentStatus(data, d, policy);
    for (let i = 0; i < 5; i++) expect(view.stats().body).toMatchObject({ policy: POLICY });
    expect(view.position(A(1))).toBe(answer);
    expect(position).toHaveBeenCalledExactlyOnceWith(A(1));
    expect(readContract).toHaveBeenCalledTimes(1);
  });

  it("starts fresh pool history and retains the selected feed identity during warmup and after publishing stats", () => {
    const d = deployment(), state = emptyState(1n, A(98));
    state.stats = { pool: A(98), nextDay: 50, snapshots: [{ day: 49, block: "1", time: 100, price: "999" }] };
    const data = new PublicData({} as Clients, d, state, () => {}), view = withDeploymentStatus(data, d, POLICY);
    expect(state.stats).toEqual({ pool: d.pool.toLowerCase(), nextDay: 0, snapshots: [] });
    expect(view.stats()).toEqual({ status: 503, body: { error: "not ready", ...deploymentStatus(d, POLICY) } });
    (data as unknown as { buildStatsBody(r: { block: bigint; time: number; price: bigint }): void }).buildStatsBody({ block: 81_000_010n, time: 1_800_000_000, price: 123n });
    expect(view.stats()).toMatchObject({ status: 200, body: { sharePrice: "123", history: [], ...deploymentStatus(d, POLICY) } });
  });
});
