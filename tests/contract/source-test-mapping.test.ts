import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PlaidServiceError } from "../../src/modules/plaid/plaid.errors.js";
import mapping from "./source-test-mapping.json" with { type: "json" };
import sourceManifest from "./source-test-manifest.json" with { type: "json" };

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXPECTED_CENTSY_TARGETS = [
  "src/app/api/plaid/webhook/tests/route.test.ts",
  "src/lib/plaid/tests/verify-webhook.test.ts",
] as const;

function createCentsyTargetFixture(): string {
  const centsyRoot = mkdtempSync(join(tmpdir(), "centsy-target-fixture-"));
  for (const path of EXPECTED_CENTSY_TARGETS) {
    const target = resolve(centsyRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "// Centsy source-mapping target fixture.\n");
  }
  return centsyRoot;
}

type RepositoryName = "centsible-api" | "centsy";

function repositoryRoots(centsyRoot: string): Record<RepositoryName, string> {
  return {
    "centsible-api": API_ROOT,
    centsy: centsyRoot,
  };
}
type MappingEntry = {
  source: string;
  sourceCommits: string[];
  targets: Array<{
    repository: RepositoryName;
    path: string;
  }>;
  disposition?: "relocated";
  destination?: "centsy";
  reason?: string;
};
const entries = mapping.entries as MappingEntry[];
const baseApiFiles: readonly string[] = sourceManifest.apiFiles;
const baseSharedFiles: readonly string[] = sourceManifest.sharedSupportFiles;

const APPROVED_SUPPLEMENTAL_SHAS = [
  "ca000fbb1f1755e77b22970ba6ff11ce520aa4ea",
  "32515278be92347635081bac76cf1766bb563189",
  "423879917c74cce21ccafa606279cc0511d4da91",
] as const;

describe("source test mapping", () => {
  it("maps every unique approved source test exactly once", () => {
    const expectedSources = [
      ...sourceManifest.apiFiles,
      ...sourceManifest.sharedSupportFiles,
      ...sourceManifest.supplementalTestFiles.map(({ path }) => path),
    ];
    const actualSources = entries.map(({ source }) => source);

    expect(new Set(expectedSources).size).toBe(52);
    expect(actualSources).toHaveLength(new Set(actualSources).size);
    expect([...actualSources].sort()).toEqual(
      [...new Set(expectedSources)].sort(),
    );
  });

  it("records the complete commit provenance for every source test", () => {
    expect(mapping.sourceCommit).toBe(sourceManifest.sourceCommit);
    expect(mapping.supplementalCommits).toEqual(APPROVED_SUPPLEMENTAL_SHAS);

    for (const entry of entries) {
      const expectedCommits = [
        ...(baseApiFiles.includes(entry.source) ||
        baseSharedFiles.includes(entry.source)
          ? [sourceManifest.sourceCommit]
          : []),
        ...sourceManifest.supplementalTestFiles
          .filter(({ path }) => path === entry.source)
          .flatMap(({ sourceCommits }) => sourceCommits),
      ];
      expect(entry.sourceCommits, entry.source).toEqual(expectedCommits);
    }
  });

  it("uses only exact target test paths and every target exists", () => {
    const centsyRoot = createCentsyTargetFixture();
    try {
      const roots = repositoryRoots(centsyRoot);
      const centsyTargets = entries
        .flatMap(({ targets }) => targets)
        .filter(({ repository }) => repository === "centsy")
        .map(({ path }) => path)
        .sort();
      expect(centsyTargets).toEqual([...EXPECTED_CENTSY_TARGETS].sort());

      for (const entry of entries) {
        expect(
          entry.targets.length > 0 || entry.disposition === "relocated",
          entry.source,
        ).toBe(true);
        for (const target of entry.targets) {
          expect(target.path, entry.source).not.toMatch(/[?*[\]]/);
          expect(target.path, entry.source).toMatch(/\.test\.ts$/);
          expect(
            existsSync(resolve(roots[target.repository], target.path)),
            `${entry.source} -> ${target.repository}/${target.path}`,
          ).toBe(true);
        }
      }
    } finally {
      rmSync(centsyRoot, { force: true, recursive: true });
    }
  });

  it("documents every relocation with a destination and concrete reason", () => {
    const relocated = entries.filter(
      (entry) => entry.disposition === "relocated",
    );

    expect(relocated.length).toBeGreaterThan(0);
    for (const entry of relocated) {
      expect(entry.destination).toBe("centsy");
      expect(entry.reason?.length ?? 0, entry.source).toBeGreaterThan(20);
      expect(
        entry.targets.some(({ repository }) => repository === "centsy"),
        entry.source,
      ).toBe(true);
    }
  });
});

describe("source behaviors without a domain-local target test", () => {
  it.each([
    ["ITEM_LOGIN_REQUIRED", true],
    ["INVALID_ACCESS_TOKEN", true],
    ["ITEM_NOT_FOUND", true],
    ["RATE_LIMIT_EXCEEDED", false],
    ["INTERNAL_SERVER_ERROR", false],
    ["UNKNOWN", false],
  ] as const)(
    "preserves Plaid terminal classification for %s",
    (code, terminal) => {
      const error = new PlaidServiceError(
        code,
        "balance",
        502,
        "source detail",
      );
      expect(error.isTerminal).toBe(terminal);
    },
  );

  it("preserves the source-facing Plaid error fields and safe relink message", () => {
    const error = new PlaidServiceError(
      "ITEM_LOGIN_REQUIRED",
      "balance",
      502,
      "Balance refresh failed",
    );
    expect(error).toMatchObject({
      code: "PLAID_ITEM_LOGIN_REQUIRED",
      httpStatus: 502,
      userMessage: "This connection needs to be re-linked.",
    });
  });
});
