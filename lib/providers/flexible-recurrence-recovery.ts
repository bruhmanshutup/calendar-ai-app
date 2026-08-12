import {
  addWeeks,
  endOfWeek,
  format,
  parseISO,
  startOfWeek,
} from "date-fns";
import { fromZonedTime } from "date-fns-tz";
import { validateAndDedupeExtraction } from "@/lib/domain/extraction-schema";
import type {
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
} from "@/lib/domain/types";
import { MockTaskExtractionProvider } from "./mock-extraction";

const ALTERNATING_DAYS =
  /\b(?:every\s+(?:other|second|2(?:nd)?)\s+day|on\s+alternate\s+days?|alternat(?:e|ing)\b.{0,40}\bdays?|day\s+on[\s,/-]+day\s+off|(?:one|1)\s+(?:rest\s+)?day\s+between)\b/i;
const EXACT_CLOCK_TIME =
  /\b(?:[01]?\d|2[0-3]):[0-5]\d\s*(?:am|pm)?\b|\b(?:1[0-2]|0?[1-9])\s*(?:am|pm)\b/i;
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
};

function normalizedSource(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "")
    .toLocaleLowerCase();
}

function alternatingStatements(text: string): string[] {
  return text
    .split(/\r?\n|(?<=[.!?])\s+(?=[A-Z])/)
    .map((statement) => statement.trim())
    .filter(
      (statement) =>
        ALTERNATING_DAYS.test(statement) && !EXACT_CLOCK_TIME.test(statement),
    );
}

function explicitCount(sourceText: string): number | undefined {
  const match =
    /\b(one|two|three|four|five|six|seven|\d+)\s+(?:times?|workouts?|sessions?)\b/i.exec(
      sourceText,
    );
  if (!match) return undefined;
  return NUMBER_WORDS[match[1].toLocaleLowerCase()] ?? Number(match[1]);
}

function weekWindow(
  sourceText: string,
  input: ExtractionInput,
): { windowStart?: string; windowEnd?: string } {
  if (!/\b(?:this|next)\s+week\b/i.test(sourceText)) return {};
  const reference = parseISO(input.currentLocalDate);
  const start = addWeeks(
    startOfWeek(reference, { weekStartsOn: 1 }),
    /\bnext\s+week\b/i.test(sourceText) ? 1 : 0,
  );
  const end = endOfWeek(start, { weekStartsOn: 1 });
  const startDate = format(start, "yyyy-MM-dd");
  const endDate = format(end, "yyyy-MM-dd");
  return {
    windowStart: fromZonedTime(
      `${startDate}T00:00:00`,
      input.timeZone,
    ).toISOString(),
    windowEnd: fromZonedTime(
      `${endDate}T23:59:59`,
      input.timeZone,
    ).toISOString(),
  };
}

function perOccurrenceEffort(
  task: ExtractedTask,
  count: number,
): Pick<
  ExtractedTask,
  "estimatedMinutes" | "minimumSessionMinutes" | "effortEstimateRationale"
> {
  const estimate = task.estimatedMinutes ?? 60;
  const source = task.sourceText;
  const explicitlyPerOccurrence =
    /\b(?:each|per\s+(?:workout|session|occurrence|day))\b/i.test(source) ||
    /\bevery\s+(?:other|second|2(?:nd)?)\s+day\s+for\s+\d/i.test(source);
  const statedAsWeeklyTotal =
    /\b(?:weekly\s+total|total|altogether|per\s+week)\b/i.test(source) ||
    /\b\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?).{0,24}\b(?:this|next)\s+week\b/i.test(
      source,
    );
  const shouldDivide =
    count > 1 &&
    estimate > 120 &&
    !explicitlyPerOccurrence &&
    (task.effortEstimateSource !== "stated" || statedAsWeeklyTotal);
  const divided = Math.round(estimate / count / 5) * 5;
  const estimatedMinutes =
    shouldDivide && divided >= 15 && divided <= 120 ? divided : estimate;

  return {
    estimatedMinutes,
    minimumSessionMinutes: Math.min(
      estimatedMinutes,
      task.minimumSessionMinutes ?? Math.min(30, estimatedMinutes),
    ),
    effortEstimateRationale:
      estimatedMinutes !== estimate
        ? `Interpreted ${estimate} minutes as the weekly total: ${estimatedMinutes} minutes per workout across ${count} alternating days.`
        : task.effortEstimateRationale,
  };
}

function normalizeAlternatingTask(
  task: ExtractedTask,
  input: ExtractionInput,
): ExtractedTask {
  const count = task.recurrence?.count ?? explicitCount(task.sourceText) ?? 4;
  const inferredWindow = weekWindow(task.sourceText, input);
  const missingInformation = task.missingInformation.filter(
    (item) =>
      !/fixed (?:event )?(?:time|end)|exact (?:clock )?time|recurrence (?:start|phase)/i.test(
        item,
      ),
  );
  const reviewRequired = Boolean(
    task.reviewRequired && missingInformation.length > 0,
  );

  return {
    ...task,
    taskType: "recurring_goal",
    dueDate: undefined,
    dueTime: undefined,
    dueAt: undefined,
    fixedStartAt: undefined,
    fixedEndAt: undefined,
    ...perOccurrenceEffort(task, count),
    splittable: false,
    recurrence: {
      frequency: "daily",
      mode: "quota",
      interval: 2,
      count,
      windowStart:
        task.recurrence?.windowStart ?? inferredWindow.windowStart,
      windowEnd: task.recurrence?.windowEnd ?? inferredWindow.windowEnd,
    },
    confidence: Math.max(task.confidence, 0.9),
    fieldConfidence: {
      ...task.fieldConfidence,
      taskType: 0.99,
      recurrence: 0.99,
      estimatedMinutes:
        task.estimatedMinutes && task.estimatedMinutes > 120
          ? Math.min(task.fieldConfidence.estimatedMinutes ?? 0.75, 0.82)
          : task.fieldConfidence.estimatedMinutes,
    },
    missingInformation,
    reviewRequired,
    approved: reviewRequired ? false : task.approved,
  };
}

export async function recoverFlexibleRecurrences(
  input: ExtractionInput,
  result: ExtractionResult,
): Promise<ExtractionResult> {
  const statements = alternatingStatements(input.text);
  if (statements.length === 0) return result;

  const local = await new MockTaskExtractionProvider().extractTasks({
    ...input,
    text: statements.join("\n"),
  });
  const fallbackBySource = new Map(
    local.tasks.map((task) => [normalizedSource(task.sourceText), task]),
  );
  const matchedSources = new Set<string>();
  const tasks = result.tasks.map((task) => {
    const key = normalizedSource(task.sourceText);
    if (!statements.some((statement) => normalizedSource(statement) === key)) {
      return task;
    }
    matchedSources.add(key);
    fallbackBySource.delete(key);
    return normalizeAlternatingTask(task, input);
  });
  const recovered = [...fallbackBySource.entries()].map(([key, task], index) => {
    matchedSources.add(key);
    return normalizeAlternatingTask(
      { ...task, id: `recovered-flexible-recurrence-${index + 1}` },
      input,
    );
  });

  return validateAndDedupeExtraction({
    tasks: [...tasks, ...recovered],
    planningRules: result.planningRules,
    ignoredStatements: result.ignoredStatements.filter(
      (statement) => !matchedSources.has(normalizedSource(statement.sourceText)),
    ),
  });
}
