import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { Keeper, JOB_ALERT_AFTER, LOG_LAG } from "../src/keeper.js";
import { MIN_RIG_AGE, PushService, ageOk } from "../src/push.js";
import { PushLimiter } from "../src/logic/pushLimits.js";
import { startHttp } from "../src/http.js";
import { emptyDay, emptyState } from "../src/state.js";
import { loadConfig } from "../src/config.js";
import type { Alerts } from "../src/alerts.js";
import type { Clients } from "../src/chains.js";
import type { Call, Sender, SendResult } from "../src/tx.js";
import type { Deployment } from "../src/addresses.js";
import type { LoanSnapshot } from "../src/reads.js";
import { evidenceKey, loanKey, type EvidenceRec } from "../src/logic/schedule.js";

const D: Deployment = {
  pool: "0x0000000000000000000000000000000000000a01",
  factory: "0x0000000000000000000000000000000000000a02",
  screen: "0x0000000000000000000000000000000000000a03",
  receiver: "0x0000000000000000000000000000000000000a04",
  reporter: "0x0000000000000000000000000000000000000a05",
  factoryDeployBlock: 1n,
};
const AGENT = "0x0000000000000000000000000000000000000b01" as const;

const cfg = (mode: "dry" | "live") =>
  loadConfig({ KEEPER_MODE: mode, KEEPER_PRIVATE_KEY: `0x${"11".repeat(32)}`, BSC_RPC: "http://x", TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_CHAT_ID: "1" });

const clients = {
  account: { address: "0x00000000000000000000000000000000000000aa" },
  bsc: { public: { readContract: async () => 1_000n } },
  xlayer: { public: {} },
} as unknown as Clients;

function fakeSender(results: SendResult[]) {
  const calls: Call[] = [];
  const s = {
    calls,
    send: async (c: Call) => {
      calls.push(c);
      return results.shift() ?? { status: "sent", hash: "0x01" };
    },
    poll: async () => {},
    hasPending: () => false,
  };
  return s as unknown as Sender & { calls: Call[] };
}

function keeperWith(mode: "dry" | "live", bsc: Sender, xlayer: Sender, alerts: string[]) {
  const a = { send: async (_k: string, t: string) => void alerts.push(t) } as unknown as Alerts;
  return new Keeper(cfg(mode), clients, D, a, { bsc, xlayer }, emptyState(1n, D.factory), () => 1_000_000);
}

describe("keeper actions", () => {
  it("in dry mode a push does not advance the machine", async () => {
    const bsc = fakeSender([{ status: "dry" }]);
    const k = keeperWith("dry", bsc, fakeSender([]), []);
    await (k as unknown as { act: (...a: unknown[]) => Promise<void> }).act(D, AGENT, { kind: "push", rigs: [16n] }, 1_000_000);
    expect(bsc.calls.length).toBe(1);
    expect(k.state.lastPushAt["16"]).toBeUndefined();
  });

  it("a sent push records the time, pays the quote plus 10%, and counts for the day", async () => {
    const bsc = fakeSender([{ status: "sent", hash: "0x01" }]);
    const k = keeperWith("live", bsc, fakeSender([]), []);
    await (k as unknown as { act: (...a: unknown[]) => Promise<void> }).act(D, AGENT, { kind: "push", rigs: [16n] }, 1_000_000);
    expect(k.state.lastPushAt["16"]).toBe(1_000_000);
    expect(bsc.calls[0]!.value).toBe(1_100n);
    expect(k.state.daily.pushes).toBe(1);
  });

  it("alerts on an unexpected simulation revert of a guardian action, not on an expected one", async () => {
    const alerts: string[] = [];
    const xlayer = fakeSender([
      { status: "reverted", reason: "NotGuardianOrOwner" },
      { status: "reverted", reason: "NoEvidence" },
    ]);
    const k = keeperWith("live", fakeSender([]), xlayer, alerts);
    const act = (k as unknown as { act: (...a: unknown[]) => Promise<void> }).act.bind(k);
    await act(D, AGENT, { kind: "suspend", rig: 16n }, 1_000_000);
    await act(D, AGENT, { kind: "flag", rig: 16n }, 1_000_000);
    expect(alerts).toEqual(["suspendPass 16 would revert (NotGuardianOrOwner); not sent"]);
  });

  it("a pause brake pauses borrows and leaves the feed on; a full brake also disables the feed (C-O4)", async () => {
    const flags = { readContract: async () => false };
    const c = { ...clients, xlayer: { public: flags } } as unknown as Clients;
    const a = { send: async () => {} } as unknown as Alerts;
    for (const [kind, want] of [
      ["pause", ["pauseBorrows"]],
      ["full", ["pauseBorrows", "disableFeed"]],
    ] as const) {
      const xlayer = fakeSender([]);
      const k = new Keeper(cfg("live"), c, D, a, { bsc: fakeSender([]), xlayer }, emptyState(1n, D.factory), () => 1_000_000);
      await (k as unknown as { brake: (d: Deployment, kind: string) => Promise<void> }).brake(D, kind);
      expect(xlayer.calls.map((x) => x.functionName)).toEqual(want);
    }
  });

  it("keeps the last full day's counts for the summary when the day rolls over", async () => {
    const k = keeperWith("dry", fakeSender([]), fakeSender([]), []);
    k.state.daily = { ...emptyDay(10), harvests: 3, pushes: 2 }; // now = 1_000_000 is in day 11
    await k.cycle();
    expect(k.state.previousDay).toMatchObject({ day: 10, harvests: 3, pushes: 2 });
    expect(k.state.daily).toMatchObject({ day: 11, harvests: 0, pushes: 0, coveredThenMatured: 0 });
    const gap = keeperWith("dry", fakeSender([]), fakeSender([]), []);
    gap.state.daily = { ...emptyDay(7), harvests: 3, pushes: 2 }; // the keeper was down on day 10
    await gap.cycle();
    expect(gap.state.previousDay).toEqual(emptyDay(10));
  });

  it("sends the first guardian revert alert at once and throttles the repeats (R1)", async () => {
    const sent: [string, boolean][] = [];
    const a = { send: async (kind: string, _t: string, always = false) => void sent.push([kind, always]) } as unknown as Alerts;
    const xlayer = fakeSender([{ status: "reverted", reason: "NotGuardianOrOwner" }]);
    const k = new Keeper(cfg("live"), clients, D, a, { bsc: fakeSender([]), xlayer }, emptyState(1n, D.factory), () => 1_000_000);
    await (k as unknown as { act: (...a: unknown[]) => Promise<void> }).act(D, AGENT, { kind: "suspend", rig: 16n }, 1_000_000);
    expect(sent).toEqual([["revert:suspendPass 16", false]]);
  });

  it("keeps a delivery check whose read failed for the next loop (R6)", async () => {
    let fail = true;
    const multicall = async () => {
      if (fail) throw new Error("rpc down");
      return [{ status: "success", result: [{ observedAt: 0n }, false] }];
    };
    const c = { ...clients, xlayer: { public: { multicall } } } as unknown as Clients;
    const alerts: string[] = [];
    let t = 1_000_000;
    const svc = new PushService(cfg("live"), c, D, fakeSender([]), new PushLimiter(), () => false, (_k, text) => void alerts.push(text), () => t);
    (svc as unknown as { sent: { ids: bigint[]; at: number }[] }).sent.push({ ids: [16n], at: t });
    t += 600;
    await expect(svc.checkDeliveries()).rejects.toThrow("rpc down");
    fail = false;
    await svc.checkDeliveries();
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain("not stored after 10 minutes");
  });

  it("alerts after a harvest or push reverts in two consecutive cycles", async () => {
    const alerts: string[] = [];
    const bsc = fakeSender([
      { status: "reverted", reason: "NotEnoughNative" },
      { status: "reverted", reason: "NotEnoughNative" },
    ]);
    const k = keeperWith("live", bsc, fakeSender([]), alerts);
    const act = (k as unknown as { act: (...a: unknown[]) => Promise<void> }).act.bind(k);
    await act(D, AGENT, { kind: "push", rigs: [16n] }, 1_000_000);
    expect(alerts).toEqual([]);
    await act(D, AGENT, { kind: "push", rigs: [16n] }, 1_000_060);
    expect(alerts.length).toBe(1);
  });
});

describe("operating fee support (part D)", () => {
  type Priv = {
    bondReady: () => Promise<boolean>;
    coverage: (d: Deployment, rig: bigint, day: number) => Promise<string>;
  };
  const withBsc = (readContract: (a: { functionName: string }) => Promise<unknown>, extra: Record<string, unknown> = {}) =>
    ({ ...clients, bsc: { public: { readContract, getGasPrice: async () => 50_000_000n, ...extra } }, xlayer: { public: { readContract: async () => 31_000_000_000_000_000n } } }) as unknown as Clients;
  const make = (c: Clients, mode: "dry" | "live", env: Record<string, string> = {}, alerts: string[] = [], xlayer = fakeSender([]), bsc = fakeSender([])) => {
    const a = { send: async (_k: string, t: string) => void alerts.push(t) } as unknown as Alerts;
    const conf = loadConfig({ KEEPER_MODE: mode, KEEPER_PRIVATE_KEY: `0x${"11".repeat(32)}`, BSC_RPC: "http://x", TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_CHAT_ID: "1", ...env });
    return new Keeper(conf, c, D, a, { bsc, xlayer }, emptyState(1n, D.factory), () => 1_000_000) as unknown as Priv;
  };

  it("fronts a bond only with BEM on BSC and an allowance, approving first", async () => {
    const alerts: string[] = [];
    const empty = make(withBsc(async () => 0n), "live", {}, alerts);
    expect(await empty.bondReady()).toBe(false);
    expect(alerts[0]).toMatch(/needs the 0.0001 BEM bond/);
    const bsc = fakeSender([]);
    const noAllowance = make(withBsc(async (a) => (a.functionName === "balanceOf" ? 100_000n : 0n)), "live", {}, [], fakeSender([]), bsc);
    expect(await noAllowance.bondReady()).toBe(false);
    expect(bsc.calls.map((c) => c.functionName)).toEqual(["approve"]);
    const ready = make(withBsc(async () => 100_000n), "live");
    expect(await ready.bondReady()).toBe(true);
  });

  it("reports fee coverage against live quotes, alerts below 110%, and says when it is not configured", async () => {
    // push 0.00165 + harvest 0.00165 BNB + 2.71M gas at 0.05 gwei = 0.0034355 BNB
    const quotes = withBsc(async (a) => (a.functionName === "quote" || a.functionName === "quoteHarvest" ? 1_650_000_000_000_000n : 0n));
    const ok = make(quotes, "live", { OKB_PER_BNB: "6.44" });
    expect(await ok.coverage(D, 16n, 11)).toBe("fee coverage 7d 140%, 14d 140% of 0.022124729158 OKB");
    const alerts: string[] = [];
    const low = make(quotes, "live", { OKB_PER_BNB: "9" }, alerts);
    expect(await low.coverage(D, 16n, 11)).toMatch(/fee coverage 7d 100%, 14d 100%/);
    expect(alerts.length).toBe(2);
    const unset: string[] = [];
    expect(await make(quotes, "live", {}, unset).coverage(D, 16n, 11)).toBe("fee coverage not configured");
    expect(unset).toEqual(["fee coverage not configured: set OKB_PER_BNB"]);
  });
});

describe("harvest and evidence bookkeeping (part D, audit L14)", () => {
  const NOW = 1_000_000;
  const CELL = "0x00000000000000000000000000000000000000c1";
  /** BSC reads of rig 16: a vault-known, custodied miner with `status`, `verifWeight` and `pending`. */
  const bscRigs = (status: number, verifWeight: bigint, pending: bigint) => ({
    readContract: async () => 100_000n, // quoteHarvest, and the keeper's BEM float and allowance
    multicall: async ({ contracts }: { contracts: { functionName: string; args?: readonly unknown[] }[] }) =>
      contracts.map((c) => {
        const answers: Record<string, unknown> = {
          rigs: [CELL, c.args?.[0]],
          getMiner: { taskId: 4, status, stopBlock: 0n, since: 0n, verifWeight, bonus: 0n },
          pending,
          cellOf: CELL,
          ownerOf: CELL,
          balanceOf: 0n,
        };
        return { status: "success", result: answers[c.functionName] };
      }),
  });
  const make = (bsc: Sender, alerts: string[] = [], rig = bscRigs(1, 500n, 50_000n)) => {
    const c = { ...clients, bsc: { public: rig }, xlayer: { public: { readContract: async () => 0n } } } as unknown as Clients;
    const a = { send: async (_k: string, t: string) => void alerts.push(t) } as unknown as Alerts;
    return new Keeper(cfg("live"), c, D, a, { bsc, xlayer: fakeSender([]) }, emptyState(1n, D.factory), () => NOW);
  };
  type Priv = {
    harvest: (d: Deployment, loans: LoanSnapshot[], bscBlock: bigint, now: number) => Promise<void>;
    evidenceHarvest: (d: Deployment, due: { rig: bigint; ek: string; kind: "first" | "afterSeize"; impairedAt: number }[], open: LoanSnapshot[], bscBlock: bigint, now: number) => Promise<void>;
    checkEvidence: (ek: string, rig: bigint, rec: EvidenceRec, v: { syncedAt: number; power: bigint }, now: number, accepted: { first: number; afterSeize: number }) => Promise<void>;
  };
  const snap = (maturity: number, debt = 1n, bem = 0n) =>
    ({
      agent: AGENT,
      start: 1_000,
      maturity,
      loan: { open: true, impairedAt: 0, seizeStart: 0, deadline: 0, expired: false, impairedRig: 0n, debt },
      collateral: [16n],
      closed: false,
      bem,
    }) as unknown as LoanSnapshot;
  const key = loanKey(AGENT, 1_000);

  it("records a due loan's maturity harvest only once its batch went out", async () => {
    const bsc = fakeSender([{ status: "waiting", reason: "transaction in flight" }]);
    const k = make(bsc);
    const p = k as unknown as Priv;
    await p.harvest(D, [snap(NOW + 600)], 1n, NOW);
    expect(bsc.calls.map((c) => c.label)).toEqual(["harvest [16]"]);
    expect(k.state.harvest.loans[key]).toBeUndefined(); // waiting: retried next cycle
    await p.harvest(D, [snap(NOW + 600)], 1n, NOW);
    expect(k.state.harvest.loans[key]).toEqual({ maturityDone: true, lastAt: NOW, shortfalls: 0 });
    await p.harvest(D, [snap(NOW + 600)], 1n, NOW + 60);
    expect(bsc.calls.length).toBe(2); // once per loan
  });

  it("books an evidence harvest as pending when sent, nothing when it did not go out, and counts it once it lands", async () => {
    const ek = evidenceKey(key, 16n);
    const due = [{ rig: 16n, ek, kind: "first" as const, impairedAt: 0 }];
    const bsc = fakeSender([{ status: "reverted", reason: "InsufficientFee" }]);
    const alerts: string[] = [];
    const k = make(bsc, alerts, bscRigs(3, 0n, 0n)); // stopped: pending 0, so the keeper fronts the bond
    const p = k as unknown as Priv;
    await p.evidenceHarvest(D, due, [snap(NOW + 86_400)], 1n, NOW);
    expect(k.state.evidence[ek]).toBeUndefined();
    await p.evidenceHarvest(D, due, [snap(NOW + 86_400)], 1n, NOW);
    expect(bsc.calls.map((c) => c.label)).toEqual(["evidence-harvest [16] for rig 16", "evidence-harvest [16] for rig 16"]);
    const rec = k.state.evidence[ek]!;
    expect(rec).toEqual({ count: 0, afterSeize: false, sends: 1, flagAt: 0, pending: { kind: "first", sentAt: NOW } });
    const accepted = { first: 1_001, afterSeize: 0 };
    await p.checkEvidence(ek, 16n, rec, { syncedAt: NOW - 3_600, power: 9n }, NOW + 600, accepted);
    expect(alerts.some((t) => t.includes("has not synced the voucher"))).toBe(true);
    await p.checkEvidence(ek, 16n, rec, { syncedAt: NOW + 2, power: 0n }, NOW + 700, accepted);
    expect(rec.count).toBe(1);
    expect(rec.pending).toBeUndefined();
  });

  it("books the scheduled harvest that just went out as the evidence instead of sending a second one (N7)", async () => {
    let now = NOW;
    const bsc = fakeSender([]);
    const xlayerReads = {
      readContract: async () => true, // feedDisabled; the seized-voucher count reads as 0 below
      multicall: async ({ contracts }: { contracts: { functionName: string }[] }) =>
        contracts.map((c) => ({
          status: "success",
          result: c.functionName === "latest" ? [{ observedAt: 0n }, false] : c.functionName === "passOf" ? [0n, true] : [CELL, 0n, 16n, 1n],
        })),
    };
    const c = { ...clients, bsc: { public: bscRigs(3, 0n, 50_000n) }, xlayer: { public: xlayerReads } } as unknown as Clients;
    const a = { send: async () => {} } as unknown as Alerts;
    const k = new Keeper(cfg("live"), c, D, a, { bsc, xlayer: fakeSender([]) }, emptyState(1n, D.factory), () => now);
    const p = k as unknown as Priv & { impairment: (d: Deployment, loans: LoanSnapshot[], bscBlock: bigint, now: number) => Promise<void> };
    (c.xlayer.public as unknown as { readContract: (a: { functionName: string }) => Promise<unknown> }).readContract = async (q) =>
      q.functionName === "balanceOf" ? 0n : true;
    const loan = snap(NOW + 3_600 + 120, 1_000_000n); // the rig's 50,000 raw cannot cover this debt
    await p.harvest(D, [loan], 1n, now); // not due yet
    await p.impairment(D, [loan], 1n, now); // first sight of the stopped miner
    now += 120; // inside the last hour before maturity, and confirmed
    await p.harvest(D, [loan], 2n, now);
    await p.impairment(D, [loan], 2n, now);
    expect(bsc.calls.map((x) => x.label)).toEqual(["harvest [16]"]);
    expect(k.state.evidence[evidenceKey(key, 16n)]).toMatchObject({ sends: 1, pending: { kind: "first", sentAt: now } });
  });
});

describe("covered harvest in the harvest job (part E §3.1)", () => {
  const NOW = 1_000_000;
  const CELL = "0x00000000000000000000000000000000000000c1";
  const DAY = 86_400;
  /**
   * BSC reads of a healthy rig #16 whose pending output comes from `pending()`; `fail()` breaks the multicall.
   * `quoteHarvest` answers 100,000; `feeBps` answers `fee()`, by default a nonsense 100,000 the keeper replaces with 5%.
   */
  const rigReads = (pending: () => bigint, fail: () => boolean = () => false, fee: () => Promise<bigint> = async () => 100_000n) => ({
    readContract: async ({ functionName }: { functionName: string }) => (functionName === "feeBps" ? fee() : 100_000n),
    multicall: async ({ contracts }: { contracts: { functionName: string; args?: readonly unknown[] }[] }) => {
      if (fail()) throw new Error("rate limited");
      return contracts.map((c) => {
        const answers: Record<string, unknown> = {
          rigs: [CELL, c.args?.[0]],
          getMiner: { taskId: 4, status: 1, stopBlock: 0n, since: 0n, verifWeight: 500n, bonus: 0n },
          pending: pending(),
          cellOf: CELL,
          ownerOf: CELL,
          balanceOf: 0n,
        };
        return { status: "success", result: answers[c.functionName] };
      });
    },
  });
  type Priv = { harvest: (d: Deployment, loans: LoanSnapshot[], bscBlock: bigint, now: number) => Promise<void> };
  const make = (bsc: Sender, rig: ReturnType<typeof rigReads>, mode: "dry" | "live" = "live") => {
    const c = { ...clients, bsc: { public: rig }, xlayer: { public: { readContract: async () => 0n } } } as unknown as Clients;
    const a = { send: async () => {} } as unknown as Alerts;
    const k = new Keeper(cfg(mode), c, D, a, { bsc, xlayer: fakeSender([]) }, emptyState(1n, D.factory), () => NOW);
    return { k, p: k as unknown as Priv };
  };
  const loan = (debt: bigint, bem = 0n) =>
    ({
      agent: AGENT,
      start: 1_000,
      maturity: NOW + 5 * DAY,
      loan: { open: true, impairedAt: 0, seizeStart: 0, deadline: 0, expired: false, impairedRig: 0n, debt },
      collateral: [16n],
      closed: false,
      bem,
    }) as unknown as LoanSnapshot;
  const key = loanKey(AGENT, 1_000);

  it("harvests once when the output covers the debt, and the maturity harvest still runs if the loan stays open", async () => {
    const bsc = fakeSender([]);
    const { k, p } = make(bsc, rigReads(() => 50_000n)); // 50,000 less 5% = 47,500 >= 40,000 x 1.01
    await p.harvest(D, [loan(40_000n)], 1n, NOW);
    expect(bsc.calls.map((x) => x.label)).toEqual(["harvest [16]"]);
    expect(k.state.harvest.loans[key]).toMatchObject({ coveredAt: NOW, maturityDone: false, shortfalls: 0 });
    await p.harvest(D, [loan(40_000n)], 1n, NOW + 3_600);
    expect(bsc.calls.length).toBe(1); // once per loan
    await p.harvest(D, [loan(40_000n)], 1n, NOW + 5 * DAY - 3_600); // still open: the compose never landed
    expect(bsc.calls.length).toBe(2);
    expect(k.state.harvest.loans[key]!.maturityDone).toBe(true);
    expect(k.state.daily.coveredThenMatured).toBe(1);
  });

  it("counts no covered loan whose maturity batch was below the bond, and records no covered harvest skipped below it", async () => {
    let pending = 50_000n;
    const bsc = fakeSender([]);
    const { k, p } = make(bsc, rigReads(() => pending));
    await p.harvest(D, [loan(40_000n)], 1n, NOW);
    pending = 0n; // the covered harvest took it all
    await p.harvest(D, [loan(40_000n)], 1n, NOW + 5 * DAY - 3_600);
    expect(bsc.calls.length).toBe(1); // the maturity batch is skipped (K1)
    expect(k.state.harvest.loans[key]!.maturityDone).toBe(true);
    expect(k.state.daily.coveredThenMatured).toBe(0); // it cost nothing
    const small = make(fakeSender([]), rigReads(() => 2_000n));
    await small.p.harvest(D, [loan(40_000n, 39_000n)], 1n, NOW); // 1,900 + 39,000 >= 40,400, but 2,000 is below the bond
    expect(small.k.state.harvest.loans[key]?.coveredAt).toBeUndefined();
  });

  it("leaves a loan the agent can close to the sweep, and an uncovered one to its schedule", async () => {
    const bsc = fakeSender([]);
    const { p } = make(bsc, rigReads(() => 1_000_000n));
    await p.harvest(D, [loan(40_000n, 40_000n)], 1n, NOW); // the agent already holds the debt
    expect(bsc.calls).toEqual([]);
    const other = make(fakeSender([]), rigReads(() => 50_000n));
    await other.p.harvest(D, [loan(60_000n)], 1n, NOW); // 47,500 < 60,600
    expect(other.k.state.harvest.loans[key]).toBeUndefined();
  });

  it("checks a loan at most every 10 minutes, and again next cycle after a failed read", async () => {
    let pending = 10_000n;
    let fail = false;
    const bsc = fakeSender([]);
    const { p } = make(bsc, rigReads(() => pending, () => fail));
    await p.harvest(D, [loan(40_000n)], 1n, NOW); // not covered; checked
    pending = 50_000n;
    await p.harvest(D, [loan(40_000n)], 1n, NOW + 300);
    expect(bsc.calls).toEqual([]); // the 10-minute timer
    fail = true;
    await p.harvest(D, [loan(40_000n)], 1n, NOW + 600); // unreadable: the timer does not move
    expect(bsc.calls).toEqual([]);
    fail = false;
    await p.harvest(D, [loan(40_000n)], 1n, NOW + 660);
    expect(bsc.calls.map((x) => x.label)).toEqual(["harvest [16]"]);
  });

  it("judges a loan at the 5% maximum when the bridge fee cannot be read", async () => {
    // 42,000 pending less 0.5% = 41,790 covers 40,000 x 1.01 = 40,400; less 5% = 39,900 does not
    const read = make(fakeSender([]), rigReads(() => 42_000n, () => false, async () => 50n));
    await read.p.harvest(D, [loan(40_000n)], 1n, NOW);
    expect(read.k.state.harvest.loans[key]?.coveredAt).toBe(NOW);
    const failed = make(fakeSender([]), rigReads(() => 42_000n, () => false, async () => Promise.reject(new Error("rate limited"))));
    await failed.p.harvest(D, [loan(40_000n)], 1n, NOW);
    expect(failed.k.state.harvest.loans[key]?.coveredAt).toBeUndefined();
  });

  it("records no covered harvest that did not go out: dry mode or a waiting send", async () => {
    const dry = make(fakeSender([{ status: "dry" }]), rigReads(() => 50_000n), "dry");
    await dry.p.harvest(D, [loan(40_000n)], 1n, NOW);
    expect(dry.k.state.harvest.loans[key]?.coveredAt).toBeUndefined();
    const waiting = make(fakeSender([{ status: "waiting", reason: "transaction in flight" }]), rigReads(() => 50_000n));
    await waiting.p.harvest(D, [loan(40_000n)], 1n, NOW);
    expect(waiting.k.state.harvest.loans[key]?.coveredAt).toBeUndefined();
  });
});

describe("failing-job alerts and the log lag (part E §3.2, §3.3)", () => {
  it("alerts only after 10 minutes of failure, says when it recovers, and counts failed cycles", async () => {
    let t = 1_000_000;
    const alerts: string[] = [];
    const a = { send: async (_k: string, txt: string) => void alerts.push(txt) } as unknown as Alerts;
    const k = new Keeper(cfg("live"), clients, D, a, { bsc: fakeSender([]), xlayer: fakeSender([]) }, emptyState(1n, D.factory), () => t);
    const job = (k as unknown as { job: (n: string, f: () => Promise<void>) => Promise<boolean> }).job.bind(k);
    const boom = async () => {
      throw new Error("rate limit");
    };
    expect(JOB_ALERT_AFTER).toBe(600);
    expect(await job("logs", boom)).toBe(false);
    t += 540;
    await job("logs", boom);
    expect(alerts).toEqual([]);
    t += 60;
    await job("logs", boom);
    expect(alerts).toEqual(["keeper job logs has failed for 10 min: Error: rate limit"]);
    t += 60;
    expect(await job("logs", async () => {})).toBe(true);
    expect(alerts[1]).toBe("keeper job logs recovered after 11 min");
    await job("balances", boom); // a blip that clears on the next cycle never alerts
    t += 60;
    await job("balances", async () => {});
    expect(alerts.length).toBe(2);
    expect(k.state.daily.jobFailures).toEqual({ logs: 3, balances: 1 });
  });

  it("starts a new streak when a job was not run for a while between two failures", async () => {
    let t = 1_000_000;
    const alerts: string[] = [];
    const a = { send: async (_k: string, txt: string) => void alerts.push(txt) } as unknown as Alerts;
    const k = new Keeper(cfg("live"), clients, D, a, { bsc: fakeSender([]), xlayer: fakeSender([]) }, emptyState(1n, D.factory), () => t);
    const job = (k as unknown as { job: (n: string, f: () => Promise<void>) => Promise<boolean> }).job.bind(k);
    const boom = async () => {
      throw new Error("rate limit");
    };
    await job("impairment", boom);
    t += 1_200; // not run meanwhile (the keeper was frozen)
    await job("impairment", boom);
    expect(alerts).toEqual([]); // a fresh streak, not "failed for 20 min"
    t += 600;
    await job("impairment", boom);
    expect(alerts).toEqual(["keeper job impairment has failed for 10 min: Error: rate limit"]);
  });

  it("scans logs only up to 16 blocks behind the head, so a lagging endpoint cannot skip blocks", async () => {
    const ranges: [bigint, bigint][] = [];
    const laggingHead = 998n; // the endpoint serving the pages is 2 blocks behind the one that gave the head
    const x = {
      getBlockNumber: async () => 1_000n,
      getContractEvents: async (q: { fromBlock: bigint; toBlock: bigint }) => {
        ranges.push([q.fromBlock, q.toBlock]);
        return [];
      },
    };
    const c = { ...clients, xlayer: { public: x } } as unknown as Clients;
    const a = { send: async () => {} } as unknown as Alerts;
    const k = new Keeper(cfg("live"), c, D, a, { bsc: fakeSender([]), xlayer: fakeSender([]) }, emptyState(1n, D.factory), () => 1_000_000);
    k.state.cursor = "900";
    await (k as unknown as { scanLogs: (d: Deployment) => Promise<void> }).scanLogs(D);
    expect(LOG_LAG).toBe(16n);
    expect(ranges.at(-1)![1]).toBe(1_000n - LOG_LAG);
    expect(ranges.every(([, to]) => to <= laggingHead)).toBe(true);
    expect(k.state.cursor).toBe("985");
  });
});

describe("push eligibility age", () => {
  it("matches CreditPolicy.MIN_RIG_AGE (3 days) and refuses a younger or unknown rig", () => {
    expect(MIN_RIG_AGE).toBe(259_200n); // = src/CreditPolicy.sol MIN_RIG_AGE (pinned in test/unit/CreditPolicy.t.sol)
    const since = 1_000_000n;
    expect(ageOk(since, 1_000_000 + 259_199)).toBe(false);
    expect(ageOk(since, 1_000_000 + 259_200)).toBe(true);
    expect(ageOk(0n, 9_999_999_999)).toBe(false);
  });
});

describe("push service batching", () => {
  afterEach(() => vi.useRealTimers());

  it("waits 5 s, sends at most 16 rigs per message, and retries while the nonce is busy", async () => {
    vi.useFakeTimers();
    const bsc = fakeSender([{ status: "waiting", reason: "transaction in flight" }]);
    const alerts: string[] = [];
    const svc = new PushService(cfg("live"), clients, D, bsc, new PushLimiter(), () => false, (_k, t) => void alerts.push(t));
    (svc as unknown as { enqueue: (ids: bigint[]) => void }).enqueue(Array.from({ length: 20 }, (_, i) => BigInt(i + 1)));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(bsc.calls.length).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(bsc.calls.length).toBe(1); // waiting: retry in 15 s
    await vi.advanceTimersByTimeAsync(15_000);
    expect(bsc.calls.length).toBe(3);
    expect((bsc.calls[1]!.args![0] as bigint[]).length).toBe(16);
    expect((bsc.calls[2]!.args![0] as bigint[]).length).toBe(4);
    expect(bsc.calls[1]!.value).toBe(1_100n);
  });

  it("refuses before any chain read when dry, frozen, unknown, or over the request budget", async () => {
    const svc = new PushService(cfg("dry"), clients, D, fakeSender([]), new PushLimiter(), () => false, () => {});
    expect(await svc.request(AGENT, "1.1.1.1")).toEqual({ status: "refused", reason: "dry mode" });
    const live = new PushService(cfg("live"), clients, D, fakeSender([]), new PushLimiter(), () => true, () => {});
    expect(await live.request(AGENT, "1.1.1.1")).toEqual({ status: "refused", reason: "upgrade pending" });
    const open = new PushService(cfg("live"), clients, D, fakeSender([]), new PushLimiter(), () => false, () => {});
    expect(await open.request("not an address", "1.1.1.1")).toEqual({ status: "refused", reason: "bad agent address" });
    for (let i = 0; i < 9; i++) await open.request("x", "2.2.2.2");
    expect((await open.request("x", "2.2.2.2")).status).toBe("refused");
    expect(await open.request("x", "2.2.2.2")).toEqual({ status: "refused", reason: "too many requests from this address" });
  });
});

describe("http", () => {
  it("a throwing push handler answers 500 and the server keeps serving", async () => {
    const push = { request: async () => Promise.reject(new Error("boom")) } as unknown as PushService;
    const server = startHttp(0, ["https://app.example"], push, () => ({ ok: true }));
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const bad = await fetch(`http://127.0.0.1:${port}/v1/push`, { method: "POST", body: JSON.stringify({ agent: AGENT }) });
      expect(bad.status).toBe(500);
      const big = await fetch(`http://127.0.0.1:${port}/v1/push`, { method: "POST", body: "x".repeat(300) });
      expect(big.status).toBe(400);
      const health = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { origin: "https://app.example" } });
      expect(health.status).toBe(200);
      expect(health.headers.get("access-control-allow-origin")).toBe("https://app.example");
      const other = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { origin: "https://evil.example" } });
      expect(other.headers.get("access-control-allow-origin")).toBe(null);
      expect((await fetch(`http://127.0.0.1:${port}/admin`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
