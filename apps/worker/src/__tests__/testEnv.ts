import type { Env } from "@idx/config";

/**
 * Shared test fixtures: a valid Env object (pointing at the local Postgres
 * test DB and a fake upstream base URL that nock intercepts) and a factory
 * for a fresh ioredis-mock client per test so tests don't share state.
 */
export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: "test",
    ARJUM_API_BASE_URL: "https://stock.arjum.test",
    ARJUM_API_KEY: "test-key",
    DAILY_REQUEST_BUDGET: 1000,
    DAILY_REQUEST_RESERVE: 250,
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://idx:idx@localhost:5432/idx_smart_money_test",
    REDIS_URL: "redis://localhost:6379/1",
    OBJECT_STORAGE_ENDPOINT: "http://localhost:9000",
    OBJECT_STORAGE_REGION: "us-east-1",
    OBJECT_STORAGE_BUCKET: "idx-raw-archive-test",
    OBJECT_STORAGE_ACCESS_KEY: "minioadmin",
    OBJECT_STORAGE_SECRET_KEY: "minioadmin",
    OBJECT_STORAGE_FORCE_PATH_STYLE: true,
    SESSION_TIMEZONE: "Asia/Jakarta",
    SESSION_MORNING_OPEN: "09:00",
    SESSION_MORNING_CLOSE: "11:30",
    SESSION_AFTERNOON_OPEN: "13:30",
    SESSION_AFTERNOON_CLOSE: "15:49",
    SESSION_FRIDAY_AFTERNOON_OPEN: "14:00",
    WEB_APP_SESSION_SECRET: "test-secret-at-least-16-chars",
    WORKER_POLL_INTERVAL_MS: 60000,
    WORKER_HEALTHCHECK_INTERVAL_MS: 300000,
    ...overrides
  };
}
