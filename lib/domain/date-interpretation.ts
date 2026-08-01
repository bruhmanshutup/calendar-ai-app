import {
  addDays,
  format,
  getDay,
  isMatch,
  isValid,
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

const MONTH_INDEX: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

export type InterpretedDate = {
  date?: string;
  time?: string;
  instant?: string;
  ambiguous: boolean;
  explanation?: string;
};

function splitExplicitTime(expression: string): {
  dateExpression: string;
  timeExpression?: string;
} {
  const normalized = expression
    .trim()
    .replace(/^(?:by|before|on|due(?:\s+on)?)\s+/i, "");
  const atTime = /^(.*?)(?:,?\s+at\s+)(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/i.exec(
    normalized,
  );
  if (atTime) {
    return { dateExpression: atTime[1].trim(), timeExpression: atTime[2] };
  }
  const clockTime = /^(.*?)(?:,?\s+)(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))$/i.exec(
    normalized,
  );
  if (clockTime) {
    return {
      dateExpression: clockTime[1].trim(),
      timeExpression: clockTime[2],
    };
  }
  return { dateExpression: normalized };
}

function explicitCalendarDate(
  month: number,
  day: number,
  year: number | undefined,
  current: Date,
): string | undefined {
  let resolvedYear = year ?? Number(format(current, "yyyy"));
  const candidate = (candidateYear: number) => {
    const value = `${candidateYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const parsedValue = parse(value, "yyyy-MM-dd", current);
    return isValid(parsedValue) && format(parsedValue, "yyyy-MM-dd") === value
      ? { value, parsedValue }
      : undefined;
  };

  let result = candidate(resolvedYear);
  if (!result) return undefined;
  if (!year && result.parsedValue < startOfDay(current)) {
    resolvedYear += 1;
    result = candidate(resolvedYear);
  }
  return result?.value;
}

function calendarDateResult(
  month: number,
  day: number,
  year: number | undefined,
  timeExpression: string | undefined,
  current: Date,
  timeZone: string,
  ambiguous = false,
  explanation?: string,
): InterpretedDate {
  const resolvedDate = explicitCalendarDate(month, day, year, current);
  if (!resolvedDate) {
    return { ambiguous: true, explanation: "The calendar date is invalid." };
  }
  const parsedTime = timeExpression
    ? parseClockTime(timeExpression)
    : undefined;
  if (timeExpression && !parsedTime) {
    return {
      date: resolvedDate,
      ambiguous: true,
      explanation: "The date is clear, but the time is ambiguous.",
    };
  }
  return {
    date: resolvedDate,
    time: parsedTime,
    instant: parsedTime
      ? fromZonedTime(`${resolvedDate}T${parsedTime}:00`, timeZone).toISOString()
      : undefined,
    ambiguous,
    explanation,
  };
}

export function resolveRelativeDate(
  expression: string,
  currentLocalDate: string,
  timeZone: string,
): InterpretedDate {
  const normalized = expression.trim().toLocaleLowerCase();
  if (!normalized) return { ambiguous: true, explanation: "No date was given." };

  if (!isMatch(currentLocalDate, "yyyy-MM-dd")) {
    return { ambiguous: true, explanation: "The reference date is invalid." };
  }
  const current = parse(currentLocalDate, "yyyy-MM-dd", new Date());

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

  const { dateExpression, timeExpression } = splitExplicitTime(normalized);

  const isoDate = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateExpression);
  if (isoDate) {
    return calendarDateResult(
      Number(isoDate[2]),
      Number(isoDate[3]),
      Number(isoDate[1]),
      timeExpression,
      current,
      timeZone,
    );
  }

  const numericDate = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(
    dateExpression,
  );
  if (numericDate) {
    const first = Number(numericDate[1]);
    const second = Number(numericDate[2]);
    const suppliedYear = numericDate[3]
      ? Number(numericDate[3].length === 2 ? `20${numericDate[3]}` : numericDate[3])
      : undefined;
    const month = first > 12 ? second : first;
    const day = first > 12 ? first : second;
    const ambiguous = first <= 12 && second <= 12 && first !== second;
    return calendarDateResult(
      month,
      day,
      suppliedYear,
      timeExpression,
      current,
      timeZone,
      ambiguous,
      ambiguous
        ? "This numeric date was interpreted as month/day; confirm the intended order."
        : undefined,
    );
  }

  const monthName =
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const monthFirst = new RegExp(
    `^(${monthName})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?$`,
    "i",
  ).exec(dateExpression);
  if (monthFirst) {
    return calendarDateResult(
      MONTH_INDEX[monthFirst[1].toLocaleLowerCase()],
      Number(monthFirst[2]),
      monthFirst[3] ? Number(monthFirst[3]) : undefined,
      timeExpression,
      current,
      timeZone,
    );
  }

  const dayFirst = new RegExp(
    `^(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthName})(?:,?\\s+(\\d{4}))?$`,
    "i",
  ).exec(dateExpression);
  if (dayFirst) {
    return calendarDateResult(
      MONTH_INDEX[dayFirst[2].toLocaleLowerCase()],
      Number(dayFirst[1]),
      dayFirst[3] ? Number(dayFirst[3]) : undefined,
      timeExpression,
      current,
      timeZone,
    );
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
