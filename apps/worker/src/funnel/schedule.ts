import type { SessionCalendarConfig } from "@idx/config";

/**
 * When is the once-a-day deep funnel allowed to run?
 *
 * It used to be gated on "not currently inside a trading session". That is
 * NOT the same as "after the trading day ended": the lunch break
 * (11:30-13:30, Fri 11:30-14:00) and the whole pre-open stretch
 * (00:00-09:00) are also outside a session. The funnel therefore fired at
 * ~11:31 WIB (first tick after the morning session) using the PREVIOUS day's
 * bars, tripped the staleness gate ("Data is stale or provisional") on every
 * name, and burned the day's single run via the Redis flag -- so the real
 * after-close data was never processed.
 *
 * The window below is: weekday, at least DELAY minutes after the afternoon
 * close, and before LATEST. The worker additionally requires a canary
 * (see index.ts) proving the upstream has actually published today's bar.
 */
export const DEEP_FUNNEL_DELAY_MINUTES_AFTER_CLOSE = 30;
export const DEEP_FUNNEL_LATEST_MINUTES = 22 * 60; // stop probing at 22:00 local (holidays never publish a bar)
export const DEEP_FUNNEL_CANARY_SYMBOL = "BBCA";
export const DEEP_FUNNEL_CANARY_INTERVAL_SECONDS = 10 * 60;

export function isDeepFunnelWindow(
  cal: SessionCalendarConfig,
  dayOfWeek: number,
  minutesSinceMidnight: number
): boolean {
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const earliest = cal.afternoon.closeMinutes + DEEP_FUNNEL_DELAY_MINUTES_AFTER_CLOSE;
  return minutesSinceMidnight >= earliest && minutesSinceMidnight < DEEP_FUNNEL_LATEST_MINUTES;
}

/**
 * Is the upstream ready for the deep funnel? The price history and the broker
 * summary are published on DIFFERENT clocks: on 2026-09-21 the BBCA price bar for
 * the day appeared at ~17:09 WIB while the broker summary still ended on the
 * previous Friday, so a canary that only looked at price ran the funnel on
 * stale broker books (every candidate tripped the FRESHNESS gate and the stale
 * books were then cached for 24h). Both must show today's date.
 */
export function deepFunnelUpstreamReady(input: {
  dayBucket: string;
  lastBarDate: string | null | undefined;
  brokerEndDate: string | null | undefined;
}): { ready: boolean; reason: string } {
  if (input.lastBarDate !== input.dayBucket)
    return { ready: false, reason: `price history latest bar is ${input.lastBarDate ?? "none"}, need ${input.dayBucket}` };
  if (input.brokerEndDate !== input.dayBucket)
    return { ready: false, reason: `broker summary ends ${input.brokerEndDate ?? "none"}, need ${input.dayBucket}` };
  return { ready: true, reason: "price history and broker summary both published for today" };
}
