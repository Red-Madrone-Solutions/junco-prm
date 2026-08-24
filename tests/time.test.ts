import { describe, expect, it } from "vitest";
import { isLocalDate, localDate, nowIso } from "../src/time";

describe("nowIso", () => {
  it("formats the clock as a UTC instant", () => {
    const fixed = new Date("2026-08-20T19:34:05.123Z");
    expect(nowIso(() => fixed)).toBe("2026-08-20T19:34:05.123Z");
  });
});

describe("localDate", () => {
  it("returns the owner's local date, not the UTC date", () => {
    // 02:30 UTC on the 21st is still the 20th in Los Angeles.
    const instant = new Date("2026-08-21T02:30:00Z");
    expect(localDate("America/Los_Angeles", instant)).toBe("2026-08-20");
    expect(localDate("UTC", instant)).toBe("2026-08-21");
  });

  it("handles a zone ahead of UTC", () => {
    const instant = new Date("2026-08-20T22:00:00Z");
    expect(localDate("Asia/Tokyo", instant)).toBe("2026-08-21");
  });
});

describe("isLocalDate", () => {
  it("accepts YYYY-MM-DD", () => {
    expect(isLocalDate("2026-08-20")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isLocalDate("2026-8-20")).toBe(false);
    expect(isLocalDate("2026-08-20T00:00:00Z")).toBe(false);
    expect(isLocalDate("tomorrow")).toBe(false);
    expect(isLocalDate(20260820)).toBe(false);
  });

  it("rejects a date that matches the shape but does not exist", () => {
    expect(isLocalDate("2026-02-31")).toBe(false);
    expect(isLocalDate("2026-13-01")).toBe(false);
    expect(isLocalDate("2026-00-10")).toBe(false);
    expect(isLocalDate("2026-04-31")).toBe(false);
  });

  it("accepts a real leap day and rejects a fake one", () => {
    expect(isLocalDate("2028-02-29")).toBe(true);
    expect(isLocalDate("2026-02-29")).toBe(false);
  });
});
