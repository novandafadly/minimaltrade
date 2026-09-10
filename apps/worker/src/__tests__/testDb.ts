import { createDbClient, schema, type Db } from "@idx/db";
import { sql } from "drizzle-orm";
import { testEnv } from "./testEnv.js";

let db: Db | undefined;

/** Shared Db client against the local Postgres test database (migrated via
 * `pnpm --filter @idx/db run migrate` with TEST_DATABASE_URL/DATABASE_URL
 * pointed at it before running these tests). */
export function getTestDb(): Db {
  if (!db) db = createDbClient(testEnv().DATABASE_URL);
  return db;
}

/** Truncates every table this worker writes to, for isolation between
 * tests. Cheap enough to call in beforeEach given the small row counts. */
export async function truncateAll(): Promise<void> {
  const database = getTestDb();
  await database.execute(sql`
    TRUNCATE TABLE
      ${schema.tradePlan},
      ${schema.signal},
      ${schema.featureSnapshot},
      ${schema.brokerSnapshot},
      ${schema.marketSnapshot},
      ${schema.rawPayloadArchive},
      ${schema.requestLedger},
      ${schema.alertLog},
      ${schema.shadowPlan},
      ${schema.dailyBar}
    RESTART IDENTITY CASCADE
  `);
}
