import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";

const databaseDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(databaseDirectory, "migrations");
const rawMigrationsDirectory = resolve(migrationsDirectory, "raw");
const testSchemaPattern = /^centsible_test_[a-z0-9_]+$/;

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

async function sortedSqlFiles(directory: string): Promise<string[]> {
  return (await readdir(directory))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();
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

async function assertSearchPath(
  client: Sql,
  schemaName: string,
): Promise<void> {
  const rows = await client<{ search_path: string }[]>`show search_path`;
  if (rows[0]?.search_path !== schemaName) {
    throw new Error("Database connection search_path is not schema-isolated");
  }
}

async function applyGeneratedMigrations(
  client: Sql,
  schemaName: string,
): Promise<void> {
  const quotedSchema = quoteRuntimeSchema(schemaName);
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

  for (const file of await sortedSqlFiles(migrationsDirectory)) {
    const sourceSql = await readFile(
      resolve(migrationsDirectory, file),
      "utf8",
    );
    const hash = createHash("sha256").update(sourceSql).digest("hex");
    if (applied.has(hash)) {
      continue;
    }

    const statements = adaptGeneratedSql(sourceSql, quotedSchema)
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);

    await client.begin(async (transaction) => {
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
  client: Sql,
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

  for (const file of await sortedSqlFiles(rawMigrationsDirectory)) {
    if (applied.has(file)) {
      continue;
    }

    const sourceSql = await readFile(
      resolve(rawMigrationsDirectory, file),
      "utf8",
    );
    const migrationSql = adaptRawSql(sourceSql, extensions);

    await client.begin(async (transaction) => {
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
): Promise<void> {
  const quotedSchema = quoteRuntimeSchema(schemaName);
  await client.unsafe(`SET search_path TO ${quotedSchema}`);
  await assertSearchPath(client, schemaName);
  const extensions = await assertSharedExtensions(client);
  await applyGeneratedMigrations(client, schemaName);
  await applyRawMigrations(client, schemaName, extensions);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const schemaName = process.env.DATABASE_SCHEMA ?? "public";
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    await migrateSchema(client, schemaName);
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
