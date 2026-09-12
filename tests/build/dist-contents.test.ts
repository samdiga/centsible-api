import { access, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const distDirectory = resolve(repositoryRoot, "dist");
const verifier = resolve(repositoryRoot, "scripts/verify-clean-build.sh");

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? listFiles(path) : [path];
      }),
    )
  ).flat();
}

describe("clean production build safeguards", () => {
  it("provides a staged-tree clean-build verifier", async () => {
    await expect(access(verifier)).resolves.toBeUndefined();
    const source = await readFile(verifier, "utf8");
    expect(source).toContain("git write-tree");
    expect(source).toContain("git archive");
    expect(source).toContain("pnpm install --frozen-lockfile");
    expect(source).toContain("pnpm test --");
  });

  it("keeps compiled output free of tests and sibling package imports", async () => {
    try {
      await access(distDirectory);
    } catch {
      return;
    }
    const files = await listFiles(distDirectory);
    expect(files.some((file) => file.endsWith(".test.js"))).toBe(false);
    const contents = await Promise.all(
      files.map((file) => readFile(file, "utf8")),
    );
    expect(contents.join("\n")).not.toMatch(/@centsible\//);
    expect(contents.join("\n")).not.toContain(
      "/Users/samdiga/code/centsible-claude",
    );
  });
});
