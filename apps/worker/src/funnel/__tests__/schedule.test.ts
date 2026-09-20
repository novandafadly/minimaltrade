import { describe, it, expect } from "vitest";
import { buildSessionCalendar } from "@idx/config";
import { isDeepFunnelWindow } from "../schedule.js";

const cal = buildSessionCalendar({
  SESSION_TIMEZONE: "Asia/Jakarta",
  SESSION_MORNING_OPEN: "09:00",
  SESSION_MORNING_CLOSE: "11:30",
  SESSION_AFTERNOON_OPEN: "13:30",
  SESSION_AFTERNOON_CLOSE: "15:49",
  SESSION_FRIDAY_AFTERNOON_OPEN: "14:00"
});
const at = (h: number, m = 0) => h * 60 + m;
const THU = 4;

describe("isDeepFunnelWindow", () => {
  it("does NOT fire during the lunch break (the 2026-09-10 bug: ran at 11:31 with yesterday's bars)", () => {
    expect(isDeepFunnelWindow(cal, THU, at(11, 31))).toBe(false);
    expect(isDeepFunnelWindow(cal, THU, at(13, 11))).toBe(false);
  });

  it("does NOT fire pre-open or during sessions", () => {
    expect(isDeepFunnelWindow(cal, THU, at(0, 5))).toBe(false);
    expect(isDeepFunnelWindow(cal, THU, at(8, 59))).toBe(false);
    expect(isDeepFunnelWindow(cal, THU, at(10, 0))).toBe(false);
    expect(isDeepFunnelWindow(cal, THU, at(15, 0))).toBe(false);
  });

  it("does NOT fire in the settle delay right after the close", () => {
    expect(isDeepFunnelWindow(cal, THU, at(15, 49))).toBe(false);
    expect(isDeepFunnelWindow(cal, THU, at(16, 18))).toBe(false);
  });

  it("opens 30 minutes after the afternoon close and stays open until 22:00", () => {
    expect(isDeepFunnelWindow(cal, THU, at(16, 19))).toBe(true);
    expect(isDeepFunnelWindow(cal, THU, at(18, 15))).toBe(true);
    expect(isDeepFunnelWindow(cal, THU, at(21, 59))).toBe(true);
    expect(isDeepFunnelWindow(cal, THU, at(22, 0))).toBe(false);
  });

  it("never fires on weekends", () => {
    expect(isDeepFunnelWindow(cal, 0, at(18, 0))).toBe(false);
    expect(isDeepFunnelWindow(cal, 6, at(18, 0))).toBe(false);
  });
});
