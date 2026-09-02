import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../../../database/schema/index.js";

export type Db = PostgresJsDatabase<typeof schema>;
export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
