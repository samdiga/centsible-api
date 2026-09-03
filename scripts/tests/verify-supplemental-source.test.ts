import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { verifySupplementalSource } from "../verify-supplemental-source.mjs";

const temporaryRepositories: string[] = [];

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function write(root: string, path: string, contents: string): void {
  const filename = join(root, path);
  mkdirSync(join(filename, ".."), { recursive: true });
  writeFileSync(filename, contents);
}

function commit(root: string, message: string): string {
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function createSourceFixture(
  options: {
    extraPath?: boolean | undefined;
    wrongChangeStatus?: boolean | undefined;
  } = {},
): {
  root: string;
  base: string;
  supplementalCommits: readonly [string, string, string];
} {
  const root = mkdtempSync(join(tmpdir(), "centsible-source-"));
  temporaryRepositories.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.test"]);
  git(root, ["config", "user.name", "Test User"]);

  write(root, "apps/api/src/repos/accounts.ts", "base repository\n");
  if (!options.wrongChangeStatus) {
    write(
      root,
      "apps/api/src/repos/accounts.test.ts",
      "base repository test\n",
    );
  }
  write(root, "apps/api/src/routes/accounts.ts", "base route\n");
  const base = commit(root, "base");

  write(root, "apps/api/src/repos/accounts.ts", "relinked repository\n");
  write(
    root,
    "apps/api/src/repos/accounts.test.ts",
    "relinked repository test\n",
  );
  if (options.extraPath) {
    write(root, "apps/mobile/src/account-card.ts", "unapproved\n");
  }
  const relinked = commit(root, "relink");

  write(root, "apps/api/src/repos/accounts.ts", "removed repository\n");
  write(
    root,
    "apps/api/src/repos/accounts.test.ts",
    "removed repository test\n",
  );
  const removed = commit(root, "removed");

  write(root, "apps/api/src/routes/accounts.ts", "deleted route\n");
  write(root, "apps/api/src/repos/accounts.ts", "deleted repository\n");
  write(root, "apps/api/src/services/accounts.ts", "deleted service\n");
  write(
    root,
    "apps/api/src/services/accounts.test.ts",
    "deleted service test\n",
  );
  const deleted = commit(root, "delete account");

  return {
    root,
    base,
    supplementalCommits: [relinked, removed, deleted],
  };
}

afterEach(() => {
  for (const root of temporaryRepositories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("verifySupplementalSource", () => {
  it("accepts only the approved supplemental accounts history", () => {
    const fixture = createSourceFixture();

    expect(() =>
      verifySupplementalSource({
        sourceRoot: fixture.root,
        sourceCommit: fixture.base,
        supplementalCommits: fixture.supplementalCommits,
      }),
    ).not.toThrow();
  });

  it("fails closed when a required supplemental commit is unknown", () => {
    const fixture = createSourceFixture();

    expect(() =>
      verifySupplementalSource({
        sourceRoot: fixture.root,
        sourceCommit: fixture.base,
        supplementalCommits: [
          fixture.supplementalCommits[0],
          "0000000000000000000000000000000000000000",
          fixture.supplementalCommits[2],
        ],
      }),
    ).toThrow("missing commit");
  });

  it("fails closed when supplemental commits do not have direct parentage", () => {
    const fixture = createSourceFixture();

    expect(() =>
      verifySupplementalSource({
        sourceRoot: fixture.root,
        sourceCommit: fixture.base,
        supplementalCommits: [
          fixture.supplementalCommits[0],
          fixture.supplementalCommits[2],
          fixture.supplementalCommits[1],
        ],
      }),
    ).toThrow("direct child");
  });

  it("fails closed when a supplemental commit changes an unapproved path", () => {
    const fixture = createSourceFixture({ extraPath: true });

    expect(() =>
      verifySupplementalSource({
        sourceRoot: fixture.root,
        sourceCommit: fixture.base,
        supplementalCommits: fixture.supplementalCommits,
      }),
    ).toThrow("unexpected changed paths");
  });

  it("fails closed when an approved path has the wrong change status", () => {
    const fixture = createSourceFixture({ wrongChangeStatus: true });

    expect(() =>
      verifySupplementalSource({
        sourceRoot: fixture.root,
        sourceCommit: fixture.base,
        supplementalCommits: fixture.supplementalCommits,
      }),
    ).toThrow("unexpected changed paths");
  });
});
