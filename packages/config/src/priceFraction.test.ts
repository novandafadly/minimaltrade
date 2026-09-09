import { describe, it, expect } from "vitest";
import { tickSizeFor, roundDownToTick, roundUpToTick } from "./priceFraction.js";

describe("IDX price fraction table", () => {
  it("picks the correct tick per price tier", () => {
    expect(tickSizeFor(150)).toBe(1);
    expect(tickSizeFor(500)).toBe(2);
    expect(tickSizeFor(2000)).toBe(5);
    expect(tickSizeFor(5000)).toBe(10);
    expect(tickSizeFor(10000)).toBe(25);
  });

  it("rounds down/up to the nearest valid tick", () => {
    expect(roundDownToTick(1003)).toBe(1000);
    expect(roundUpToTick(1003)).toBe(1005);
  });
});
