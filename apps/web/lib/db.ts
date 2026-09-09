// Server-only module: imports the pg driver, must never be pulled into a
// client bundle. Only import this from Route Handlers / server components.
import { loadEnv } from "@idx/config";
import { createDbClient, type Db } from "@idx/db";

/**
 * Lazily-constructed singleton DB client for route handlers. loadEnv() is
 * only invoked here (inside a function body, not at module load time) so
 * `next build`'s static analysis of route handler modules never requires
 * DATABASE_URL etc. to be present — only an actual request does.
 */
let cached: Db | undefined;

export function getDb(): Db {
  if (!cached) {
    const env = loadEnv();
    cached = createDbClient(env.DATABASE_URL);
  }
  return cached;
}
