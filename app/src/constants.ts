/** Rules of the contracts that the screens quote or compute with (SPEC §4-§8). Parameters the owner can change live in the view model instead. */

export const MIN_RIG_AGE = 3 * 86_400; // seconds
export const REPORT_FUTURE_SKEW = 60; // a report may be observed up to 60 s ahead of the chain clock
export const REPORT_VALID_FOR = 300; // seconds a report stays usable
export const COUNTDOWN_MARGIN = 15; // the borrow countdown ends this early so the transaction can land
export const MAX_COLLATERAL = 16;
export const LATE_HARVEST_EVERY = 72 * 3_600; // seconds, "about every 72 h" after maturity
export const DAY = 86_400;
export const HOUR = 3_600;

export const BEM_DECIMALS = 8;
export const TPBEM_DECIMALS = 14;
export const NATIVE_DECIMALS = 18;

export const MIN_AMOUNT_STEP = 10_000n; // the amount boxes work in steps of 0.0001 BEM
export const QUEUE_GRACE = 7 * 86_400; // TapePool.QUEUE_GRACE: a queued change can be executed until this long after its eta

/* ───────── BEM mined before a loan (SPEC-PHASE5-PRELOAN) ───────── */

/** `RigVault.BOND` (raw BEM): a harvest whose batch total is below it pulls a bond from the caller. 0.0001 BEM. */
export const BOND = 10_000n;
/** `RigVault.DUST` (raw BEM): a harvest sends each rig's balance rounded down to a multiple of this. */
export const DUST = 100n;
/** The choice between harvesting first and keeping the BEM in the loan is required from this share of the debt (owner decision O-1). */
export const REQUIRED_SHARE_PCT = 10n;
/** The BEM OFT adapter's `feeBps` is read at each refresh; when that read fails the 5% maximum is assumed, as the keeper does. */
export const BRIDGE_FEE_BPS_MAX = 500;
/** A harvest from here never sends more than this much BNB (a hard cap, in wei): 0.01 BNB. */
export const MAX_HARVEST_VALUE = 10n ** 16n;
/** The app reads BSC this many blocks behind the head, and four behind on a retry, so a load-balanced public node has the block. */
export const BSC_PIN_LAG = 2n;
export const BSC_PIN_LAG_RETRY = 4n;
/** X Layer's clock must pass the harvest's BSC time by more than this many seconds before the voucher may move. */
export const GATE_MARGIN = 2;
/** A harvest record that has not settled this long after it was written offers "Move anyway" (seconds). */
export const STUCK_AFTER = 600;
/** Without a readable `finalized` block, a BSC block this many blocks behind the head counts as final. */
export const FINAL_LAG = 15n;
/** A `passed` record whose voucher never moved is dropped after this long (seconds). */
export const PASSED_KEEP = 24 * 3_600;
/** A harvest that was paid to the agent and has not been seen landing there for this long offers to take the voucher back (seconds). */
export const LANDING_WAIT = 900;
/** The ERC-1967 implementation slot of a proxy. */
export const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
