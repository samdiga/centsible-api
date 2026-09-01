import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import routes from "./source-route-manifest.json" with { type: "json" };
import tests from "./source-test-manifest.json" with { type: "json" };

describe("pinned source inventory", () => {
  it("contains every canonical handler and recurring alias", () => {
    expect(routes.sourceCommit).toBe(
      "06d3972a7ffc88b6c65a4bab4ad47487e55b800c",
    );
    expect(routes.canonical).toHaveLength(54);
    expect(routes.aliases).toHaveLength(9);
  });

  it("accounts for all API and shared support test files", () => {
    expect(tests.apiFiles).toHaveLength(40);
    expect(tests.sharedSupportFiles).toHaveLength(11);
  });

  it("accepts only the pinned source checkout", () => {
    const accepted = spawnSync("node", ["scripts/verify-source-pin.mjs"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CENTSIBLE_SOURCE_ROOT: "/Users/samdiga/code/centsible-claude",
      },
    });
    expect(accepted.status, accepted.stderr).toBe(0);

    const rejected = spawnSync("node", ["scripts/verify-source-pin.mjs"], {
      encoding: "utf8",
      env: { ...process.env, CENTSIBLE_SOURCE_ROOT: process.cwd() },
    });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("does not match pinned");
  });
});
