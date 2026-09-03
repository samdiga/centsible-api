import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { migrateSchema, quoteIdentifier } from "../../../database/migrate.js";
import {
  createIsolatedConnectionConfig,
  createIsolatedTestDatabase,
  readTestDatabaseConfig,
} from "../../support/test-database.js";

const legacyGeneratedMigrations = [
  ["0000_white_puff_adder.sql", 1_777_433_461_801],
  ["0001_cooing_edwin_jarvis.sql", 1_780_144_889_875],
  ["0002_smooth_scarecrow.sql", 1_780_145_085_060],
  ["0003_rename_recurring_series_to_bill_setup.sql", 1_781_419_789_017],
  ["0004_dark_war_machine.sql", 1_781_422_174_883],
  ["0005_unique_hammerhead.sql", 1_783_292_163_175],
  ["0006_quick_hairball.sql", 1_783_885_904_474],
] as const;

function testSchemaName(suffix: string): string {
  return `centsible_test_${suffix}_${randomUUID().replaceAll("-", "_")}`;
}

async function installLegacyGeneratedBaseline(
  client: postgres.Sql,
  targetSchema: string,
  legacyJournalSchema: string,
  journalEntryCount: number = legacyGeneratedMigrations.length,
): Promise<void> {
  const quotedTarget = quoteIdentifier(targetSchema);
  const quotedJournal = quoteIdentifier(legacyJournalSchema);
  await client.unsafe(`SET search_path TO ${quotedTarget}`);

  for (const [filename] of legacyGeneratedMigrations) {
    const sourceSql = await readFile(
      resolve(process.cwd(), "database", "migrations", filename),
      "utf8",
    );
    const statements = sourceSql
      .replaceAll('"public".', `${quotedTarget}.`)
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    await client.begin(async (transaction) => {
      await transaction.unsafe(`SET LOCAL search_path TO ${quotedTarget}`);
      for (const statement of statements) {
        await transaction.unsafe(statement);
      }
    });
  }

  await client.unsafe(`CREATE SCHEMA ${quotedJournal}`);
  await client.unsafe(`
    CREATE TABLE ${quotedJournal}."__drizzle_migrations" (
      "id" serial PRIMARY KEY NOT NULL,
      "hash" text NOT NULL,
      "created_at" bigint NOT NULL
    )
  `);
  for (const [filename, createdAt] of legacyGeneratedMigrations.slice(
    0,
    journalEntryCount,
  )) {
    const sourceSql = await readFile(
      resolve(process.cwd(), "database", "migrations", filename),
      "utf8",
    );
    const hash = createHash("sha256").update(sourceSql).digest("hex");
    await client.unsafe(
      `insert into ${quotedJournal}."__drizzle_migrations" (hash, created_at) values ($1, $2)`,
      [hash, createdAt],
    );
  }
}

function hasExternalTestDatabaseApproval(): boolean {
  try {
    readTestDatabaseConfig(process.env);
    return true;
  } catch {
    return false;
  }
}

async function readPublicSnapshot(databaseUrl: string): Promise<{
  functionDefinitionHash: string;
  functionCount: string;
  triggerDefinitionHash: string;
  triggerCount: string;
  userRowHash: string;
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
        function_definition_hash: string;
        trigger_count: string;
        trigger_definition_hash: string;
        user_row_hash: string;
        user_row_count: string;
      }[]
    >`
      select
        (select count(*)::text from public.users) as user_row_count,
        (
          select coalesce(
            md5(string_agg(md5(to_jsonb("user")::text), '' order by "user".id)),
            md5('')
          )
          from public.users as "user"
        ) as user_row_hash,
        (
          select count(*)::text
          from pg_proc as procedure
          join pg_namespace as namespace on namespace.oid = procedure.pronamespace
          where namespace.nspname = 'public'
            and procedure.proname = 'set_updated_at'
        ) as function_count,
        (
          select coalesce(
            md5(string_agg(md5(pg_get_functiondef(procedure.oid)), '' order by procedure.oid)),
            md5('')
          )
          from pg_proc as procedure
          join pg_namespace as namespace on namespace.oid = procedure.pronamespace
          where namespace.nspname = 'public'
            and procedure.proname = 'set_updated_at'
        ) as function_definition_hash,
        (
          select count(*)::text
          from pg_trigger as trigger
          join pg_class as relation on relation.oid = trigger.tgrelid
          join pg_namespace as namespace on namespace.oid = relation.relnamespace
          where namespace.nspname = 'public'
            and relation.relname in ('users', 'transactions')
            and not trigger.tgisinternal
        ) as trigger_count
        ,(
          select coalesce(
            md5(string_agg(md5(pg_get_triggerdef(trigger.oid, true)), '' order by trigger.oid)),
            md5('')
          )
          from pg_trigger as trigger
          join pg_class as relation on relation.oid = trigger.tgrelid
          join pg_namespace as namespace on namespace.oid = relation.relnamespace
          where namespace.nspname = 'public'
            and relation.relname in ('users', 'transactions')
            and not trigger.tgisinternal
        ) as trigger_definition_hash
    `;
    const snapshot = rows[0];
    if (!snapshot) {
      throw new Error("Could not read public schema safety snapshot");
    }
    return {
      functionDefinitionHash: snapshot.function_definition_hash,
      functionCount: snapshot.function_count,
      triggerDefinitionHash: snapshot.trigger_definition_hash,
      triggerCount: snapshot.trigger_count,
      userRowHash: snapshot.user_row_hash,
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

      const beforeReconnect = await testDb.db.execute(
        sql<{ backend_pid: number }>`select pg_backend_pid() as backend_pid`,
      );
      await testDb.reconnect();
      const afterReconnect = await testDb.db.execute(
        sql<{ backend_pid: number }>`select pg_backend_pid() as backend_pid`,
      );
      expect(afterReconnect[0]?.backend_pid).not.toBe(
        beforeReconnect[0]?.backend_pid,
      );

      const reconnectedSearchPath = await testDb.db.execute(
        sql<{ search_path: string }>`show search_path`,
      );
      expect(reconnectedSearchPath[0]?.search_path).toBe(testDb.schemaName);

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

  it("imports a complete legacy Drizzle history before applying 0007", async () => {
    const { databaseUrl } = readTestDatabaseConfig(process.env);
    const targetSchema = testSchemaName("lt");
    const legacyJournalSchema = testSchemaName("lj");
    const quotedTarget = quoteIdentifier(targetSchema);
    const quotedJournal = quoteIdentifier(legacyJournalSchema);
    const admin = postgres(databaseUrl, {
      max: 1,
      onnotice: () => undefined,
      prepare: false,
    });
    const connection = createIsolatedConnectionConfig(
      databaseUrl,
      targetSchema,
    );
    const client = postgres(connection.url, connection.options);

    try {
      await admin.unsafe(`CREATE SCHEMA ${quotedTarget}`);
      await installLegacyGeneratedBaseline(
        client,
        targetSchema,
        legacyJournalSchema,
      );

      await migrateSchema(client, targetSchema, { legacyJournalSchema });

      const rows = await client<
        { local_count: string; user_data_versions: string | null }[]
      >`
        select
          (select count(*)::text from __drizzle_migrations) as local_count,
          to_regclass('user_data_versions')::text as user_data_versions
      `;
      expect(rows[0]).toEqual({
        local_count: "8",
        user_data_versions: "user_data_versions",
      });

      const triggerBefore = await client<{ oid: string }[]>`
        select trigger.oid::text as oid
        from pg_trigger as trigger
        join pg_class as relation on relation.oid = trigger.tgrelid
        where relation.relnamespace = current_schema()::regnamespace
          and relation.relname = 'users'
          and trigger.tgname = 'set_updated_at_users'
      `;
      await client`delete from schema_raw_migrations`;

      await migrateSchema(client, targetSchema, { legacyJournalSchema });

      const rawHistory = await client<{ filename: string }[]>`
        select filename from schema_raw_migrations order by filename
      `;
      const triggerAfter = await client<{ oid: string }[]>`
        select trigger.oid::text as oid
        from pg_trigger as trigger
        join pg_class as relation on relation.oid = trigger.tgrelid
        where relation.relnamespace = current_schema()::regnamespace
          and relation.relname = 'users'
          and trigger.tgname = 'set_updated_at_users'
      `;
      expect(rawHistory.map(({ filename }) => filename)).toEqual([
        "0001_extras.sql",
        "0002_audit_sync_action.sql",
        "0003_cash_horizon_schema_patch.sql",
        "0004_bills_type_cadence.sql",
        "0005_phase1_integrity_indexes.sql",
        "0006_search_indexes.sql",
      ]);
      expect(triggerAfter[0]?.oid).toBe(triggerBefore[0]?.oid);
    } finally {
      await client.end({ timeout: 5 });
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${quotedTarget} CASCADE`);
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${quotedJournal} CASCADE`);
      await admin.end({ timeout: 5 });
    }
  }, 120_000);

  it("fails closed before applying migrations for a partial legacy journal", async () => {
    const { databaseUrl } = readTestDatabaseConfig(process.env);
    const targetSchema = testSchemaName("pt");
    const legacyJournalSchema = testSchemaName("pj");
    const quotedTarget = quoteIdentifier(targetSchema);
    const quotedJournal = quoteIdentifier(legacyJournalSchema);
    const admin = postgres(databaseUrl, {
      max: 1,
      onnotice: () => undefined,
      prepare: false,
    });
    const connection = createIsolatedConnectionConfig(
      databaseUrl,
      targetSchema,
    );
    const client = postgres(connection.url, connection.options);

    try {
      await admin.unsafe(`CREATE SCHEMA ${quotedTarget}`);
      await installLegacyGeneratedBaseline(
        client,
        targetSchema,
        legacyJournalSchema,
        1,
      );

      await expect(
        migrateSchema(client, targetSchema, { legacyJournalSchema }),
      ).rejects.toThrow("Legacy Drizzle migration history is inconsistent");
      const rows = await client<{ local_journal: string | null }[]>`
        select to_regclass('__drizzle_migrations')::text as local_journal
      `;
      expect(rows[0]?.local_journal).toBeNull();
    } finally {
      await client.end({ timeout: 5 });
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${quotedTarget} CASCADE`);
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${quotedJournal} CASCADE`);
      await admin.end({ timeout: 5 });
    }
  }, 120_000);
});
