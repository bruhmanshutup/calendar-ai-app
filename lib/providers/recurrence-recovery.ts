import { validateAndDedupeExtraction } from "@/lib/domain/extraction-schema";
import type {
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
} from "@/lib/domain/types";
import { MockTaskExtractionProvider } from "./mock-extraction";
import { parseTimedRecurrence } from "./timed-recurrence";

function normalizedSource(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function timedRecurrenceStatements(text: string): string[] {
  return text
    .split(/\r?\n|(?<=[.!?])\s+(?=[A-Z])/)
    .map((statement) => statement.trim())
    .filter((statement) => Boolean(parseTimedRecurrence(statement)));
}

function mergeTimedRecurrence(
  existing: ExtractedTask,
  recovered: ExtractedTask,
): ExtractedTask {
  if (existing.recurrence?.mode === "fixed_times") return existing;
  const recoveredStatedEffort = recovered.effortEstimateSource === "stated";
  return {
    ...existing,
    taskType: "recurring_goal",
    dueDate: undefined,
    dueTime: undefined,
    dueAt: undefined,
    fixedStartAt: undefined,
    fixedEndAt: undefined,
    estimatedMinutes: recoveredStatedEffort
      ? recovered.estimatedMinutes
      : existing.estimatedMinutes,
    minimumSessionMinutes: recoveredStatedEffort
      ? recovered.minimumSessionMinutes
      : existing.minimumSessionMinutes,
    effortEstimateSource: recoveredStatedEffort
      ? recovered.effortEstimateSource
      : existing.effortEstimateSource,
    effortEstimateRationale: recoveredStatedEffort
      ? recovered.effortEstimateRationale
      : existing.effortEstimateRationale,
    recurrence: recovered.recurrence,
    fieldConfidence: {
      ...existing.fieldConfidence,
      taskType: 0.98,
      recurrence: 0.98,
      estimatedMinutes: recoveredStatedEffort
        ? recovered.fieldConfidence.estimatedMinutes
        : existing.fieldConfidence.estimatedMinutes,
    },
    missingInformation: existing.missingInformation.filter(
      (item) => !/deadline|fixed (?:event )?(?:time|end)/i.test(item),
    ).concat(
      recovered.missingInformation.filter(
        (item) =>
          !existing.missingInformation.some(
            (current) => current.toLocaleLowerCase() === item.toLocaleLowerCase(),
          ),
      ),
    ),
    reviewRequired: existing.reviewRequired || recovered.reviewRequired,
    approved:
      existing.approved && !existing.reviewRequired && !recovered.reviewRequired,
  };
}

export async function recoverTimedRecurrences(
  input: ExtractionInput,
  result: ExtractionResult,
): Promise<ExtractionResult> {
  const statements = timedRecurrenceStatements(input.text);
  if (statements.length === 0) return result;

  const local = await new MockTaskExtractionProvider().extractTasks({
    ...input,
    text: statements.join("\n"),
  });
  const recoveredBySource = new Map(
    local.tasks
      .filter((task) => task.recurrence?.mode === "fixed_times")
      .map((task) => [normalizedSource(task.sourceText), task]),
  );
  if (recoveredBySource.size === 0) return result;

  const mergedTasks = result.tasks.map((task) => {
    const recovered = recoveredBySource.get(normalizedSource(task.sourceText));
    if (!recovered) return task;
    recoveredBySource.delete(normalizedSource(task.sourceText));
    return mergeTimedRecurrence(task, recovered);
  });
  const recoveredTasks = [...recoveredBySource.values()].map((task, index) => ({
    ...task,
    id: `recovered-recurrence-${index + 1}`,
  }));
  const recoveredSources = new Set(
    [...local.tasks, ...recoveredTasks].map((task) =>
      normalizedSource(task.sourceText),
    ),
  );

  return validateAndDedupeExtraction({
    tasks: [...mergedTasks, ...recoveredTasks],
    ignoredStatements: result.ignoredStatements.filter(
      (statement) =>
        !recoveredSources.has(normalizedSource(statement.sourceText)),
    ),
  });
}
