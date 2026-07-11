import { describe, expect, test } from "bun:test";
import { resolveTrustLevel } from "./trust-level";

describe("resolveTrustLevel", () => {
  test("gives explicitly trusted users highest priority", () => {
    expect(
      resolveTrustLevel("octocat", "read", {
        trustedUsers: ["octocat"],
        semiTrustedRoles: ["write"],
      }),
    ).toBe("trusted");
  });

  test("maps configured collaborator roles to semi-trusted", () => {
    expect(
      resolveTrustLevel("collaborator", "maintain", {
        trustedUsers: [],
        semiTrustedRoles: ["admin", "maintain", "write"],
      }),
    ).toBe("semi-trusted");
  });

  test("treats unmatched actors as untrusted", () => {
    expect(
      resolveTrustLevel("visitor", "read", {
        trustedUsers: [],
        semiTrustedRoles: ["write"],
      }),
    ).toBe("untrusted");
  });

  test("retains backwards compatibility when no policy exists", () => {
    expect(resolveTrustLevel("octocat", "write")).toBe("trusted");
  });
});
