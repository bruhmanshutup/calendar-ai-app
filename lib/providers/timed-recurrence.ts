import { addDays, addMonths, addWeeks, format, parseISO } from "date-fns";
import { fromZonedTime } from "date-fns-tz";
import { resolveRelativeDate } from "@/lib/domain/date-interpretation";
import {
  DAYS_OF_WEEK,
  groupRecurrenceDaySchedules,
} from "@/lib/domain/recurrence";
import type { DayOfWeek, ExtractedTask } from "@/lib/domain/types";

const DAY_NAME =
  "(?:mon(?:day)?s?|tue(?:s(?:day)?)?s?|wed(?:nesday)?s?|thu(?:rs(?:day)?)?s?|fri(?:day)?s?|sat(?:urday)?s?|sun(?:day)?s?)";
const DAY_GROUP = "(?:weekdays?|weekends?)";
const DAY_ITEM = `(?:${DAY_NAME}|${DAY_GROUP})`;
const DAY_EXPRESSION =
  `(?:(?:every\\s+(?:other\\s+|\\d+\\s+)?day)|(?:each\\s+day)|daily|${DAY_GROUP}|` +
  `(?:every\\s+)?${DAY_GROUP}|(?:every\\s+)?${DAY_NAME}(?:\\s*(?:,|and|&|/|through|thru|to|-)\\s*${DAY_ITEM})*)`;
const EXACT_TIME =
  "(?:noon|midnight|(?:[01]?\\d|2[0-3]):[0-5]\\d(?:\\s*(?:a\\.?m\\.?|p\\.?m\\.?))?|(?:0?[1-9]|1[0-2])(?:\\s*)(?:a\\.?m\\.?|p\\.?m\\.?))";
const TIME_LIST = `${EXACT_TIME}(?:\\s*(?:,|and|&)\\s*(?:at\\s+)?${EXACT_TIME})*`;
const MONTH_NAME =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE_EXPRESSION =
  `(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?|${MONTH_NAME}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_NAME}(?:,?\\s+\\d{4})?|(?:(?:this|next)\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))`;

const DAY_ALIASES: Array<[RegExp, DayOfWeek]> = [
  [/^mons?$/i, "monday"],
  [/^mondays?$/i, "monday"],
  [/^tues?$/i, "tuesday"],
  [/^tuesdays?$/i, "tuesday"],
  [/^weds?$/i, "wednesday"],
  [/^wednesdays?$/i, "wednesday"],
  [/^thu(?:rs?)?$/i, "thursday"],
  [/^thursdays?$/i, "thursday"],
  [/^fris?$/i, "friday"],
  [/^fridays?$/i, "friday"],
  [/^sats?$/i, "saturday"],
  [/^saturdays?$/i, "saturday"],
  [/^suns?$/i, "sunday"],
  [/^sundays?$/i, "sunday"],
];

type ParseContext = {
  currentLocalDate: string;
  timeZone: string;
};

export type ParsedTimedRecurrence = {
  titleSource: string;
  recurrence: NonNullable<ExtractedTask["recurrence"]>;
  issues: string[];
};

type ScheduleClause = {
  start: number;
  end: number;
  days: DayOfWeek[];
  times: string[];
  override: boolean;
};

const COUNT_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

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
  if (/\b(?:every\s+(?:other\s+|\d+\s+)?day|each\s+day|daily)\b/i.test(value)) {
    return [...DAYS_OF_WEEK];
  }
  if (/weekdays?/i.test(value)) return DAYS_OF_WEEK.slice(0, 5);
  if (/weekends?/i.test(value)) return DAYS_OF_WEEK.slice(5);

  const range = new RegExp(
    `(${DAY_NAME})\\s*(?:through|thru|to|-)\\s*(${DAY_NAME})`,
    "i",
  ).exec(value);
  if (range) {
    const start = dayForToken(range[1]);
    const end = dayForToken(range[2]);
    if (start && end) return expandDayRange(start, end);
  }

  const tokens = value.match(new RegExp(DAY_NAME, "gi")) ?? [];
  return unique(
    tokens.map(dayForToken).filter((day): day is DayOfWeek => !!day),
  );
}

function toTwentyFourHourTime(value: string): string | undefined {
  const normalized = value
    .toLocaleLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, "");
  if (normalized === "noon") return "12:00";
  if (normalized === "midnight") return "00:00";
  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(normalized);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (
    minute > 59 ||
    hour > 23 ||
    (!match[2] && !match[3]) ||
    (match[3] && (hour < 1 || hour > 12))
  ) {
    return undefined;
  }
  if (match[3] === "am" && hour === 12) hour = 0;
  if (match[3] === "pm" && hour !== 12) hour += 12;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseTimes(value: string): string[] {
  const matches = value.match(new RegExp(EXACT_TIME, "gi")) ?? [];
  return unique(
    matches
      .map(toTwentyFourHourTime)
      .filter((time): time is string => Boolean(time)),
  ).sort();
}

function hasRecurringCue(text: string, clauseCount: number): boolean {
  return (
    clauseCount > 1 ||
    /\b(?:on\s+)?alternat(?:e|ing)\s+days?\b/i.test(text) ||
    /\b(?:daily|weekly|monthly|each\s+day|every\s+(?:other\s+|\d+\s+)?(?:day|week|month)|weekdays?|weekends?)\b/i.test(
      text,
    ) ||
    /\b(?:every\s+\d+\s+hours?|(?:once|twice|\d+\s+times)\s+(?:a|per)\s+day|(?:school|work|shift)\s*days?|days?\s+i\s+work|\d+\s+days?\s+on\s*[,/]?\s*\d+\s+days?\s+off)\b/i.test(
      text,
    ) ||
    new RegExp(`\\b${DAY_NAME}\\b`, "i").test(text) &&
      /\b(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b/i.test(
        text,
      )
  );
}

function scheduleClauses(text: string): ScheduleClause[] {
  const pattern = new RegExp(
    `(${DAY_EXPRESSION})\\s*(?:(?:at|@)\\s*)?(${TIME_LIST})`,
    "gi",
  );
  return [...text.matchAll(pattern)]
    .map((match) => {
      const start = match.index ?? 0;
      const prefix = text.slice(Math.max(0, start - 35), start);
      return {
        start,
        end: start + match[0].length,
        days: parseDays(match[1]),
        times: parseTimes(match[2]),
        override:
          /\b(?:except|instead(?:\s+of)?|rather\s+than|but(?:\s+on)?|override(?:\s+on)?)\s*(?:on\s+)?$/i.test(
            prefix,
          ),
      };
    })
    .filter((clause) => clause.days.length > 0 && clause.times.length > 0);
}

function intradayIntervalClause(text: string): ScheduleClause | undefined {
  const match = new RegExp(
    `\\bevery\\s+(\\d+)\\s+hours?\\s+(?:from|starting\\s+at)\\s*(${EXACT_TIME})\\s+(?:to|until|through)\\s*(${EXACT_TIME})`,
    "i",
  ).exec(text);
  if (!match) return undefined;
  const intervalMinutes = Number(match[1]) * 60;
  const startTime = toTwentyFourHourTime(match[2]);
  const endTime = toTwentyFourHourTime(match[3]);
  if (!intervalMinutes || !startTime || !endTime) return undefined;
  const asMinutes = (time: string) => {
    const [hour, minute] = time.split(":").map(Number);
    return hour * 60 + minute;
  };
  const start = asMinutes(startTime);
  const end = asMinutes(endTime);
  if (end < start) return undefined;
  const times: string[] = [];
  for (let value = start; value <= end; value += intervalMinutes) {
    times.push(
      `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`,
    );
  }
  const parsedDays = /\b(?:on\s+)?alternat(?:e|ing)\s+days?\b/i.test(text)
    ? [...DAYS_OF_WEEK]
    : parseDays(text);
  return {
    start: match.index,
    end: match.index + match[0].length,
    days: parsedDays.length ? parsedDays : [...DAYS_OF_WEEK],
    times,
    override: false,
  };
}

function recurringClockRangeClause(text: string): ScheduleClause | undefined {
  if (/\bevery\s+\d+\s+hours?\s+(?:from|starting\s+at)\b/i.test(text)) {
    return undefined;
  }
  const match = /\bfrom\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)\s*(?:-|to)\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\b/i.exec(
    text,
  );
  if (!match) return undefined;
  const endMeridiem = /(a\.?m\.?|p\.?m\.?)\s*$/i.exec(match[2])?.[1];
  const startText = /(?:a\.?m\.?|p\.?m\.?)\s*$/i.test(match[1])
    ? match[1]
    : `${match[1]}${endMeridiem ?? ""}`;
  const startTime = toTwentyFourHourTime(startText);
  if (!startTime) return undefined;
  const parsedDays = /\b(?:on\s+)?alternat(?:e|ing)\s+days?\b/i.test(text)
    ? [...DAYS_OF_WEEK]
    : parseDays(text);
  return {
    start: match.index,
    end: match.index + match[0].length,
    days: parsedDays.length ? parsedDays : [...DAYS_OF_WEEK],
    times: [startTime],
    override: false,
  };
}

function findInterval(text: string): {
  frequency?: "daily" | "weekly" | "monthly";
  interval: number;
} {
  if (/\b(?:on\s+)?alternat(?:e|ing)\s+days?\b/i.test(text)) {
    return { frequency: "daily", interval: 2 };
  }
  const match = /\bevery\s+(other|\d+)\s+(days?|weeks?|months?)\b/i.exec(text);
  if (!match) return { interval: 1 };
  const interval = match[1].toLocaleLowerCase() === "other" ? 2 : Number(match[1]);
  const unit = match[2].toLocaleLowerCase();
  return {
    interval: Math.max(1, interval),
    frequency: unit.startsWith("day")
      ? "daily"
      : unit.startsWith("week")
        ? "weekly"
        : "monthly",
  };
}

function findOccurrenceLimit(text: string): number | undefined {
  const match = new RegExp(
    `\\bfor\\s+(one|two|three|four|five|six|seven|eight|nine|ten|\\d+)\\s+(?:times?|occurrences?)\\b`,
    "i",
  ).exec(text);
  if (!match) return undefined;
  return COUNT_WORDS[match[1].toLocaleLowerCase()] ?? Number(match[1]);
}

function resolveDate(
  value: string,
  context?: ParseContext,
): { date?: string; ambiguous: boolean } {
  if (!context) return { ambiguous: true };
  const resolved = resolveRelativeDate(
    value,
    context.currentLocalDate,
    context.timeZone,
  );
  return { date: resolved.date, ambiguous: resolved.ambiguous };
}

function recurrenceBounds(
  text: string,
  context: ParseContext | undefined,
  issues: string[],
): { anchorDate?: string; windowStart?: string; windowEnd?: string } {
  const start = new RegExp(
    `\\b(?:starting(?:\\s+from)?|beginning|from)\\s+(?:on\\s+)?(${DATE_EXPRESSION})\\b`,
    "i",
  ).exec(text);
  const until = new RegExp(`\\buntil\\s+(?:on\\s+)?(${DATE_EXPRESSION})\\b`, "i").exec(
    text,
  );
  const result: { anchorDate?: string; windowStart?: string; windowEnd?: string } = {};
  if (start) {
    const resolved = resolveDate(start[1], context);
    if (resolved.date && context) {
      result.anchorDate = resolved.date;
      result.windowStart = fromZonedTime(
        `${resolved.date}T00:00:00`,
        context.timeZone,
      ).toISOString();
    } else {
      issues.push("Clarify the recurrence start date");
    }
    if (resolved.ambiguous) issues.push("Confirm the recurrence start date");
  }
  if (until) {
    const resolved = resolveDate(until[1], context);
    if (resolved.date && context) {
      result.windowEnd = fromZonedTime(
        `${resolved.date}T23:59:59`,
        context.timeZone,
      ).toISOString();
    } else {
      issues.push("Clarify the recurrence end date");
    }
    if (resolved.ambiguous) issues.push("Confirm the recurrence end date");
  }
  if (!until) {
    const duration = /\bfor\s+(\d+)\s+(days?|weeks?|months?)\b/i.exec(text);
    if (duration && context) {
      const amount = Number(duration[1]);
      if (amount < 1) {
        issues.push("Use a positive recurrence duration");
        return result;
      }
      const startDate = result.anchorDate ?? context.currentLocalDate;
      const start = parseISO(startDate);
      const exclusiveEnd = duration[2].toLocaleLowerCase().startsWith("day")
        ? addDays(start, amount)
        : duration[2].toLocaleLowerCase().startsWith("week")
          ? addWeeks(start, amount)
          : addMonths(start, amount);
      const endDate = format(addDays(exclusiveEnd, -1), "yyyy-MM-dd");
      result.anchorDate = startDate;
      result.windowStart ??= fromZonedTime(
        `${startDate}T00:00:00`,
        context.timeZone,
      ).toISOString();
      result.windowEnd = fromZonedTime(
        `${endDate}T23:59:59`,
        context.timeZone,
      ).toISOString();
    } else if (duration) {
      issues.push("Clarify when the finite recurrence begins");
    }
  }
  return result;
}

function dateOverrides(
  text: string,
  context: ParseContext | undefined,
  issues: string[],
): NonNullable<ExtractedTask["recurrence"]>["dateOverrides"] {
  const overrides: NonNullable<
    NonNullable<ExtractedTask["recurrence"]>["dateOverrides"]
  > = [];
  const timed = new RegExp(
    `\\b(?:except|but\\s+on|override(?:\\s+on)?|on)\\s+(?:on\\s+)?(${DATE_EXPRESSION})\\b\\s+(?:at|@)\\s*(${TIME_LIST})`,
    "gi",
  );
  for (const match of text.matchAll(timed)) {
    const resolved = resolveDate(match[1], context);
    const times = parseTimes(match[2]);
    if (resolved.date && times.length) {
      overrides.push({ date: resolved.date, times });
    } else {
      issues.push(`Clarify the date-specific override: ${match[0]}`);
    }
    if (resolved.ambiguous) issues.push(`Confirm the date in: ${match[0]}`);
  }
  const skipped = new RegExp(
    `\\b(?:skip|except|not\\s+on|off\\s+on)\\s+(?:on\\s+)?(${DATE_EXPRESSION})\\b(?!\\s+(?:at|@))`,
    "gi",
  );
  for (const match of text.matchAll(skipped)) {
    const resolved = resolveDate(match[1], context);
    if (resolved.date) {
      overrides.push({ date: resolved.date, skip: true });
    } else {
      issues.push(`Clarify the skipped date: ${match[0]}`);
    }
    if (resolved.ambiguous) issues.push(`Confirm the date in: ${match[0]}`);
  }
  const byDate = new Map(overrides.map((override) => [override.date, override]));
  return [...byDate.values()];
}

function cleanTitleSource(text: string): string {
  const marker = new RegExp(
    `\\b(?:daily|weekly|monthly|each\\s+day|alternat(?:e|ing)\\s+days?|every\\s+(?:(?:other|\\d+)\\s+)?(?:day|week|month)|every\\s+\\d+\\s+hours?|(?:once|twice|\\d+\\s+times)\\s+(?:a|per)\\s+day|(?:school|work|shift)\\s*days?|\\d+\\s+days?\\s+on|weekdays?|weekends?|${DAY_NAME})\\b`,
    "i",
  ).exec(text);
  if (marker && marker.index > 0) {
    return text
      .slice(0, marker.index)
      .replace(/\s+(?:on\s+)?(?:the\s+)?last\s+day\s+(?:of\s*)?$/i, "")
      .replace(
        /\s+(?:on\s+)?(?:the\s+)?(?:\d{1,2}(?:st|nd|rd|th)|first|second|third|fourth|fifth|last)(?:\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))?(?:\s*(?:,|and|&)\s*(?:the\s+)?(?:\d{1,2}(?:st|nd|rd|th)|first|second|third|fourth|fifth|last)(?:\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))?)*\s+(?:of\s*)?$/i,
        "",
      )
      .replace(/\s+(?:once|twice|\d+\s+times?)\s*$/i, "")
      .replace(/\b(?:on|every)\s*$/i, "")
      .replace(/[\s,;:—–-]+$/, "")
      .trim();
  }

  const commaParts = text.split(/[,;]/).map((part) => part.trim()).filter(Boolean);
  const actionPart = commaParts.find(
    (part) =>
      !/\b(?:daily|weekly|monthly|every|weekday|weekend|except|until|starting)\b/i.test(
        part,
      ) &&
      !new RegExp(DAY_NAME, "i").test(part) &&
      !new RegExp(EXACT_TIME, "i").test(part),
  );
  return actionPart ?? text;
}

function ambiguousScheduleIssues(text: string): string[] {
  const issues: string[] = [];
  const statedDurations = [
    ...text.matchAll(/\b(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)\b/gi),
  ].map((match) => {
    const amount = Number(match[1]);
    return /^h/i.test(match[2]) ? amount * 60 : amount;
  });
  if (new Set(statedDurations).size > 1) {
    issues.push("Confirm the different durations for each recurring day");
  }
  if (
    /\b(?:at|@)\s+\d{1,2}\b(?!\s*(?::\d{2}|a\.?m\.?|p\.?m\.?))/i.test(text)
  ) {
    issues.push("Clarify AM or PM for the recurring time");
  }
  if (
    /\b(?:morning|afternoon|evening|night|before\s+work|after\s+work|after\s+waking|before\s+bed)\b/i.test(
      text,
    )
  ) {
    issues.push("Replace the relative time with an exact clock time");
  }
  if (
    /\b(?:school\s*days?|work\s*days?|shift\s*days?|days?\s+i\s+work|when\s+i\s+(?:work|travel))\b/i.test(
      text,
    )
  ) {
    issues.push("Clarify the calendar dates for the conditional recurrence");
  }
  if (
    /\bevery\s+\d+\s+hours?\b/i.test(text) &&
    !intradayIntervalClause(text)
  ) {
    issues.push("Add the first and last daily times for the hourly interval");
  }
  if (
    /\b(?:once|twice|\d+\s+times)\s+(?:a|per)\s+day\b/i.test(text) &&
    parseTimes(text).length === 0
  ) {
    issues.push("Provide the exact time for each daily occurrence");
  }
  if (/\b\d+\s+days?\s+on\s*[,/]?\s*\d+\s+days?\s+off\b/i.test(text)) {
    issues.push("Confirm the first on-day for the rotating schedule");
  }
  if (
    /\b(?:odd|even|alternating)\s+weeks?\b/i.test(text) ||
    /\balternate\s+weeks?\b/i.test(text)
  ) {
    issues.push("Clarify the anchor week for the alternating weekly schedule");
  }
  if (
    /\b(?:UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|Eastern|Central|Mountain|Pacific)\b/i.test(
      text,
    )
  ) {
    issues.push("Confirm the time zone for the recurring clock times");
  }
  for (const match of text.matchAll(/\b(?:except|unless|but)\b([^.;]*)/gi)) {
    const segment = match[1];
    if (
      parseDays(segment).length === 0 &&
      !new RegExp(DATE_EXPRESSION, "i").test(segment)
    ) {
      issues.push(`Clarify the unsupported exception: ${match[0].trim()}`);
    }
  }
  return unique(issues);
}

function parseMonthlyRecurrence(
  text: string,
  context?: ParseContext,
): ParsedTimedRecurrence | undefined {
  const monthlyCue = /\b(?:monthly|every\s+(?:(?:other|\d+)\s+)?months?|each\s+month)\b/i.test(
    text,
  );
  const ordinalCue = new RegExp(
    `\\b(?:first|second|third|fourth|fifth|last)\\s+${DAY_NAME}\\b`,
    "i",
  ).test(text);
  if (!monthlyCue && !ordinalCue) return undefined;

  const issues = ambiguousScheduleIssues(text);
  const interval = findInterval(text);
  const rules: NonNullable<
    NonNullable<ExtractedTask["recurrence"]>["monthlyRules"]
  > = [];
  const dayNumberList =
    "(?:\\d{1,2}(?:st|nd|rd|th))(?:\\s*(?:,|and|&)\\s*(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th))*";
  const dayRulePattern = new RegExp(
    `(?:on\\s+)?(?:the\\s+)?(${dayNumberList})(?:\\s+of\\s+(?:every|each|the)\\s+month)?\\s+(?:at|@)\\s*(${TIME_LIST})`,
    "gi",
  );
  for (const match of text.matchAll(dayRulePattern)) {
    const daysOfMonth = [...match[1].matchAll(/(\d{1,2})(?:st|nd|rd|th)/gi)]
      .map((item) => Number(item[1]))
      .filter((day) => day >= 1 && day <= 31);
    const times = parseTimes(match[2]);
    if (!daysOfMonth.length || !times.length) continue;
    rules.push({
      type: "days_of_month",
      daysOfMonth: unique(daysOfMonth).sort((a, b) => a - b),
      times,
    });
  }
  const ordinalMap: Record<string, 1 | 2 | 3 | 4 | 5 | -1> = {
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    fifth: 5,
    last: -1,
  };
  const lastDayPattern = new RegExp(
    `\\blast\\s+day(?:\\s+of\\s+(?:every|each|the)\\s+month)?\\s+(?:at|@)\\s*(${TIME_LIST})`,
    "gi",
  );
  for (const match of text.matchAll(lastDayPattern)) {
    const times = parseTimes(match[1]);
    if (times.length) rules.push({ type: "last_day_of_month", times });
  }
  const ordinalPattern = new RegExp(
    `\\b(first|second|third|fourth|fifth|last)\\s+(${DAY_NAME})(?:\\s+of\\s+(?:every|each|the)\\s+month)?\\s+(?:at|@)\\s*(${TIME_LIST})`,
    "gi",
  );
  for (const match of text.matchAll(ordinalPattern)) {
    const dayOfWeek = dayForToken(match[2]);
    const times = parseTimes(match[3]);
    if (dayOfWeek && times.length) {
      rules.push({
        type: "ordinal_weekday",
        ordinal: ordinalMap[match[1].toLocaleLowerCase()],
        dayOfWeek,
        times,
      });
    }
  }
  if (!rules.length) {
    const timesMatch = new RegExp(`\\b(?:at|@)\\s*(${TIME_LIST})`, "i").exec(
      text,
    );
    const times = timesMatch ? parseTimes(timesMatch[1]) : [];
    const dayNumbers = [
      ...text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\b/g),
    ]
      .map((match) => Number(match[1]))
      .filter((day) => day >= 1 && day <= 31);
    if (dayNumbers.length && times.length) {
      rules.push({
        type: "days_of_month",
        daysOfMonth: unique(dayNumbers).sort((a, b) => a - b),
        times,
      });
    }
  }
  if (!rules.length && !new RegExp(EXACT_TIME, "i").test(text)) {
    issues.push("Add an exact time for the monthly recurrence");
  }
  if (!rules.length) issues.push("Clarify which monthly date or weekday to use");
  const bounds = recurrenceBounds(text, context, issues);
  const resolvedInterval = interval.frequency === "monthly" ? interval.interval : 1;
  if (resolvedInterval > 1 && !bounds.anchorDate) {
    issues.push("Confirm the first month in the repeating interval");
  }
  const overrides = dateOverrides(text, context, issues);

  return {
    titleSource: cleanTitleSource(text),
    issues: unique(issues),
    recurrence: {
      frequency: "monthly",
      mode: "fixed_times",
      interval: resolvedInterval,
      occurrenceLimit: findOccurrenceLimit(text),
      monthlyRules: rules.length ? rules : undefined,
      ...bounds,
      dateOverrides: overrides,
    },
  };
}

export function parseTimedRecurrence(
  text: string,
  context?: ParseContext,
): ParsedTimedRecurrence | undefined {
  const monthly = parseMonthlyRecurrence(text, context);
  if (monthly) return monthly;

  const intraday = intradayIntervalClause(text);
  const clockRange = recurringClockRangeClause(text);
  const clauses = [
    ...scheduleClauses(text),
    ...(intraday ? [intraday] : []),
    ...(clockRange ? [clockRange] : []),
  ];
  if (!hasRecurringCue(text, clauses.length)) return undefined;
  const issues = ambiguousScheduleIssues(text);
  const schedules: Partial<Record<DayOfWeek, string[]>> = {};
  const normalClauses = clauses.filter((clause) => !clause.override);
  const overrideClauses = clauses.filter((clause) => clause.override);

  for (const clause of normalClauses) {
    clause.days.forEach((day) => {
      schedules[day] = [...clause.times];
    });
  }

  const exclusionPattern = new RegExp(
    `\\b(?:except|but\\s+not\\s+on|not\\s+on|skip|off(?:\\s+on)?)\\s+(?:on\\s+)?(${DAY_EXPRESSION})`,
    "gi",
  );
  for (const match of text.matchAll(exclusionPattern)) {
    const end = (match.index ?? 0) + match[0].length;
    if (new RegExp(`^\\s*(?:at|@)\\s*${EXACT_TIME}`, "i").test(text.slice(end))) {
      continue;
    }
    parseDays(match[1]).forEach((day) => {
      schedules[day] = [];
    });
  }

  for (const clause of overrideClauses) {
    clause.days.forEach((day) => {
      schedules[day] = [...clause.times];
    });
  }

  const additivePattern = new RegExp(
    `\\b(?:and|also)(?:\\s+again)?\\s+(?:at|@)\\s*(${EXACT_TIME})`,
    "gi",
  );
  for (const match of text.matchAll(additivePattern)) {
    const position = match.index ?? 0;
    const prior = [...clauses]
      .filter((clause) => clause.end <= position)
      .sort((a, b) => b.end - a.end)[0];
    const time = toTwentyFourHourTime(match[1]);
    if (!prior || !time) continue;
    prior.days.forEach((day) => {
      schedules[day] = unique([...(schedules[day] ?? []), time]).sort();
    });
  }

  const scheduledDays = DAYS_OF_WEEK.filter((day) => (schedules[day]?.length ?? 0) > 0);
  if (scheduledDays.length === 0) issues.push("Add at least one exact recurring day and time");
  const interval = findInterval(text);
  const bounds = recurrenceBounds(text, context, issues);
  if (interval.interval > 1 && !bounds.anchorDate) {
    issues.push("Confirm the first occurrence in the repeating interval");
  }
  const frequency =
    interval.frequency ??
    (scheduledDays.length === DAYS_OF_WEEK.length ? "daily" : "weekly");
  const overrides = dateOverrides(text, context, issues);
  const timeRules = groupRecurrenceDaySchedules(schedules);

  return {
    titleSource: cleanTitleSource(text),
    issues: unique(issues),
    recurrence: {
      frequency,
      mode: "fixed_times",
      interval: interval.interval,
      occurrenceLimit: findOccurrenceLimit(text),
      daysOfWeek: scheduledDays,
      timeRules: timeRules.length ? timeRules : undefined,
      ...bounds,
      dateOverrides: overrides,
    },
  };
}

export function containsSplitRecurrence(text: string): boolean {
  const parsed = parseTimedRecurrence(text);
  return Boolean(
    parsed &&
      ((parsed.recurrence.timeRules?.length ?? 0) > 1 ||
        (parsed.recurrence.monthlyRules?.length ?? 0) > 0 ||
        (parsed.recurrence.dateOverrides?.length ?? 0) > 0),
  );
}
