import type { Env } from "@idx/config";
import { CircuitOpenError, UpstreamHttpError } from "./errors.js";
import { sharedCircuitBreaker, type CircuitBreaker } from "./circuitBreaker.js";

/**
 * Thin fetch wrapper: X-API-Key auth, bounded retry with exponential
 * backoff + jitter for transient errors only, and circuit breaker
 * integration. No schema parsing here — that's endpoints.ts's job, kept
 * separate so retry/circuit logic is testable without Zod fixtures.
 */

export interface HttpCallOptions {
  /** max attempts including the first (default 3) */
  maxAttempts?: number;
  /** base delay in ms for exponential backoff (default 200) */
  baseDelayMs?: number;
  breaker?: CircuitBreaker;
  /** override for tests: injected sleep implementation */
  sleep?: (ms: number) => Promise<void>;
  /** override for tests: injected fetch implementation */
  fetchImpl?: typeof fetch;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isTransientStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

/** Result of a raw HTTP call: parsed JSON body plus the status/timing metadata
 * the adapter needs for the raw archive and DataEnvelope construction. */
export interface RawHttpResult {
  status: number;
  json: unknown;
  requestedAt: string;
  receivedAt: string;
}

export async function callUpstream(
  env: Pick<Env, "ARJUM_API_BASE_URL" | "ARJUM_API_KEY">,
  path: string,
  options: HttpCallOptions = {}
): Promise<RawHttpResult> {
  const breaker = options.breaker ?? sharedCircuitBreaker;
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 200;
  const sleep = options.sleep ?? defaultSleep;
  const doFetch = options.fetchImpl ?? fetch;

  if (breaker.isOpen()) {
    throw new CircuitOpenError(path);
  }

  const url = new URL(path, env.ARJUM_API_BASE_URL).toString();
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const requestedAt = new Date().toISOString();
    try {
      const res = await doFetch(url, {
        method: "GET",
        headers: { "X-API-Key": env.ARJUM_API_KEY, Accept: "application/json" }
      });
      const receivedAt = new Date().toISOString();

      if (isTransientStatus(res.status)) {
        lastError = new UpstreamHttpError(path, res.status, true, `Transient upstream error ${res.status} on ${path}`);
        breaker.recordFailure();
        if (attempt < maxAttempts) {
          await sleep(backoffDelay(baseDelayMs, attempt));
          continue;
        }
        throw lastError;
      }

      if (res.status >= 400) {
        // 4xx: not transient, never retried, still counts as a failure for the breaker
        breaker.recordFailure();
        await safeJson(res); // drain body for cleanliness; content not needed on the error path
        throw new UpstreamHttpError(path, res.status, false, `Upstream rejected request: ${res.status} on ${path}`);
      }

      const json = await res.json();
      breaker.recordSuccess();
      return { status: res.status, json, requestedAt, receivedAt };
    } catch (err) {
      if (err instanceof UpstreamHttpError) {
        if (!err.transient) throw err;
        lastError = err;
      } else {
        // network error / timeout: treat as transient
        breaker.recordFailure();
        lastError = new UpstreamHttpError(path, null, true, `Network error calling ${path}: ${(err as Error).message}`);
        if (attempt < maxAttempts) {
          await sleep(backoffDelay(baseDelayMs, attempt));
          continue;
        }
      }
      throw lastError;
    }
  }

  throw lastError ?? new UpstreamHttpError(path, null, true, `Unknown failure calling ${path}`);
}

function backoffDelay(baseDelayMs: number, attempt: number): number {
  const exp = baseDelayMs * 2 ** (attempt - 1);
  const jitter = Math.random() * baseDelayMs;
  return exp + jitter;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
