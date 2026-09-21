import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql, type TransactionSql } from "postgres";

import { seedSchema } from "./seed.js";

const databaseDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(databaseDirectory, "migrations");
const rawMigrationsDirectory = resolve(migrationsDirectory, "raw");
const migrationJournalPath = resolve(
  migrationsDirectory,
  "meta",
  "_journal.json",
);
const testSchemaPattern = /^centsible_test_[a-z0-9_]+$/;
// Only this pinned pre-cutover set may be inferred from schema evidence. Any
// later raw migration must execute normally and write its own tracker row.
const legacyRawBaselineFiles = [
  "0001_extras.sql",
  "0002_audit_sync_action.sql",
  "0003_cash_horizon_schema_patch.sql",
  "0004_bills_type_cadence.sql",
  "0005_phase1_integrity_indexes.sql",
  "0006_search_indexes.sql",
] as const;

type MigrationOptions = Readonly<{
  /** Exercises public legacy-history import in an isolated integration schema. */
  legacyJournalSchema?: string;
}>;

type GeneratedMigration = Readonly<{
  createdAt?: number;
  filename: string;
  hash: string;
  sourceSql: string;
}>;

/** Quotes only generated integration-test schema names. */
export function quoteIdentifier(schemaName: string): string {
  if (!testSchemaPattern.test(schemaName)) {
    throw new Error("Refusing to use a non-test schema identifier");
  }

  return `"${schemaName}"`;
}

function quoteRuntimeSchema(schemaName: string): string {
  return schemaName === "public" ? '"public"' : quoteIdentifier(schemaName);
}

function quoteDatabaseIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_$]*$/i.test(identifier)) {
    throw new Error("Migration schema has an unsafe identifier");
  }
  return `"${identifier}"`;
}

/** Resolves an explicitly selected schema for the migration CLI. */
export function resolveMigrationSchema(environment: NodeJS.ProcessEnv): string {
  const schemaName = environment.DATABASE_SCHEMA;
  if (!schemaName) {
    throw new Error(
      "DATABASE_SCHEMA is required; migrations never default to public",
    );
  }
  if (
    schemaName === "public" &&
    environment.ALLOW_PUBLIC_DATABASE_MIGRATION !== "true"
  ) {
    throw new Error(
      "DATABASE_SCHEMA=public requires ALLOW_PUBLIC_DATABASE_MIGRATION=true",
    );
  }

  return schemaName;
}

async function sortedSqlFiles(directory: string): Promise<string[]> {
  return (await readdir(directory))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();
}

async function readGeneratedMigrations(): Promise<GeneratedMigration[]> {
  const journal = JSON.parse(await readFile(migrationJournalPath, "utf8")) as {
    entries?: unknown;
  };
  if (!Array.isArray(journal.entries)) {
    throw new Error("Generated migration journal is invalid");
  }
  const journalEntries = journal.entries.map((entry, index) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("idx" in entry) ||
      entry.idx !== index ||
      !("tag" in entry) ||
      typeof entry.tag !== "string" ||
      !("when" in entry) ||
      typeof entry.when !== "number" ||
      !Number.isSafeInteger(entry.when)
    ) {
      throw new Error("Generated migration journal is invalid");
    }
    return { createdAt: entry.when, filename: `${entry.tag}.sql` };
  });
  const journalByFilename = new Map(
    journalEntries.map((entry) => [entry.filename, entry.createdAt]),
  );

  return Promise.all(
    (await sortedSqlFiles(migrationsDirectory)).map(async (filename) => {
      const sourceSql = await readFile(
        resolve(migrationsDirectory, filename),
        "utf8",
      );
      return {
        createdAt: journalByFilename.get(filename),
        filename,
        hash: createHash("sha256").update(sourceSql).digest("hex"),
        sourceSql,
      };
    }),
  );
}

async function relationExists(
  client: TransactionSql,
  qualifiedName: string,
): Promise<boolean> {
  const rows = await client<{ relation: string | null }[]>`
    select to_regclass(${qualifiedName})::text as relation
  `;
  return rows[0]?.relation !== null && rows[0]?.relation !== undefined;
}

async function importLegacyGeneratedHistory(
  client: TransactionSql,
  targetSchema: string,
  legacyJournalSchema: string,
  migrations: readonly GeneratedMigration[],
): Promise<void> {
  const legacyMigrations = migrations.filter(
    (migration): migration is GeneratedMigration & { createdAt: number } =>
      migration.createdAt !== undefined,
  );
  if (legacyMigrations.length === 0) {
    throw new Error("Generated migration journal has no legacy entries");
  }

  const quotedLegacySchema = quoteDatabaseIdentifier(legacyJournalSchema);
  const legacyTable = `${quotedLegacySchema}."__drizzle_migrations"`;
  if (
    !(await relationExists(
      client,
      `${legacyJournalSchema}.__drizzle_migrations`,
    ))
  ) {
    return;
  }

  const legacyRows = await client.unsafe<
    { created_at: string; hash: string }[]
  >(
    `select hash, created_at::text from ${legacyTable} order by created_at, id`,
  );
  const expectedLegacy = legacyMigrations.map(({ createdAt, hash }) => ({
    created_at: String(createdAt),
    hash,
  }));
  if (
    legacyRows.length !== expectedLegacy.length ||
    legacyRows.some(
      (row, index) =>
        row.hash !== expectedLegacy[index]?.hash ||
        row.created_at !== expectedLegacy[index]?.created_at,
    )
  ) {
    throw new Error("Legacy Drizzle migration history is inconsistent");
  }

  const quotedTarget = quoteRuntimeSchema(targetSchema);
  const targetTable = `${quotedTarget}."__drizzle_migrations"`;
  await client.unsafe(
    `CREATE TABLE IF NOT EXISTS ${targetTable} (
      "id" serial PRIMARY KEY NOT NULL,
      "hash" text NOT NULL,
      "created_at" bigint NOT NULL
    )`,
  );
  await client.savepoint(async (transaction) => {
    await transaction.unsafe(
      `LOCK TABLE ${targetTable} IN ACCESS EXCLUSIVE MODE`,
    );
    const targetRows = await transaction.unsafe<{ hash: string }[]>(
      `select hash from ${targetTable}`,
    );
    const targetHashes = new Set(targetRows.map((row) => row.hash));
    const knownHashes = new Set(migrations.map((migration) => migration.hash));
    const hasCompleteLegacyHistory = legacyMigrations.every((migration) =>
      targetHashes.has(migration.hash),
    );
    if (
      targetRows.length > 0 &&
      (!hasCompleteLegacyHistory ||
        targetHashes.size !== targetRows.length ||
        [...targetHashes].some((hash) => !knownHashes.has(hash)))
    ) {
      throw new Error("Schema-local migration history is inconsistent");
    }
    if (targetRows.length > 0) return;

    for (const migration of legacyMigrations) {
      await transaction.unsafe(
        `insert into ${targetTable} (hash, created_at) values ($1, $2)`,
        [migration.hash, migration.createdAt],
      );
    }
  });
}

function adaptGeneratedSql(sqlText: string, quotedSchema: string): string {
  return sqlText.replaceAll('"public".', `${quotedSchema}.`);
}

type ExtensionSchemas = Readonly<{
  pgTrgm: string;
  vector: string;
}>;

function adaptRawSql(sqlText: string, extensions: ExtensionSchemas): string {
  return sqlText
    .replaceAll(/^CREATE EXTENSION IF NOT EXISTS (?:vector|pg_trgm);\s*$/gm, "")
    .replaceAll("vector(1536)", `${extensions.vector}.vector(1536)`)
    .replaceAll("vector_cosine_ops", `${extensions.vector}.vector_cosine_ops`)
    .replaceAll("gin_trgm_ops", `${extensions.pgTrgm}.gin_trgm_ops`)
    .replace(
      /FROM pg_indexes WHERE indexname = ('[^']+')/g,
      "FROM pg_indexes WHERE indexname = $1 AND schemaname = current_schema()",
    )
    .replace(
      /(WHERE constraint_name = '[^']+'\s+AND table_name = '[^']+')/g,
      "$1 AND table_schema = current_schema()",
    );
}

function quoteExtensionSchema(schemaName: string): string {
  if (!/^[a-z_][a-z0-9_$]*$/i.test(schemaName)) {
    throw new Error("Required extension has an unsafe schema identifier");
  }

  return `"${schemaName}"`;
}

async function assertSharedExtensions(client: Sql): Promise<ExtensionSchemas> {
  const rows = await client<{ extname: string; schema_name: string }[]>`
    select extension.extname, namespace.nspname as schema_name
    from pg_extension as extension
    join pg_namespace as namespace on namespace.oid = extension.extnamespace
    where extname in ('vector', 'pg_trgm')
  `;
  const installed = new Map(rows.map((row) => [row.extname, row.schema_name]));
  const missing = ["vector", "pg_trgm"].filter(
    (extension) => !installed.has(extension),
  );

  if (missing.length > 0) {
    throw new Error(
      `Required shared database extensions are unavailable: ${missing.join(", ")}`,
    );
  }

  const vector = installed.get("vector");
  const pgTrgm = installed.get("pg_trgm");
  if (!vector || !pgTrgm) {
    throw new Error("Required shared database extensions are unavailable");
  }

  return {
    pgTrgm: quoteExtensionSchema(pgTrgm),
    vector: quoteExtensionSchema(vector),
  };
}

/** Confirms a client is bound to exactly the selected schema. */
export async function assertSchemaSearchPath(
  client: Sql,
  schemaName: string,
): Promise<void> {
  const rows = await client<{ search_path: string }[]>`show search_path`;
  if (rows[0]?.search_path !== schemaName) {
    throw new Error("Database connection search_path is not schema-isolated");
  }
}

async function applyGeneratedMigrations(
  client: TransactionSql,
  schemaName: string,
  options: MigrationOptions,
): Promise<void> {
  const quotedSchema = quoteRuntimeSchema(schemaName);
  const migrations = await readGeneratedMigrations();
  const legacyJournalSchema =
    options.legacyJournalSchema ??
    (schemaName === "public" ? "drizzle" : undefined);
  if (legacyJournalSchema) {
    await importLegacyGeneratedHistory(
      client,
      schemaName,
      legacyJournalSchema,
      migrations,
    );
  }
  await client.unsafe(
    `CREATE TABLE IF NOT EXISTS ${quotedSchema}."__drizzle_migrations" (
      "id" serial PRIMARY KEY NOT NULL,
      "hash" text NOT NULL,
      "created_at" bigint NOT NULL
    )`,
  );

  const appliedRows = await client<{ hash: string }[]>`
    select hash from __drizzle_migrations
  `;
  const applied = new Set(appliedRows.map((row) => row.hash));

  for (const { hash, sourceSql } of migrations) {
    if (applied.has(hash)) {
      continue;
    }

    const statements = adaptGeneratedSql(sourceSql, quotedSchema)
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);

    await client.savepoint(async (transaction) => {
      await transaction.unsafe(`SET LOCAL search_path TO ${quotedSchema}`);
      for (const statement of statements) {
        await transaction.unsafe(statement);
      }
      await transaction`
        insert into __drizzle_migrations (hash, created_at)
        values (${hash}, ${Date.now()})
      `;
    });
  }
}

async function applyRawMigrations(
  client: TransactionSql,
  schemaName: string,
  extensions: ExtensionSchemas,
): Promise<void> {
  const quotedSchema = quoteRuntimeSchema(schemaName);
  await client.unsafe(
    `CREATE TABLE IF NOT EXISTS ${quotedSchema}."schema_raw_migrations" (
      "filename" text PRIMARY KEY,
      "applied_at" timestamptz NOT NULL DEFAULT now()
    )`,
  );

  const appliedRows = await client<{ filename: string }[]>`
    select filename from schema_raw_migrations
  `;
  const applied = new Set(appliedRows.map((row) => row.filename));
  const migrationFiles = await sortedSqlFiles(rawMigrationsDirectory);

  if (applied.size === 0 && migrationFiles.length > 0) {
    const missingBaselineFiles = legacyRawBaselineFiles.filter(
      (filename) => !migrationFiles.includes(filename),
    );
    if (missingBaselineFiles.length > 0) {
      throw new Error("Pinned raw migration baseline files are unavailable");
    }

    const legacyRows = await client<
      {
        raw_0001: boolean;
        raw_0002: boolean;
        raw_0003: boolean;
        raw_0004: boolean;
        raw_0005: boolean;
        raw_0006: boolean;
      }[]
    >`
      select
        exists (
          select 1
          from information_schema.table_constraints
          where constraint_name = 'transactions_parent_fk'
            and table_name = 'transactions'
            and table_schema = current_schema()
        ) as raw_0001,
        exists (
          select 1
          from pg_enum as enum_value
          join pg_type as enum_type on enum_type.oid = enum_value.enumtypid
          join pg_namespace as namespace on namespace.oid = enum_type.typnamespace
          where namespace.nspname = current_schema()
            and enum_type.typname = 'audit_action'
            and enum_value.enumlabel = 'sync'
        ) as raw_0002,
        to_regclass('forecast_events_series_date_uniq') is not null as raw_0003,
        exists (
          select 1
          from information_schema.table_constraints
          where constraint_name = 'bill_setup_to_account_id_accounts_id_fk'
            and table_name = 'bill_setup'
            and table_schema = current_schema()
        ) as raw_0004,
        to_regclass('budgets_one_active_per_user_uniq') is not null as raw_0005,
        to_regclass('transactions_name_trgm_idx') is not null as raw_0006
    `;
    const legacyRow = legacyRows[0];
    if (!legacyRow) {
      throw new Error("Could not inspect legacy raw migration history");
    }
    const legacyState = [
      legacyRow.raw_0001,
      legacyRow.raw_0002,
      legacyRow.raw_0003,
      legacyRow.raw_0004,
      legacyRow.raw_0005,
      legacyRow.raw_0006,
    ];
    // Generated 0000 and 0004 already contain the idempotent effects repeated
    // by raw 0002 and 0004, so those two invariants are present on a clean DB.
    const generatedOnlyState = [false, true, false, true, false, false];
    const hasCompleteLegacyBaseline = legacyState.every(Boolean);
    const hasGeneratedOnlyBaseline = legacyState.every(
      (present, index) => present === generatedOnlyState[index],
    );

    if (hasCompleteLegacyBaseline) {
      await client.savepoint(async (transaction) => {
        for (const filename of legacyRawBaselineFiles) {
          await transaction`
            insert into schema_raw_migrations (filename)
            values (${filename})
          `;
          applied.add(filename);
        }
      });
    } else if (!hasGeneratedOnlyBaseline) {
      throw new Error("Legacy raw migration history is inconsistent");
    }
  }

  for (const file of migrationFiles) {
    if (applied.has(file)) {
      continue;
    }

    const sourceSql = await readFile(
      resolve(rawMigrationsDirectory, file),
      "utf8",
    );
    const migrationSql = adaptRawSql(sourceSql, extensions);

    await client.savepoint(async (transaction) => {
      await transaction.unsafe(`SET LOCAL search_path TO ${quotedSchema}`);
      await transaction.unsafe("SET LOCAL lock_timeout = '5s'");
      await transaction.unsafe(migrationSql);
      await transaction`
        insert into schema_raw_migrations (filename)
        values (${file})
      `;
    });
  }
}

/** Applies the generated and raw migration history inside one selected schema. */
export async function migrateSchema(
  client: Sql,
  schemaName: string,
  options: MigrationOptions = {},
): Promise<void> {
  const quotedSchema = quoteRuntimeSchema(schemaName);
  await client.unsafe(`SET search_path TO ${quotedSchema}`);
  await assertSchemaSearchPath(client, schemaName);
  const extensions = await assertSharedExtensions(client);
  await client.begin(async (transaction) => {
    await transaction.unsafe(`SET LOCAL search_path TO ${quotedSchema}`);
    await applyGeneratedMigrations(transaction, schemaName, options);
    await applyRawMigrations(transaction, schemaName, extensions);
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const schemaName = resolveMigrationSchema(process.env);
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    await migrateSchema(client, schemaName);
    await seedSchema(client, schemaName);
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
