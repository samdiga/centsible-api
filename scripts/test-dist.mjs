import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distributionDirectory = resolve(repositoryRoot, "dist");

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    }),
  );
  return files.flat();
}

const distributionFiles = (await listFiles(distributionDirectory)).map((path) =>
  relative(distributionDirectory, path),
);

const testArtifacts = distributionFiles.filter(
  (path) => path.endsWith(".test.js") || path.split(sep).includes("tests"),
);

assert.deepEqual(
  testArtifacts,
  [],
  `distribution contains test artifacts: ${testArtifacts.join(", ")}`,
);

const distributionImports = await Promise.all(
  distributionFiles
    .filter((path) => path.endsWith(".js"))
    .map((path) =>
      import("node:fs/promises").then(({ readFile }) =>
        readFile(resolve(distributionDirectory, path), "utf8"),
      ),
    ),
);
const distributionSource = distributionImports.join("\n");

assert.doesNotMatch(distributionSource, /@centsible\//);
assert.doesNotMatch(
  distributionSource,
  /\/Users\/samdiga\/code\/centsible-claude/,
);
assert.doesNotMatch(
  distributionSource,
  /(?:from|import)\s*["'][^"']*\.tsx?["']/,
);

const { createHttpApp } = await import("../dist/app/create-http-app.js");
const app = createHttpApp();
const response = await app.request("/health");
const body = await response.json();

assert.equal(response.status, 200);
assert.equal(body.status, "ok");
assert.equal(body.service, "centsible-api");
assert.match(body.timestamp, /^\d{4}-\d{2}-\d{2}T/);

const { createWorker } = await import("../dist/app/create-worker.js");
const worker = createWorker({ adapters: [{ enabled: false }] });
await worker.start();
await worker.stop();
