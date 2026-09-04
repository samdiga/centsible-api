import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import {
  createIsolatedCleanup,
  createIsolatedConnectionConfig,
  closePools,
  createIsolatedSession,
  readTestDatabaseConfig,
  waitForBlockedBackend,
} from "./test-database.js";
import {
  quoteIdentifier,
  resolveMigrationSchema,
} from "../../database/migrate.js";

const safeEnvironment: NodeJS.ProcessEnv = {
  ALLOW_SHARED_SANDBOX_TEST_DATABASE: "true",
  DATABASE_ENVIRONMENT: "sandbox",
  NODE_ENV: "test",
  TEST_DATABASE_URL: "postgresql://user:password@example.test/centsible",
  TEST_SCHEMA_PREFIX: "centsible_test_",
};

class FakePool {
  closed = false;
  endFailures = 0;

  constructor(private readonly failureMessage = "end failed") {}

  async end(): Promise<void> {
    if (this.endFailures > 0) {
      this.endFailures -= 1;
      throw new Error(this.failureMessage);
    }
    this.closed = true;
  }
}

class FakeAdmin extends FakePool {
  droppedSchema: string | undefined;
  dropFailures = 0;

  async unsafe(query: string): Promise<void> {
    if (this.dropFailures > 0) {
      this.dropFailures -= 1;
      throw new Error("drop failed");
    }
    if (this.droppedSchema) {
      throw new Error("schema was dropped twice");
    }
    this.droppedSchema = query;
  }
}

class FakeSessionClient extends FakePool {
  constructor(
    readonly id: number,
    readonly searchPath: string,
  ) {
    super();
  }
}

describe("test database guard configuration", () => {
  it.each([
    [
      "missing TEST_DATABASE_URL",
      { TEST_DATABASE_URL: undefined },
      "TEST_DATABASE_URL is required",
    ],
    ["non-test NODE_ENV", { NODE_ENV: "production" }, "NODE_ENV must be test"],
    [
      "non-sandbox database environment",
      { DATABASE_ENVIRONMENT: "production" },
      "DATABASE_ENVIRONMENT must be sandbox",
    ],
    [
      "missing shared sandbox approval",
      { ALLOW_SHARED_SANDBOX_TEST_DATABASE: "false" },
      "without explicit guard",
    ],
    [
      "altered schema prefix",
      { TEST_SCHEMA_PREFIX: "other_" },
      "TEST_SCHEMA_PREFIX must be centsible_test_",
    ],
  ])("refuses %s", (_name, override, message) => {
    expect(() =>
      readTestDatabaseConfig({ ...safeEnvironment, ...override }),
    ).toThrow(message);
  });

  it("requires an externally supplied test URL instead of falling back to DATABASE_URL", () => {
    expect(() =>
      readTestDatabaseConfig({
        ...safeEnvironment,
        DATABASE_URL: "postgresql://user:password@example.test/production",
        TEST_DATABASE_URL: undefined,
      }),
    ).toThrow("TEST_DATABASE_URL is required");
  });
});

describe("isolated schema connection configuration", () => {
  it("rejects URL options that can override the schema-only startup path", () => {
    for (const parameter of ["options", "search_path", "SEARCH_PATH"]) {
      expect(() =>
        createIsolatedConnectionConfig(
          `postgresql://user:password@example-pooler.test/centsible?${parameter}=public`,
          "centsible_test_unit",
        ),
      ).toThrow("search_path");
    }
  });

  it("uses the same generated-schema startup path for every physical client", () => {
    const first = createIsolatedConnectionConfig(
      "postgresql://user:password@example-pooler.test/centsible?sslmode=require",
      "centsible_test_unit",
    );
    const reconnect = createIsolatedConnectionConfig(
      "postgresql://user:password@example-pooler.test/centsible?sslmode=require",
      "centsible_test_unit",
    );

    expect(first.url).toBe(reconnect.url);
    expect(first.url).not.toContain("-pooler");
    expect(new URL(first.url).searchParams.get("sslmode")).toBe("require");
    expect(first.options.connection.options).toBe(
      "-c search_path=centsible_test_unit",
    );
    expect(first.options.max).toBe(1);
    expect(reconnect.options.connection.options).toBe(
      "-c search_path=centsible_test_unit",
    );
  });

  it("turns over the physical client and rechecks the generated search path", async () => {
    const schemaName = "centsible_test_turnover";
    const first = new FakeSessionClient(1, schemaName);
    const second = new FakeSessionClient(2, schemaName);
    const clients = [first, second];
    const observedSearchPaths: string[] = [];
    const session = createIsolatedSession({
      assertConnection: async (client) => {
        observedSearchPaths.push(client.searchPath);
        expect(client.searchPath).toBe(schemaName);
      },
      createClient: () => {
        const client = clients.shift();
        if (!client) {
          throw new Error("unexpected reconnect");
        }
        return client;
      },
      createDb: (client) => ({ clientId: client.id }),
      schemaName,
    });

    await session.reconnect();

    expect(first.closed).toBe(true);
    expect(session.db.clientId).toBe(2);
    expect(observedSearchPaths).toEqual([schemaName]);
  });
});

describe("PostgreSQL contention observation", () => {
  it("waits until the intended holder PID blocks the waiter", async () => {
    let observations = 0;
    const observer = (async () => {
      observations += 1;
      return [{ blockers: observations === 1 ? [202] : [303] }];
    }) as unknown as Sql;

    await waitForBlockedBackend(observer, 101, 303, {
      intervalMs: 0,
      timeoutMs: 100,
    });

    expect(observations).toBe(2);
  });
});

describe("migration schema selection", () => {
  it("does not default the migration CLI to public", () => {
    expect(() => resolveMigrationSchema({})).toThrow(
      "DATABASE_SCHEMA is required",
    );
  });

  it("requires an explicit public migration approval", () => {
    expect(() => resolveMigrationSchema({ DATABASE_SCHEMA: "public" })).toThrow(
      "ALLOW_PUBLIC_DATABASE_MIGRATION=true",
    );
  });

  it("quotes only generated test schema identifiers", () => {
    expect(quoteIdentifier("centsible_test_unit_1")).toBe(
      '"centsible_test_unit_1"',
    );
    expect(() => quoteIdentifier("public")).toThrow("non-test schema");
    expect(() =>
      quoteIdentifier('centsible_test_x"; drop schema public; --'),
    ).toThrow("non-test schema");
  });
});

describe("isolated schema cleanup", () => {
  it("closes the schema pool and removes only the exact generated schema", async () => {
    const isolated = new FakePool();
    const admin = new FakeAdmin();
    const cleanup = createIsolatedCleanup({
      createAdmin: () => admin,
      isolated,
      schemaName: "centsible_test_cleanup",
    });

    await cleanup();
    await cleanup();

    expect(isolated.closed).toBe(true);
    expect(admin.closed).toBe(true);
    expect(admin.droppedSchema).toBe(
      'DROP SCHEMA "centsible_test_cleanup" CASCADE',
    );
  });

  it("keeps cleanup retryable when the exact schema drop fails", async () => {
    const isolated = new FakePool();
    const firstAdmin = new FakeAdmin();
    firstAdmin.dropFailures = 1;
    const secondAdmin = new FakeAdmin();
    const admins = [firstAdmin, secondAdmin];
    const cleanup = createIsolatedCleanup({
      createAdmin: () => {
        const admin = admins.shift();
        if (!admin) {
          throw new Error("unexpected cleanup attempt");
        }
        return admin;
      },
      isolated,
      schemaName: "centsible_test_retry",
    });

    await expect(cleanup()).rejects.toThrow("centsible_test_retry");
    await cleanup();

    expect(isolated.closed).toBe(true);
    expect(firstAdmin.closed).toBe(true);
    expect(secondAdmin.closed).toBe(true);
    expect(secondAdmin.droppedSchema).toBe(
      'DROP SCHEMA "centsible_test_retry" CASCADE',
    );
  });

  it("retries an admin shutdown without dropping the schema twice", async () => {
    const isolated = new FakePool();
    const admin = new FakeAdmin();
    admin.endFailures = 1;
    const cleanup = createIsolatedCleanup({
      createAdmin: () => admin,
      isolated,
      schemaName: "centsible_test_close_retry",
    });

    await expect(cleanup()).rejects.toThrow("centsible_test_close_retry");
    await cleanup();

    expect(admin.closed).toBe(true);
    expect(admin.droppedSchema).toBe(
      'DROP SCHEMA "centsible_test_close_retry" CASCADE',
    );
  });

  it("closes every pool even when one shutdown fails", async () => {
    const failing = new FakePool();
    failing.endFailures = 1;
    const closing = new FakePool();

    await expect(
      closePools("centsible_test_close_failure", [failing, closing]),
    ).rejects.toThrow("centsible_test_close_failure");

    expect(closing.closed).toBe(true);
  });

  it("preserves every pool shutdown failure", async () => {
    const first = new FakePool("first close failed");
    const second = new FakePool("second close failed");
    first.endFailures = 1;
    second.endFailures = 1;

    let failure: unknown;
    try {
      await closePools("centsible_test_all_close_failures", [first, second]);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "first close failed" }),
      expect.objectContaining({ message: "second close failed" }),
    ]);
  });

  it("drops the exact schema even when a peer shutdown fails", async () => {
    const isolated = new FakePool();
    const peer = new FakePool();
    peer.endFailures = 1;
    const admin = new FakeAdmin();
    const cleanup = createIsolatedCleanup({
      createAdmin: () => admin,
      isolated,
      additionalPools: () => [peer],
      schemaName: "centsible_test_peer_failure",
    });

    await expect(cleanup()).rejects.toThrow("centsible_test_peer_failure");
    expect(isolated.closed).toBe(true);
    expect(admin.droppedSchema).toBe(
      'DROP SCHEMA "centsible_test_peer_failure" CASCADE',
    );
    await cleanup();
    expect(peer.closed).toBe(true);
  });
});
