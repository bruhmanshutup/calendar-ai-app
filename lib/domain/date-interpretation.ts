import {
  addDays,
  format,
  getDay,
  isMatch,
  parse,
  startOfDay,
} from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export type InterpretedDate = {
  date?: string;
  time?: string;
  instant?: string;
  ambiguous: boolean;
  explanation?: string;
};

export function resolveRelativeDate(
  expression: string,
  currentLocalDate: string,
  timeZone: string,
): InterpretedDate {
  const normalized = expression.trim().toLocaleLowerCase();
  if (!normalized) return { ambiguous: true, explanation: "No date was given." };

  const current = parse(currentLocalDate, "yyyy-MM-dd", new Date());
  if (!isMatch(currentLocalDate, "yyyy-MM-dd")) {
    return { ambiguous: true, explanation: "The reference date is invalid." };
  }

  const weekdayMatch = /^(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+(.+))?$/.exec(
    normalized,
  );
  if (weekdayMatch) {
    const isNext = Boolean(weekdayMatch[1]);
    const weekday = weekdayMatch[2];
    const targetIndex = WEEKDAY_INDEX[weekday];
    const currentIndex = getDay(current);
    let delta = (targetIndex - currentIndex + 7) % 7;
    if (isNext) {
      delta = delta === 0 ? 7 : delta;
    }
    const localDate = addDays(startOfDay(current), delta);
    const date = format(localDate, "yyyy-MM-dd");
    const parsedTime = weekdayMatch[3]
      ? parseClockTime(weekdayMatch[3])
      : undefined;
    if (weekdayMatch[3] && !parsedTime) {
      return {
        date,
        ambiguous: true,
        explanation: "The date is clear, but the time is ambiguous.",
      };
    }
    return {
      date,
      time: parsedTime,
      instant: parsedTime
        ? fromZonedTime(`${date}T${parsedTime}:00`, timeZone).toISOString()
        : undefined,
      ambiguous: false,
    };
  }

  const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? normalized
    : undefined;
  if (isoDate && isMatch(isoDate, "yyyy-MM-dd")) {
    return { date: isoDate, ambiguous: false };
  }

  return {
    ambiguous: true,
    explanation:
      "PlanPilot preserved this expression because it could not be resolved safely.",
  };
}

export function parseClockTime(value: string): string | undefined {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(value.trim());
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3]?.toLocaleLowerCase();
  if (minute > 59 || hour > (meridiem ? 12 : 23) || hour === 0 && meridiem) {
    return undefined;
  }
  if (meridiem === "pm" && hour !== 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function dateOnlyPlanningDeadline(
  date: string,
  sleepingTime: string,
  timeZone: string,
): string {
  const safeTime = parseClockTime(sleepingTime) ?? "23:59";
  return fromZonedTime(`${date}T${safeTime}:00`, timeZone).toISOString();
}

export function localDateForInstant(instant: string, timeZone: string): string {
  return formatInTimeZone(new Date(instant), timeZone, "yyyy-MM-dd");
}
