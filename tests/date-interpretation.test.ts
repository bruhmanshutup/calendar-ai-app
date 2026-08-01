import { describe, expect, it } from "vitest";
import {
  dateOnlyPlanningDeadline,
  parseClockTime,
  resolveRelativeDate,
} from "../lib/domain/date-interpretation";

describe("date interpretation", () => {
  it("resolves Friday from the user local date", () => {
    expect(
      resolveRelativeDate(
        "Friday",
        "2026-07-29",
        "America/Los_Angeles",
      ),
    ).toEqual({
      date: "2026-07-31",
      time: undefined,
      instant: undefined,
      ambiguous: false,
    });
  });

  it("resolves next Tuesday deterministically", () => {
    expect(
      resolveRelativeDate(
        "next Tuesday",
        "2026-07-30",
        "America/Los_Angeles",
      ).date,
    ).toBe("2026-08-04");
  });

  it("keeps date-only deadlines without an invented time", () => {
    const result = resolveRelativeDate(
      "Friday",
      "2026-07-30",
      "America/Los_Angeles",
    );
    expect(result.date).toBe("2026-07-31");
    expect(result.time).toBeUndefined();
    expect(result.instant).toBeUndefined();
  });

  it("resolves ISO, numeric, and month-name calendar dates", () => {
    expect(
      resolveRelativeDate("2026-08-15", "2026-07-30", "UTC").date,
    ).toBe("2026-08-15");
    expect(
      resolveRelativeDate("8/15/2026", "2026-07-30", "UTC").date,
    ).toBe("2026-08-15");
    expect(
      resolveRelativeDate("Aug 15", "2026-07-30", "UTC").date,
    ).toBe("2026-08-15");
    expect(
      resolveRelativeDate("15 August 2026", "2026-07-30", "UTC").date,
    ).toBe("2026-08-15");
  });

  it("keeps ambiguous numeric dates usable but flags them for review", () => {
    const result = resolveRelativeDate("8/9", "2026-07-30", "UTC");
    expect(result.date).toBe("2026-08-09");
    expect(result.ambiguous).toBe(true);
    expect(result.explanation).toContain("month/day");
  });

  it("rolls a yearless calendar date forward when needed", () => {
    expect(
      resolveRelativeDate("July 15", "2026-07-30", "UTC").date,
    ).toBe("2027-07-15");
  });

  it("rejects impossible calendar dates", () => {
    const result = resolveRelativeDate("February 30", "2026-07-30", "UTC");
    expect(result.date).toBeUndefined();
    expect(result.ambiguous).toBe(true);
  });

  it("resolves explicit due times in the user time zone", () => {
    const result = resolveRelativeDate(
      "Friday at 5 PM",
      "2026-07-30",
      "America/Los_Angeles",
    );
    expect(result.time).toBe("17:00");
    expect(result.instant).toBe("2026-08-01T00:00:00.000Z");
  });

  it("handles daylight-saving transitions", () => {
    const result = resolveRelativeDate(
      "Sunday at 9 AM",
      "2026-03-07",
      "America/Los_Angeles",
    );
    expect(result.instant).toBe("2026-03-08T16:00:00.000Z");
  });

  it("uses sleeping time only as a feasibility assumption", () => {
    expect(
      dateOnlyPlanningDeadline(
        "2026-03-08",
        "23:00",
        "America/Los_Angeles",
      ),
    ).toBe("2026-03-09T06:00:00.000Z");
  });

  it("returns a typed ambiguous result for missing and unclear dates", () => {
    expect(resolveRelativeDate("", "2026-07-30", "UTC").ambiguous).toBe(true);
    const ambiguous = resolveRelativeDate(
      "sometime next weekend",
      "2026-07-30",
      "UTC",
    );
    expect(ambiguous.date).toBeUndefined();
    expect(ambiguous.ambiguous).toBe(true);
  });

  it("parses 12-hour and 24-hour clock values safely", () => {
    expect(parseClockTime("12 AM")).toBe("00:00");
    expect(parseClockTime("12:30 pm")).toBe("12:30");
    expect(parseClockTime("23:15")).toBe("23:15");
    expect(parseClockTime("25:00")).toBeUndefined();
  });
});
