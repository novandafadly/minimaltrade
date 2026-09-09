import type { ZodIssue } from "zod";

/**
 * Adapter-level error types. Kept distinct from generic Error so callers
 * (funnel, health check) can branch on `instanceof` without string matching.
 */

/** Thrown when an upstream response fails Zod validation. Never retried —
 * a schema mismatch is a contract bug, not a transient failure. */
export class SchemaValidationError extends Error {
  readonly endpoint: string;
  readonly issues: ZodIssue[];
  readonly rawPayload: unknown;

  constructor(endpoint: string, issues: ZodIssue[], rawPayload: unknown) {
    super(`Schema validation failed for ${endpoint}: ${issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    this.name = "SchemaValidationError";
    this.endpoint = endpoint;
    this.issues = issues;
    this.rawPayload = rawPayload;
  }
}

/** Thrown by upstream HTTP calls that fail after exhausting retries. */
export class UpstreamHttpError extends Error {
  readonly endpoint: string;
  readonly status: number | null;
  readonly transient: boolean;

  constructor(endpoint: string, status: number | null, transient: boolean, message: string) {
    super(message);
    this.name = "UpstreamHttpError";
    this.endpoint = endpoint;
    this.status = status;
    this.transient = transient;
  }
}

/** Thrown when the circuit breaker is open and a call is short-circuited
 * with no stale fallback available. */
export class CircuitOpenError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string) {
    super(`Circuit breaker open for ${endpoint}; upstream calls short-circuited`);
    this.name = "CircuitOpenError";
    this.endpoint = endpoint;
  }
}

/** Thrown when a call would exceed the daily request budget (hard cap) or
 * the budget-minus-reserve ceiling for non-manual/non-retry callers. */
export class BudgetExceededError extends Error {
  readonly endpoint: string;
  readonly requested: number;
  readonly limit: number;

  constructor(endpoint: string, requested: number, limit: number) {
    super(`Daily request budget exceeded for ${endpoint}: ${requested} would exceed limit ${limit}`);
    this.name = "BudgetExceededError";
    this.endpoint = endpoint;
    this.requested = requested;
    this.limit = limit;
  }
}
