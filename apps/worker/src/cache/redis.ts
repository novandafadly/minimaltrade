import { Redis } from "ioredis";

/** Single shared Redis connection factory. Tests inject their own client
 * (ioredis-mock or a real local instance) rather than calling this. */
export function createRedisClient(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    // fail fast on boot instead of buffering forever if Redis is down
    maxRetriesPerRequest: 3,
    lazyConnect: false
  });
}
