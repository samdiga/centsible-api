import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distributionDirectory = resolve(repositoryRoot, "dist");

// Keep this destructive operation pinned to this repository's generated output.
if (
  dirname(distributionDirectory) !== repositoryRoot ||
  distributionDirectory !== resolve(repositoryRoot, "dist")
) {
  throw new Error("Refusing to clean an unexpected distribution directory");
}

await rm(distributionDirectory, { recursive: true, force: true });
