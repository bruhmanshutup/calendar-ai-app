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

export function recurrenceTimesForDay(
  recurrence: ExtractedTask["recurrence"],
  day: DayOfWeek,
): string[] {
  return [
    ...new Set(
      recurrence?.timeRules
        ?.filter((rule) => rule.daysOfWeek.includes(day))
        .map((rule) => rule.time) ?? [],
    ),
  ].sort();
}

export function groupRecurrenceDaySchedules(
  schedules: Partial<Record<DayOfWeek, string[]>>,
): RecurrenceTimeRule[] {
  const daysByTime = new Map<string, DayOfWeek[]>();
  for (const day of DAYS_OF_WEEK) {
    const times = [...new Set(schedules[day] ?? [])].sort();
    for (const time of times) {
      daysByTime.set(time, [...(daysByTime.get(time) ?? []), day]);
    }
  }
  return [...daysByTime.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([time, daysOfWeek]) => ({ daysOfWeek, time }));
}
