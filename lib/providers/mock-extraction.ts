import {
  addWeeks,
  addHours,
  differenceInCalendarDays,
  endOfWeek,
  format,
  parseISO,
  startOfWeek,
} from "date-fns";
import { fromZonedTime } from "date-fns-tz";
import {
  resolveRelativeDate,
  type InterpretedDate,
} from "@/lib/domain/date-interpretation";
import { validateAndDedupeExtraction } from "@/lib/domain/extraction-schema";
import type {
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
  TaskCategory,
  TaskPriority,
} from "@/lib/domain/types";
import type { TaskExtractionProvider } from "./task-extraction";
import {
  parseTimedRecurrence,
  type ParsedTimedRecurrence,
} from "./timed-recurrence";

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
};

function estimateMinutes(text: string): {
  minutes: number;
  confidence: number;
  assumed: boolean;
  source: "stated" | "heuristic";
  rationale: string;
} {
  const hours = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)/i.exec(text);
  if (hours) {
    return {
      minutes: Math.round(Number(hours[1]) * 60),
      confidence: 0.98,
      assumed: false,
      source: "stated",
      rationale: "Used the duration stated in the source text.",
    };
  }
  const minutes = /(\d+)\s*(?:minutes?|mins?)/i.exec(text);
  if (minutes) {
    return {
      minutes: Number(minutes[1]),
      confidence: 0.98,
      assumed: false,
      source: "stated",
      rationale: "Used the duration stated in the source text.",
    };
  }
  const lower = text.toLocaleLowerCase();
  if (/exam|study|essay|report|proposal/.test(lower)) {
    return {
      minutes: 90,
      confidence: 0.46,
      assumed: true,
      source: "heuristic",
      rationale: "Used a conservative local estimate for substantial focused work.",
    };
  }
  if (/gym|work\s*out|workout|run|appointment/.test(lower)) {
    return {
      minutes: 60,
      confidence: 0.48,
      assumed: true,
      source: "heuristic",
      rationale: "Used a typical local estimate for this kind of activity.",
    };
  }
  return {
    minutes: 45,
    confidence: 0.42,
    assumed: true,
    source: "heuristic",
    rationale: "Used a conservative default because no duration was stated.",
  };
}

function categoryFor(text: string): TaskCategory {
  const lower = text.toLocaleLowerCase();
  if (/essay|homework|exam|study|class|chemistry|reading/.test(lower)) {
    return "school";
  }
  if (/meeting|report|client|proposal|email/.test(lower)) return "work";
  if (/gym|work\s*out|workout|run|yoga/.test(lower)) return "fitness";
  if (/doctor|dentist|therapy|medication/.test(lower)) return "health";
  if (/buy|pick up|pickup|store|errand|groceries/.test(lower)) return "errand";
  return "personal";
}

function titleFor(text: string, datePhrase?: string): string {
  return text
    .replace(/^\s*(?:[-*•]|\d+[.)]|\[[ x]\])\s*/i, "")
    .replace(/^(?:task|to-?do|action item|reminder)\s*:\s*/i, "")
    .replace(datePhrase ?? /$^/, " ")
    .replace(/\s*\(\s*overdue\s*\)\s*/gi, " ")
    .replace(/\b(?:by|before|on|due(?:\s+on)?)\s*$/i, "")
    .replace(/\b(?:for\s+)?\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?)(?:\s+each)?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s,;:.!—–-]+$/, "");
}

function recurrenceCount(text: string): number | undefined {
  const match = /\b(one|two|three|four|five|six|seven|\d+)\s+times?\b/i.exec(
    text,
  );
  if (!match) {
    return /\b(?:every\s+(?:other|second|2(?:nd)?)\s+day|on\s+alternate\s+days?|alternat(?:e|ing)\b.{0,40}\bdays?|day\s+on[\s,/-]+day\s+off)\b/i.test(
      text,
    )
      ? 4
      : undefined;
  }
  return NUMBER_WORDS[match[1].toLocaleLowerCase()] ?? Number(match[1]);
}

function extractDatePhrase(text: string): string | undefined {
  const timeSuffix =
    "(?:\\s+(?:at\\s+)?(?:\\d{1,2}:\\d{2}(?:\\s*(?:am|pm))?|\\d{1,2}\\s*(?:am|pm)))?";
  const patterns = [
    new RegExp(
      `\\b(?:next\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)${timeSuffix}`,
      "i",
    ),
    new RegExp(`\\b\\d{4}-\\d{1,2}-\\d{1,2}${timeSuffix}`, "i"),
    new RegExp(`\\b\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?${timeSuffix}`, "i"),
    new RegExp(
      `\\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?${timeSuffix}`,
      "i",
    ),
    new RegExp(
      `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:,?\\s+\\d{4})?${timeSuffix}`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[0].trim();
  }
  return undefined;
}

function localWeekWindow(
  currentLocalDate: string,
  timeZone: string,
  text = "",
): { start: string; end: string } {
  const localReference = new Date(`${currentLocalDate}T12:00:00`);
  const start = addWeeks(
    startOfWeek(localReference, { weekStartsOn: 1 }),
    /\bnext\s+week\b/i.test(text) ? 1 : 0,
  );
  const end = endOfWeek(start, { weekStartsOn: 1 });
  return {
    start: fromZonedTime(
      `${format(start, "yyyy-MM-dd")}T00:00:00`,
      timeZone,
    ).toISOString(),
    end: fromZonedTime(
      `${format(end, "yyyy-MM-dd")}T23:59:59`,
      timeZone,
    ).toISOString(),
  };
}

function isFixedEvent(text: string): boolean {
  return /\b(appointment|meeting|class|flight|reservation|interview)\b/i.test(
    text,
  );
}

function isDeadlineLanguage(text: string): boolean {
  return /\b(by|due|before|submit|complete|finish)\b/i.test(text);
}

function priorityFor(
  text: string,
  dueDate: string | undefined,
  currentLocalDate: string,
): { priority: TaskPriority; confidence: number } {
  if (/\b(?:urgent|asap)\b/i.test(text)) {
    return { priority: "urgent", confidence: 0.95 };
  }

  if (dueDate) {
    const daysUntilDue = differenceInCalendarDays(
      parseISO(dueDate),
      parseISO(currentLocalDate),
    );
    if (daysUntilDue <= 0) {
      return { priority: "urgent", confidence: 0.94 };
    }
    if (daysUntilDue <= 2) {
      return { priority: "high", confidence: 0.9 };
    }
  }

  if (/\b(?:important|high priority)\b/i.test(text)) {
    return { priority: "high", confidence: 0.92 };
  }
  return { priority: "medium", confidence: dueDate ? 0.74 : 0.55 };
}

function hasActionVerb(text: string): boolean {
  return /\b(?:apply|attend|book|bring|build|buy|call|clean|complete|create|deliver|do|draft|email|exercise|finish|fix|go|make|meet|pay|pick\s+up|practice|prepare|read|register|remember\s+to|renew|return|review|run|schedule|send|study|submit|take|turn\s+in|update|upload|wash|write)\b/i.test(
    text,
  );
}

function hasTaskNoun(text: string): boolean {
  return /\b(?:appointment|application|assignment|bill|birthday|deadline|dentist|dishes|doctor|errand|essay|exam|flight|form|groceries|gym|homework|interview|laundry|medication|meeting|payment|project|quiz|rent|report|reservation|taxes|test|therapy|workout)\b/i.test(
    text,
  );
}

function isClearlyNonTask(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^(?:from|to|cc|bcc|subject|sent)\s*:/i.test(trimmed) ||
    /^(?:hi|hello|hey|thanks|thank you|best|regards|sincerely)[\s,!.-]*(?:\w+)?$/i.test(
      trimmed,
    ) ||
    /^(?:https?:\/\/|www\.)\S+$/i.test(trimmed) ||
    (!hasActionVerb(trimmed) &&
      /\b(?:available|cancelled|canceled|closed|delayed|located|moved|open|rescheduled)\b/i.test(
        trimmed,
      ))
  );
}

function isTaskCandidate(text: string, datePhrase?: string): boolean {
  if (isClearlyNonTask(text)) return false;
  const title = titleFor(text, datePhrase);
  if (!title || title.toLocaleLowerCase() === datePhrase?.toLocaleLowerCase()) {
    return false;
  }
  const action = hasActionVerb(text);
  if (
    /^(?:fyi|note|reminder|information|background)\s*:/i.test(text) &&
    !action
  ) {
    return false;
  }
  const titleWords = title.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  return (
    action ||
    hasTaskNoun(text) ||
    isFixedEvent(text) ||
    isDeadlineLanguage(text) ||
    Boolean(parseTimedRecurrence(text)) ||
    Boolean(recurrenceCount(text)) ||
    Boolean(datePhrase && titleWords.length >= 2)
  );
}

function ignoredReason(text: string): string {
  if (/^(?:fyi|note|reminder|information|background)\s*:/i.test(text)) {
    return "Informational reminder with no concrete user action.";
  }
  if (isClearlyNonTask(text)) {
    return "Metadata, greeting, link, or status update; no task was created.";
  }
  return "No concrete task or scheduled responsibility was identified.";
}

function buildTask(
  line: string,
  datePhrase: string | undefined,
  interpreted: InterpretedDate | undefined,
  input: ExtractionInput,
  index: number,
  timedRecurrence?: ParsedTimedRecurrence,
): ExtractedTask {
  const estimate = estimateMinutes(line);
  const count = recurrenceCount(line);
  const alternatingDays =
    /\b(?:every\s+(?:other|second|2(?:nd)?)\s+day|on\s+alternate\s+days?|alternat(?:e|ing)\b.{0,40}\bdays?|day\s+on[\s,/-]+day\s+off)\b/i.test(
      line,
    );
  const fixed =
    !timedRecurrence && isFixedEvent(line) && !isDeadlineLanguage(line);
  const taskType =
    timedRecurrence || count
      ? "recurring_goal"
      : fixed
        ? "fixed_time"
        : "flexible";
  const category = categoryFor(line);
  const priority = priorityFor(
    line,
    !fixed ? interpreted?.date : undefined,
    input.currentLocalDate,
  );
  const fixedStartAt = fixed ? interpreted?.instant : undefined;
  const fixedEndAt =
    fixedStartAt && /\bfor\s+\d+/i.test(line)
      ? addHours(new Date(fixedStartAt), estimate.minutes / 60).toISOString()
      : undefined;
  const missingInformation: string[] = [];
  if (estimate.assumed) missingInformation.push("Confirm effort estimate");
  if (!interpreted?.date && !count && !fixed && !timedRecurrence) {
    missingInformation.push("No deadline was stated");
  }
  if (fixed && !fixedEndAt) missingInformation.push("Fixed event end time");
  if (interpreted?.ambiguous) missingInformation.push("Clarify date or time");
  if (timedRecurrence?.issues.length) {
    missingInformation.push(...timedRecurrence.issues);
  }
  const reviewRequired =
    (fixed && (!fixedStartAt || !fixedEndAt)) ||
    Boolean(interpreted?.ambiguous) ||
    Boolean(timedRecurrence?.issues.length) ||
    estimate.confidence < 0.5;
  const week = count
    ? localWeekWindow(input.currentLocalDate, input.timeZone, line)
    : undefined;

  return {
    id: `imported-${index + 1}`,
    title: titleFor(timedRecurrence?.titleSource ?? line, datePhrase),
    taskType,
    dueDate: !fixed ? interpreted?.date : undefined,
    dueTime: !fixed ? interpreted?.time : undefined,
    dueAt: !fixed ? interpreted?.instant : undefined,
    fixedStartAt,
    fixedEndAt,
    estimatedMinutes: estimate.minutes,
    effortEstimateSource: estimate.source,
    effortEstimateRationale: estimate.rationale,
    priority: priority.priority,
    category,
    energyDemand:
      category === "school" || category === "work"
        ? "high"
        : category === "errand"
          ? "low"
          : "medium",
    splittable:
      /\bsplit|over several|across\b/i.test(line) ||
      (estimate.minutes > 60 && !fixed && !count),
    minimumSessionMinutes: count ? estimate.minutes : Math.min(30, estimate.minutes),
    recurrence: timedRecurrence?.recurrence ??
      (count
        ? {
          frequency: alternatingDays ? "daily" : "weekly",
          mode: "quota",
          interval: alternatingDays ? 2 : undefined,
          count,
          windowStart: week?.start,
          windowEnd: week?.end,
        }
        : undefined),
    confidence: reviewRequired ? 0.62 : 0.9,
    fieldConfidence: {
      title: 0.94,
      taskType: fixed || count || timedRecurrence ? 0.96 : 0.84,
      dueDate: interpreted?.date ? 0.92 : undefined,
      dueTime: interpreted?.time ? 0.92 : undefined,
      estimatedMinutes: estimate.confidence,
      priority: priority.confidence,
      recurrence: count || timedRecurrence ? 0.98 : undefined,
    },
    missingInformation,
    sourceText: line,
    approved: !reviewRequired,
    reviewRequired,
  };
}

export class MockTaskExtractionProvider implements TaskExtractionProvider {
  async extractTasks(input: ExtractionInput): Promise<ExtractionResult> {
    const fragments = input.text
      .split(/\r?\n|(?<=[.!?])\s+(?=[A-Z])/)
      .map((line) => line.trim())
      .filter(Boolean);
    const lines = fragments.reduce<string[]>((items, fragment) => {
      if (
        /^(?:about|roughly|approximately)\s+\d+/i.test(fragment) &&
        items.length > 0
      ) {
        items[items.length - 1] = `${items[items.length - 1]} ${fragment}`;
      } else {
        items.push(fragment);
      }
      return items;
    }, []);
    const tasks: ExtractedTask[] = [];
    const ignoredStatements: ExtractionResult["ignoredStatements"] = [];

    lines.forEach((line, index) => {
      const alternatingWithoutClock =
        /\b(?:every\s+(?:other|second|2(?:nd)?)\s+day|on\s+alternate\s+days?|alternat(?:e|ing)\b.{0,40}\bdays?|day\s+on[\s,/-]+day\s+off)\b/i.test(
          line,
        ) &&
        !/\b(?:[01]?\d|2[0-3]):[0-5]\d\s*(?:am|pm)?\b|\b(?:1[0-2]|0?[1-9])\s*(?:am|pm)\b/i.test(
          line,
        );
      const timedRecurrence = alternatingWithoutClock
        ? undefined
        : parseTimedRecurrence(line, {
            currentLocalDate: input.currentLocalDate,
            timeZone: input.timeZone,
          });
      const datePhrase = timedRecurrence ? undefined : extractDatePhrase(line);
      if (!isTaskCandidate(line, datePhrase)) {
        ignoredStatements.push({
          sourceText: line,
          reason: ignoredReason(line),
        });
        return;
      }
      const interpreted = datePhrase
        ? resolveRelativeDate(
            datePhrase,
            input.currentLocalDate,
            input.timeZone,
          )
        : undefined;
      tasks.push(
        buildTask(
          line,
          datePhrase,
          interpreted,
          input,
          index,
          timedRecurrence,
        ),
      );
    });

    return validateAndDedupeExtraction({ tasks, ignoredStatements });
  }
}
