// Keeper entry point (SPEC-PHASE3-KEEPER §2). One loop every 60 s; dry mode unless KEEPER_MODE=live.
import { parseGwei } from "viem";
import { bnbSpent } from "./logic/budget.js";
import { Alerts } from "./alerts.js";
import { makeClients } from "./chains.js";
import { loadConfig } from "./config.js";
import { startHttp } from "./http.js";
import { Keeper } from "./keeper.js";
import { log, redact, registerSecrets } from "./log.js";
import { PushLimiter } from "./logic/pushLimits.js";
import { PushService } from "./push.js";
import { checkStack } from "./reads.js";
import { loadState, saveState } from "./state.js";
import { Sender } from "./tx.js";

const CYCLE_MS = 60_000;

async function main(): Promise<void> {
  const cfg = loadConfig();
  registerSecrets(cfg.secrets);
  // a stray rejection is logged (redacted) and the guardian keeps running (L9)
  process.on("unhandledRejection", (e) => log("error", "unhandled rejection", { error: redact(String(e)) }));
  const clients = makeClients(cfg);
  const alerts = new Alerts(cfg.telegramToken, cfg.telegramChatId, `[keeper ${cfg.mode}]`);
  const alert = (text: string) => void alerts.send(`tx:${text}`, text);
  const deployment = cfg.deployment;
  // this build mirrors the redeploy 3 evidence rules: refuse to start against any other non-legacy pool (RB3-05)
  if (deployment) await checkStack(clients, deployment);
  const state = loadState(cfg.statePath, deployment?.factoryDeployBlock ?? 0n, deployment?.factory ?? "");
  state.spendStartedAt ||= Math.floor(Date.now() / 1000);
  const persist = () => saveState(cfg.statePath, state);
  const senders = {
    bsc: new Sender(clients.bsc, { mode: cfg.mode, capWei: parseGwei("3"), stuckAfterSec: 180, alert, journal: state.pendingTx.bsc, persist,
      mined: (call, receipt) => {
        const amount = bnbSpent(call, receipt);
        if (amount !== null) state.spend.push({ at: Math.floor(Date.now() / 1000), amount: amount.toString() });
      },
    }),
    xlayer: new Sender(clients.xlayer, { mode: cfg.mode, capWei: parseGwei("1"), stuckAfterSec: 60, alert, journal: state.pendingTx.xlayer, persist,
      mined: (call, receipt) => {
        if (call.label === "sync income" && call.address.toLowerCase() === deployment?.pool.toLowerCase() && receipt.status === "success") delete state.income.positiveSince;
      },
    }),
  };
  const keeper = new Keeper(cfg, clients, deployment, alerts, senders, state);
  const push = new PushService(
    cfg,
    clients,
    deployment,
    senders.bsc,
    new PushLimiter(state.pushCounts),
    () => keeper.frozen,
    (kind, text) => void alerts.send(kind, text),
    undefined, persist, state.custodyAlerts,
  );
  const server = startHttp(
    cfg.port,
    cfg.appOrigins,
    push,
    () => ({
      ok: true,
      mode: cfg.mode,
      frozen: keeper.frozen,
      deployed: deployment !== null,
      lastCycleAt: keeper.lastCycleAt,
      logCursor: keeper.state.cursor,
      agents: Object.keys(keeper.state.agents).length,
      keeper: clients.account.address,
    }),
    keeper.publicData ?? undefined, // the app's read-only routes (SPEC-PHASE5-APP §8)
  );

  log("info", "keeper started", { mode: cfg.mode, keeper: clients.account.address, deployed: deployment !== null });
  await alerts.send("start", `keeper started in ${cfg.mode} mode as ${clients.account.address}`, true);

  let stopping = false;
  const stop = () => {
    stopping = true;
    saveState(cfg.statePath, keeper.state);
    server.close();
    log("info", "keeper stopped");
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  while (!stopping) {
    const started = Date.now();
    await keeper.cycle();
    await push.checkDeliveries().catch((e) => log("error", "delivery check failed", { error: String(e) }));
    try {
      saveState(cfg.statePath, keeper.state);
    } catch (e) {
      log("error", "could not save state", { error: String(e) });
    }
    const wait = Math.max(1_000, CYCLE_MS - (Date.now() - started));
    await new Promise((r) => setTimeout(r, wait));
  }
}

main().catch((e) => {
  log("error", "keeper crashed", { error: String(e) });
  process.exit(1);
});
