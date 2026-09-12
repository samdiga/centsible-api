import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const expected = "06d3972a7ffc88b6c65a4bab4ad47487e55b800c";
export const DEFAULT_PINNED_SOURCE_ROOT =
  "/private/tmp/centsible-source-pin-06d3972";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(
  process.env.CENTSIBLE_SOURCE_ROOT || DEFAULT_PINNED_SOURCE_ROOT,
);

function git(...args) {
  return execFileSync("git", ["-C", sourceRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8"));
}

function assertSamePaths(label, actual, expectedPaths) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expectedPaths].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(`${label} does not match the pinned manifest`);
  }
}

const actual = git("rev-parse", "HEAD");
if (actual !== expected) {
  throw new Error(`Source commit ${actual} does not match pinned ${expected}`);
}

const routeManifest = readJson("tests/contract/source-route-manifest.json");
const testManifest = readJson("tests/contract/source-test-manifest.json");
if (
  routeManifest.sourceCommit !== expected ||
  testManifest.sourceCommit !== expected
) {
  throw new Error("A source manifest does not identify the pinned commit");
}

const sourceFiles = git("ls-tree", "-r", "--name-only", "HEAD")
  .split("\n")
  .filter(Boolean);
const sourceFileSet = new Set(sourceFiles);
const declaredFiles = new Set([
  // `pinned: false` marks a route added after the source pin (e.g. new
  // post-migration features) — it has no file in the pinned source tree by
  // definition, so it's excluded from this existence check rather than
  // given a fabricated path.
  ...routeManifest.canonical
    .filter((route) => route.pinned !== false)
    .map((route) => route.source),
  ...testManifest.apiFiles,
  ...testManifest.sharedSupportFiles,
  ...testManifest.generatedMigrations,
  ...testManifest.rawMigrations,
  ...testManifest.migrationMetadata,
  ...testManifest.copiedSupportFiles,
]);

for (const path of declaredFiles) {
  if (!sourceFileSet.has(path)) {
    throw new Error(`Pinned source file is missing: ${path}`);
  }
}

assertSamePaths(
  "API tests",
  sourceFiles.filter(
    (path) => path.startsWith("apps/api/src/") && path.endsWith(".test.ts"),
  ),
  testManifest.apiFiles,
);
assertSamePaths(
  "Shared support tests",
  sourceFiles.filter(
    (path) =>
      path.endsWith(".test.ts") &&
      (path.startsWith("packages/shared-types/src/") ||
        path.startsWith("packages/shared-logic/src/")),
  ),
  testManifest.sharedSupportFiles,
);
assertSamePaths(
  "Generated migrations",
  sourceFiles.filter((path) =>
    /^packages\/db\/drizzle\/\d{4}_[^/]+\.sql$/.test(path),
  ),
  testManifest.generatedMigrations,
);
assertSamePaths(
  "Raw migrations",
  sourceFiles.filter((path) =>
    /^packages\/db\/drizzle\/raw\/\d{4}_[^/]+\.sql$/.test(path),
  ),
  testManifest.rawMigrations,
);

console.log(`Verified pinned source ${expected}`);
