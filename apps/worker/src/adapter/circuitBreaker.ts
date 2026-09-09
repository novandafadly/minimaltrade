/**
 * Simple in-process circuit breaker (blueprint §11: protect upstream from
 * hammering during an outage, and mark downstream signals stale while open).
 *
 * One breaker instance is shared across all endpoints by default (the
 * upstream is a single provider/host — if it's down, it's down for
 * everything), but each call site can pass its own breaker instance if a
 * per-endpoint breaker is ever desired.
 */

export interface CircuitBreakerOptions {
  /** consecutive failures before the circuit opens */
  failureThreshold: number;
  /** cooldown window (ms) the circuit stays open before allowing a trial call */
  cooldownMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  cooldownMs: 60_000
};

type CircuitState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private readonly options: CircuitBreakerOptions;

  constructor(options: CircuitBreakerOptions = DEFAULT_CIRCUIT_BREAKER_OPTIONS) {
    this.options = options;
  }

  /** True if calls should be short-circuited right now. Transitions
   * open -> half-open once the cooldown has elapsed, allowing one trial call. */
  isOpen(now: number = Date.now()): boolean {
    if (this.state !== "open") return false;
    if (this.openedAt !== null && now - this.openedAt >= this.options.cooldownMs) {
      this.state = "half-open";
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
    this.openedAt = null;
  }

  recordFailure(now: number = Date.now()): void {
    this.consecutiveFailures += 1;
    if (this.state === "half-open") {
      // trial call failed -> reopen immediately
      this.state = "open";
      this.openedAt = now;
      return;
    }
    if (this.consecutiveFailures >= this.options.failureThreshold) {
      this.state = "open";
      this.openedAt = now;
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}

/** Process-wide default breaker shared by the adapter's endpoint functions. */
export const sharedCircuitBreaker = new CircuitBreaker();

export function isCircuitOpen(now?: number): boolean {
  return sharedCircuitBreaker.isOpen(now);
}
