import { describe, it, expect } from "vitest";
import { buildSessionCalendar, isWithinSession } from "./sessionCalendar.js";

const env = {
  SESSION_TIMEZONE: "Asia/Jakarta",
  SESSION_MORNING_OPEN: "09:00",
  SESSION_MORNING_CLOSE: "11:30",
  SESSION_AFTERNOON_OPEN: "13:30",
  SESSION_AFTERNOON_CLOSE: "15:49",
  SESSION_FRIDAY_AFTERNOON_OPEN: "14:00"
};

describe("session calendar", () => {
  const cal = buildSessionCalendar(env);

  it("is within session during morning hours on a weekday", () => {
    expect(isWithinSession(cal, 2, 10 * 60)).toBe(true); // Tue 10:00
  });

  it("is outside session on weekends", () => {
    expect(isWithinSession(cal, 0, 10 * 60)).toBe(false); // Sun
    expect(isWithinSession(cal, 6, 10 * 60)).toBe(false); // Sat
  });

  it("uses the later Friday afternoon open", () => {
    expect(isWithinSession(cal, 5, 13 * 60 + 45)).toBe(false); // 13:45 Fri, before 14:00
    expect(isWithinSession(cal, 5, 14 * 60 + 15)).toBe(true); // 14:15 Fri
  });
});
