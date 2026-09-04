import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import {
  assertSchemaSearchPath,
  migrateSchema,
  quoteIdentifier,
} from "../../database/migrate.js";
import * as schema from "../../database/schema/index.js";
import type { Db } from "../../src/platform/database/types.js";

const testSchemaPattern = /^centsible_test_[a-z0-9_]+$/;
const requiredPrefix = "centsible_test_";

type ClosablePool = {
  end(options: { timeout: number }): Promise<void>;
};

type SchemaAdmin = ClosablePool & {
  unsafe(query: string): Promise<unknown>;
};

type IsolatedConnectionConfig = Readonly<{
  options: {
    connection: { options: string };
    max: number;
    onnotice: () => void;
    prepare: boolean;
  };
  url: string;
}>;

export type TestDatabaseConfig = Readonly<{
  databaseUrl: string;
  schemaPrefix: typeof requiredPrefix;
}>;

export type IsolatedSchemaClient = Readonly<{
  client: Sql;
  db: Db;
  close(): Promise<void>;
}>;

/** Validates every explicit opt-in required before any test schema is created. */
export function readTestDatabaseConfig(
  environment: NodeJS.ProcessEnv,
): TestDatabaseConfig {
  const databaseUrl = environment.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "TEST_DATABASE_URL is required for the shared sandbox test database",
    );
  }
  if (environment.NODE_ENV !== "test") {
    throw new Error(
      "NODE_ENV must be test for the shared sandbox test database",
    );
  }
  if (environment.DATABASE_ENVIRONMENT !== "sandbox") {
    throw new Error(
      "DATABASE_ENVIRONMENT must be sandbox for the shared sandbox test database",
    );
  }
  if (environment.ALLOW_SHARED_SANDBOX_TEST_DATABASE !== "true") {
    throw new Error(
      "Refusing shared sandbox test database without explicit guard",
    );
  }
  if (environment.TEST_SCHEMA_PREFIX !== requiredPrefix) {
    throw new Error(`TEST_SCHEMA_PREFIX must be ${requiredPrefix}`);
  }

  return { databaseUrl, schemaPrefix: requiredPrefix };
}

function createSchemaName(): string {
  const schemaName = `${requiredPrefix}${randomUUID().replaceAll("-", "_")}`;
  if (!testSchemaPattern.test(schemaName)) {
    throw new Error("Generated test schema name is invalid");
  }

  return schemaName;
}

/**
 * Returns a direct Neon URL and connection options that pin every physical
 * connection (including reconnects) to the generated schema at startup.
 */
export function createIsolatedConnectionConfig(
  databaseUrl: string,
  schemaName: string,
): IsolatedConnectionConfig {
  quoteIdentifier(schemaName);
  const url = new URL(databaseUrl);
  for (const key of url.searchParams.keys()) {
    if (["options", "search_path"].includes(key.toLowerCase())) {
      throw new Error(
        "Database URL query parameters must not override search_path",
      );
    }
  }
  if (url.hostname.includes("-pooler")) {
    url.hostname = url.hostname.replace("-pooler", "");
  }

  return {
    options: {
      connection: { options: `-c search_path=${schemaName}` },
      max: 1,
      onnotice: () => undefined,
      prepare: false,
    },
    url: url.toString(),
  };
}

/** Closes every supplied pool before reporting any shutdown failure. */
export async function closePools(
  schemaName: string,
  pools: readonly ClosablePool[],
): Promise<void> {
  const results = await Promise.allSettled(
    pools.map((pool) => pool.end({ timeout: 5 })),
  );
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0) {
    throw new Error(
      `Failed to close test database pools for schema ${schemaName}`,
      { cause: failures[0]!.reason },
    );
  }
}

/** Owns one isolated client and safely replaces it after physical turnover. */
export function createIsolatedSession<TClient extends ClosablePool, TDb>({
  assertConnection,
  createClient,
  createDb,
  schemaName,
}: {
  assertConnection(client: TClient): Promise<void>;
  createClient(): TClient;
  createDb(client: TClient): TDb;
  schemaName: string;
}): {
  readonly client: TClient;
  readonly db: TDb;
  end(options: { timeout: number }): Promise<void>;
  reconnect(): Promise<void>;
} {
  let client = createClient();
  let db = createDb(client);

  return {
    get client(): TClient {
      return client;
    },
    get db(): TDb {
      return db;
    },
    end(options: { timeout: number }): Promise<void> {
      return client.end(options);
    },
    async reconnect(): Promise<void> {
      await client.end({ timeout: 5 });
      const replacement = createClient();
      try {
        await assertConnection(replacement);
      } catch (error: unknown) {
        try {
          await closePools(schemaName, [replacement]);
        } catch {
          // The isolated-schema diagnostic takes precedence.
        }
        throw new Error(
          `Reconnected test client is not schema-isolated: ${schemaName}`,
          { cause: error },
        );
      }
      client = replacement;
      db = createDb(client);
    },
  };
}

/** Builds idempotent, exact-schema cleanup with retry after a failed drop. */
export function createIsolatedCleanup({
  createAdmin,
  isolated,
  schemaName,
}: {
  createAdmin(): SchemaAdmin;
  isolated: ClosablePool;
  schemaName: string;
}): () => Promise<void> {
  const quotedSchema = quoteIdentifier(schemaName);
  let isolatedClosed = false;
  let pendingAdmin: SchemaAdmin | undefined;
  let schemaDropped = false;
  let cleaned = false;

  return async () => {
    if (cleaned) {
      return;
    }

    if (!isolatedClosed) {
      try {
        await isolated.end({ timeout: 5 });
        isolatedClosed = true;
      } catch (error: unknown) {
        throw new Error(`Failed to close test schema pool: ${schemaName}`, {
          cause: error,
        });
      }
    }

    if (schemaDropped) {
      if (pendingAdmin) {
        try {
          await closePools(schemaName, [pendingAdmin]);
          pendingAdmin = undefined;
        } catch (error: unknown) {
          throw new Error(
            `Failed to close test schema admin pool: ${schemaName}`,
            {
              cause: error,
            },
          );
        }
      }
      cleaned = true;
      console.info(`[test-db] cleaned isolated schema ${schemaName}`);
      return;
    }

    const admin = createAdmin();
    try {
      await admin.unsafe(`DROP SCHEMA ${quotedSchema} CASCADE`);
      schemaDropped = true;
      pendingAdmin = admin;
    } catch (error: unknown) {
      try {
        await closePools(schemaName, [admin]);
      } catch {
        // The exact schema diagnostic takes precedence; all close attempts ran.
      }
      throw new Error(`Failed to drop isolated test schema: ${schemaName}`, {
        cause: error,
      });
    }

    try {
      await closePools(schemaName, [admin]);
      pendingAdmin = undefined;
    } catch (error: unknown) {
      throw new Error(`Failed to close test schema admin pool: ${schemaName}`, {
        cause: error,
      });
    }

    cleaned = true;
    console.info(`[test-db] cleaned isolated schema ${schemaName}`);
  };
}

function createAdmin(databaseUrl: string): SchemaAdmin {
  return postgres(databaseUrl, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
}

/** Creates a second max-one client pinned to an existing generated schema. */
export async function createIsolatedSchemaClient(
  databaseUrl: string,
  schemaName: string,
): Promise<IsolatedSchemaClient> {
  const connectionConfig = createIsolatedConnectionConfig(
    databaseUrl,
    schemaName,
  );
  const client = postgres(connectionConfig.url, connectionConfig.options);
  try {
    await assertSchemaSearchPath(client, schemaName);
  } catch (error: unknown) {
    try {
      await closePools(schemaName, [client]);
    } catch {
      // Preserve the schema-isolation failure while still attempting cleanup.
    }
    throw error;
  }
  return {
    client,
    db: drizzle(client, { schema }),
    close: () => client.end({ timeout: 5 }),
  };
}

/**
 * Creates a dedicated schema and pool for one integration run. The helper never
 * selects `public` and cleanup can only drop the exact generated schema.
 */
export async function createIsolatedTestDatabase(): Promise<{
  db: Db;
  schemaName: string;
  cleanup(): Promise<void>;
  reconnect(): Promise<void>;
  createPeerClient(): Promise<IsolatedSchemaClient>;
}> {
  const config = readTestDatabaseConfig(process.env);
  const schemaName = createSchemaName();
  const quotedSchema = quoteIdentifier(schemaName);
  const connectionConfig = createIsolatedConnectionConfig(
    config.databaseUrl,
    schemaName,
  );
  const admin = createAdmin(config.databaseUrl);
  const isolatedSession = createIsolatedSession({
    assertConnection: (client) => assertSchemaSearchPath(client, schemaName),
    createClient: () =>
      postgres(connectionConfig.url, connectionConfig.options),
    createDb: (client) => drizzle(client, { schema }),
    schemaName,
  });

  try {
    await admin.unsafe(`CREATE SCHEMA ${quotedSchema}`);
    console.info(`[test-db] created isolated schema ${schemaName}`);
  } catch (error: unknown) {
    try {
      await closePools(schemaName, [admin, isolatedSession]);
    } catch {
      // The exact schema diagnostic takes precedence; all close attempts ran.
    }
    throw new Error(`Failed to create isolated test schema: ${schemaName}`, {
      cause: error,
    });
  }

  try {
    await closePools(schemaName, [admin]);
    await migrateSchema(isolatedSession.client, schemaName);
  } catch (error: unknown) {
    try {
      await closePools(schemaName, [isolatedSession]);
    } catch {
      // The exact schema diagnostic takes precedence; all close attempts ran.
    }
    throw new Error(
      `Isolated test schema retained after migration failure: ${schemaName}`,
      { cause: error },
    );
  }

  return {
    get db(): Db {
      return isolatedSession.db;
    },
    schemaName,
    reconnect: () => isolatedSession.reconnect(),
    createPeerClient: () =>
      createIsolatedSchemaClient(config.databaseUrl, schemaName),
    cleanup: createIsolatedCleanup({
      createAdmin: () => createAdmin(config.databaseUrl),
      isolated: isolatedSession,
      schemaName,
    }),
  };
}
