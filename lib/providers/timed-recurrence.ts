import {
  DAYS_OF_WEEK,
  groupRecurrenceDayTimes,
} from "@/lib/domain/recurrence";
import type { DayOfWeek, ExtractedTask } from "@/lib/domain/types";

const DAY_TOKEN =
  "(?:mon(?:day)?s?|tue(?:s(?:day)?)?s?|wed(?:nesday)?s?|thu(?:rs(?:day)?)?s?|fri(?:day)?s?|sat(?:urday)?s?|sun(?:day)?s?|weekdays?|weekends?)";
const TIME_TOKEN = "(?:[01]?\\d|2[0-3])(?::[0-5]\\d)?(?:\\s*(?:a\\.?m\\.?|p\\.?m\\.?))?";
const DAILY_PHRASE = /\b(?:every\s+day|each\s+day|daily)\b/i;

const DAY_ALIASES: Array<[RegExp, DayOfWeek]> = [
  [/^mons?$/i, "monday"],
  [/^mondays?$/i, "monday"],
  [/^tues?$/i, "tuesday"],
  [/^tuesdays?$/i, "tuesday"],
  [/^weds?$/i, "wednesday"],
  [/^wednesdays?$/i, "wednesday"],
  [/^thurs?$/i, "thursday"],
  [/^thursdays?$/i, "thursday"],
  [/^fris?$/i, "friday"],
  [/^fridays?$/i, "friday"],
  [/^sats?$/i, "saturday"],
  [/^saturdays?$/i, "saturday"],
  [/^suns?$/i, "sunday"],
  [/^sundays?$/i, "sunday"],
];

export type ParsedTimedRecurrence = {
  titleSource: string;
  recurrence: NonNullable<ExtractedTask["recurrence"]>;
};

function dayForToken(value: string): DayOfWeek | undefined {
  const normalized = value.toLocaleLowerCase().replace(/[^a-z]/g, "");
  return DAY_ALIASES.find(([pattern]) => pattern.test(normalized))?.[1];
}

function expandDayRange(start: DayOfWeek, end: DayOfWeek): DayOfWeek[] {
  const first = DAYS_OF_WEEK.indexOf(start);
  const last = DAYS_OF_WEEK.indexOf(end);
  if (first < 0 || last < 0) return [];
  if (first <= last) return DAYS_OF_WEEK.slice(first, last + 1);
  return [...DAYS_OF_WEEK.slice(first), ...DAYS_OF_WEEK.slice(0, last + 1)];
}

function parseDays(value: string): DayOfWeek[] {
  if (/weekdays?/i.test(value)) return DAYS_OF_WEEK.slice(0, 5);
  if (/weekends?/i.test(value)) return DAYS_OF_WEEK.slice(5);

  const range = new RegExp(`(${DAY_TOKEN})\\s*(?:through|thru|to|-)\\s*(${DAY_TOKEN})`, "i").exec(value);
  if (range) {
    const start = dayForToken(range[1]);
    const end = dayForToken(range[2]);
    if (start && end) return expandDayRange(start, end);
  }

  const tokens = value.match(new RegExp(DAY_TOKEN, "gi")) ?? [];
  return [...new Set(tokens.map(dayForToken).filter((day): day is DayOfWeek => !!day))];
}

function toTwentyFourHourTime(value: string): string | undefined {
  const normalized = value.toLocaleLowerCase().replace(/\./g, "").replace(/\s+/g, "");
  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(normalized);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (minute > 59 || hour > 23 || (match[3] && (hour < 1 || hour > 12))) {
    return undefined;
  }
  if (match[3] === "am" && hour === 12) hour = 0;
  if (match[3] === "pm" && hour !== 12) hour += 12;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function cleanTitleSource(text: string, dailyIndex: number): string {
  const before = text.slice(0, dailyIndex).trim();
  if (before) return before.replace(/[\s,;:—–-]+$/, "").trim();

  const withoutSchedule = text
    .replace(DAILY_PHRASE, " ")
    .replace(new RegExp(`\\b(?:at|@)\\s*${TIME_TOKEN}`, "i"), " ")
    .split(/\b(?:but|except)\b/i)[0]
    .replace(/^[\s,;:—–-]+|[\s,;:—–-]+$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return withoutSchedule || text;
}

export function parseTimedRecurrence(
  text: string,
): ParsedTimedRecurrence | undefined {
  const daily = DAILY_PHRASE.exec(text);
  if (!daily) return undefined;

  const primaryPattern = new RegExp(
    `\\b(?:every\\s+day|each\\s+day|daily)\\b(?:(?!\\b(?:but|except)\\b)[\\s\\S]){0,60}?\\b(?:at|@)\\s*(${TIME_TOKEN})`,
    "i",
  );
  const primary = primaryPattern.exec(text);
  const primaryTime = primary ? toTwentyFourHourTime(primary[1]) : undefined;
  if (!primaryTime) return undefined;

  const dayTimes: Partial<Record<DayOfWeek, string>> = Object.fromEntries(
    DAYS_OF_WEEK.map((day) => [day, primaryTime]),
  );
  const overridePattern = new RegExp(
    `((?:${DAY_TOKEN})(?:\\s*(?:,|and|&|through|thru|to|-)\\s*(?:${DAY_TOKEN}))*)\\s*(?:at|@)\\s*(${TIME_TOKEN})`,
    "gi",
  );
  for (const match of text.matchAll(overridePattern)) {
    const time = toTwentyFourHourTime(match[2]);
    const days = parseDays(match[1]);
    if (!time || days.length === 0) continue;
    days.forEach((day) => {
      dayTimes[day] = time;
    });
  }

  return {
    titleSource: cleanTitleSource(text, daily.index),
    recurrence: {
      frequency: "daily",
      mode: "fixed_times",
      daysOfWeek: [...DAYS_OF_WEEK],
      timeRules: groupRecurrenceDayTimes(dayTimes),
    },
  };
}

export function containsSplitRecurrence(text: string): boolean {
  const parsed = parseTimedRecurrence(text);
  return Boolean(parsed && (parsed.recurrence.timeRules?.length ?? 0) > 1);
}
