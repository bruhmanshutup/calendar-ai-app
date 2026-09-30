import type {
  ExtractedTask,
  ExtractionResult,
  ResponsibilityKind,
  TaskClassification,
} from "./types";

const ALL_DAY = /\b(?:all[ -]?day|whole day|campus is closed|office is closed|holiday)\b/i;
const TEMPORAL_REVIEW = /\b(?:date|time|year|when|calendar)\b/i;
const NAMED_TIME_WINDOW = /\b(?:morning|afternoon|evening|tonight|overnight|at lunch|before work|after work)\b/i;
const EXPLICIT_CLOCK = /\b(?:\d{1,2}:\d{2}|\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)|noon|midnight)\b/i;
const DEADLINE_CUE = /\b(?:due|deadline|by|no later than|before)\b/i;

function inferKind(task: ExtractedTask): ResponsibilityKind {
  if (task.responsibilityKind) return task.responsibilityKind;
  if (task.taskType === "fixed_time" || task.recurrence?.mode === "fixed_times") return "event";
  return "task";
}

/** Derive orthogonal meaning without inventing source facts. */
export function classifyTask(task: ExtractedTask): TaskClassification {
  const kind = inferKind(task);
  const recurrence = task.recurrence ? "recurring" : "once";
  const sourceSaysAllDay = ALL_DAY.test(task.sourceText);
  const hasFixedOccurrence = Boolean(
    task.fixedStartAt || task.fixedEndAt || task.taskType === "fixed_time" || task.recurrence?.mode === "fixed_times",
  );
  const hasDeadline = Boolean(
    task.dueAt || task.dueDate || task.dueTime || task.dueWindow || task.deadlineStrength,
  );
  const hasNamedFlexibleWindow = Boolean(
    kind === "reminder" &&
    task.dueDate &&
    !task.dueAt &&
    !task.dueTime &&
    (!task.dueWindow || task.dueWindow.precision === "named_period") &&
    !DEADLINE_CUE.test(task.sourceText) &&
    NAMED_TIME_WINDOW.test(task.sourceText),
  );

  let timing: TaskClassification["timing"];
  if (
    sourceSaysAllDay &&
    kind === "event" &&
    !task.dueAt &&
    !task.dueDate &&
    !task.dueTime &&
    !EXPLICIT_CLOCK.test(task.sourceText)
  ) {
    timing = "all_day";
  } else if (
    task.reviewRequired && !task.fixedStartAt && !task.fixedEndAt && !task.dueDate && !task.dueAt && !task.dueWindow && !task.recurrence?.timeRules?.length && !task.recurrence?.monthlyRules?.length && !task.occurrenceWindow &&
    task.missingInformation.some((item) => TEMPORAL_REVIEW.test(item))
  ) {
    timing = "unresolved";
  } else if (hasFixedOccurrence || task.occurrenceWindow?.precision === "exact") {
    timing = "fixed_time";
  } else if (hasNamedFlexibleWindow) {
    timing = "flexible_window";
  } else if (hasDeadline) {
    timing = "deadline";
  } else {
    timing = "flexible_window";
  }

  return { kind, timing, recurrence };
}

export function withTaskClassification(task: ExtractedTask): ExtractedTask {
  return { ...task, classification: classifyTask(task) };
}

export function withResultClassifications(result: ExtractionResult): ExtractionResult {
  return { ...result, tasks: result.tasks.map(withTaskClassification) };
}
