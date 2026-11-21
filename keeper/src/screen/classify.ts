// What a screen run's reasons mean for the miner and the queue (SPEC-PHASE5-REGISTER §6.5). The patterns match the
// vendored `runChecks` reason strings; a reason that matches none is `check`, which fails closed: no PASS, the owner is told.

/** Rig-level reasons: the rig itself cannot borrow, and the FAIL is final for that voucher. */
export type FailCode =
  | "no-voucher"
  | "voucher-mismatch"
  | "processor"
  | "not-mining"
  | "task"
  | "circuit"
  | "wrong-output"
  | "differs"
  | "counterexample"
  | "too-wide";

export const FAIL_CODES: readonly FailCode[] = ["no-voucher", "voucher-mismatch", "processor", "not-mining", "task", "circuit", "wrong-output", "differs", "counterexample", "too-wide"];

/** Codes of an `error` record: the run could not decide, so there is no PASS and nothing is final. */
export type ErrorCode = "transient" | "verify" | "check";

export type ReasonClass = { kind: "fail"; code: FailCode } | { kind: "protocol" } | { kind: "transient" } | { kind: "check" };

const RIG: readonly (readonly [RegExp, FailCode])[] = [
  [/^no voucher for this rig on X Layer$/, "no-voucher"],
  [/^voucher and vault disagree on the rig's circuit$/, "voucher-mismatch"],
  [/^PodMining's miner record differs from the vault$/, "voucher-mismatch"],
  [/^the rig's processor is not PoD-mineable$/, "processor"],
  [/^processor 0x[0-9a-fA-F]{40} is not PoD-mineable$/, "processor"],
  [/^miner status \d+, not active$/, "not-mining"],
  [/^task is not active$/, "task"],
  [/^unknown task kind \d+$/, "task"],
  [/^task has no cycles, outputs or vectors$/, "task"],
  [/^netlist: /, "circuit"],
  [/^rig pins differ from the task$/, "circuit"],
  [/^combinational task but the rig has state$/, "circuit"],
  [/^V1: the rig's output differs at official vector \d+$/, "wrong-output"],
  // only an answer that would revoke is the rig's fault; Prf(), an empty revert or a bad count are the screen's own problem
  [/^V2: challenge of official vector \d+ gave success \(the miner would be revoked\), not Corr\(\)$/, "wrong-output"],
  [/^V2: challenge of official vector \d+ gave Nomn\(\) \(not mining\), not Corr\(\)$/, "not-mining"],
  [/^the rig differs from the task reference at input 0x[0-9a-f]*$/, "differs"],
  [/^the rig fails a registered counterexample$/, "counterexample"],
  [/^too wide: \d+ input bits over the \d+-bit equivalence limit$/, "too-wide"],
];

/** What the upgrade watch also brakes on: no rig is judged until a human reviews the change (SCREEN §6). */
const PROTOCOL: readonly RegExp[] = [
  /^PodMining implementation differs from the reviewed one$/,
  /^PodMining is not sealed with frozen tasks and no owner$/,
  /^PodMining is paused$/,
  /^PodMining module code differs from the reviewed one$/,
  /^MAX_REF_LEVELS is implausibly large$/,
  /^processor 0x[0-9a-fA-F]{40} is behind an unreviewed beacon$/,
  /^the circuits evaluator differs from the reviewed implementation$/,
  /^PodMining minerKey differs from the local key$/,
];

/**
 * Narrowly transient: the endpoint did not answer. A revert inside `read()` is also an `rpc:` reason ("… reverted …"),
 * and it is NOT transient: the chain answered something unexpected.
 */
const TRANSIENT: readonly RegExp[] = [
  /failed after \d+ attempts/,
  /network error \(/,
  /^HTTP \d{3}$/,
  /\bHTTP \d{3}\b/,
  /chain id \d+, expected \d+/,
  /block .* not found/,
  /^vector file download failed/,
  /^timeout$/,
];

export function classifyReason(reason: string): ReasonClass {
  for (const p of PROTOCOL) if (p.test(reason)) return { kind: "protocol" };
  if (TRANSIENT.some((p) => p.test(reason))) return { kind: "transient" };
  for (const [p, code] of RIG) if (p.test(reason)) return { kind: "fail", code };
  return { kind: "check" };
}

/** The most serious class wins: protocol, then transient, then check, then fail (the first rig-level reason's code). */
export function classifyReasons(reasons: readonly string[]): ReasonClass | { kind: "pass" } {
  if (reasons.length === 0) return { kind: "pass" };
  const all = reasons.map(classifyReason);
  for (const k of ["protocol", "transient", "check"] as const) if (all.some((c) => c.kind === k)) return { kind: k };
  return all[0]!;
}

/** True when a run's reasons all say the rig itself cannot borrow: a FAIL that is worth reproducing on the second provider. */
export const rigLevel = (reasons: readonly string[]): boolean => classifyReasons(reasons).kind === "fail";
