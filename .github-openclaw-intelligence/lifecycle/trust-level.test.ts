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

  test("higher permissions satisfy lower semi-trusted role requirements", () => {
    // Regression: admins/maintainers must not be locked out when a policy
    // (e.g. from an older install template) lists only "write".
    expect(
      resolveTrustLevel("owner", "admin", {
        trustedUsers: [],
        semiTrustedRoles: ["write"],
      }),
    ).toBe("semi-trusted");
    expect(
      resolveTrustLevel("maintainer", "maintain", {
        trustedUsers: [],
        semiTrustedRoles: ["write"],
      }),
    ).toBe("semi-trusted");
  });

  test("lower permissions do not satisfy higher role requirements", () => {
    expect(
      resolveTrustLevel("contributor", "write", {
        trustedUsers: [],
        semiTrustedRoles: ["admin"],
      }),
    ).toBe("untrusted");
  });

  test("unknown permission strings fail closed", () => {
    expect(
      resolveTrustLevel("mystery", "superuser", {
        trustedUsers: [],
        semiTrustedRoles: ["write"],
      }),
    ).toBe("untrusted");
  });

  test("retains backwards compatibility when no policy exists", () => {
    expect(resolveTrustLevel("octocat", "write")).toBe("trusted");
  });
});
