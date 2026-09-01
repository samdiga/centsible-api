import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { migrateSchema, quoteIdentifier } from "../../database/migrate.js";
import * as schema from "../../database/schema/schema.js";
import type { Db } from "../../src/platform/database/types.js";

const testSchemaPattern = /^centsible_test_[a-z0-9_]+$/;

function requireIsolatedTestDatabaseEnvironment(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "TEST_DATABASE_URL is required for the shared sandbox test database",
    );
  }
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "NODE_ENV must be test for the shared sandbox test database",
    );
  }
  if (process.env.DATABASE_ENVIRONMENT !== "sandbox") {
    throw new Error(
      "DATABASE_ENVIRONMENT must be sandbox for the shared sandbox test database",
    );
  }
  if (process.env.ALLOW_SHARED_SANDBOX_TEST_DATABASE !== "true") {
    throw new Error(
      "Refusing shared sandbox test database without explicit guard",
    );
  }
  if (process.env.TEST_SCHEMA_PREFIX !== "centsible_test_") {
    throw new Error("TEST_SCHEMA_PREFIX must be centsible_test_");
  }

  return databaseUrl;
}

function createSchemaName(): string {
  const schemaName = `centsible_test_${randomUUID().replaceAll("-", "_")}`;
  if (!testSchemaPattern.test(schemaName)) {
    throw new Error("Generated test schema name is invalid");
  }

  return schemaName;
}

function directNeonUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  if (url.hostname.includes("-pooler")) {
    url.hostname = url.hostname.replace("-pooler", "");
  }
  return url.toString();
}

/**
 * Creates a dedicated schema and pool for one integration run. The helper never
 * selects `public` and cleanup can only drop the exact generated schema.
 */
export async function createIsolatedTestDatabase(): Promise<{
  db: Db;
  schemaName: string;
  cleanup(): Promise<void>;
}> {
  const databaseUrl = requireIsolatedTestDatabaseEnvironment();
  const schemaName = createSchemaName();
  const quotedSchema = quoteIdentifier(schemaName);
  const admin = postgres(databaseUrl, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  // Neon pooled connections reject startup `search_path` options. The direct
  // endpoint lets Postgres enforce the path before the first query executes.
  const isolatedSql = postgres(directNeonUrl(databaseUrl), {
    connection: { options: `-c search_path=${schemaName}` },
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });

  try {
    await admin.unsafe(`CREATE SCHEMA ${quotedSchema}`);
    console.info(`[test-db] created isolated schema ${schemaName}`);
    await migrateSchema(isolatedSql, schemaName);
  } catch (error: unknown) {
    await isolatedSql.end({ timeout: 5 });
    await admin.end({ timeout: 5 });
    throw new Error(
      `Isolated test schema retained after migration failure: ${schemaName}`,
      {
        cause: error,
      },
    );
  }

  const db = drizzle(isolatedSql, { schema });
  let cleaned = false;

  return {
    db,
    schemaName,
    async cleanup(): Promise<void> {
      if (cleaned) {
        return;
      }
      cleaned = true;

      await isolatedSql.end({ timeout: 5 });
      await admin.unsafe(`DROP SCHEMA ${quoteIdentifier(schemaName)} CASCADE`);
      await admin.end({ timeout: 5 });
      console.info(`[test-db] cleaned isolated schema ${schemaName}`);
    },
  };
}
