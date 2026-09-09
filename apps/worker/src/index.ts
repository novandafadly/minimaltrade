import { loadEnv } from "@idx/config";

/**
 * Worker entrypoint placeholder. Real orchestration (scheduler, adapter,
 * funnel, cache, ledger) lands in Phase 1 remainder / Phase 2.
 */
function main() {
  const env = loadEnv();
  console.log(`[worker] starting in ${env.NODE_ENV} mode (placeholder)`);
}

main();
