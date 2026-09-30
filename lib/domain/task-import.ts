import type { ExtractedTask } from "./types";

export type TaskImportMerge = {
  tasks: ExtractedTask[];
  addedTasks: ExtractedTask[];
  importedTaskIds: string[];
  refreshedTaskIds: string[];
  duplicateCount: number;
  removedMetadataCount: number;
  refreshedTaskCount: number;
};

export function sessionsToPreserveAfterImport<
  T extends { taskId: string; status: string },
>(
  sessions: T[],
  retainedTaskIds: ReadonlySet<string>,
  refreshedTaskIds: ReadonlySet<string>,
): T[] {
  return sessions.filter(
    (session) =>
      retainedTaskIds.has(session.taskId) &&
      (!refreshedTaskIds.has(session.taskId) ||
        session.status === "completed"),
  );
}

function normalizedText(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function normalizedIdentityText(value: string | undefined): string {
  return normalizedText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const IDENTITY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "for",
  "from",
  "in",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

function identityTokens(value: string): Set<string> {
  return new Set(
    normalizedIdentityText(value)
      .split(" ")
      .filter((token) => token && !IDENTITY_STOP_WORDS.has(token)),
  );
}

function titleSimilarity(left: string, right: string): number {
  const leftTokens = identityTokens(left);
  const rightTokens = identityTokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) intersection += 1;
  });
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

function canonicalTitleIdentity(value: string): string {
  return [...identityTokens(value)].sort().join(" ");
}

function taskSourceFingerprint(task: ExtractedTask): string {
  return normalizedIdentityText(task.sourceText) || normalizedIdentityText(task.title);
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${sortedJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * Fields that distinguish two active responsibilities even when an AI uses the
 * same title and supporting sentence for both. Planning estimates and review
 * state are intentionally excluded because they may vary between reimports.
 */
function semanticIdentitySlot(task: ExtractedTask): string {
  return sortedJson({
    taskType: task.taskType,
    responsibilityKind: task.responsibilityKind,
    dueDate: task.dueDate,
    dueTime: task.dueTime,
    dueWindow: task.dueWindow,
    occurrenceWindow: task.occurrenceWindow,
    fixedStartAt: task.fixedStartAt,
    fixedEndAt: task.fixedEndAt,
    recurrence: task.recurrence,
    sequence: task.sequence,
  });
}

function taskIdentityFingerprint(task: ExtractedTask): string {
  return [
    taskSourceFingerprint(task),
    canonicalTitleIdentity(task.title),
    semanticIdentitySlot(task),
  ].join("|");
}

function sourceRelationScore(
  existing: ExtractedTask,
  incoming: ExtractedTask,
): number {
  const existingSource = taskSourceFingerprint(existing);
  const incomingSource = taskSourceFingerprint(incoming);
  if (existingSource === incomingSource) return 1;
  if (
    Math.min(existingSource.length, incomingSource.length) >= 12 &&
    (existingSource.includes(incomingSource) ||
      incomingSource.includes(existingSource))
  ) {
    return 0.9;
  }

  const existingSpan = existing.sourceSpan;
  const incomingSpan = incoming.sourceSpan;
  if (
    existingSpan?.sourceId &&
    incomingSpan?.sourceId === existingSpan.sourceId &&
    Math.min(existingSpan.end, incomingSpan.end) >
      Math.max(existingSpan.start, incomingSpan.start)
  ) {
    return 0.8;
  }
  return 0;
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

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasUserEdit(task: ExtractedTask, paths: string[]): boolean {
  return Boolean(
    task.fieldProvenance?.some(
      (field) => field.origin === "user" && paths.includes(field.path),
    ),
  );
}

/**
 * Lets a corrected interpreter repair an older temporal-role mistake without
 * turning every duplicate import into an overwrite. Each branch requires both
 * source wording for that role and a stronger, internally coherent incoming
 * representation. User-edited temporal fields always win.
 */
function hasCorrectedTemporalInterpretation(
  existing: ExtractedTask,
  incoming: ExtractedTask,
  ignoreUserEdits = false,
): boolean {
  const source = incoming.sourceText;
  const deadlineLanguage = /\b(?:due|deadline|submit(?:ted)?\s+by|send(?:\s+\w+){0,5}\s+by|finish(?:ed)?\s+by|complete(?:d)?\s+by|\bby)\b/i.test(
    source,
  );
  const exactClock = /\b(?:at|by)\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i.test(
    source,
  );
  const occurrenceLanguage = /\b(?:we(?:'|’)?ll\s+meet|we\s+will\s+meet|meet(?:ing)?\s+(?:is|starts?|begins?)|appointment\s+(?:is|starts?|begins?)|class\s+(?:is|starts?|begins?)|call\s+(?:is|starts?|begins?))\b/i.test(
    source,
  );
  const softPreferenceLanguage = /\b(?:if\s+possible|ideally|prefer(?:ably)?|would\s+rather|try\s+to)\b/i.test(
    source,
  );

  const exactDeadlinePaths = ["taskType", "dueDate", "dueTime", "dueAt"];
  if (
    deadlineLanguage &&
    exactClock &&
    incoming.taskType === "flexible" &&
    incoming.dueDate &&
    incoming.dueTime &&
    incoming.dueAt &&
    (ignoreUserEdits || !hasUserEdit(existing, exactDeadlinePaths)) &&
    exactDeadlinePaths.some(
      (path) =>
        !sameValue(
          existing[path as keyof ExtractedTask],
          incoming[path as keyof ExtractedTask],
        ),
    )
  ) {
    return true;
  }

  const namedDeadlinePaths = ["taskType", "dueDate", "dueTime", "dueAt", "dueWindow"];
  if (
    deadlineLanguage &&
    incoming.taskType === "flexible" &&
    incoming.dueDate &&
    incoming.dueWindow &&
    (ignoreUserEdits || !hasUserEdit(existing, namedDeadlinePaths)) &&
    !sameValue(existing.dueWindow, incoming.dueWindow)
  ) {
    return true;
  }

  const fixedEventPaths = [
    "taskType",
    "dueDate",
    "dueTime",
    "dueAt",
    "dueWindow",
    "fixedStartAt",
    "fixedEndAt",
  ];
  if (
    occurrenceLanguage &&
    incoming.taskType === "fixed_time" &&
    incoming.fixedStartAt &&
    incoming.fixedEndAt &&
    (ignoreUserEdits || !hasUserEdit(existing, fixedEventPaths)) &&
    fixedEventPaths.some(
      (path) =>
        !sameValue(
          existing[path as keyof ExtractedTask],
          incoming[path as keyof ExtractedTask],
        ),
    )
  ) {
    return true;
  }

  const preferencePaths = [
    "taskType",
    "dueDate",
    "dueTime",
    "dueAt",
    "dueWindow",
    "fixedStartAt",
    "fixedEndAt",
    "schedulingConstraints",
  ];
  return Boolean(
    softPreferenceLanguage &&
      incoming.taskType === "flexible" &&
      incoming.schedulingConstraints?.preferredDateWindows?.length &&
      !incoming.dueDate &&
      !incoming.fixedStartAt &&
      (ignoreUserEdits || !hasUserEdit(existing, preferencePaths)) &&
      !sameValue(
        existing.schedulingConstraints?.preferredDateWindows,
        incoming.schedulingConstraints.preferredDateWindows,
      ),
  );
}

function shouldRefreshDuplicate(
  existing: ExtractedTask,
  incoming: ExtractedTask,
): boolean {
  return (
    (existing.taskType !== "fixed_time" && incoming.taskType === "fixed_time" && Boolean(existing.schedulingConstraints?.calculatedTiming?.buffer)
      && !hasUserEdit(existing, ["taskType", "fixedStartAt", "fixedEndAt", "dueAt", "dueDate", "dueTime", "schedulingConstraints"])) ||
    (!existing.schedulingConstraints?.calculatedTiming && Boolean(incoming.schedulingConstraints?.calculatedTiming)
      && !hasUserEdit(existing, ["taskType", "fixedStartAt", "fixedEndAt", "dueAt", "dueDate", "dueTime", "schedulingConstraints"])) ||
    (!existing.schedulingConstraints?.linkedTiming && Boolean(incoming.schedulingConstraints?.linkedTiming)
      && !hasUserEdit(existing, ["taskType", "fixedStartAt", "fixedEndAt", "dueAt", "dueDate", "dueTime", "schedulingConstraints"])) ||
    /[*_~`\[\]]/.test(existing.title) ||
    (isLegacyDayAgendaInterpretation(existing) &&
      incoming.taskType === "fixed_time" &&
      Boolean(incoming.fixedStartAt && incoming.fixedEndAt)) ||
    hasCorrectedDayAgendaTiming(existing, incoming) ||
    hasCorrectedTemporalInterpretation(existing, incoming)
  );
}

function strongIdentitySlot(
  task: ExtractedTask,
): { role: "occurrence" | "deadline" | "recurrence"; value: string } | undefined {
  if (task.fixedStartAt || task.occurrenceWindow) {
    return {
      role: "occurrence",
      value: sortedJson({
        fixedStartAt: task.fixedStartAt,
        fixedEndAt: task.fixedEndAt,
        occurrenceWindow: task.occurrenceWindow,
      }),
    };
  }
  if (task.recurrence) {
    return { role: "recurrence", value: sortedJson(task.recurrence) };
  }
  if (task.dueDate || task.dueTime || task.dueAt || task.dueWindow) {
    return {
      role: "deadline",
      value: sortedJson({
        dueDate: task.dueDate,
        dueTime: task.dueTime,
        dueAt: task.dueAt,
        dueWindow: task.dueWindow,
      }),
    };
  }
  return undefined;
}

function hasStrongIdentityConflict(
  existing: ExtractedTask,
  incoming: ExtractedTask,
): boolean {
  const left = strongIdentitySlot(existing);
  const right = strongIdentitySlot(incoming);
  return Boolean(
    left && right && left.role === right.role && left.value !== right.value,
  );
}

function possibleIdentityMatch(
  existing: ExtractedTask,
  incoming: ExtractedTask,
): boolean {
  if (!sourceRelationScore(existing, incoming)) return false;
  return (
    canonicalTitleIdentity(existing.title) ===
      canonicalTitleIdentity(incoming.title) ||
    titleSimilarity(existing.title, incoming.title) >= 0.45
  );
}

function duplicateMatchScore(
  existing: ExtractedTask,
  incoming: ExtractedTask,
  identityIsUnambiguous: boolean,
): number {
  const sourceScore = sourceRelationScore(existing, incoming);
  if (!sourceScore) return -1;

  const exactId = Boolean(
    existing.id && incoming.id && existing.id === incoming.id,
  );
  const exactTitle =
    canonicalTitleIdentity(existing.title) ===
    canonicalTitleIdentity(incoming.title);
  const similarity = titleSimilarity(existing.title, incoming.title);
  const strongConflict = hasStrongIdentityConflict(existing, incoming);
  const isCorrection = shouldRefreshDuplicate(existing, incoming);
  const representsCorrection =
    isCorrection ||
    hasCorrectedTemporalInterpretation(existing, incoming, true);

  if (exactId && (exactTitle || similarity >= 0.45)) {
    return 400 + sourceScore;
  }
  if (strongConflict && !(representsCorrection && identityIsUnambiguous)) {
    return -1;
  }
  if (representsCorrection && (exactTitle || similarity >= 0.45)) {
    return 300 + similarity + sourceScore;
  }
  if (exactTitle) return 200 + sourceScore;
  return -1;
}

function preserveUserEditedFields(
  existing: ExtractedTask,
  incoming: ExtractedTask,
): ExtractedTask {
  const next = { ...incoming } as ExtractedTask & Record<string, unknown>;
  const existingRecord = existing as ExtractedTask & Record<string, unknown>;
  const userFields =
    existing.fieldProvenance?.filter((field) => field.origin === "user") ?? [];
  userFields.forEach((field) => {
    if (!field.path.includes(".") && field.path in existingRecord) {
      next[field.path] = existingRecord[field.path];
    }
  });
  if (userFields.length) {
    const userPaths = new Set(userFields.map((field) => field.path));
    next.fieldProvenance = [
      ...(incoming.fieldProvenance ?? []).filter(
        (field) => !userPaths.has(field.path),
      ),
      ...userFields,
    ];
  }
  return next;
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
  const usedIds = new Set(
    retainedTasks
      .map((task) => task.id)
      .filter((id): id is string => !!id),
  );
  const addedTasks: ExtractedTask[] = [];
  const refreshedTasks = new Map<string, ExtractedTask>();
  const importedTaskIds: string[] = [];
  const importedIdMap = new Map<string, string>();
  let duplicateCount = 0;

  // First collapse only semantically identical rows from the same provider
  // response. A shared source sentence alone is not an identity: one sentence
  // can legitimately contain several independent responsibilities.
  const uniqueImports: ExtractedTask[] = [];
  const seenImportIdentities = new Set<string>();
  importedTasks.forEach((task) => {
    const identity = taskIdentityFingerprint(task);
    if (seenImportIdentities.has(identity)) {
      duplicateCount += 1;
      return;
    }
    seenImportIdentities.add(identity);
    uniqueImports.push(task);
  });

  const matches = new Map<number, number>();
  const claimedExistingIndexes = new Set<number>();

  // Claim exact identities first. This makes same-title repeated occurrences
  // deterministic before the more tolerant correction matching below.
  uniqueImports.forEach((task, importIndex) => {
    const identity = taskIdentityFingerprint(task);
    const existingIndex = retainedTasks.findIndex(
      (existing, index) =>
        !claimedExistingIndexes.has(index) &&
        taskIdentityFingerprint(existing) === identity,
    );
    if (existingIndex < 0) return;
    matches.set(importIndex, existingIndex);
    claimedExistingIndexes.add(existingIndex);
  });

  // Reimports may contain a cleaned title or a corrected temporal role. Match
  // those only when source evidence and responsibility words agree. Conflicting
  // dates/times are accepted as corrections only for an unambiguous identity.
  uniqueImports.forEach((task, importIndex) => {
    if (matches.has(importIndex)) return;
    const possibleExisting = retainedTasks.filter((existing) =>
      possibleIdentityMatch(existing, task),
    ).length;
    const possibleIncoming = uniqueImports.filter((incoming) =>
      possibleIdentityMatch(incoming, task),
    ).length;
    const identityIsUnambiguous =
      possibleExisting === 1 && possibleIncoming === 1;
    let bestIndex = -1;
    let bestScore = -1;
    retainedTasks.forEach((existing, existingIndex) => {
      if (claimedExistingIndexes.has(existingIndex)) return;
      const score = duplicateMatchScore(
        existing,
        task,
        identityIsUnambiguous,
      );
      if (score > bestScore) {
        bestIndex = existingIndex;
        bestScore = score;
      }
    });
    if (bestIndex < 0) return;
    matches.set(importIndex, bestIndex);
    claimedExistingIndexes.add(bestIndex);
  });

  uniqueImports.forEach((task, importIndex) => {
    const matchedIndex = matches.get(importIndex);
    if (matchedIndex !== undefined) {
      duplicateCount += 1;
      const existing = retainedTasks[matchedIndex];
      const existingId = existing.id;
      if (task.id && existingId) importedIdMap.set(task.id, existingId);
      if (existingId && !importedTaskIds.includes(existingId)) {
        importedTaskIds.push(existingId);
      }
      if (existingId && shouldRefreshDuplicate(existing, task)) {
        refreshedTasks.set(
          existingId,
          preserveUserEditedFields(existing, {
            ...task,
            id: existingId,
            completed: existing.completed,
            completedAt: existing.completedAt,
            completedMinutes: existing.completedMinutes,
            cancelled: existing.cancelled,
            cancelledAt: existing.cancelledAt,
          }),
        );
      }
      return;
    }

    const id = uniqueTaskId(task.id, usedIds, createId);
    const added = { ...task, id };
    if (task.id) importedIdMap.set(task.id, id);
    addedTasks.push(added);
    importedTaskIds.push(id);
    usedIds.add(id);
  });

  // Imports can reuse an existing task or allocate a new ID after a collision.
  // Retarget every formula and dependency in this import to that actual ID.
  const canonicalByIdentity = new Map(uniqueImports.map((task) => [taskIdentityFingerprint(task), task]));
  importedTasks.forEach((task) => {
    const canonical = canonicalByIdentity.get(taskIdentityFingerprint(task));
    const resolved = canonical?.id && importedIdMap.get(canonical.id);
    if (task.id && resolved) importedIdMap.set(task.id, resolved);
  });
  const remap = (task: ExtractedTask) => {
    task.dependencies = task.dependencies?.map((dependency) => ({ ...dependency, taskId: dependency.taskId ? importedIdMap.get(dependency.taskId) ?? dependency.taskId : undefined }));
    const linked = task.schedulingConstraints?.linkedTiming;
    if (linked) task.schedulingConstraints = { ...task.schedulingConstraints, linkedTiming: { ...linked, rules: linked.rules.map((rule) => ({ ...rule, taskId: importedIdMap.get(rule.taskId) ?? rule.taskId })) } };
  };
  addedTasks.forEach(remap);
  refreshedTasks.forEach(remap);

  return {
    tasks: [
      ...retainedTasks.map((task) =>
        task.id ? (refreshedTasks.get(task.id) ?? task) : task,
      ),
      ...addedTasks,
    ],
    addedTasks,
    importedTaskIds,
    refreshedTaskIds: [...refreshedTasks.keys()],
    duplicateCount,
    removedMetadataCount: existingTasks.length - retainedTasks.length,
    refreshedTaskCount: refreshedTasks.size,
  };
}
