import type { ExtractedTask } from "./types";

export type TaskImportMerge = {
  tasks: ExtractedTask[];
  addedTasks: ExtractedTask[];
  importedTaskIds: string[];
  duplicateCount: number;
  removedMetadataCount: number;
  refreshedTaskCount: number;
};

function normalizedText(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function taskFingerprint(task: ExtractedTask): string {
  const source = normalizedText(task.sourceText);
  return source || normalizedText(task.title);
}

function isLegacyDayAgendaInterpretation(task: ExtractedTask): boolean {
  return /^\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*[-–—:]/i.test(
    task.title,
  );
}

function hasCorrectedDayAgendaTiming(
  existing: ExtractedTask,
  incoming: ExtractedTask,
): boolean {
  const agendaSource =
    /^\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(existing.sourceText);
  const timingChanged =
    existing.taskType !== "fixed_time" ||
    existing.fixedStartAt !== incoming.fixedStartAt ||
    existing.fixedEndAt !== incoming.fixedEndAt ||
    existing.estimatedMinutes !== incoming.estimatedMinutes;
  const onwardCertaintyChanged =
    /\bonwards?\b/i.test(existing.sourceText) &&
    (existing.reviewRequired !== incoming.reviewRequired ||
      existing.approved !== incoming.approved);
  return Boolean(
    agendaSource &&
      normalizedText(existing.title) === normalizedText(incoming.title) &&
      incoming.taskType === "fixed_time" &&
      incoming.fixedStartAt &&
      incoming.fixedEndAt &&
      (timingChanged || onwardCertaintyChanged),
  );
}

function shouldRefreshDuplicate(
  existing: ExtractedTask,
  incoming: ExtractedTask,
): boolean {
  return (
    /[*_~`\[\]]/.test(existing.title) ||
    (isLegacyDayAgendaInterpretation(existing) &&
      incoming.taskType === "fixed_time" &&
      Boolean(incoming.fixedStartAt && incoming.fixedEndAt)) ||
    hasCorrectedDayAgendaTiming(existing, incoming)
  );
}

function isClearlyImportMetadata(task: ExtractedTask): boolean {
  const source = task.sourceText.trim();
  const title = normalizedText(task.title).replace(/[*_~`#]+/g, " ");
  const monthHeading =
    /^(?:tasks?\s+)?due\s+in\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)$/i.test(
      title,
    );
  const markdownLinksOnly =
    /^(?:\s*!?\[[^\]]+]\([^)]+\)\s*)+$/.test(source);
  const actionableTitle =
    /\b(?:apply|book|buy|call|complete|confirm|email|finish|pay|read|register|reply|request|review|schedule|select|send|submit|upload|view|waive|write)\b/i.test(
      title,
    );
  return monthHeading || (markdownLinksOnly && !actionableTitle);
}

function isSupersededStructuredPlanSummary(task: ExtractedTask): boolean {
  const title = normalizedText(task.title).replace(/[*_~`#]+/g, " ");
  const source = normalizedText(task.sourceText).replace(/[*_~`#]+/g, " ");
  return (
    /^(?:daily|weekly)?\s*checklist\s*:?$/.test(title) ||
    /^complete\s+\d+\s*[-–— ]\s*week\b.*\bplan\b/.test(title) ||
    /^\d+\s*[-–— ]\s*week\b.*\bplan\b/.test(source)
  );
}

function defaultTaskId(): string {
  return `task-${globalThis.crypto.randomUUID()}`;
}

function uniqueTaskId(
  requestedId: string | undefined,
  usedIds: Set<string>,
  createId: () => string,
): string {
  const requested = requestedId?.trim();
  if (requested && !usedIds.has(requested)) return requested;

  let candidate = createId();
  while (!candidate || usedIds.has(candidate)) candidate = createId();
  return candidate;
}

export function mergeImportedTasks(
  existingTasks: ExtractedTask[],
  importedTasks: ExtractedTask[],
  createId: () => string = defaultTaskId,
): TaskImportMerge {
  const importsStructuredPlan = importedTasks.some((task) =>
    task.id?.startsWith("structured-plan-"),
  );
  const retainedTasks = existingTasks.filter(
    (task) =>
      !isClearlyImportMetadata(task) &&
      !(importsStructuredPlan && isSupersededStructuredPlanSummary(task)),
  );
  const existingByFingerprint = new Map(
    retainedTasks.map((task) => [taskFingerprint(task), task]),
  );
  const fingerprints = new Set(existingByFingerprint.keys());
  const usedIds = new Set(
    retainedTasks
      .map((task) => task.id)
      .filter((id): id is string => !!id),
  );
  const addedTasks: ExtractedTask[] = [];
  const refreshedTasks = new Map<string, ExtractedTask>();
  const importedTaskIds: string[] = [];
  let duplicateCount = 0;

  for (const task of importedTasks) {
    const fingerprint = taskFingerprint(task);
    if (fingerprints.has(fingerprint)) {
      duplicateCount += 1;
      const existingId = existingByFingerprint.get(fingerprint)?.id;
      if (existingId && !importedTaskIds.includes(existingId)) {
        importedTaskIds.push(existingId);
      }
      const existing = existingByFingerprint.get(fingerprint);
      if (existingId && existing && shouldRefreshDuplicate(existing, task)) {
        refreshedTasks.set(existingId, {
          ...task,
          id: existingId,
          completed: existing.completed,
          completedAt: existing.completedAt,
          completedMinutes: existing.completedMinutes,
          cancelled: existing.cancelled,
          cancelledAt: existing.cancelledAt,
        });
      }
      continue;
    }

    const id = uniqueTaskId(task.id, usedIds, createId);
    const added = { ...task, id };
    addedTasks.push(added);
    importedTaskIds.push(id);
    fingerprints.add(fingerprint);
    usedIds.add(id);
  }

  return {
    tasks: [
      ...retainedTasks.map((task) =>
        task.id ? (refreshedTasks.get(task.id) ?? task) : task,
      ),
      ...addedTasks,
    ],
    addedTasks,
    importedTaskIds,
    duplicateCount,
    removedMetadataCount: existingTasks.length - retainedTasks.length,
    refreshedTaskCount: refreshedTasks.size,
  };
}
