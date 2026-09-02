import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../database/schema/index.js";
import type { Db, DbTransaction } from "./types.js";

let db: Db | undefined;
let sql: ReturnType<typeof postgres> | undefined;

/** Returns the process-wide runtime database client. */
export function getDb(): Db {
  if (db) {
    return db;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  sql = postgres(databaseUrl, {
    connect_timeout: 10,
    idle_timeout: 20,
    max: 10,
    prepare: false,
  });
  db = drizzle(sql, { schema });
  return db;
}

/** Closes the process-wide runtime pool. */
export async function closeDb(): Promise<void> {
  if (!sql) {
    return;
  }

  await sql.end({ timeout: 5 });
  db = undefined;
  sql = undefined;
}

/** Runs work atomically through the runtime database client. */
export async function withTransaction<T>(
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  return getDb().transaction(fn);
}

export { schema };
export type { Db, DbTransaction } from "./types.js";
