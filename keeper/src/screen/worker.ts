// The worker thread of one screen run (SPEC-PHASE5-REGISTER D-1, §6.4). The equivalence step is synchronous CPU work
// (up to 2^20 inputs) and the RPC part is serial, so the run never shares the keeper loop's thread. One run per worker.
import { parentPort, workerData } from "node:worker_threads";
import { rpcDeps, runJob, type JobInput, type JobResult } from "./job.js";

const done = (r: JobResult) => parentPort?.postMessage(r);

runJob(workerData as JobInput, rpcDeps()).then(done, (e: unknown) =>
  done({ kind: "error", transient: false, message: e instanceof Error ? e.message : String(e) }),
);
