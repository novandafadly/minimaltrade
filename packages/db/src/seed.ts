import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import { strategyConfigTable } from "./schema.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to seed");

const sql = postgres(databaseUrl, { max: 1 });
const db = drizzle(sql);

await db
  .insert(strategyConfigTable)
  .values({
    version: DEFAULT_STRATEGY_CONFIG.version,
    formulaVersion: DEFAULT_STRATEGY_CONFIG.formulaVersion,
    config: DEFAULT_STRATEGY_CONFIG,
    isActive: true,
    createdBy: "seed"
  })
  .onConflictDoNothing();

await sql.end();
console.log(`Seeded strategy_config ${DEFAULT_STRATEGY_CONFIG.version}`);
