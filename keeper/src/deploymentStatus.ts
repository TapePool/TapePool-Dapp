// Cutover identity (SPEC-REDEPLOY-4 RB4-03). HTTP answers use cached values and never read a chain.
import type { Address } from "viem";
import type { Deployment } from "./addresses.js";
import type { PublicDataApi } from "./publicData.js";

export const deploymentStatus = (d: Deployment | null, policy: Address | null) => ({
  pool: d?.pool ?? null,
  receiver: d?.receiver ?? null,
  reporter: d?.reporter ?? null,
  policy,
});

/** Include the selected stack even while stats are warming up; position answers retain their format. */
export function withDeploymentStatus(data: PublicDataApi, d: Deployment, policy: Address): PublicDataApi {
  return {
    stats: () => {
      const answer = data.stats();
      return { ...answer, body: { ...(answer.body as object), ...deploymentStatus(d, policy) } };
    },
    position: (address) => data.position(address),
  };
}
