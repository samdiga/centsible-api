import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
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

async function installLegacyRaw0001(client: postgres.Sql): Promise<void> {
  const extensionRows = await client<
    { extname: string; schema_name: string }[]
  >`
    select extension.extname, namespace.nspname as schema_name
    from pg_extension as extension
    join pg_namespace as namespace on namespace.oid = extension.extnamespace
    where extension.extname in ('vector', 'pg_trgm')
  `;
  const extensionSchemas = new Map(
    extensionRows.map((row) => [row.extname, `"${row.schema_name}"`]),
  );
  const vectorSchema = extensionSchemas.get("vector");
  if (!vectorSchema) throw new Error("vector extension is required for test");

  const sourceSql = await readFile(
    resolve(process.cwd(), "database", "migrations", "raw", "0001_extras.sql"),
    "utf8",
  );
  const migrationSql = sourceSql
    .replaceAll(/^CREATE EXTENSION IF NOT EXISTS vector;\s*$/gm, "")
    .replaceAll("vector(1536)", `${vectorSchema}.vector(1536)`)
    .replaceAll("vector_cosine_ops", `${vectorSchema}.vector_cosine_ops`)
    .replace(
      /FROM pg_indexes WHERE indexname = ('[^']+')/g,
      "FROM pg_indexes WHERE indexname = $1 AND schemaname = current_schema()",
    )
    .replace(
      /(WHERE constraint_name = '[^']+'\s+AND table_name = '[^']+')/g,
      "$1 AND table_schema = current_schema()",
    );
  await client.unsafe(migrationSql);
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

      const columns = await testDb.db.execute(sql<{
        table_name: string;
        column_name: string;
      }>`
        select table_name, column_name from information_schema.columns
        where table_schema = current_schema()
          and (table_name, column_name) in (
            ('bill_occurrences', 'occurrence_key'),
            ('bill_occurrences', 'expected_amount_override_cents'),
            ('bill_occurrences', 'due_date_override'),
            ('forecast_events', 'bill_occurrence_id')
          ) order by table_name, column_name
      `);
      expect(columns).toHaveLength(4);
      const indexes = await testDb.db.execute(sql<{
        indexname: string;
        indexdef: string;
      }>`
        select indexname, indexdef from pg_indexes
        where schemaname = current_schema()
          and indexname in (
            'bill_occurrences_setup_occurrence_key_uniq',
            'forecast_events_bill_occurrence_id_uniq'
          ) order by indexname
      `);
      expect(indexes).toHaveLength(2);
      expect(indexes[1]?.indexdef).toContain(
        "WHERE (bill_occurrence_id IS NOT NULL)",
      );
      const foreignKey = await testDb.db.execute(sql<{
        constraint_name: string;
      }>`
        select constraint_name from information_schema.table_constraints
        where table_schema = current_schema()
          and table_name = 'forecast_events'
          and constraint_name = 'forecast_events_bill_occurrence_id_bill_occurrences_id_fk'
          and constraint_type = 'FOREIGN KEY'
      `);
      expect(foreignKey).toHaveLength(1);
    } finally {
      await testDb.cleanup();
    }

    await expect(readPublicSnapshot(databaseUrl)).resolves.toEqual(
      publicBefore,
    );
  }, 120_000);

  it("rejects duplicate monthly cycle keys without changing either occurrence", async () => {
    const { databaseUrl } = readTestDatabaseConfig(process.env);
    const schemaName = testSchemaName("duplicate_cycle");
    const quotedSchema = quoteIdentifier(schemaName);
    const admin = postgres(databaseUrl, {
      max: 1,
      onnotice: () => undefined,
      prepare: false,
    });
    const connection = createIsolatedConnectionConfig(databaseUrl, schemaName);
    const client = postgres(connection.url, connection.options);
    const setupId = randomUUID();
    const weeklySetupId = randomUUID();
    const firstId = randomUUID();
    const secondId = randomUUID();
    const weeklyId = randomUUID();
    try {
      await admin.unsafe(`CREATE SCHEMA ${quotedSchema}`);
      await client.unsafe(
        "create table bill_setup (id uuid primary key, cadence text not null)",
      );
      await client.unsafe(
        "create table bill_occurrences (id uuid primary key, user_id uuid not null, bill_setup_id uuid not null, due_date date not null)",
      );
      await client.unsafe(
        "create table forecast_events (id uuid primary key, user_id uuid not null, recurring_series_id uuid, date date not null, source_type text not null)",
      );
      const userId = randomUUID();
      await client`insert into bill_setup (id, cadence) values (${setupId}, 'monthly'), (${weeklySetupId}, 'weekly')`;
      await client`insert into bill_occurrences (id, user_id, bill_setup_id, due_date) values (${firstId}, ${userId}, ${setupId}, '2026-09-04'), (${secondId}, ${userId}, ${setupId}, '2026-09-25')`;
      await client`insert into bill_occurrences (id, user_id, bill_setup_id, due_date) values (${weeklyId}, ${userId}, ${weeklySetupId}, '2026-09-07')`;
      const migrationSql = await readFile(
        resolve(
          process.cwd(),
          "database/migrations/0014_bill_occurrence_overrides.sql",
        ),
        "utf8",
      );
      await expect(
        client.begin(async (transaction) => {
          await transaction.unsafe(migrationSql);
        }),
      ).rejects.toThrow("Duplicate bill occurrence cycle keys");
      const rows = await client<{ id: string; due_date: string }[]>`
        select id, due_date::text from bill_occurrences
        where bill_setup_id = ${setupId} order by due_date
      `;
      expect(rows).toEqual([
        { id: firstId, due_date: "2026-09-04" },
        { id: secondId, due_date: "2026-09-25" },
      ]);
      const columns = await client<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = current_schema() and table_name = 'bill_occurrences'
          and column_name = 'occurrence_key'
      `;
      expect(columns).toHaveLength(0);

      await client`delete from bill_occurrences where id = ${secondId}`;
      const recurringEventId = randomUUID();
      const manualEventId = randomUUID();
      await client`
        insert into forecast_events (id, user_id, recurring_series_id, date, source_type)
        values
          (${recurringEventId}, ${userId}, ${setupId}, '2026-09-04', 'recurring'),
          (${manualEventId}, ${userId}, ${setupId}, '2026-09-04', 'manual')
      `;
      await client.begin(async (transaction) => {
        await transaction.unsafe(migrationSql);
      });
      const migrated = await client<{ id: string; occurrence_key: string }[]>`
        select id, occurrence_key from bill_occurrences order by due_date
      `;
      expect(migrated).toEqual([
        { id: firstId, occurrence_key: `${setupId}:2026-09` },
        { id: weeklyId, occurrence_key: `${weeklySetupId}:2026-09-07` },
      ]);
      const events = await client<
        { id: string; bill_occurrence_id: string | null }[]
      >`
        select id, bill_occurrence_id from forecast_events order by source_type desc
      `;
      expect(events).toEqual([
        { id: recurringEventId, bill_occurrence_id: firstId },
        { id: manualEventId, bill_occurrence_id: null },
      ]);
    } finally {
      await client.end({ timeout: 5 });
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await admin.end({ timeout: 5 });
    }
  }, 120_000);

  it("imports a complete legacy Drizzle history before applying later migrations", async () => {
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

      const migrationDirectory = resolve(
        process.cwd(),
        "database",
        "migrations",
      );
      const migrationFiles = (await readdir(migrationDirectory))
        .filter((filename) => /^\d{4}_.+\.sql$/.test(filename))
        .sort();
      const expectedHashes = await Promise.all(
        migrationFiles.map(async (filename) =>
          createHash("sha256")
            .update(
              await readFile(resolve(migrationDirectory, filename), "utf8"),
            )
            .digest("hex"),
        ),
      );
      const localHistory = await client<{ hash: string }[]>`
        select hash from __drizzle_migrations order by id
      `;
      expect(localHistory.map(({ hash }) => hash)).toEqual(expectedHashes);
      const rows = await client<{ user_data_versions: string | null }[]>`
        select to_regclass('user_data_versions')::text as user_data_versions
      `;
      expect(rows[0]).toEqual({ user_data_versions: "user_data_versions" });

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
      const expectedRawHistory = (
        await readdir(resolve(migrationDirectory, "raw"))
      )
        .filter((filename) => /^\d{4}_.+\.sql$/.test(filename))
        .sort();
      const triggerAfter = await client<{ oid: string }[]>`
        select trigger.oid::text as oid
        from pg_trigger as trigger
        join pg_class as relation on relation.oid = trigger.tgrelid
        where relation.relnamespace = current_schema()::regnamespace
          and relation.relname = 'users'
          and trigger.tgname = 'set_updated_at_users'
      `;
      expect(rawHistory.map(({ filename }) => filename)).toEqual(
        expectedRawHistory,
      );
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

  it("rejects a legacy raw history containing only 0001", async () => {
    const { databaseUrl } = readTestDatabaseConfig(process.env);
    const targetSchema = testSchemaName("rt");
    const legacyJournalSchema = testSchemaName("rj");
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
      await installLegacyRaw0001(client);
      await client.unsafe(`
        CREATE TABLE schema_raw_migrations (
          filename text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      const generated0007Hash = createHash("sha256")
        .update(
          await readFile(
            resolve(
              process.cwd(),
              "database",
              "migrations",
              "0007_user_data_versions.sql",
            ),
            "utf8",
          ),
        )
        .digest("hex");

      await expect(
        migrateSchema(client, targetSchema, { legacyJournalSchema }),
      ).rejects.toThrow("Legacy raw migration history is inconsistent");
      const localJournal = await client<{ relation: string | null }[]>`
        select to_regclass('__drizzle_migrations')::text as relation
      `;
      let generated0007Count = "0";
      if (localJournal[0]?.relation) {
        const generatedRows = await client<{ count: string }[]>`
          select count(*)::text as count
          from __drizzle_migrations
          where hash = ${generated0007Hash}
        `;
        generated0007Count = generatedRows[0]?.count ?? "0";
      }
      const rows = await client<
        {
          later_forecast_index: string | null;
          later_search_index: string | null;
          tracker_count: string;
          user_data_versions: string | null;
        }[]
      >`
        select
          (select count(*)::text from schema_raw_migrations) as tracker_count,
          to_regclass('user_data_versions')::text as user_data_versions,
          to_regclass('forecast_events_series_date_uniq')::text as later_forecast_index,
          to_regclass('transactions_name_trgm_idx')::text as later_search_index
      `;
      expect(generated0007Count).toBe("0");
      expect(rows[0]).toEqual({
        tracker_count: "0",
        user_data_versions: null,
        later_forecast_index: null,
        later_search_index: null,
      });
    } finally {
      await client.end({ timeout: 5 });
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${quotedTarget} CASCADE`);
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${quotedJournal} CASCADE`);
      await admin.end({ timeout: 5 });
    }
  }, 120_000);
});
