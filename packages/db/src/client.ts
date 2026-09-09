import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

export function createDbClient(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 10 });
  return drizzle(sql, { schema });
}

export type Db = ReturnType<typeof createDbClient>;
export * as schema from "./schema.js";
