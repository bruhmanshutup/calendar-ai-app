import { addHours, endOfWeek, startOfWeek } from "date-fns";
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
} from "@/lib/domain/types";
import type { TaskExtractionProvider } from "./task-extraction";

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
} {
  const hours = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)/i.exec(text);
  if (hours) {
    return {
      minutes: Math.round(Number(hours[1]) * 60),
      confidence: 0.98,
      assumed: false,
    };
  }
  const minutes = /(\d+)\s*(?:minutes?|mins?)/i.exec(text);
  if (minutes) {
    return {
      minutes: Number(minutes[1]),
      confidence: 0.98,
      assumed: false,
    };
  }
  const lower = text.toLocaleLowerCase();
  if (/exam|study|essay|report|proposal/.test(lower)) {
    return { minutes: 90, confidence: 0.46, assumed: true };
  }
  if (/gym|workout|run|appointment/.test(lower)) {
    return { minutes: 60, confidence: 0.48, assumed: true };
  }
  return { minutes: 45, confidence: 0.42, assumed: true };
}

function categoryFor(text: string): TaskCategory {
  const lower = text.toLocaleLowerCase();
  if (/essay|homework|exam|study|class|chemistry|reading/.test(lower)) {
    return "school";
  }
  if (/meeting|report|client|proposal|email/.test(lower)) return "work";
  if (/gym|workout|run|yoga/.test(lower)) return "fitness";
  if (/doctor|dentist|therapy|medication/.test(lower)) return "health";
  if (/buy|pick up|pickup|store|errand|groceries/.test(lower)) return "errand";
  return "personal";
}

function titleFor(text: string): string {
  return text
    .replace(/^[-*•\d.)\s]+/, "")
    .replace(/\s+(?:by|due)\s+(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday).*$/i, "")
    .replace(/\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?).*$/i, "")
    .trim()
    .replace(/[.!]+$/, "");
}

function recurrenceCount(text: string): number | undefined {
  const match = /\b(one|two|three|four|five|six|seven|\d+)\s+times?\b/i.exec(
    text,
  );
  if (!match) return undefined;
  return NUMBER_WORDS[match[1].toLocaleLowerCase()] ?? Number(match[1]);
}

function extractDatePhrase(text: string): string | undefined {
  const match =
    /\b((?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?/i.exec(
      text,
    );
  if (!match) return undefined;
  return `${match[1]}${match[2] ? ` at ${match[2]}` : ""}`;
}

function localWeekWindow(
  currentLocalDate: string,
  timeZone: string,
): { start: string; end: string } {
  const localReference = new Date(`${currentLocalDate}T12:00:00`);
  const start = startOfWeek(localReference, { weekStartsOn: 1 });
  const end = endOfWeek(localReference, { weekStartsOn: 1 });
  return {
    start: fromZonedTime(
      `${start.toISOString().slice(0, 10)}T00:00:00`,
      timeZone,
    ).toISOString(),
    end: fromZonedTime(
      `${end.toISOString().slice(0, 10)}T23:59:59`,
      timeZone,
    ).toISOString(),
  };
}

function isInformationOnly(text: string): boolean {
  return /^(?:fyi|note|reminder|information|background)\s*:/i.test(text);
}

function isFixedEvent(text: string): boolean {
  return /\b(appointment|meeting|class|flight|reservation|interview)\b/i.test(
    text,
  );
}

function isDeadlineLanguage(text: string): boolean {
  return /\b(by|due|before|submit|complete|finish)\b/i.test(text);
}

function buildTask(
  line: string,
  interpreted: InterpretedDate | undefined,
  input: ExtractionInput,
  index: number,
): ExtractedTask {
  const estimate = estimateMinutes(line);
  const count = recurrenceCount(line);
  const fixed = isFixedEvent(line) && !isDeadlineLanguage(line);
  const taskType = count ? "recurring_goal" : fixed ? "fixed_time" : "flexible";
  const category = categoryFor(line);
  const fixedStartAt = fixed ? interpreted?.instant : undefined;
  const fixedEndAt =
    fixedStartAt && /\bfor\s+\d+/i.test(line)
      ? addHours(new Date(fixedStartAt), estimate.minutes / 60).toISOString()
      : undefined;
  const missingInformation: string[] = [];
  if (estimate.assumed) missingInformation.push("Confirm effort estimate");
  if (!interpreted?.date && !count && !fixed) {
    missingInformation.push("No deadline was stated");
  }
  if (fixed && !fixedEndAt) missingInformation.push("Fixed event end time");
  if (interpreted?.ambiguous) missingInformation.push("Clarify date or time");
  const reviewRequired =
    (fixed && (!fixedStartAt || !fixedEndAt)) ||
    Boolean(interpreted?.ambiguous) ||
    estimate.confidence < 0.5;
  const week = count
    ? localWeekWindow(input.currentLocalDate, input.timeZone)
    : undefined;

  return {
    id: `imported-${index + 1}`,
    title: titleFor(line),
    taskType,
    dueDate: !fixed ? interpreted?.date : undefined,
    dueTime: !fixed ? interpreted?.time : undefined,
    dueAt: !fixed ? interpreted?.instant : undefined,
    fixedStartAt,
    fixedEndAt,
    estimatedMinutes: estimate.minutes,
    priority: /\burgent|asap\b/i.test(line)
      ? "urgent"
      : /\bimportant|high priority\b/i.test(line)
        ? "high"
        : "medium",
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
    minimumSessionMinutes: count ? estimate.minutes : 30,
    recurrence: count
      ? {
          frequency: "weekly",
          count,
          windowStart: week?.start,
          windowEnd: week?.end,
        }
      : undefined,
    confidence: reviewRequired ? 0.62 : 0.9,
    fieldConfidence: {
      title: 0.94,
      taskType: fixed || count ? 0.96 : 0.84,
      dueDate: interpreted?.date ? 0.92 : undefined,
      dueTime: interpreted?.time ? 0.92 : undefined,
      estimatedMinutes: estimate.confidence,
      priority: /\burgent|asap|important|high priority\b/i.test(line)
        ? 0.92
        : 0.55,
      recurrence: count ? 0.98 : undefined,
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
      if (isInformationOnly(line)) {
        ignoredStatements.push({
          sourceText: line,
          reason: "Informational statement; no action was requested.",
        });
        return;
      }
      const datePhrase = extractDatePhrase(line);
      const interpreted = datePhrase
        ? resolveRelativeDate(
            datePhrase,
            input.currentLocalDate,
            input.timeZone,
          )
        : undefined;
      tasks.push(buildTask(line, interpreted, input, index));
    });

    return validateAndDedupeExtraction({ tasks, ignoredStatements });
  }
}
