import { z } from "zod";

/**
 * Central environment contract. Every process (worker, web BFF, scripts) must
 * import env from here instead of reading process.env directly, so a missing
 * or malformed variable fails fast at boot rather than producing silent NaNs
 * downstream in risk/scoring math.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  ARJUM_API_BASE_URL: z.string().url(),
  ARJUM_API_KEY: z.string().min(1),
  DAILY_REQUEST_BUDGET: z.coerce.number().int().positive().default(1000),
  DAILY_REQUEST_RESERVE: z.coerce.number().int().nonnegative().default(250),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  OBJECT_STORAGE_ENDPOINT: z.string().url(),
  OBJECT_STORAGE_REGION: z.string().default("us-east-1"),
  OBJECT_STORAGE_BUCKET: z.string().min(1),
  OBJECT_STORAGE_ACCESS_KEY: z.string().min(1),
  OBJECT_STORAGE_SECRET_KEY: z.string().min(1),
  OBJECT_STORAGE_FORCE_PATH_STYLE: z.coerce.boolean().default(true),

  SESSION_TIMEZONE: z.string().default("Asia/Jakarta"),
  SESSION_MORNING_OPEN: z.string().default("09:00"),
  SESSION_MORNING_CLOSE: z.string().default("11:30"),
  SESSION_AFTERNOON_OPEN: z.string().default("13:30"),
  SESSION_AFTERNOON_CLOSE: z.string().default("15:49"),
  SESSION_FRIDAY_AFTERNOON_OPEN: z.string().default("14:00"),

  WEB_APP_SESSION_SECRET: z.string().min(16),

  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  WORKER_HEALTHCHECK_INTERVAL_MS: z.coerce.number().int().positive().default(300000)
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}
