import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import routes from "./source-route-manifest.json" with { type: "json" };
import tests from "./source-test-manifest.json" with { type: "json" };

function createUnpinnedSourceFixture(): string {
  const sourceRoot = mkdtempSync(join(tmpdir(), "centsible-source-fixture-"));
  execFileSync("git", ["init", "--quiet", sourceRoot]);
  execFileSync("git", [
    "-C",
    sourceRoot,
    "-c",
    "user.name=Centsible Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "Unpinned fixture",
  ]);
  return sourceRoot;
}

describe("pinned source inventory", () => {
  it("contains every canonical handler and recurring alias", () => {
    expect(routes.sourceCommit).toBe(
      "06d3972a7ffc88b6c65a4bab4ad47487e55b800c",
    );
    expect(routes.supplementalCommits).toEqual([
      "ca000fbb1f1755e77b22970ba6ff11ce520aa4ea",
      "32515278be92347635081bac76cf1766bb563189",
      "423879917c74cce21ccafa606279cc0511d4da91",
    ]);
    expect(routes.canonical).toHaveLength(65);
    expect(routes.aliases).toHaveLength(9);
  });

  it("pins every canonical method and mounted path", () => {
    expect(
      routes.canonical.map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      "GET /health",
      "GET /accounts",
      "POST /accounts",
      "PATCH /accounts/:accountId",
      "DELETE /accounts/:accountId",
      "POST /accounts/:accountId/refresh-balance",
      "GET /transactions",
      "GET /transactions/export",
      "GET /transactions/:id",
      "POST /transactions/bulk",
      "PATCH /transactions/:id",
      "GET /dashboard/net-worth/history",
      "GET /dashboard/summary",
      "GET /categories",
      "POST /categories",
      "PATCH /categories/:id",
      "DELETE /categories/:id",
      "GET /tags",
      "POST /tags",
      "PATCH /tags/:id",
      "DELETE /tags/:id",
      "GET /rules/preview",
      "GET /rules",
      "POST /rules",
      "PATCH /rules/:id",
      "DELETE /rules/:id",
      "POST /rules/:id/apply",
      "GET /budgets/suggestions",
      "GET /budgets/active",
      "POST /budgets",
      "GET /budgets/:id/progress",
      "PUT /budgets/:id/items",
      "PATCH /budgets/active/items/:categoryId",
      "DELETE /budgets/active/items/:categoryId",
      "GET /bills",
      "POST /bills",
      "PATCH /bills/:id",
      "POST /bills/detect",
      "DELETE /bills/:id",
      "GET /bills/:id",
      "GET /bills/:id/occurrences",
      "POST /bills/:id/occurrences/:occId/mark-paid",
      "POST /bills/:id/occurrences/:occId/skip",
      "GET /forecast",
      "GET /forecast/accuracy",
      "GET /notifications/preferences",
      "PATCH /notifications/preferences",
      "PUT /notifications/push-token",
      "DELETE /notifications/push-token",
      "GET /reports/summary",
      "GET /user/export",
      "POST /user/import",
      "DELETE /user/data",
      "GET /pipeline/runs",
      "GET /pipeline/runs/:id",
      "POST /pipeline/run",
      "GET /pipeline/schedule",
      "PUT /pipeline/schedule",
      "GET /plaid/items",
      "POST /plaid/link-token",
      "POST /plaid/exchange",
      "POST /plaid/items/:itemId/refresh",
      "POST /plaid/items/:itemId/update-link-token",
      "DELETE /plaid/items/:itemId",
      "POST /plaid/webhook",
    ]);
    expect(
      routes.canonical.find(
        ({ method, path }) => method === "POST" && path === "/plaid/webhook",
      ),
    ).toMatchObject({ target: "centsy" });
  });

  it("pins every recurring alias to its canonical bills operation", () => {
    expect(
      routes.aliases.map(
        ({ method, path, canonicalPath }) =>
          `${method} ${path} => ${canonicalPath}`,
      ),
    ).toEqual([
      "GET /recurring => /bills",
      "POST /recurring => /bills",
      "PATCH /recurring/:id => /bills/:id",
      "POST /recurring/detect => /bills/detect",
      "DELETE /recurring/:id => /bills/:id",
      "GET /recurring/:id => /bills/:id",
      "GET /recurring/:id/occurrences => /bills/:id/occurrences",
      "POST /recurring/:id/occurrences/:occId/mark-paid => /bills/:id/occurrences/:occId/mark-paid",
      "POST /recurring/:id/occurrences/:occId/skip => /bills/:id/occurrences/:occId/skip",
    ]);
  });

  it("accounts for all API and shared support test files", () => {
    expect(tests.apiFiles).toHaveLength(40);
    expect(tests.sharedSupportFiles).toHaveLength(11);
    expect(tests.supplementalCommits).toEqual([
      "ca000fbb1f1755e77b22970ba6ff11ce520aa4ea",
      "32515278be92347635081bac76cf1766bb563189",
      "423879917c74cce21ccafa606279cc0511d4da91",
    ]);
    expect(tests.supplementalTestFiles).toEqual([
      {
        path: "apps/api/src/repos/accounts.test.ts",
        change: "modified",
        sourceCommits: [
          "ca000fbb1f1755e77b22970ba6ff11ce520aa4ea",
          "32515278be92347635081bac76cf1766bb563189",
        ],
      },
      {
        path: "apps/api/src/services/accounts.test.ts",
        change: "added",
        sourceCommits: ["423879917c74cce21ccafa606279cc0511d4da91"],
      },
    ]);
  });

  it("accepts only the pinned source checkout", () => {
    const unqualifiedEnv = { ...process.env };
    delete unqualifiedEnv.CENTSIBLE_SOURCE_ROOT;
    const accepted = spawnSync("node", ["scripts/verify-source-pin.mjs"], {
      encoding: "utf8",
      env: unqualifiedEnv,
    });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain(
      "Verified pinned source 06d3972a7ffc88b6c65a4bab4ad47487e55b800c",
    );

    const unpinnedSourceRoot = createUnpinnedSourceFixture();
    try {
      const rejected = spawnSync("node", ["scripts/verify-source-pin.mjs"], {
        encoding: "utf8",
        env: {
          ...process.env,
          CENTSIBLE_SOURCE_ROOT: unpinnedSourceRoot,
        },
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("does not match pinned");
    } finally {
      rmSync(unpinnedSourceRoot, { force: true, recursive: true });
    }
  });
});
