// Keeper integration tests on LOCAL anvil forks of BSC and X Layer (SPEC-PHASE3-KEEPER §10).
// Opt-in: KEEPER_ANVIL=1 and BSC_RPC (an archive endpoint). Nothing here touches a real chain except
// the read-only fork source. See test/anvil/harness.ts.
import { describe, expect, it } from "vitest";
import { getAddress, pad } from "viem";
import { ADDR, SLOT } from "../src/addresses.js";
import { agentAbi, poolAbi, screenAbi } from "../src/abi.js";
import {
  BIG_HOLDER,
  HOLDER_C905,
  LOAN_TIME,
  OWNER,
  RIG,
  SAFE,
  erc20,
  factoryCreate,
  ownerPoolAbi,
  rescueAbi,
  startStack,
  voucherAbi,
} from "./anvil/harness.js";

const BEEF = "0x000000000000000000000000000000000000bEEF" as const;
describe.skipIf(!process.env.KEEPER_ANVIL || !process.env.BSC_RPC)("keeper on anvil forks", () => {
  it(
    "A: push on request, harvest, sweep, a rescue with a stale report, seize, upgrade brakes and a restart",
    async () => {
      const s = await startStack(8745, 8746);
      try {
        const { bsc, xl, as, d, agent, borrower, clock, sync, holder } = s;
        const k = () => holder.keeper;
        const suspended = async () => (await xl.readContract({ address: d.screen, abi: screenAbi, functionName: "passOf", args: [RIG] }))[1];

        // 1. push on request (fresh after it lands; unscreened rigs refused), then borrow
        let mark = await bsc.getBlockNumber();
        expect((await s.push.request(agent, "1.2.3.4")).status).toBe("queued");
        expect(await s.deliverSince(mark)).toBe(1);
        expect(await s.reportTime()).toBeGreaterThanOrEqual(LOAN_TIME);
        expect((await s.push.request(agent, "1.2.3.4")).status).toBe("fresh");
        const other = getAddress(await xl.readContract({ address: d.factory, abi: factoryCreate, functionName: "predictAgent", args: [HOLDER_C905, 0n] }));
        await as("xl", HOLDER_C905).writeContract({ address: d.factory, abi: factoryCreate, functionName: "create", args: [0n] });
        await as("xl", HOLDER_C905).writeContract({ address: ADDR.voucher, abi: voucherAbi, functionName: "safeTransferFrom", args: [HOLDER_C905, other, 5n] });
        expect(await s.push.request(other, "5.6.7.8")).toEqual({ status: "refused", reason: "not eligible" });
        const ownerBefore = await xl.getBalance({ address: OWNER });
        const fee = await s.borrow(1_000_000n);
        expect((await s.loan()).open).toBe(true);
        expect(fee).toBe(0n); // sponsored launch terms
        expect((await xl.getBalance({ address: OWNER })) - ownerBefore).toBe(fee);

        // 2. covered harvest (part E §3.1). Rig #16's pending on the fork (≈ 0.0084 BEM) is short of the
        //    0.011 BEM debt: no harvest. With 0.006 BEM already in the agent, the agent plus the bridged
        //    output covers the debt (+1%) while the agent alone cannot close it: one covered harvest at the
        //    next check, before that cycle's sweep, and only once. Its compose is never delivered here, so
        //    the loan stays open and the maturity harvest still goes out in the last hour; a repayment lands
        //    and is swept
        const vaultLogs = async (from: bigint) => bsc.getLogs({ address: ADDR.rigVault, fromBlock: from + 1n, toBlock: await bsc.getBlockNumber() });
        mark = await bsc.getBlockNumber();
        await k().cycle();
        expect(await vaultLogs(mark)).toEqual([]); // not covered
        await as("xl", BIG_HOLDER).writeContract({ address: ADDR.bemXLayer, abi: erc20, functionName: "transfer", args: [agent, 600_000n] });
        const debtFunded = (await s.loan()).debt;
        await sync(clock.now + 700); // past the 10-minute check timer
        mark = await bsc.getBlockNumber();
        await k().cycle();
        expect((await vaultLogs(mark)).length).toBeGreaterThan(0);
        expect((await s.loan()).debt).toBe(debtFunded - 600_000n); // the same cycle's sweep, after the harvest
        mark = await bsc.getBlockNumber();
        await sync(clock.now + 700);
        await k().cycle();
        expect(await vaultLogs(mark)).toEqual([]); // one covered harvest per loan
        await s.fundCell(RIG, 50_000n); // output mined after the covered harvest: the maturity batch clears the bond
        await sync(Number((await s.loan()).maturity) - 3_600);
        mark = await bsc.getBlockNumber();
        await k().cycle();
        expect((await vaultLogs(mark)).length).toBeGreaterThan(0);
        mark = await bsc.getBlockNumber();
        await sync(clock.now + 60);
        await k().cycle();
        expect(await vaultLogs(mark)).toEqual([]); // once per loan
        const debtBefore = (await s.loan()).debt;
        await as("xl", BIG_HOLDER).writeContract({ address: ADDR.bemXLayer, abi: erc20, functionName: "transfer", args: [agent, 200_000n] });
        await sync(clock.now + 60);
        await k().cycle();
        expect((await s.loan()).debt).toBeLessThan(debtBefore);

        // 3. the Safe rescues rig #16: confirmed over two cycles -> suspend + push
        await as("bsc", SAFE).writeContract({ address: ADDR.rigVault, abi: rescueAbi, functionName: "rescue", args: [RIG, BEEF] });
        await sync(clock.now + 60);
        await k().cycle(); // first sight
        expect(await suspended()).toBe(false);
        mark = await bsc.getBlockNumber();
        await sync(clock.now + 60);
        const pushedAt = clock.now;
        await k().cycle(); // confirmed
        expect(await suspended()).toBe(true);
        expect(await s.deliverSince(mark)).toBe(1);
        //    the report goes stale before the next cycle: no flag is tried (the report is not timely),
        //    and the landed push is not repeated before its 10-minute cooldown
        await sync(pushedAt + 310);
        mark = await bsc.getBlockNumber();
        await k().cycle();
        expect((await s.loan()).impairedAt).toBe(0n);
        expect(await s.countSince(mark)).toBe(0);
        expect(s.alertsSeen.some((t) => t.includes("would revert"))).toBe(false);
        //    after the cooldown: push again, then flag on the timely report
        await sync(pushedAt + 610);
        mark = await bsc.getBlockNumber();
        await k().cycle();
        expect(await s.deliverSince(mark)).toBe(1);
        await sync(clock.now + 30);
        await k().cycle();
        const flagged = await s.loan();
        expect(flagged.impairedAt).toBeGreaterThan(0n);
        expect(flagged.doubtful).toBe(true);

        // 4. after the 72 h cure window: a report from after seizeStart, then seize
        await sync(Number(flagged.seizeStart) + 60);
        mark = await bsc.getBlockNumber();
        await k().cycle();
        expect(await s.deliverSince(mark)).toBe(1);
        await sync(clock.now + 30);
        await k().cycle();
        expect(await xl.readContract({ address: agent, abi: agentAbi, functionName: "closed" })).toBe(true);
        expect(getAddress(await xl.readContract({ address: ADDR.voucher, abi: voucherAbi, functionName: "ownerOf", args: [RIG] }))).toBe(d.pool);

        // 5. a voucher upgrade: frozen at first sight, both brakes on the second cycle
        await s.xlTest.setStorageAt({ address: ADDR.voucher, index: SLOT.implementation, value: pad("0x00000000000000000000000000000000DeaDBeef", { size: 32 }) });
        await sync(clock.now + 60);
        await k().cycle();
        expect(k().frozen).toBe(true);
        expect(await xl.readContract({ address: d.pool, abi: poolAbi, functionName: "borrowsPaused" })).toBe(false);
        await sync(clock.now + 60);
        await k().cycle();
        expect(await xl.readContract({ address: d.pool, abi: poolAbi, functionName: "borrowsPaused" })).toBe(true);
        expect(await xl.readContract({ address: d.pool, abi: poolAbi, functionName: "feedDisabled" })).toBe(true);

        // 6. a restart with an empty state still sees the upgrade at once
        holder.keeper = s.makeKeeper();
        await sync(clock.now + 60);
        await k().cycle();
        expect(k().frozen).toBe(true);
        expect(s.alertsSeen.some((t) => t.includes("voucher implementation changed"))).toBe(true);
      } finally {
        s.stop();
      }
    },
    15 * 60_000,
  );

  it(
    "B: feed disabled during a rescue, flag after enableFeed, re-flag after expiry, NoDebt when repaid in the cure window",
    async () => {
      const s = await startStack(8747, 8748);
      try {
        const { bsc, xl, as, d, agent, clock, sync, holder } = s;
        const k = () => holder.keeper;
        await s.pushAndBorrow(1_000_000n);

        // 1. the owner disables the feed; then the Safe rescues the rig
        await as("xl", OWNER).writeContract({ address: d.pool, abi: ownerPoolAbi, functionName: "disableFeed" });
        await as("bsc", SAFE).writeContract({ address: ADDR.rigVault, abi: rescueAbi, functionName: "rescue", args: [RIG, BEEF] });
        let mark = await bsc.getBlockNumber();
        await sync(clock.now + 60);
        await k().cycle();
        await sync(clock.now + 60);
        await k().cycle();
        //    suspended and alerted, but no push: path (a) evidence is closed while the feed is off
        expect((await xl.readContract({ address: d.screen, abi: screenAbi, functionName: "passOf", args: [RIG] }))[1]).toBe(true);
        expect(s.alertsSeen.some((t) => t.includes("flag impossible until enableFeed"))).toBe(true);
        expect(await s.countSince(mark)).toBe(0);
        expect((await s.loan()).impairedAt).toBe(0n);

        // 2. the owner enables the feed: push, then flag
        await as("xl", OWNER).writeContract({ address: d.pool, abi: ownerPoolAbi, functionName: "enableFeed" });
        mark = await bsc.getBlockNumber();
        // redeploy 3 RB3-03: the push waits until X Layer time is at least feedEnabledAt + MAX_CLOCK_SKEW + 30 s
        const enabledAt = Number(await xl.readContract({ address: d.pool, abi: poolAbi, functionName: "feedEnabledAt" }));
        await sync(Math.max(clock.now + 60, enabledAt + 90));
        await k().cycle();
        expect(await s.deliverSince(mark)).toBe(1);
        await sync(clock.now + 30);
        await k().cycle();
        const first = await s.loan();
        expect(first.impairedAt).toBeGreaterThan(0n);

        // 3. the flag expires while the rig is still rescued: push and flag again
        await sync(Number(first.deadline) + 120); // replacement evidence is expiry + 60, inclusive
        mark = await bsc.getBlockNumber();
        await k().cycle();
        expect(await s.deliverSince(mark)).toBe(1);
        await sync(clock.now + 30);
        await k().cycle();
        const second = await s.loan();
        expect(second.impairedAt).toBeGreaterThan(first.impairedAt);
        expect(second.expired).toBe(false);

        // 4. enough BEM lands in the cure window; with the sweep on its 10-minute pause, the seize
        //    simulation reverts NoDebt (silent), then the sweep closes the loan without a seize
        await as("xl", BIG_HOLDER).writeContract({ address: ADDR.bemXLayer, abi: erc20, functionName: "transfer", args: [agent, 2_000_000n] });
        await sync(Number(second.seizeStart) + 60);
        k().state.lastSweepAt[agent] = clock.now;
        mark = await bsc.getBlockNumber();
        await k().cycle(); // window: a report from after seizeStart
        expect(await s.deliverSince(mark)).toBe(1);
        await sync(clock.now + 30);
        await k().cycle(); // seize would revert NoDebt
        expect(await xl.readContract({ address: agent, abi: agentAbi, functionName: "closed" })).toBe(false);
        expect(s.alertsSeen.some((t) => t.includes("would revert"))).toBe(false);
        await sync(clock.now + 600);
        await k().cycle(); // the sweep repays and closes the loan
        expect((await s.loan()).open).toBe(false);
        expect(await xl.readContract({ address: agent, abi: agentAbi, functionName: "closed" })).toBe(false);
      } finally {
        s.stop();
      }
    },
    15 * 60_000,
  );

  it(
    "C: feed disabled and the miner stopped: evidence harvests sync power 0, flag on path (b), seize after the cure window",
    async () => {
      const s = await startStack(8749, 8750);
      try {
        const { bsc, xl, as, d, agent, clock, sync, holder } = s;
        const k = () => holder.keeper;
        const record = async () => xl.readContract({ address: ADDR.voucher, abi: voucherAbi, functionName: "rigs", args: [RIG] });
        const vaultLogs = async (from: bigint) => bsc.getLogs({ address: ADDR.rigVault, fromBlock: from + 1n, toBlock: await bsc.getBlockNumber() });
        // the rig's output so far is harvested before the loan, so the evidence harvests carry none
        // (it would repay this small loan) and must front the bond from the keeper's BEM float
        const pre = await bsc.getBlockNumber();
        await s.harvest([RIG]);
        expect(await s.deliverHarvests(pre)).toBe(1);
        await s.pushAndBorrow(1_000_000n);
        const start = (await s.loan()).start;
        await s.fundKeeperBem(1_000_000n);
        expect((await record())[3]).toBeGreaterThan(0n);

        // 1. the owner disables the feed; the rig's miner stops on BSC (power 0 at PodMining). A stop
        //    (status 3) stands in for a revocation (status 2): the vault syncs power 0 for both, and T10
        //    shows a revoked key leaves a harvest batch working
        await as("xl", OWNER).writeContract({ address: d.pool, abi: ownerPoolAbi, functionName: "disableFeed" });
        await s.stopMiner(RIG);
        let mark = await bsc.getBlockNumber();
        await sync(clock.now + 60);
        await k().cycle(); // first sight: nothing yet
        expect(await vaultLogs(mark)).toEqual([]);

        // 2. confirmed: the keeper sends an evidence harvest (a cycle later if it must approve its
        //    bond float first); landed, it syncs power 0 on the voucher, and the next cycle flags
        let landed = 0;
        for (let i = 0; i < 2 && landed === 0; i++) {
          await sync(clock.now + 60);
          await k().cycle();
          landed = await s.deliverHarvests(mark);
        }
        expect(landed).toBe(1);
        expect(s.alertsSeen.some((t) => t.startsWith("sent evidence-harvest"))).toBe(true);
        expect(s.alertsSeen.some((t) => t.startsWith("sent approve BEM bond float"))).toBe(true);
        const [, synced, , pow] = await record();
        expect(pow).toBe(0n);
        expect(synced).toBeGreaterThan(start);
        expect((await s.loan()).impairedAt).toBe(0n);
        await sync(clock.now + 30);
        await k().cycle();
        const flagged = await s.loan();
        expect(flagged.impairedAt).toBeGreaterThan(0n);
        expect(flagged.doubtful).toBe(true);
        mark = await bsc.getBlockNumber();
        await sync(clock.now + 60);
        await k().cycle();
        expect(await vaultLogs(mark)).toEqual([]); // no second harvest before seizeStart

        // 3. in the seize window the older sync is not evidence: no seize until a second evidence
        //    harvest, sent 5 minutes after seizeStart, lands
        await sync(Number(flagged.seizeStart) + 60);
        mark = await bsc.getBlockNumber();
        await k().cycle();
        expect(await vaultLogs(mark)).toEqual([]);
        expect(await xl.readContract({ address: agent, abi: agentAbi, functionName: "closed" })).toBe(false);
        await sync(Number(flagged.seizeStart) + 300);
        await k().cycle();
        expect(await s.deliverHarvests(mark)).toBe(1);
        expect((await record())[1]).toBeGreaterThanOrEqual(flagged.seizeStart);
        await sync(clock.now + 30);
        await k().cycle();
        expect(await xl.readContract({ address: agent, abi: agentAbi, functionName: "closed" })).toBe(true);
        expect(getAddress(await xl.readContract({ address: ADDR.voucher, abi: voucherAbi, functionName: "ownerOf", args: [RIG] }))).toBe(d.pool);
        expect(s.alertsSeen.some((t) => t.includes("would revert"))).toBe(false);
      } finally {
        s.stop();
      }
    },
    15 * 60_000,
  );
});
