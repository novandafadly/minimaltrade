import { describe, expect, it, vi } from "vitest";
import { callUpstream } from "../httpClient.js";
import { CircuitBreaker } from "../circuitBreaker.js";
import { CircuitOpenError, UpstreamHttpError } from "../errors.js";
import { testEnv } from "../../__tests__/testEnv.js";

const env = testEnv();

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("callUpstream retry behavior", () => {
  it("retries a transient 5xx up to maxAttempts with exponential backoff, then succeeds", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call < 3) return jsonResponse(503);
      return jsonResponse(200, { ok: true });
    });
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };

    const result = await callUpstream(env, "/api/health", {
      fetchImpl,
      sleep,
      maxAttempts: 3,
      baseDelayMs: 100,
      breaker: new CircuitBreaker({ failureThreshold: 5, cooldownMs: 1000 })
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2); // slept between attempts 1->2 and 2->3
    expect(sleeps[0]).toBeGreaterThanOrEqual(100);
    expect(sleeps[1]).toBeGreaterThanOrEqual(200); // exponential growth
    expect(result.json).toEqual({ ok: true });
  });

  it("throws after exhausting maxAttempts on persistent 5xx", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500));
    await expect(
      callUpstream(env, "/api/health", {
        fetchImpl,
        sleep: async () => {},
        maxAttempts: 3,
        breaker: new CircuitBreaker({ failureThreshold: 100, cooldownMs: 1000 })
      })
    ).rejects.toBeInstanceOf(UpstreamHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("never retries a 4xx", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404));
    await expect(
      callUpstream(env, "/api/health", {
        fetchImpl,
        sleep: async () => {},
        maxAttempts: 3,
        breaker: new CircuitBreaker({ failureThreshold: 100, cooldownMs: 1000 })
      })
    ).rejects.toBeInstanceOf(UpstreamHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("circuit breaker integration", () => {
  it("opens after N consecutive failures and short-circuits further calls without hitting the network", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 5000 });
    const fetchImpl = vi.fn(async () => jsonResponse(500));

    for (let i = 0; i < 3; i++) {
      await expect(
        callUpstream(env, "/api/health", { fetchImpl, sleep: async () => {}, maxAttempts: 1, breaker })
      ).rejects.toBeInstanceOf(UpstreamHttpError);
    }

    expect(breaker.isOpen()).toBe(true);
    fetchImpl.mockClear();

    await expect(
      callUpstream(env, "/api/health", { fetchImpl, sleep: async () => {}, maxAttempts: 1, breaker })
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fetchImpl).not.toHaveBeenCalled(); // short-circuited, no network call
  });

  it("moves to half-open after the cooldown and closes again on a successful trial call", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10 });
    const fetchImpl = vi.fn(async () => jsonResponse(500));
    await expect(
      callUpstream(env, "/api/health", { fetchImpl, sleep: async () => {}, maxAttempts: 1, breaker })
    ).rejects.toBeInstanceOf(UpstreamHttpError);
    expect(breaker.isOpen()).toBe(true);

    await new Promise((r) => setTimeout(r, 15));
    expect(breaker.isOpen()).toBe(false); // cooldown elapsed -> half-open, trial call allowed

    fetchImpl.mockImplementationOnce(async () => jsonResponse(200, { ok: true }));
    const result = await callUpstream(env, "/api/health", { fetchImpl, sleep: async () => {}, maxAttempts: 1, breaker });
    expect(result.json).toEqual({ ok: true });
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.getState()).toBe("closed");
  });
});
