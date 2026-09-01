import { sql } from "drizzle-orm";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  createIsolatedTestDatabase,
  readTestDatabaseConfig,
} from "../../support/test-database.js";

function hasExternalTestDatabaseApproval(): boolean {
  try {
    readTestDatabaseConfig(process.env);
    return true;
  } catch {
    return false;
  }
}

async function readPublicSnapshot(databaseUrl: string): Promise<{
  functionCount: string;
  triggerCount: string;
  userRowCount: string;
}> {
  const observer = postgres(databaseUrl, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });

  try {
    const rows = await observer<
      {
        function_count: string;
        trigger_count: string;
        user_row_count: string;
      }[]
    >`
      select
        (select count(*)::text from public.users) as user_row_count,
        (
          select count(*)::text
          from pg_proc as procedure
          join pg_namespace as namespace on namespace.oid = procedure.pronamespace
          where namespace.nspname = 'public'
            and procedure.proname = 'set_updated_at'
        ) as function_count,
        (
          select count(*)::text
          from pg_trigger as trigger
          join pg_class as relation on relation.oid = trigger.tgrelid
          join pg_namespace as namespace on namespace.oid = relation.relnamespace
          where namespace.nspname = 'public'
            and relation.relname in ('users', 'transactions')
            and not trigger.tgisinternal
        ) as trigger_count
    `;
    const snapshot = rows[0];
    if (!snapshot) {
      throw new Error("Could not read public schema safety snapshot");
    }
    return {
      functionCount: snapshot.function_count,
      triggerCount: snapshot.trigger_count,
      userRowCount: snapshot.user_row_count,
    };
  } finally {
    await observer.end({ timeout: 5 });
  }
}

const guardedDescribe = hasExternalTestDatabaseApproval()
  ? describe
  : describe.skip;

guardedDescribe("isolated Neon schema migrations", () => {
  it("creates a non-public prefixed schema and migrates it", async () => {
    const { databaseUrl } = readTestDatabaseConfig(process.env);
    const publicBefore = await readPublicSnapshot(databaseUrl);
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

    await expect(readPublicSnapshot(databaseUrl)).resolves.toEqual(
      publicBefore,
    );
  }, 120_000);
});
