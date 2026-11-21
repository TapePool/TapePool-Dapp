// Start one screen run in a worker thread and wait for it, within a wall-clock budget (SPEC-PHASE5-REGISTER §6.4).
import { Worker, type WorkerOptions } from "node:worker_threads";
import { isJobResult, type JobInput, type JobResult } from "./job.js";

/** 15 minutes per run: check and verify together. */
export const JOB_BUDGET_MS = 15 * 60_000;

/**
 * The worker gets only what the job needs, in `workerData`: an empty environment (no keeper key, token or RPC variable,
 * L5) and a memory ceiling, so a run that goes wrong ends as an error instead of taking the keeper loop with it.
 */
export function workerOptions(input: JobInput): WorkerOptions {
  return {
    workerData: input,
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 },
  };
}

/** Never rejects: a crash, an exit without an answer or the budget running out is an error result. */
export function runInWorker(input: JobInput, budgetMs = JOB_BUDGET_MS): Promise<JobResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: JobResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const worker = new Worker(new URL("./worker.js", import.meta.url), workerOptions(input));
    const timer = setTimeout(() => {
      finish({ kind: "error", transient: true, message: "timeout" });
      void worker.terminate();
    }, budgetMs);
    worker.once("message", (r: unknown) => {
      finish(isJobResult(r) ? r : { kind: "error", transient: false, message: "malformed worker result" });
      void worker.terminate();
    });
    worker.once("error", (e) => finish({ kind: "error", transient: false, message: `worker failed: ${e.message}` }));
    worker.once("exit", (code) => finish({ kind: "error", transient: false, message: `worker exited with code ${code}` }));
  });
}
