import { defineConfig } from "vitest/config";

/**
 * Several test files share one physical Postgres test database (truncated
 * between tests) and use nock's global HTTP interceptor state, so test
 * files must not run concurrently against each other. `fileParallelism:
 * false` runs test files sequentially (each file's own tests can still run
 * concurrently within itself, but we don't rely on that either).
 */
export default defineConfig({
  test: {
    fileParallelism: false
  }
});
