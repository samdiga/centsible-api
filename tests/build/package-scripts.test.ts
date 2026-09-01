import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("package scripts", () => {
  it("exposes separate API and worker lifecycle commands", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["start:api"]).toContain("dist/entrypoints/api.js");
    expect(pkg.scripts["start:worker"]).toContain("dist/entrypoints/worker.js");
    expect(pkg.scripts.build).toContain("tsconfig.build.json");
  });
});
