import type { ExtractedTask } from "./types";

export type TaskImportMerge = {
  tasks: ExtractedTask[];
  addedTasks: ExtractedTask[];
  duplicateCount: number;
};

function normalizedText(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function taskFingerprint(task: ExtractedTask): string {
  return JSON.stringify({
    sourceText: normalizedText(task.sourceText),
    title: normalizedText(task.title),
    taskType: task.taskType,
    dueDate: task.dueDate ?? null,
    dueTime: task.dueTime ?? null,
    dueAt: task.dueAt ?? null,
    fixedStartAt: task.fixedStartAt ?? null,
    fixedEndAt: task.fixedEndAt ?? null,
    recurrence: task.recurrence ?? null,
  });
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
  const fingerprints = new Set(existingTasks.map(taskFingerprint));
  const usedIds = new Set(
    existingTasks
      .map((task) => task.id)
      .filter((id): id is string => !!id),
  );
  const addedTasks: ExtractedTask[] = [];
  let duplicateCount = 0;

  for (const task of importedTasks) {
    const fingerprint = taskFingerprint(task);
    if (fingerprints.has(fingerprint)) {
      duplicateCount += 1;
      continue;
    }

    const id = uniqueTaskId(task.id, usedIds, createId);
    const added = { ...task, id };
    addedTasks.push(added);
    fingerprints.add(fingerprint);
    usedIds.add(id);
  }

  return {
    tasks: [...existingTasks, ...addedTasks],
    addedTasks,
    duplicateCount,
  };
}
