import type { ExtractedTask } from "./types";

/** Calculated proposals may be visible without pretending they are approved. */
export function isCalculatedFixedTime(task: ExtractedTask): boolean {
  return Boolean(task.schedulingConstraints?.calculatedTiming && task.taskType === "fixed_time" && task.fixedStartAt && task.fixedEndAt);
}

/** Materialize a saved buffer interval as its own ordinary calendar block. */
export function materializeCalculatedTimeBlock(task: ExtractedTask): ExtractedTask {
  const buffer = task.schedulingConstraints?.calculatedTiming?.buffer;
  if (!buffer || task.taskType === "fixed_time") return task;
  if (task.fieldProvenance?.some((field) => field.origin === "user" && ["taskType", "responsibilityKind", "dueAt", "dueDate", "dueTime", "fixedStartAt", "fixedEndAt", "schedulingConstraints"].includes(field.path))) return task;
  const minutes = (Date.parse(buffer.end) - Date.parse(buffer.start)) / 60_000;
  // Only serialization requirements, not source or relationship validation.
  if (!Number.isFinite(minutes) || minutes <= 0) return task;
  const replaced = new Set(["taskType", "responsibilityKind", "fixedStartAt", "fixedEndAt", "estimatedMinutes", "dueAt", "dueDate", "dueTime"]);
  return {
    ...task,
    taskType: "fixed_time",
    responsibilityKind: "event",
    fixedStartAt: buffer.start,
    fixedEndAt: buffer.end,
    estimatedMinutes: minutes,
    minimumSessionMinutes: Math.min(minutes, 240),
    durationRange: undefined,
    splittable: false,
    dueAt: undefined,
    dueDate: undefined,
    dueTime: undefined,
    dueWindow: undefined,
    deadlineStrength: undefined,
    occurrenceWindow: undefined,
    // A former checkpoint's placeholder occurrence/window is not a second
    // placement constraint for the now-materialized fixed interval.
    schedulingConstraints: { calculatedTiming: task.schedulingConstraints!.calculatedTiming },
    fieldProvenance: [
      ...(task.fieldProvenance ?? []).filter((field) => !replaced.has(field.path)),
      ...["fixedStartAt", "fixedEndAt", "estimatedMinutes"].map((path) => ({ path, origin: "derived" as const, rationale: "Independent fixed block from the AI-interpreted buffer and calculator-produced boundaries. Relationship not validated." })),
    ],
    missingInformation: task.missingInformation.map((message) => message.replace("Review before scheduling.", "Shown on the schedule as a fixed proposal; check its timing.")),
  };
}
