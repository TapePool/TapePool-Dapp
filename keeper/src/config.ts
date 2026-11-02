// Keeper configuration from the environment (SPEC-PHASE3-KEEPER §8). Secrets are only read here and
// are registered for log redaction; they are never logged or put in an alert.
import { getAddress, isAddress, parseEther, zeroAddress, type Hex } from "viem";
import { DEPLOYMENT, type Deployment } from "./addresses.js";

export type Mode = "dry" | "live";

export interface Config {
  deployment: Deployment | null;
  mode: Mode;
  xlayerRpc: string; // the first of xlayerRpcs: the endpoint transactions are sent through
  xlayerRpcs: string[]; // every X Layer endpoint, in order: reads fall back across them (part E §3.2)
  bscRpc: string;
  privateKey: Hex;
  telegramToken: string;
  telegramChatId: string;
  seizedHarvestEveryHours: number; // part D §5.1: open loans follow their maturity instead
  bnbReserve: bigint;
  sweepMin: bigint;
  pushDailyMax: number;
  /** OKB per BNB, scaled by 1e18, for the fee coverage watch (part D §5.3); null when unset. */
  okbPerBnb: bigint | null;
  appOrigins: string[];
  port: number;
  statePath: string;
  suspendOnRevoke: boolean; // K-O5
  holdHarvestOnVaultFreeze: boolean; // K-O6
  secrets: string[];
}

/** Per-rig, per-borrower and per-IP push limits are constants (SPEC-PHASE3-KEEPER §5.3 rule 6, part D D-O4). */
export const PUSH_LIMITS = { perRigDaily: 3, perRigWeekly: 10, perBorrowerDaily: 3, perIpHourly: 10 } as const;

/** A complete explicit replacement; the coordinator confirms RD-02 before selecting it. */
export function loadDeployment(env: NodeJS.ProcessEnv): Deployment | null {
  const names = ["POOL", "FACTORY", "SCREEN", "RECEIVER", "REPORTER", "LENS"] as const;
  const blocks = ["FACTORY", "POOL", "RECEIVER", "REPORTER"] as const;
  if (![...names.map((n) => `KEEPER_${n}`), ...blocks.map((n) => `KEEPER_${n}_DEPLOY_BLOCK`)].some((n) => env[n]?.trim())) return DEPLOYMENT;
  if (env.KEEPER_CUTOVER_RD02 !== "confirmed") throw new Error("new deployment requires KEEPER_CUTOVER_RD02=confirmed after CheckOldStack");
  const addresses = Object.fromEntries(names.map((n) => {
    const v = req(env, `KEEPER_${n}`);
    if (!isAddress(v) || v === zeroAddress) throw new Error(`KEEPER_${n} must be a nonzero address`);
    return [n.toLowerCase(), getAddress(v)];
  }));
  const heights = Object.fromEntries(blocks.map((n) => {
    const v = req(env, `KEEPER_${n}_DEPLOY_BLOCK`);
    if (!/^\d+$/.test(v) || BigInt(v) === 0n) throw new Error(`KEEPER_${n}_DEPLOY_BLOCK must be a positive block`);
    return [`${n.toLowerCase()}DeployBlock`, BigInt(v)];
  }));
  return { ...addresses, ...heights, legacy: false } as unknown as Deployment;
}

/** A positive decimal (for example "6.44"), scaled by 1e18; null when unset. */
function decimal(env: NodeJS.ProcessEnv, name: string): bigint | null {
  const v = env[name]?.trim();
  if (v === undefined || v === "") return null;
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`${name} must be a positive decimal number`);
  const scaled = parseEther(v);
  if (scaled <= 0n) throw new Error(`${name} must be a positive decimal number`);
  return scaled;
}

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (v === undefined || v.trim() === "") throw new Error(`missing environment variable ${name}`);
  return v.trim();
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const v = env[name]?.trim().toLowerCase();
  if (v === undefined || v === "") return fallback;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new Error(`${name} must be true or false`);
}

const PUBLIC_XLAYER_RPC = "https://rpc.xlayer.tech";
/** The known public X Layer endpoints: not secret. Any other URL in XLAYER_RPC is redacted (part E §3.2). */
const PUBLIC_XLAYER_RPCS = [PUBLIC_XLAYER_RPC, "https://xlayerrpc.okx.com", "https://xlayer.drpc.org"];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const modeRaw = (env.KEEPER_MODE ?? "dry").trim().toLowerCase();
  if (modeRaw !== "dry" && modeRaw !== "live") throw new Error("KEEPER_MODE must be dry or live");
  const pk = req(env, "KEEPER_PRIVATE_KEY");
  const privateKey = (pk.startsWith("0x") ? pk : `0x${pk}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("KEEPER_PRIVATE_KEY has the wrong format");
  const bscRpc = req(env, "BSC_RPC");
  const telegramToken = req(env, "TELEGRAM_BOT_TOKEN");
  const listed = (env.XLAYER_RPC ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const xlayerRpcs = listed.length > 0 ? listed : [PUBLIC_XLAYER_RPC];
  const xlayerRpc = xlayerRpcs[0]!;
  return {
    deployment: loadDeployment(env),
    mode: modeRaw,
    xlayerRpc,
    xlayerRpcs,
    bscRpc,
    privateKey,
    telegramToken,
    telegramChatId: req(env, "TELEGRAM_CHAT_ID"),
    seizedHarvestEveryHours: num(env, "SEIZED_HARVEST_EVERY_H", 168),
    bnbReserve: parseEther(env.BNB_RESERVE?.trim() || "0.01"),
    sweepMin: BigInt(env.SWEEP_MIN?.trim() || "1000"),
    pushDailyMax: num(env, "PUSH_DAILY_MAX", 10),
    okbPerBnb: decimal(env, "OKB_PER_BNB"),
    appOrigins: (env.APP_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    port: num(env, "PORT", 8080),
    statePath: env.STATE_PATH?.trim() || "/data/state.json",
    suspendOnRevoke: flag(env, "SUSPEND_ON_REVOKE", true),
    holdHarvestOnVaultFreeze: flag(env, "HOLD_HARVEST_ON_VAULT_FREEZE", true),
    // a keyed X Layer endpoint is as secret as the BSC one: RPC errors quote the URL
    secrets: [privateKey, privateKey.slice(2), bscRpc, telegramToken, ...xlayerRpcs.filter((u) => !PUBLIC_XLAYER_RPCS.includes(u.replace(/\/+$/, "")))],
  };
}
