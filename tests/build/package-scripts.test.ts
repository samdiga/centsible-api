import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("package scripts", () => {
  it("exposes separate API and worker lifecycle commands", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["start:api"]).toContain("dist/entrypoints/api.js");
    expect(pkg.scripts["start:worker"]).toContain("dist/entrypoints/worker.js");
    expect(pkg.scripts["dev:api"]).toContain("entrypoints/api.ts");
    expect(pkg.scripts["dev:worker"]).toContain("entrypoints/worker.ts");
    expect(pkg.scripts["dev:api"]).not.toContain("src/entrypoints");
    expect(pkg.scripts["dev:worker"]).not.toContain("src/entrypoints");
    expect(pkg.scripts.build).toContain("tsconfig.build.json");
  });

  it("keeps test-only scripts and support code out of the production build", () => {
    const buildConfig = JSON.parse(
      readFileSync("tsconfig.build.json", "utf8"),
    ) as {
      include: string[];
      exclude: string[];
    };

    expect(buildConfig.include).toEqual([
      "src",
      "app",
      "entrypoints",
      "database",
    ]);
    expect(buildConfig.exclude).toContain("tests/**");
  });
});
