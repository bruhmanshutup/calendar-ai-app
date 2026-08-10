import { describe, expect, it } from "vitest";
import { DAYS_OF_WEEK, recurrenceTimesForDay } from "../lib/domain/recurrence";
import type { DayOfWeek } from "../lib/domain/types";
import { parseTimedRecurrence } from "../lib/providers/timed-recurrence";

const context = {
  currentLocalDate: "2026-08-09",
  timeZone: "America/Los_Angeles",
};

function scheduleFor(text: string): Record<DayOfWeek, string[]> {
  const parsed = parseTimedRecurrence(text, context);
  expect(parsed, text).toBeDefined();
  return Object.fromEntries(
    DAYS_OF_WEEK.map((day) => [
      day,
      recurrenceTimesForDay(parsed?.recurrence, day),
    ]),
  ) as Record<DayOfWeek, string[]>;
}

describe("common exact recurrence wording", () => {
  it.each([
    {
      label: "one daily time",
      text: "Take medication every day at 8 AM.",
      expected: Object.fromEntries(DAYS_OF_WEEK.map((day) => [day, ["08:00"]])),
    },
    {
      label: "weekday and weekend split",
      text: "Take medication every weekday at 8 AM and weekends at 10 AM.",
      expected: {
        monday: ["08:00"],
        tuesday: ["08:00"],
        wednesday: ["08:00"],
        thursday: ["08:00"],
        friday: ["08:00"],
        saturday: ["10:00"],
        sunday: ["10:00"],
      },
    },
    {
      label: "day range and weekend split",
      text: "Practice Monday through Friday at 7 AM; weekends at 9 AM.",
      expected: {
        monday: ["07:00"],
        tuesday: ["07:00"],
        wednesday: ["07:00"],
        thursday: ["07:00"],
        friday: ["07:00"],
        saturday: ["09:00"],
        sunday: ["09:00"],
      },
    },
    {
      label: "slash-separated day groups",
      text: "Practice piano Mon/Wed/Fri at 7 AM and Tue/Thu at 6 PM.",
      expected: {
        monday: ["07:00"],
        tuesday: ["18:00"],
        wednesday: ["07:00"],
        thursday: ["18:00"],
        friday: ["07:00"],
        saturday: [],
        sunday: [],
      },
    },
    {
      label: "skipped weekday",
      text: "Take medication every day at 8 AM except Sunday.",
      expected: {
        monday: ["08:00"],
        tuesday: ["08:00"],
        wednesday: ["08:00"],
        thursday: ["08:00"],
        friday: ["08:00"],
        saturday: ["08:00"],
        sunday: [],
      },
    },
    {
      label: "replacement weekday time",
      text: "Take medication every day at 8 AM, except Sunday at 10 AM.",
      expected: {
        monday: ["08:00"],
        tuesday: ["08:00"],
        wednesday: ["08:00"],
        thursday: ["08:00"],
        friday: ["08:00"],
        saturday: ["08:00"],
        sunday: ["10:00"],
      },
    },
    {
      label: "multiple daily occurrences",
      text: "Take medication every day at 8 AM and 8 PM.",
      expected: Object.fromEntries(
        DAYS_OF_WEEK.map((day) => [day, ["08:00", "20:00"]]),
      ),
    },
    {
      label: "replacement removes both default times",
      text: "Take medication every day at 8 AM and 8 PM, except Sunday at 9 AM.",
      expected: {
        monday: ["08:00", "20:00"],
        tuesday: ["08:00", "20:00"],
        wednesday: ["08:00", "20:00"],
        thursday: ["08:00", "20:00"],
        friday: ["08:00", "20:00"],
        saturday: ["08:00", "20:00"],
        sunday: ["09:00"],
      },
    },
    {
      label: "noon and midnight",
      text: "Check equipment weekdays at noon, weekends at midnight.",
      expected: {
        monday: ["12:00"],
        tuesday: ["12:00"],
        wednesday: ["12:00"],
        thursday: ["12:00"],
        friday: ["12:00"],
        saturday: ["00:00"],
        sunday: ["00:00"],
      },
    },
  ])("interprets $label exactly", ({ text, expected }) => {
    expect(scheduleFor(text)).toEqual(expected);
  });

  it("keeps a one-date replacement separate from the weekly pattern", () => {
    const parsed = parseTimedRecurrence(
      "Take medication every day at 8 AM, except August 12 at 10 AM.",
      context,
    );

    expect(parsed?.recurrence.timeRules).toEqual([
      { daysOfWeek: DAYS_OF_WEEK, time: "08:00" },
    ]);
    expect(parsed?.recurrence.dateOverrides).toEqual([
      { date: "2026-08-12", times: ["10:00"] },
    ]);
  });

  it("keeps a one-date skip separate from permanent days off", () => {
    const parsed = parseTimedRecurrence(
      "Take medication every day at 8 AM; skip August 12.",
      context,
    );

    expect(parsed?.recurrence.daysOfWeek).toEqual(DAYS_OF_WEEK);
    expect(parsed?.recurrence.dateOverrides).toEqual([
      { date: "2026-08-12", skip: true },
    ]);
  });

  it("anchors an every-other-day pattern only when the first date is explicit", () => {
    const anchored = parseTimedRecurrence(
      "Water plants every other day at 8 AM starting August 10, 2026.",
      context,
    );
    const unanchored = parseTimedRecurrence(
      "Water plants every other day at 8 AM.",
      context,
    );

    expect(anchored?.recurrence).toMatchObject({
      frequency: "daily",
      interval: 2,
      anchorDate: "2026-08-10",
    });
    expect(anchored?.issues).not.toContain(
      "Confirm the first occurrence in the repeating interval",
    );
    expect(unanchored?.issues).toContain(
      "Confirm the first occurrence in the repeating interval",
    );
  });

  it("preserves explicit start, duration, end, and occurrence limits", () => {
    const duration = parseTimedRecurrence(
      "Take medication every day at 8 AM for 2 weeks starting August 10, 2026.",
      context,
    );
    const until = parseTimedRecurrence(
      "Take medication every day at 8 AM until September 1, 2026.",
      context,
    );
    const limited = parseTimedRecurrence(
      "Take medication every day at 8 AM for ten occurrences.",
      context,
    );

    expect(duration?.recurrence).toMatchObject({
      anchorDate: "2026-08-10",
      windowStart: "2026-08-10T07:00:00.000Z",
      windowEnd: "2026-08-24T06:59:59.000Z",
    });
    expect(until?.recurrence.windowEnd).toBe("2026-09-02T06:59:59.000Z");
    expect(limited?.recurrence.occurrenceLimit).toBe(10);
  });

  it("expands an exact within-day hourly interval", () => {
    const parsed = parseTimedRecurrence(
      "Take medication every 4 hours from 8 AM to 8 PM every day.",
      context,
    );

    expect(parsed?.titleSource).toBe("Take medication");
    expect(scheduleFor(
      "Take medication every 4 hours from 8 AM to 8 PM every day.",
    )).toEqual(
      Object.fromEntries(
        DAYS_OF_WEEK.map((day) => [
          day,
          ["08:00", "12:00", "16:00", "20:00"],
        ]),
      ),
    );
  });

  it("represents common monthly dates and ordinal weekdays", () => {
    const dates = parseTimedRecurrence(
      "Pay bills on the 1st and 15th of every month at 9 AM.",
      context,
    );
    const ordinal = parseTimedRecurrence(
      "Team sync on the first Monday of every month at 10 AM.",
      context,
    );
    const last = parseTimedRecurrence(
      "Close books on the last Friday of every month at 5 PM.",
      context,
    );
    const lastDay = parseTimedRecurrence(
      "Close books on the last day of every month at 6 PM.",
      context,
    );

    expect(dates?.titleSource).toBe("Pay bills");
    expect(dates?.recurrence.monthlyRules).toEqual([
      { type: "days_of_month", daysOfMonth: [1, 15], times: ["09:00"] },
    ]);
    expect(ordinal?.recurrence.monthlyRules).toEqual([
      {
        type: "ordinal_weekday",
        ordinal: 1,
        dayOfWeek: "monday",
        times: ["10:00"],
      },
    ]);
    expect(last?.recurrence.monthlyRules).toEqual([
      {
        type: "ordinal_weekday",
        ordinal: -1,
        dayOfWeek: "friday",
        times: ["17:00"],
      },
    ]);
    expect(lastDay?.titleSource).toBe("Close books");
    expect(lastDay?.recurrence.monthlyRules).toEqual([
      { type: "last_day_of_month", times: ["18:00"] },
    ]);
  });

  it("keeps different monthly dates at different times", () => {
    const parsed = parseTimedRecurrence(
      "Pay bills every month on the 1st at 9 AM and the 15th at 4 PM.",
      context,
    );

    expect(parsed?.recurrence.monthlyRules).toEqual([
      { type: "days_of_month", daysOfMonth: [1], times: ["09:00"] },
      { type: "days_of_month", daysOfMonth: [15], times: ["16:00"] },
    ]);
  });

  it.each([
    [
      "Take medication every day at 8.",
      "Clarify AM or PM for the recurring time",
    ],
    [
      "Exercise every day in the morning.",
      "Replace the relative time with an exact clock time",
    ],
    [
      "Exercise every day at 8 AM except holidays.",
      "Clarify the unsupported exception: except holidays",
    ],
    [
      "Exercise weekdays after work.",
      "Replace the relative time with an exact clock time",
    ],
    [
      "Take medication every 4 hours.",
      "Add the first and last daily times for the hourly interval",
    ],
    [
      "Take medication twice a day.",
      "Provide the exact time for each daily occurrence",
    ],
    [
      "Log symptoms every work day at 5 PM.",
      "Clarify the calendar dates for the conditional recurrence",
    ],
    [
      "Use treatment 4 days on, 3 days off at 8 AM.",
      "Confirm the first on-day for the rotating schedule",
    ],
    [
      "Exercise weekdays at 8 AM for 30 minutes, weekends at 10 AM for 60 minutes.",
      "Confirm the different durations for each recurring day",
    ],
    [
      "Team sync Mondays at 9 AM Eastern.",
      "Confirm the time zone for the recurring clock times",
    ],
    [
      "Team sync Mondays at 9 AM on odd weeks and 10 AM on even weeks.",
      "Clarify the anchor week for the alternating weekly schedule",
    ],
  ])("requires review rather than guessing: %s", (text, issue) => {
    const parsed = parseTimedRecurrence(text, context);
    expect(parsed, text).toBeDefined();
    expect(parsed?.issues).toContain(issue);
  });
});
