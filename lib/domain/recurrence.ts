import type { DayOfWeek, ExtractedTask } from "./types";

export const DAYS_OF_WEEK: DayOfWeek[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

export type RecurrenceTimeRule = NonNullable<
  NonNullable<ExtractedTask["recurrence"]>["timeRules"]
>[number];

export function recurrenceTimeForDay(
  recurrence: ExtractedTask["recurrence"],
  day: DayOfWeek,
): string | undefined {
  return recurrence?.timeRules?.find((rule) =>
    rule.daysOfWeek.includes(day),
  )?.time;
}

export function groupRecurrenceDayTimes(
  times: Partial<Record<DayOfWeek, string>>,
): RecurrenceTimeRule[] {
  const grouped = new Map<string, DayOfWeek[]>();
  for (const day of DAYS_OF_WEEK) {
    const time = times[day];
    if (!time) continue;
    grouped.set(time, [...(grouped.get(time) ?? []), day]);
  }
  return [...grouped.entries()].map(([time, daysOfWeek]) => ({
    daysOfWeek,
    time,
  }));
}
