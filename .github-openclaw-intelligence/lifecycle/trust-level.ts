/**
 * trust-level.ts — Trust-level resolution for OpenClaw Intelligence.
 *
 * Determines the trust tier for a given GitHub actor based on the
 * repository's `trustPolicy` configuration.  The resolved level controls
 * what the agent is allowed to do during the workflow run:
 *
 *   • `trusted`       — full capabilities (all tools available)
 *   • `semi-trusted`  — read-only tools only (system-prompt restriction)
 *   • `untrusted`     — blocked or read-only response (no agent invocation)
 *
 * This module is intentionally free of side effects so it can be unit-tested
 * in isolation.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type TrustLevel = "trusted" | "semi-trusted" | "untrusted";

export interface TrustPolicy {
  trustedUsers?: string[];
  semiTrustedRoles?: string[];
  untrustedBehavior?: "read-only-response" | "block";
}

// ─── Permission hierarchy ─────────────────────────────────────────────────────

/**
 * GitHub repository permission levels ranked from lowest to highest.  Used so
 * that a higher permission always satisfies a lower role requirement (for
 * example an `admin` actor satisfies a `"write"` entry in
 * `semiTrustedRoles`).  Without this, older settings.json files that list
 * only `["write"]` would lock out repository admins and maintainers.
 */
const PERMISSION_RANK: Record<string, number> = {
  none: 0,
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5,
};

/**
 * Check whether an actor's permission satisfies a required role, taking the
 * GitHub permission hierarchy into account.  Unknown permission strings only
 * match by exact equality (fail closed).
 */
function permissionSatisfiesRole(actorPermission: string, role: string): boolean {
  if (actorPermission === role) return true;
  const actorRank = PERMISSION_RANK[actorPermission];
  const roleRank = PERMISSION_RANK[role];
  if (actorRank === undefined || roleRank === undefined) return false;
  return actorRank >= roleRank;
}

// ─── Resolution ───────────────────────────────────────────────────────────────

/**
 * Resolve the trust level for a given GitHub actor.
 *
 * @param actor           - The `github.actor` username (e.g. "octocat").
 * @param actorPermission - The actor's repository permission level
 *                          (e.g. "admin", "maintain", "write", "read", "none").
 * @param trustPolicy     - The `trustPolicy` section from settings.json.
 *                          When absent or undefined the actor is treated as
 *                          `trusted` for backwards compatibility.
 * @returns The resolved trust level.
 */
export function resolveTrustLevel(
  actor: string,
  actorPermission: string,
  trustPolicy?: TrustPolicy,
): TrustLevel {
  // No policy configured → backwards-compatible: everyone is trusted.
  if (!trustPolicy) return "trusted";

  // 1. Explicit trusted users list takes highest priority.
  if (trustPolicy.trustedUsers?.includes(actor)) return "trusted";

  // 2. Check if the actor's permission satisfies any semi-trusted role.
  //    Higher permissions satisfy lower role requirements (admin ≥ maintain ≥
  //    write), so listing "write" covers maintainers and admins too.
  if (trustPolicy.semiTrustedRoles?.some((role) => permissionSatisfiesRole(actorPermission, role))) {
    return "semi-trusted";
  }

  // 3. Everything else is untrusted.
  return "untrusted";
}
