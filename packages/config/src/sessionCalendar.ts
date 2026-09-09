/**
 * IDX trading session windows (WIB / Asia-Jakarta). Used to gate polling and
 * to mark data "outside session" so screener/broker data isn't misread as a
 * live intraday trigger when the market is closed. Configurable via env;
 * defaults reflect standard IDX hours as of this blueprint.
 */
export interface SessionWindow {
  openMinutes: number; // minutes from local midnight
  closeMinutes: number;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export interface SessionCalendarConfig {
  timezone: string;
  morning: SessionWindow;
  afternoon: SessionWindow;
  fridayAfternoonOpen: number;
}

export function buildSessionCalendar(env: {
  SESSION_TIMEZONE: string;
  SESSION_MORNING_OPEN: string;
  SESSION_MORNING_CLOSE: string;
  SESSION_AFTERNOON_OPEN: string;
  SESSION_AFTERNOON_CLOSE: string;
  SESSION_FRIDAY_AFTERNOON_OPEN: string;
}): SessionCalendarConfig {
  return {
    timezone: env.SESSION_TIMEZONE,
    morning: {
      openMinutes: toMinutes(env.SESSION_MORNING_OPEN),
      closeMinutes: toMinutes(env.SESSION_MORNING_CLOSE)
    },
    afternoon: {
      openMinutes: toMinutes(env.SESSION_AFTERNOON_OPEN),
      closeMinutes: toMinutes(env.SESSION_AFTERNOON_CLOSE)
    },
    fridayAfternoonOpen: toMinutes(env.SESSION_FRIDAY_AFTERNOON_OPEN)
  };
}

/** Returns true if the given local wall-clock time (minutes since midnight, 0-6 dow Sun=0) is inside a regular session. */
export function isWithinSession(
  cal: SessionCalendarConfig,
  dayOfWeek: number,
  minutesSinceMidnight: number
): boolean {
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const morningOpen = cal.morning.openMinutes;
  const afternoonOpen = dayOfWeek === 5 ? cal.fridayAfternoonOpen : cal.afternoon.openMinutes;
  const inMorning =
    minutesSinceMidnight >= morningOpen && minutesSinceMidnight <= cal.morning.closeMinutes;
  const inAfternoon =
    minutesSinceMidnight >= afternoonOpen && minutesSinceMidnight <= cal.afternoon.closeMinutes;
  return inMorning || inAfternoon;
}
