import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_CHANGES = [
  [
    ["M", "apps/api/src/repos/accounts.ts"],
    ["M", "apps/api/src/repos/accounts.test.ts"],
  ],
  [
    ["M", "apps/api/src/repos/accounts.ts"],
    ["M", "apps/api/src/repos/accounts.test.ts"],
  ],
  [
    ["M", "apps/api/src/routes/accounts.ts"],
    ["M", "apps/api/src/repos/accounts.ts"],
    ["A", "apps/api/src/services/accounts.ts"],
    ["A", "apps/api/src/services/accounts.test.ts"],
  ],
];

function runGit(sourceRoot, args, failureMessage) {
  try {
    return execFileSync("git", args, {
      cwd: sourceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(failureMessage);
  }
}

function assertCommitExists(sourceRoot, commit) {
  runGit(
    sourceRoot,
    ["cat-file", "-e", `${commit}^{commit}`],
    `missing commit ${commit}`,
  );
}

function assertDirectChild(sourceRoot, parent, child) {
  const actualParent = runGit(
    sourceRoot,
    ["rev-parse", `${child}^`],
    `missing parent for commit ${child}`,
  );
  if (actualParent !== parent) {
    throw new Error(`${child} is not a direct child of ${parent}`);
  }
}

function assertAncestor(sourceRoot, ancestor, descendant) {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { cwd: sourceRoot, stdio: "ignore" },
  );
  if (result.status !== 0) {
    throw new Error(`${ancestor} is not an ancestor of ${descendant}`);
  }
}

function changedPaths(sourceRoot, commit) {
  const output = runGit(
    sourceRoot,
    ["diff-tree", "--no-commit-id", "--name-status", "-r", commit],
    `could not inspect commit ${commit}`,
  );
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t", 2));
}

function assertExpectedChanges(sourceRoot, commit, expected) {
  const actual = changedPaths(sourceRoot, commit).sort((left, right) =>
    left.join("\t").localeCompare(right.join("\t")),
  );
  const expectedPaths = [...expected].sort((left, right) =>
    left.join("\t").localeCompare(right.join("\t")),
  );
  if (JSON.stringify(actual) !== JSON.stringify(expectedPaths)) {
    throw new Error(
      `unexpected changed paths in ${commit}: expected ${JSON.stringify(expectedPaths)}, received ${JSON.stringify(actual)}`,
    );
  }
}

export function verifySupplementalSource({
  sourceRoot,
  sourceCommit,
  supplementalCommits,
}) {
  if (!Array.isArray(supplementalCommits) || supplementalCommits.length !== 3) {
    throw new Error("supplemental source must contain exactly three commits");
  }

  assertCommitExists(sourceRoot, sourceCommit);
  for (const commit of supplementalCommits) {
    assertCommitExists(sourceRoot, commit);
  }
  assertAncestor(sourceRoot, sourceCommit, supplementalCommits[0]);
  assertDirectChild(sourceRoot, supplementalCommits[0], supplementalCommits[1]);
  assertDirectChild(sourceRoot, supplementalCommits[1], supplementalCommits[2]);

  supplementalCommits.forEach((commit, index) => {
    assertExpectedChanges(sourceRoot, commit, EXPECTED_CHANGES[index]);
  });
}

function loadSourcePin() {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const routeManifest = JSON.parse(
    readFileSync(
      resolve(projectRoot, "tests/contract/source-route-manifest.json"),
      "utf8",
    ),
  );
  const testManifest = JSON.parse(
    readFileSync(
      resolve(projectRoot, "tests/contract/source-test-manifest.json"),
      "utf8",
    ),
  );
  if (
    routeManifest.sourceCommit !== testManifest.sourceCommit ||
    !Array.isArray(routeManifest.supplementalCommits) ||
    !Array.isArray(testManifest.supplementalCommits) ||
    JSON.stringify(routeManifest.supplementalCommits) !==
      JSON.stringify(testManifest.supplementalCommits)
  ) {
    throw new Error("source manifests do not share one supplemental pin");
  }
  return {
    sourceCommit: routeManifest.sourceCommit,
    supplementalCommits: routeManifest.supplementalCommits,
  };
}

function main() {
  const sourceRoot = process.argv[2];
  if (!sourceRoot) {
    throw new Error(
      "usage: node scripts/verify-supplemental-source.mjs <source-root>",
    );
  }
  const pin = loadSourcePin();
  verifySupplementalSource({ sourceRoot, ...pin });
  console.log(
    `Verified supplemental source ${pin.supplementalCommits.join(", ")}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
