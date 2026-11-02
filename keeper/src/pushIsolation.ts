import { revertReason, type SendResult } from "./tx.js";

const custody = (e: unknown) => revertReason(e).includes("CustodyUnreadable");

/** Only custody failures split a batch; unrelated failures keep their usual retry/alert behavior. */
export async function isolatedQuotes(ids: bigint[], quote: (ids: bigint[]) => Promise<bigint>, unreadable: (id: bigint) => void): Promise<{ ids: bigint[]; fee: bigint }[]> {
  try { return [{ ids, fee: await quote(ids) }]; }
  catch (e) {
    if (!custody(e)) throw e;
    const out: { ids: bigint[]; fee: bigint }[] = [];
    for (const id of ids) {
      try { out.push({ ids: [id], fee: await quote([id]) }); }
      catch (one) { if (!custody(one)) throw one; unreadable(id); }
    }
    return out;
  }
}

export async function isolatedPush(ids: bigint[], quote: (ids: bigint[]) => Promise<bigint>, send: (ids: bigint[], fee: bigint) => Promise<SendResult>, unreadable: (id: bigint) => void): Promise<{ ids: bigint[]; result: SendResult }[]> {
  const out: { ids: bigint[]; result: SendResult }[] = [];
  for (const q of await isolatedQuotes(ids, quote, unreadable)) {
    let r: SendResult;
    try { r = await send(q.ids, q.fee); }
    catch (e) { if (!custody(e)) throw e; r = { status: "reverted", reason: "CustodyUnreadable" }; }
    if (r.status === "reverted" && r.reason.includes("CustodyUnreadable")) {
      if (q.ids.length === 1) unreadable(q.ids[0]!);
      else {
        // Custody can fail between quote and simulation: retry each rig independently.
        for (const id of q.ids) out.push(...await isolatedPush([id], quote, send, unreadable));
      }
    } else out.push({ ids: q.ids, result: r });
  }
  return out;
}
