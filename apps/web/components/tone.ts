import type { CategoryBadge } from "../lib/category";
import type { HealthStatus } from "../lib/types";

export function toneClassName(tone: CategoryBadge["tone"]): string {
  return `badge badge-${tone}`;
}

export function healthToneClassName(status: HealthStatus): string {
  const map: Record<HealthStatus, string> = {
    ok: "health-ok",
    degraded: "health-degraded",
    down: "health-down",
    unknown: "health-unknown"
  };
  return map[status];
}
