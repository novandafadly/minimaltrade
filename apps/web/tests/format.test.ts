import { describe, expect, it } from "vitest";
import { formatAge, formatNumber, formatPercent, formatRatio, formatRupiah } from "../lib/format";

describe("formatRupiah", () => {
  it("formats whole rupiah with id-ID thousand separators and Rp prefix", () => {
    expect(formatRupiah(1000)).toBe("Rp1.000");
    expect(formatRupiah(1005)).toBe("Rp1.005");
    expect(formatRupiah(1040)).toBe("Rp1.040");
    expect(formatRupiah(5_000_000)).toBe("Rp5.000.000");
  });

  it("rounds to the nearest whole rupiah", () => {
    expect(formatRupiah(999.6)).toBe("Rp1.000");
  });

  it("returns an em dash for null/undefined/NaN", () => {
    expect(formatRupiah(null)).toBe("—");
    expect(formatRupiah(undefined)).toBe("—");
    expect(formatRupiah(NaN)).toBe("—");
  });
});

describe("formatNumber", () => {
  it("formats integers with id-ID grouping", () => {
    expect(formatNumber(14)).toBe("14");
    expect(formatNumber(1000)).toBe("1.000");
  });
});

describe("formatRatio", () => {
  it("formats with a comma decimal separator matching blueprint's 'Net RR 2,1' example", () => {
    expect(formatRatio(2.1)).toBe("2,1");
  });
});

describe("formatPercent", () => {
  it("formats a 0-1 ratio as a percentage", () => {
    expect(formatPercent(0.345)).toBe("34,5%");
    expect(formatPercent(0.05, 0)).toBe("5%");
  });
});

describe("formatAge", () => {
  const now = new Date("2026-09-09T10:00:00Z").getTime();

  it("returns 'just now' for very recent timestamps", () => {
    expect(formatAge(new Date(now - 2000).toISOString(), now)).toBe("just now");
  });

  it("formats seconds, minutes, hours, days", () => {
    expect(formatAge(new Date(now - 30_000).toISOString(), now)).toBe("30s");
    expect(formatAge(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5m");
    expect(formatAge(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe("3h");
    expect(formatAge(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe("2d");
  });

  it("returns 'unknown' for missing or invalid input", () => {
    expect(formatAge(null)).toBe("unknown");
    expect(formatAge("not-a-date")).toBe("unknown");
  });
});
