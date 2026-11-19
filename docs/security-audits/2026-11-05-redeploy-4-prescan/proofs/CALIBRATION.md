# Calibration of the Codex scan method (2026-11-05), for the report's Methodology

Before the scan of `ceed0a2`, the coordinating session ran the same method on commit `e710426`, the 2026-11-02 stack, whose defects are known from the 2026-11-04 review. The sessions were not told this was a calibration. Two units only, because the point was the two High and Medium defects that earlier Codex passes had not established. Folders: `D:\TapePool-blind4\codex\o-feed`, `o-evidence`.

| Known defect (2026-11-04 review) | Unit | Result |
|---|---|---|
| H-01 High, raw `bonus` next to mult-scaled `verifWeight` | feed | **Found as High** by Sol in about 15 minutes, with a live read of three Behemoth miners, the same numbers as the review (circuit 52: 48 weight, 24 base) and a policy test. Astra, reviewing another unit, also found it on its own (its C-01) |
| L-03 Low, same root cause as H-01 | feed | Covered by the same finding |
| M-01 Medium, a feed brake drops rows B and U in a clear | agent-evidence | **Found as a lead, not a finding.** Sol reproduced the exact sequence with a test (1 BEM of doubtful principal restored, 0.53 BEM more redeemed). It left it unscored because the spec's text at that commit allowed it. Astra kept it an unscored lead, and rejected a direct break of invariant 16 |
| L-02 Low, a zero `ownerOf` answer becomes evidence | feed | **Not reported.** Sol tested that case and recorded it as conforming, since the spec's text at that commit did not forbid it |
| L-01 Low and L-04 Low | not in these two units | Not measured |

**What this says about the method.**

- It finds what the earlier Codex passes did not: live reads and the units table reached H-01 quickly.
- It is weak where the code conforms to a sentence of the spec and the fault lies in what the sentence allows. Both misses and the unscored lead are of that kind. So no lead may stay unscored: triage decides each lead against §15, §8 and template §5, and the owner sees every one.
- A filter stop ended Sol's feed session twice. A fresh session reading the saved files finished the unit, so a stop costs time and not coverage.
- These are two units on one commit, so this is a check that the method works, not a measured detection rate.
