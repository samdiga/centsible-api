import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createIsolatedTestDatabase } from "../../support/test-database.js";

const originalEnvironment = { ...process.env };

try {
  process.loadEnvFile?.(".env");
} catch {
  // CI supplies the guarded database variables through its environment.
}

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (testDatabaseUrl) {
  process.env.TEST_DATABASE_URL = testDatabaseUrl;
}
process.env.NODE_ENV = "test";
process.env.DATABASE_ENVIRONMENT = "sandbox";
process.env.ALLOW_SHARED_SANDBOX_TEST_DATABASE = "true";
process.env.TEST_SCHEMA_PREFIX = "centsible_test_";

const testEnvironment = { ...process.env };

function restoreEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in environment)) {
      delete process.env[key];
    }
  }

  Object.assign(process.env, environment);
}

afterEach(() => {
  restoreEnvironment(testEnvironment);
});

afterAll(() => {
  restoreEnvironment(originalEnvironment);
});

describe("isolated Neon schema migrations", () => {
  it("creates a non-public prefixed schema and migrates it", async () => {
    const testDb = await createIsolatedTestDatabase();

    try {
      expect(testDb.schemaName).toMatch(/^centsible_test_[a-z0-9_]+$/);
      expect(testDb.schemaName).not.toBe("public");

      const rows = await testDb.db.execute(
        sql<{ users: string | null }>`select to_regclass('users') as users`,
      );
      expect(rows[0]?.users).toBe("users");

      const searchPath = await testDb.db.execute(
        sql<{ search_path: string }>`show search_path`,
      );
      expect(searchPath[0]?.search_path).toBe(testDb.schemaName);

      const migrationTables = await testDb.db.execute(
        sql<{ table_schema: string }>`
          select table_schema
          from information_schema.tables
          where table_name in ('__drizzle_migrations', 'schema_raw_migrations')
            and table_schema = current_schema()
          order by table_name
        `,
      );
      expect(migrationTables.map((row) => row.table_schema)).toEqual([
        testDb.schemaName,
        testDb.schemaName,
      ]);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);

  it("refuses shared sandbox access without the explicit guard", async () => {
    process.env.ALLOW_SHARED_SANDBOX_TEST_DATABASE = "false";

    await expect(createIsolatedTestDatabase()).rejects.toThrow(
      "Refusing shared sandbox test database without explicit guard",
    );
  });
});
